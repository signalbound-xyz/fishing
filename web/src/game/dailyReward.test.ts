import { describe, expect, it } from 'vitest';
import { hashTypedData, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { RODS } from '../tackle/catalog';
import { GameError, claimDailyReward, dailyRewardCheck, energyCountdown, energyNow, landFish, startCast, type CastTicket } from './actions';
import { LOCATIONS, SPECIES, TUNING } from './content';
import { DAILY, DAILY_REWARD, DAY_MS, LOCAL_PLAYER, generateDaily, localClaimed, localEarned, localRewards, profileOf, rollDaily, setProgress, streakOn, type DailySet, type DayCatch } from './daily';
import { CLAIM_DAYS, REWARD_ENERGY, askVerifier, authorizationFits, claimEndMs, rewardStatus, rewardTypedData, type RewardAuthorization, type RewardFacts } from './dailyReward';
import { totals } from './equipment';
import vectors from './fixtures/dailyReward.json';
import { freshSave, loadSave } from './save';
import type { Save } from './types';

const DAY = DAILY_REWARD.localFirstDay + 3;
const NOON = DAY * DAY_MS + 12 * 3_600_000;
const MAX = TUNING.maxEnergy;

/** Catches that complete every challenge of a set, at the waters the goals name. */
export function completing(set: DailySet, tag = 'f'): DayCatch[] {
  const out: DayCatch[] = [];
  for (const c of set.challenges) {
    const g = c.goal;
    const loc = 'loc' in g && g.loc !== undefined ? g.loc : c.at;
    const pool = LOCATIONS[loc].pool.map(([id]) => id);
    const add = (speciesId: number, weight = SPECIES[speciesId].minWeight): void => void out.push({ id: `${tag}${out.length + 1}`, speciesId, weight, locationId: loc });
    if (g.kind === 'catch') for (let i = 0; i < g.count; i++) add(pool[0]);
    else if (g.kind === 'species') for (let i = 0; i < g.count; i++) add(g.speciesId);
    else if (g.kind === 'distinct') pool.slice(0, g.count).forEach((id) => add(id));
    else if (g.kind === 'rarity') for (let i = 0; i < g.count; i++) add(pool.find((id) => SPECIES[id].rarity >= g.min)!);
    else add(pool.find((id) => SPECIES[id].maxWeight >= g.grams)!, g.grams);
  }
  return out;
}

const ticket = (locationId: number): CastTicket => ({ locationId, totals: totals(RODS[0], null, LOCATIONS[locationId]) });

/** Lands, without casting, the fish that complete the save's day. */
function completeDay(s: Save, now: number): Save {
  const set = rollDaily(s.daily, now, LOCAL_PLAYER, profileOf(s)).set!;
  let out = s;
  completing(set).forEach((c, i) => (out = landFish(out, ticket(c.locationId), { speciesId: c.speciesId, weight: c.weight, isSpecial: false }, 'B', now + i).save));
  expect(setProgress(out.daily.set!, out.daily.catches).complete).toBe(true);
  return out;
}
const withEnergy = (s: Save, energy: number, at: number): Save => ({ ...s, energy, energyAt: at });
const failsWith = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof GameError) return e.message;
    throw e;
  }
  return '';
};

describe('what stands between a player and the reward', () => {
  const base: RewardFacts = { day: DAY, today: DAY, firstDay: DAY - 10, complete: true, claimed: false, energy: 10, max: 20 };

  it('is ready when the day is complete, unclaimed and there is room for all four', () => {
    expect(rewardStatus(base)).toEqual({ status: 'ready', spend: 0 });
    expect(rewardStatus({ ...base, energy: 16 })).toEqual({ status: 'ready', spend: 0 });
    expect(rewardStatus({ ...base, energy: 0 })).toEqual({ status: 'ready', spend: 0 });
  });

  it('is never given in part: over 16 energy it says how much to spend', () => {
    expect(rewardStatus({ ...base, energy: 17 })).toEqual({ status: 'full', spend: 1 });
    expect(rewardStatus({ ...base, energy: 18 })).toEqual({ status: 'full', spend: 2 });
    expect(rewardStatus({ ...base, energy: 20 })).toEqual({ status: 'full', spend: 4 });
  });

  it('needs all three challenges', () => {
    expect(rewardStatus({ ...base, complete: false }).status).toBe('incomplete');
    // not even with a full bar is an incomplete day "full"
    expect(rewardStatus({ ...base, complete: false, energy: 20 })).toEqual({ status: 'incomplete', spend: 0 });
  });

  it('is claimed once', () => {
    expect(rewardStatus({ ...base, claimed: true }).status).toBe('claimed');
    expect(rewardStatus({ ...base, claimed: true, energy: 20 }).status).toBe('claimed');
  });

  it('stays claimable on the next day and expires after it', () => {
    expect(CLAIM_DAYS).toBe(2);
    expect(rewardStatus({ ...base, today: DAY + 1 }).status).toBe('ready');
    expect(rewardStatus({ ...base, today: DAY + 2 }).status).toBe('expired');
    expect(rewardStatus({ ...base, today: DAY + 2, claimed: true }).status).toBe('expired');
    expect(claimEndMs(DAY)).toBe((DAY + 2) * DAY_MS);
  });

  it('does not exist before the first day, or while rewards are off', () => {
    expect(rewardStatus({ ...base, firstDay: 0 }).status).toBe('off');
    expect(rewardStatus({ ...base, firstDay: DAY + 1 }).status).toBe('off');
    expect(rewardStatus({ ...base, firstDay: DAY }).status).toBe('ready');
    // yesterday, completed, on the day rewards begin: before the first day, so nothing
    expect(rewardStatus({ ...base, day: DAY - 1, firstDay: DAY }).status).toBe('off');
  });

  it('a day that has not begun is not complete', () => {
    expect(rewardStatus({ ...base, day: DAY + 1 }).status).toBe('incomplete');
  });

  it('is four energy', () => {
    expect(REWARD_ENERGY).toBe(4);
    expect(REWARD_ENERGY).toBe(DAILY_REWARD.fullSet.amount);
  });
});

describe('the reward in the local game', () => {
  it('cannot be claimed before all three challenges are done', () => {
    let s = withEnergy(freshSave(NOON), 5, NOON);
    expect(dailyRewardCheck(s, DAY, NOON).status).toBe('incomplete');
    expect(failsWith(() => claimDailyReward(s, DAY, NOON))).toBe('Complete all three challenges first');
    // two of three is not three
    const set = rollDaily(s.daily, NOON, LOCAL_PLAYER, profileOf(s)).set!;
    const some = completing({ ...set, challenges: set.challenges.slice(0, 1) });
    some.forEach((c, i) => (s = landFish(s, ticket(c.locationId), { speciesId: c.speciesId, weight: c.weight, isSpecial: false }, 'B', NOON + i).save));
    s = withEnergy(s, 5, NOON);
    if (!setProgress(s.daily.set!, s.daily.catches).complete) {
      expect(failsWith(() => claimDailyReward(s, DAY, NOON + 10))).toBe('Complete all three challenges first');
      expect(energyNow(s, NOON + 10)).toBe(5);
    }
  });

  it('adds exactly four energy, once, and costs nothing', () => {
    const done = withEnergy(completeDay(freshSave(NOON), NOON), 9, NOON);
    expect(dailyRewardCheck(done, DAY, NOON + 1000)).toEqual({ status: 'ready', spend: 0 });
    const after = claimDailyReward(done, DAY, NOON + 1000);
    expect(energyNow(after, NOON + 1000)).toBe(13);
    expect(after.pearl).toBe(done.pearl);
    expect(after.xp).toBe(done.xp);
    expect(after.fish).toBe(done.fish);
    expect(after.daily.catches).toBe(done.daily.catches);
    expect(after.daily.set).toBe(done.daily.set);
    expect(after.daily.streak).toEqual(done.daily.streak);
    expect(streakOn(after.daily.streak, DAY)).toBe(1);
    expect(localClaimed(after.daily, DAY)).toBe(true);

    expect(dailyRewardCheck(after, DAY, NOON + 2000).status).toBe('claimed');
    expect(failsWith(() => claimDailyReward(after, DAY, NOON + 2000))).toBe('This reward is already claimed');
    expect(energyNow(after, NOON + 2000)).toBe(13);
  });

  it('never lifts energy over the bar, whatever the bar holds', () => {
    const done = completeDay(freshSave(NOON), NOON);
    for (let e = 0; e <= MAX; e++) {
      const s = withEnergy(done, e, NOON);
      if (e <= MAX - REWARD_ENERGY) {
        const after = claimDailyReward(s, DAY, NOON);
        expect(energyNow(after, NOON)).toBe(e + REWARD_ENERGY);
        expect(energyNow(after, NOON)).toBeLessThanOrEqual(MAX);
      } else {
        expect(failsWith(() => claimDailyReward(s, DAY, NOON))).toBe(`Spend ${e + REWARD_ENERGY - MAX} energy to claim your full +4 reward`);
      }
    }
  });

  it('with a bar too full it is refused whole, and waits until there is room', () => {
    let s = withEnergy(completeDay(freshSave(NOON), NOON), 18, NOON);
    expect(dailyRewardCheck(s, DAY, NOON)).toEqual({ status: 'full', spend: 2 });
    expect(failsWith(() => claimDailyReward(s, DAY, NOON))).toBe('Spend 2 energy to claim your full +4 reward');
    expect(localClaimed(s.daily, DAY)).toBe(false);
    // two casts at the pond (one energy each) make the room
    s = startCast(s, NOON + 1000).save;
    expect(dailyRewardCheck(s, DAY, NOON + 1000)).toEqual({ status: 'full', spend: 1 });
    s = startCast(s, NOON + 2000).save;
    expect(dailyRewardCheck(s, DAY, NOON + 2000)).toEqual({ status: 'ready', spend: 0 });
    s = claimDailyReward(s, DAY, NOON + 3000);
    expect(energyNow(s, NOON + 3000)).toBe(MAX);
  });

  it('counts regenerated energy against the room', () => {
    const period = TUNING.energyRegenSeconds * 1000;
    const s = withEnergy(completeDay(freshSave(NOON), NOON), 15, NOON);
    // three periods later the bar holds 18, although the save still says 15
    expect(dailyRewardCheck(s, DAY, NOON + 3 * period)).toEqual({ status: 'full', spend: 2 });
    expect(dailyRewardCheck(s, DAY, NOON + period)).toEqual({ status: 'ready', spend: 0 });
  });

  it('keeps the regeneration period that was running', () => {
    const period = TUNING.energyRegenSeconds * 1000;
    const s = withEnergy(completeDay(freshSave(NOON), NOON), 5, NOON);
    const at = NOON + Math.floor(period * 0.6);
    const left = energyCountdown(s, at);
    const after = claimDailyReward(s, DAY, at);
    expect(energyNow(after, at)).toBe(9);
    expect(energyCountdown(after, at)).toBe(left);
    // the next point arrives when it would have, for a save that claimed and for one that did not
    expect(energyNow(after, NOON + period - 1)).toBe(9);
    expect(energyNow(after, NOON + period)).toBe(10);
    expect(energyNow(s, NOON + period)).toBe(6);
  });

  it('survives a reload: a claimed reward stays claimed', () => {
    const claimed = claimDailyReward(withEnergy(completeDay(freshSave(NOON), NOON), 4, NOON), DAY, NOON);
    const again = loadSave(JSON.stringify(claimed), NOON + 5000);
    expect(again.status).toBe('ok');
    expect(localClaimed(again.save.daily, DAY)).toBe(true);
    expect(energyNow(again.save, NOON + 5000)).toBe(8);
    expect(failsWith(() => claimDailyReward(again.save, DAY, NOON + 5000))).toBe('This reward is already claimed');
    // and an unclaimed one stays claimable
    const open = loadSave(JSON.stringify(withEnergy(completeDay(freshSave(NOON), NOON), 4, NOON)), NOON + 5000).save;
    expect(dailyRewardCheck(open, DAY, NOON + 5000).status).toBe('ready');
  });

  it('yesterday stays claimable today, and is gone the day after', () => {
    const done = withEnergy(completeDay(freshSave(NOON), NOON), 3, NOON);
    // the day turns: the catches are dropped, the completed day is written down
    const next = NOON + DAY_MS;
    // (a day of regeneration has filled the bar: empty it again, the room is not what this is about)
    const rolled: Save = withEnergy({ ...done, daily: rollDaily(done.daily, next, LOCAL_PLAYER, profileOf(done)) }, 3, next);
    expect(rolled.daily.day).toBe(DAY + 1);
    expect(rolled.daily.catches).toEqual([]);
    expect(localEarned(rolled.daily, DAY)).toBe(true);
    expect(dailyRewardCheck(rolled, DAY, next).status).toBe('ready');
    expect(dailyRewardCheck(rolled, DAY + 1, next).status).toBe('incomplete');

    const claimed = claimDailyReward(rolled, DAY, next);
    expect(energyNow(claimed, next)).toBe(7);
    expect(failsWith(() => claimDailyReward(claimed, DAY, next))).toBe('This reward is already claimed');

    // unclaimed, two days on: expired, and the book forgets it
    const later = NOON + 2 * DAY_MS;
    const late: Save = withEnergy({ ...rolled, daily: rollDaily(rolled.daily, later, LOCAL_PLAYER, profileOf(rolled)) }, 3, later);
    expect(dailyRewardCheck(late, DAY, later).status).toBe('expired');
    expect(failsWith(() => claimDailyReward(late, DAY, later))).toBe('That reward has expired');
    expect(localRewards(late.daily, DAY + 2).earned).toEqual([]);
  });

  it('each day pays once: yesterday and today are two rewards', () => {
    let s = withEnergy(completeDay(freshSave(NOON), NOON), 0, NOON);
    const next = NOON + DAY_MS;
    s = { ...s, daily: rollDaily(s.daily, next, LOCAL_PLAYER, profileOf(s)) };
    s = withEnergy(completeDay(s, next), 0, next);
    expect(dailyRewardCheck(s, DAY, next).status).toBe('ready');
    expect(dailyRewardCheck(s, DAY + 1, next).status).toBe('ready');
    s = claimDailyReward(s, DAY, next);
    s = claimDailyReward(s, DAY + 1, next);
    expect(energyNow(s, next)).toBe(8);
    expect(failsWith(() => claimDailyReward(s, DAY, next))).toBe('This reward is already claimed');
    expect(failsWith(() => claimDailyReward(s, DAY + 1, next))).toBe('This reward is already claimed');
  });

  it('a day closed while the game was shut is still written down when it opens again', () => {
    const done = withEnergy(completeDay(freshSave(NOON), NOON), 2, NOON);
    // stored, then opened the next evening
    const now = NOON + DAY_MS + 3_600_000;
    const opened = withEnergy(loadSave(JSON.stringify(done), now).save, 2, now);
    expect(dailyRewardCheck(opened, DAY, now).status).toBe('ready');
    const rolled: Save = { ...opened, daily: rollDaily(opened.daily, now, LOCAL_PLAYER, profileOf(opened)) };
    expect(dailyRewardCheck(rolled, DAY, now).status).toBe('ready');
  });

  it('pays nothing for days before the rewards began', () => {
    const early = (DAILY_REWARD.localFirstDay - 1) * DAY_MS + 3_600_000;
    const done = withEnergy(completeDay(freshSave(early), early), 2, early);
    expect(dailyRewardCheck(done, DAILY_REWARD.localFirstDay - 1, early).status).toBe('off');
    expect(failsWith(() => claimDailyReward(done, DAILY_REWARD.localFirstDay - 1, early))).toBe('There is no reward for that day');
    // nor on the first day, for the day before it
    const first = early + DAY_MS;
    const rolled: Save = { ...done, daily: rollDaily(done.daily, first, LOCAL_PLAYER, profileOf(done)) };
    expect(dailyRewardCheck(rolled, DAILY_REWARD.localFirstDay - 1, first).status).toBe('off');
    expect(localRewards(rolled.daily, DAILY_REWARD.localFirstDay).earned).toEqual([]);
  });

  it('a save from before the reward existed loads, and can claim today', () => {
    const done = withEnergy(completeDay(freshSave(NOON), NOON), 6, NOON);
    const old = JSON.parse(JSON.stringify(done)) as { daily: Record<string, unknown> };
    delete old.daily.rewards;
    const loaded = loadSave(JSON.stringify(old), NOON + 1000);
    expect(loaded.status).toBe('ok');
    expect(loaded.save.pearl).toBe(done.pearl);
    expect(loaded.save.xp).toBe(done.xp);
    expect(loaded.save.fish).toEqual(done.fish);
    expect(loaded.save.daily.streak).toEqual(done.daily.streak);
    expect(loaded.save.daily.catches).toEqual(done.daily.catches);
    expect(dailyRewardCheck(loaded.save, DAY, NOON + 1000).status).toBe('ready');
    expect(energyNow(claimDailyReward(loaded.save, DAY, NOON + 1000), NOON + 1000)).toBe(10);
  });

  it('a hand-edited reward book cannot invent a completed day', () => {
    const s = withEnergy(freshSave(NOON), 2, NOON);
    // "earned" for a day far in the future, and garbage
    const forged: Save = { ...s, daily: { ...rollDaily(s.daily, NOON, LOCAL_PLAYER, profileOf(s)), rewards: { earned: [DAY + 40, -1, 1.5, 'x' as unknown as number], claimed: [] } } };
    expect(dailyRewardCheck(forged, DAY + 40, NOON).status).toBe('incomplete');
    expect(localRewards(forged.daily, DAY)).toEqual({ earned: [], claimed: [] });
  });

  it('the same day and player always get the same three challenges', () => {
    const p = profileOf(freshSave(NOON));
    expect(generateDaily(DAY, LOCAL_PLAYER, p)).toEqual(generateDaily(DAY, LOCAL_PLAYER, p));
    expect(generateDaily(DAY, '0xAbC', p)).toEqual(generateDaily(DAY, '0xabc', p));
    expect(generateDaily(DAY, LOCAL_PLAYER, p).version).toBe(DAILY.version);
  });
});

describe('the signed authorization', () => {
  it('hashes and signs exactly as the contract does (vectors written by contracts/test/DailyRewards.t.sol)', async () => {
    expect(vectors.length).toBeGreaterThan(3);
    for (const v of vectors) {
      const data = rewardTypedData(v.chainId, v.contract as `0x${string}`, { player: v.player as `0x${string}`, day: v.day, rules: v.rules, amount: v.amount, deadline: v.deadline });
      expect(hashTypedData(data)).toBe(v.digest);
      // the fixture's key is a test constant of the Solidity test, not a real one
      const account = privateKeyToAccount(v.key as `0x${string}`);
      expect(account.address).toBe(v.signer);
      expect(await account.signTypedData(data)).toBe(v.signature);
      expect(await recoverTypedDataAddress({ ...data, signature: v.signature as `0x${string}` })).toBe(v.signer);
    }
  });

  it('is bound to its chain, its contract, its player, its day and its terms', () => {
    const v = vectors[0];
    const terms = { player: v.player as `0x${string}`, day: v.day, rules: v.rules, amount: v.amount, deadline: v.deadline };
    const base = hashTypedData(rewardTypedData(v.chainId, v.contract as `0x${string}`, terms));
    const other = '0x00000000000000000000000000000000000000bb' as const;
    const variants = [
      rewardTypedData(v.chainId + 1, v.contract as `0x${string}`, terms),
      rewardTypedData(v.chainId, other, terms),
      rewardTypedData(v.chainId, v.contract as `0x${string}`, { ...terms, player: other }),
      rewardTypedData(v.chainId, v.contract as `0x${string}`, { ...terms, day: terms.day + 1 }),
      rewardTypedData(v.chainId, v.contract as `0x${string}`, { ...terms, rules: terms.rules + 1 }),
      rewardTypedData(v.chainId, v.contract as `0x${string}`, { ...terms, amount: 5 }),
      rewardTypedData(v.chainId, v.contract as `0x${string}`, { ...terms, deadline: terms.deadline + 1 }),
    ].map((d) => hashTypedData(d));
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it('a page only sends an authorization that is for exactly its claim', () => {
    const v = vectors[0];
    const a: RewardAuthorization = { player: v.player as `0x${string}`, day: v.day, rules: v.rules, amount: v.amount, deadline: v.deadline, chainId: v.chainId, contract: v.contract as `0x${string}`, signer: v.signer as `0x${string}`, signature: v.signature as `0x${string}` };
    const want = { chainId: v.chainId, contract: v.contract.toLowerCase(), player: v.player.toLowerCase(), day: v.day };
    const now = v.deadline - 100;
    expect(authorizationFits(a, want, now)).toBe(true);
    expect(authorizationFits(a, want, v.deadline)).toBe(false);
    expect(authorizationFits(a, { ...want, chainId: 1 }, now)).toBe(false);
    expect(authorizationFits(a, { ...want, contract: '0x00000000000000000000000000000000000000bb' }, now)).toBe(false);
    expect(authorizationFits(a, { ...want, player: '0x00000000000000000000000000000000000000bb' }, now)).toBe(false);
    expect(authorizationFits(a, { ...want, day: v.day + 1 }, now)).toBe(false);
    expect(authorizationFits({ ...a, amount: 20 }, want, now)).toBe(false);
    expect(authorizationFits({ ...a, signature: '0x1234' }, want, now)).toBe(false);
  });
});

describe('asking the verifier, from the page', () => {
  const v = vectors[0];
  const good: RewardAuthorization = { player: v.player as `0x${string}`, day: v.day, rules: v.rules, amount: v.amount, deadline: v.deadline, chainId: v.chainId, contract: v.contract as `0x${string}`, signer: v.signer as `0x${string}`, signature: v.signature as `0x${string}` };
  const want = { chainId: v.chainId, contract: v.contract, player: v.player, day: v.day };
  const now = (): number => v.deadline - 100;
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const answering = (res: () => Response | Promise<Response>) => {
    const sent: { url: string; body: unknown }[] = [];
    const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return res();
    };
    return { sent, fetcher };
  };

  it('sends the account and the day, and nothing the page believes about the catches', async () => {
    const { sent, fetcher } = answering(() => json({ authorization: good }));
    const a = await askVerifier(fetcher, '/api/daily-reward', want, now);
    expect(a).toEqual({ ok: true, authorization: good });
    expect(sent).toEqual([{ url: '/api/daily-reward', body: { player: v.player, day: v.day } }]);
  });

  it('refuses an answer that is for another claim, before any wallet sees it', async () => {
    const wrong: Partial<RewardAuthorization>[] = [
      { player: '0x00000000000000000000000000000000000000bb' },
      { day: v.day + 1 },
      { amount: 20 },
      { chainId: 1 },
      { contract: '0x00000000000000000000000000000000000000bb' },
      { deadline: v.deadline - 200 },
      { signature: '0x' },
    ];
    for (const w of wrong) {
      const a = await askVerifier(answering(() => json({ authorization: { ...good, ...w } })).fetcher, '/x', want, now);
      expect(a.ok, JSON.stringify(w)).toBe(false);
    }
    // and things that are not authorizations at all
    for (const body of [{ authorization: 'yes' }, { authorization: {} }, { authorization: { ...good, contract: 5 } }, [], null, 'ok']) {
      expect((await askVerifier(answering(() => json(body)).fetcher, '/x', want, now)).ok, JSON.stringify(body)).toBe(false);
    }
  });

  it('passes on the verifier\u2019s refusal as it was given', async () => {
    const a = await askVerifier(answering(() => json({ error: { code: 'incomplete', message: 'Not all three challenges are done yet.' } }, 422)).fetcher, '/x', want, now);
    expect(a).toEqual({ ok: false, code: 'incomplete', message: 'Not all three challenges are done yet.' });
    // an authorization that comes with a failure status is not one
    expect((await askVerifier(answering(() => json({ authorization: good }, 500)).fetcher, '/x', want, now)).ok).toBe(false);
  });

  it('a service that is down, slow, limited or not there is a failure, never a claim', async () => {
    const down = await askVerifier(() => Promise.reject(new TypeError('Failed to fetch')), '/x', want, now);
    expect(down).toMatchObject({ ok: false, code: 'service' });
    // the dev server answers every path with the page itself
    const page = await askVerifier(answering(() => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })).fetcher, '/x', want, now);
    expect(page).toMatchObject({ ok: false, code: 'service' });
    const limited = await askVerifier(answering(() => new Response('', { status: 429 })).fetcher, '/x', want, now);
    expect(limited).toMatchObject({ ok: false, message: 'Too many requests. Wait a minute and try again.' });
    const gateway = await askVerifier(answering(() => new Response('Bad gateway', { status: 502 })).fetcher, '/x', want, now);
    expect(gateway).toMatchObject({ ok: false, code: 'service' });
  });
});

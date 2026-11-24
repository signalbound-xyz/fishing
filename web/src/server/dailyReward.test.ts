import { describe, expect, it } from 'vitest';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LOCATIONS, SPECIES } from '../game/content';
import { DAILY, generateDaily, setProgress, type DailySet, type DayCatch } from '../game/daily';
import { DAY_SECONDS } from '../game/dailyLog';
import { REWARD_ENERGY, rewardTypedData } from '../game/dailyReward';
import { authorize, checkDay, parseRequest, profileFromBits, rateLimiter, type ChainFacts, type PlayerEvent, type Verifier } from './dailyReward';
import { createHandler, verifierFrom } from './http';

type Address = `0x${string}`;

const DAY = 20_790;
const ME = '0x00000000000000000000000000000000000000aa' as Address;
const OTHER = '0x00000000000000000000000000000000000000bb' as Address;
const CONTRACT = '0x00000000000000000000000000000000000000cc' as Address;
/** A test key: it signs nothing outside this file. */
const KEY = '0x8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63' as const;
const account = privateKeyToAccount(KEY);

/** A chain with one block a second. Block GENESIS was mined a little before the day begins. */
const GENESIS = 1_000n;
const T0 = DAY * DAY_SECONDS - 5_000;
const blockAt = (ts: number): bigint => GENESIS + BigInt(ts - T0);
const DAY_FIRST = blockAt(DAY * DAY_SECONDS);
const NEXT_FIRST = blockAt((DAY + 1) * DAY_SECONDS);

/** Catches that complete every challenge of a set, at the waters the goals name. */
function completing(set: DailySet, tag = 'f'): DayCatch[] {
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
const caught = (block: bigint, fish: DayCatch, removed = false): PlayerEvent => ({ block, removed, kind: 'catch', fish });

/** A fake chain and a verifier on top of it. Everything it is asked is counted. */
function world(opts: { head?: bigint; unlocks?: number; rods?: number; confirmations?: bigint } = {}) {
  const st = {
    head: opts.head ?? DAY_FIRST + 40_000n,
    events: new Map<string, PlayerEvent[]>(),
    unlocks: opts.unlocks ?? 0,
    rods: opts.rods ?? 0,
    firstDay: DAY - 5,
    claimed: new Set<string>(),
    signerAccepted: true,
    broken: null as null | 'head' | 'events' | 'player' | 'rewards' | 'timestamp',
    /** Seconds the server's clock is ahead of the chain's. */
    skew: 0,
    signed: 0,
    asked: { events: [] as [bigint, bigint][], player: [] as bigint[] },
    /** What `events` hands back besides the truth: a node that repeats itself or answers out of range. */
    extra: [] as PlayerEvent[],
  };
  const ts = (b: bigint): number => T0 + Number(b - GENESIS);
  const down = (what: typeof st.broken): void => {
    if (st.broken === what) throw new Error(`rpc down: ${what}`);
  };
  const chain: ChainFacts = {
    async head() {
      down('head');
      return { number: st.head, timestamp: ts(st.head) };
    },
    async timestamp(b) {
      down('timestamp');
      if (b > st.head) throw new Error('block not there yet');
      return ts(b);
    },
    async events(player, from, to) {
      down('events');
      if (to > st.head) throw new Error('range past the head');
      if (to - from + 1n > 100_000n) throw new Error('query exceeds max block range');
      st.asked.events.push([from, to]);
      return [...(st.events.get(player.toLowerCase()) ?? []).filter((e) => e.block >= from && e.block <= to), ...st.extra];
    },
    async player(_player, block) {
      down('player');
      st.asked.player.push(block);
      return { unlocks: st.unlocks, rods: st.rods };
    },
    async rewards(player, day, signer) {
      down('rewards');
      return { firstDay: st.firstDay, claimed: st.claimed.has(`${player.toLowerCase()}:${day}`), signerAccepted: st.signerAccepted && signer === account.address };
    },
  };
  const v: Verifier = {
    config: { chainId: 20994, contract: CONTRACT, signer: account.address, confirmations: opts.confirmations ?? 5n, ttlSeconds: 600, startBlock: GENESIS, maxClockSkew: 120 },
    chain,
    sign: async (data) => {
      st.signed++;
      return account.signTypedData(data);
    },
    now: () => (ts(st.head) + st.skew) * 1000,
    dayBlocks: new Map(),
  };
  const put = (player: Address, events: PlayerEvent[]): void => void st.events.set(player.toLowerCase(), [...(st.events.get(player.toLowerCase()) ?? []), ...events]);
  /** The set the player's interface shows for `day`, from the profile the day began with. */
  const setFor = (player: Address, day = DAY, unlocks = st.unlocks, rods = st.rods): DailySet => generateDaily(day, player, profileFromBits(unlocks, rods));
  /** Lands, early in the day, everything that completes it. */
  const complete = (player: Address, day = DAY, at = blockAt(day * DAY_SECONDS) + 100n): DayCatch[] => {
    const fish = completing(setFor(player, day), `${player.slice(-2)}-${day}-`);
    put(
      player,
      fish.map((f, i) => caught(at + BigInt(i * 10), f)),
    );
    return fish;
  };
  return { st, v, ts, put, setFor, complete };
}

describe('a request', () => {
  it('is a player and a day, and nothing else is read', () => {
    expect(parseRequest({ player: ME, day: DAY })).toEqual({ player: ME, day: DAY });
    expect(parseRequest({ player: ME.toUpperCase().replace('0X', '0x'), day: DAY })).toEqual({ player: ME, day: DAY });
    expect(parseRequest({ player: ME, day: DAY, catches: [{ id: '1' }], complete: true, progress: { done: 3 }, amount: 20 })).toEqual({ player: ME, day: DAY });
  });

  it('is refused when it is not that', async () => {
    for (const bad of [null, 'x', 5, [], {}, { player: ME }, { day: DAY }, { player: '0x12', day: DAY }, { player: ME, day: '20790' }, { player: ME, day: 1.5 }, { player: ME, day: -1 }, { player: ME, day: 1e9 }]) {
      expect(parseRequest(bad)).toBeNull();
      const w = world();
      const r = await authorize(w.v, bad);
      expect(r).toMatchObject({ ok: false, code: 'bad_request', status: 400 });
      expect(w.st.signed).toBe(0);
    }
  });
});

describe('a completed day', () => {
  it('is authorized: four energy, for this player, this day, this contract and this chain', async () => {
    const w = world();
    w.complete(ME);
    const r = await authorize(w.v, { player: ME, day: DAY });
    if (!r.ok) throw new Error(r.message);
    const a = r.authorization;
    expect(a).toMatchObject({ player: ME, day: DAY, rules: DAILY.version, amount: 4, chainId: 20994, contract: CONTRACT, signer: account.address });
    expect(a.amount).toBe(REWARD_ENERGY);
    const now = Math.floor(w.v.now() / 1000);
    expect(a.deadline).toBe(now + 600);
    const signer = await recoverTypedDataAddress({ ...rewardTypedData(20994, CONTRACT, a), signature: a.signature });
    expect(signer).toBe(account.address);
    expect(w.st.signed).toBe(1);
  });

  it('is checked against the same three challenges the interface draws', async () => {
    const w = world({ unlocks: 0b10, rods: 0b100 });
    const check = await checkDay(w.v, ME, DAY, { number: w.st.head - 5n, timestamp: w.ts(w.st.head - 5n) });
    expect(check.set).toEqual(generateDaily(DAY, ME, profileFromBits(0b10, 0b100)));
    // drawn again, it is the same set: generation is deterministic
    expect((await checkDay(w.v, ME, DAY, { number: w.st.head - 5n, timestamp: w.ts(w.st.head - 5n) })).set).toEqual(check.set);
    expect(check.complete).toBe(false);
  });

  it('is authorized on the next day too, with a deadline that ends with the claim window', async () => {
    const w = world();
    w.complete(ME);
    // late on the next day: ten minutes would run past its end
    w.st.head = blockAt((DAY + 2) * DAY_SECONDS) - 200n;
    const r = await authorize(w.v, { player: ME, day: DAY });
    if (!r.ok) throw new Error(r.message);
    expect(r.authorization.deadline).toBe((DAY + 2) * DAY_SECONDS - 1);
    // the day's own catches were read, not the next day's
    expect(w.st.asked.events[0][0]).toBe(DAY_FIRST);
  });

  it('reads a long range in pieces the node accepts', async () => {
    const w = world();
    w.complete(ME);
    w.st.head = blockAt((DAY + 2) * DAY_SECONDS) - 200n;
    const r = await authorize(w.v, { player: ME, day: DAY });
    expect(r.ok).toBe(true);
    expect(w.st.asked.events.length).toBeGreaterThan(2);
    for (const [from, to] of w.st.asked.events) expect(to - from + 1n).toBeLessThanOrEqual(50_000n);
  });
});

describe('a day that is not complete', () => {
  it('is refused, with how far the chain has it', async () => {
    const w = world();
    const r = await authorize(w.v, { player: ME, day: DAY });
    expect(r).toMatchObject({ ok: false, code: 'incomplete', status: 422, progress: { done: 0, of: 3 } });
    expect(w.st.signed).toBe(0);
  });

  it('two of three is not three', async () => {
    const w = world();
    const set = w.setFor(ME);
    const fish = completing({ ...set, challenges: set.challenges.slice(0, 2) });
    w.put(
      ME,
      fish.map((f, i) => caught(DAY_FIRST + 50n + BigInt(i), f)),
    );
    const done = setProgress(set, fish).done;
    const r = await authorize(w.v, { player: ME, day: DAY });
    if (done < 3) {
      expect(r).toMatchObject({ ok: false, code: 'incomplete', progress: { done, of: 3 } });
      expect(w.st.signed).toBe(0);
    }
  });

  it('what the request claims about catches changes nothing', async () => {
    const w = world();
    const forged = { player: ME, day: DAY, catches: completing(w.setFor(ME)), complete: true, done: 3, progress: { done: 3, of: 3 }, authorization: { amount: 4 } };
    const r = await authorize(w.v, forged);
    expect(r).toMatchObject({ ok: false, code: 'incomplete', progress: { done: 0, of: 3 } });
    expect(w.st.signed).toBe(0);
  });

  it('somebody else’s catches do not count', async () => {
    const w = world();
    w.complete(OTHER);
    // even if the node hands them back for this player's query, they would be this player's only by their topic;
    // the fake keys events by player, as the indexed topic does
    expect(await authorize(w.v, { player: ME, day: DAY })).toMatchObject({ ok: false, code: 'incomplete' });
    expect((await authorize(w.v, { player: OTHER, day: DAY })).ok).toBe(true);
  });

  it('catches of the day before and the day after do not count', async () => {
    const w = world();
    const fish = completing(w.setFor(ME));
    w.put(ME, [...fish.map((f, i) => caught(DAY_FIRST - 1n - BigInt(i), { ...f, id: `y${i}` })), ...fish.map((f, i) => caught(NEXT_FIRST + BigInt(i), { ...f, id: `t${i}` }))]);
    w.st.head = NEXT_FIRST + 5_000n;
    expect(await authorize(w.v, { player: ME, day: DAY })).toMatchObject({ ok: false, code: 'incomplete', progress: { done: 0, of: 3 } });
    // the last block of the day does count
    w.put(
      ME,
      fish.map((f) => caught(NEXT_FIRST - 1n, f)),
    );
    expect((await authorize(w.v, { player: ME, day: DAY })).ok).toBe(true);
  });

  it('a fish counts once, however often the node repeats it', async () => {
    const w = world();
    const set = w.setFor(ME);
    const many = set.challenges.find((c) => c.goal.kind === 'catch' && c.goal.count > 1);
    expect(many, 'this day has a "catch N fish" goal').toBeTruthy();
    const one = completing({ ...set, challenges: [many!] })[0];
    // the same fish id, at the same block and at others
    w.put(ME, [caught(DAY_FIRST + 10n, one), caught(DAY_FIRST + 10n, one), caught(DAY_FIRST + 11n, one), caught(DAY_FIRST + 12n, one), caught(DAY_FIRST + 13n, one)]);
    w.st.extra = [caught(DAY_FIRST + 10n, one)];
    const check = await checkDay(w.v, ME, DAY, { number: w.st.head - 5n, timestamp: w.ts(w.st.head - 5n) });
    expect(check.catches).toHaveLength(1);
    expect(check.complete).toBe(false);
  });

  it('a log the chain took back, or one outside the range asked for, is ignored', async () => {
    const w = world();
    const fish = completing(w.setFor(ME));
    w.put(
      ME,
      fish.map((f, i) => caught(DAY_FIRST + 20n + BigInt(i), f, true)),
    );
    expect(await authorize(w.v, { player: ME, day: DAY })).toMatchObject({ ok: false, code: 'incomplete', progress: { done: 0, of: 3 } });
    // a node answering with events from before the day
    const w2 = world();
    w2.st.extra = fish.map((f, i) => caught(DAY_FIRST - 100n - BigInt(i), f));
    expect(await authorize(w2.v, { player: ME, day: DAY })).toMatchObject({ ok: false, code: 'incomplete' });
    expect(w.st.signed + w2.st.signed).toBe(0);
  });
});

describe('blocks that are not confirmed yet', () => {
  it('do not count until they are deep enough', async () => {
    const w = world({ confirmations: 5n });
    const fish = completing(w.setFor(ME));
    // everything but the last fish early, the last one three blocks under the head
    w.put(
      ME,
      fish.slice(0, -1).map((f, i) => caught(DAY_FIRST + 30n + BigInt(i), f)),
    );
    w.put(ME, [caught(w.st.head - 3n, fish[fish.length - 1])]);
    expect(await authorize(w.v, { player: ME, day: DAY })).toMatchObject({ ok: false, code: 'incomplete' });
    expect(w.st.signed).toBe(0);
    // two blocks later it is five deep
    w.st.head += 2n;
    expect((await authorize(w.v, { player: ME, day: DAY })).ok).toBe(true);
  });

  it('the player is read at the same confirmed block as the events', async () => {
    const w = world({ confirmations: 7n });
    w.complete(ME);
    await authorize(w.v, { player: ME, day: DAY });
    expect(w.st.asked.player).toEqual([w.st.head - 7n]);
    expect(w.st.asked.events.at(-1)![1]).toBe(w.st.head - 7n);
  });

  it('a catch that a reorganization removed stops counting', async () => {
    const w = world();
    const fish = w.complete(ME);
    expect((await checkDay(w.v, ME, DAY, { number: w.st.head - 5n, timestamp: w.ts(w.st.head - 5n) })).complete).toBe(true);
    // the same day read again after the chain dropped the block with the last fish
    w.st.events.set(ME, w.st.events.get(ME)!.filter((e) => e.kind !== 'catch' || e.fish.id !== fish[fish.length - 1].id));
    const again = await checkDay(w.v, ME, DAY, { number: w.st.head - 5n, timestamp: w.ts(w.st.head - 5n) });
    expect(again.catches).toHaveLength(fish.length - 1);
  });
});

describe('what the player had when the day began', () => {
  it('a water opened during the day does not change the day’s challenges', async () => {
    // the player has the second water now, and the chain says it was unlocked today
    const w = world({ unlocks: 0b10 });
    w.put(ME, [{ block: DAY_FIRST + 500n, removed: false, kind: 'unlock', locationId: 1 }]);
    const check = await checkDay(w.v, ME, DAY, { number: w.st.head - 5n, timestamp: w.ts(w.st.head - 5n) });
    expect(check.set).toEqual(generateDaily(DAY, ME, profileFromBits(0, 0)));
    // completing the set of the morning's profile is what is authorized
    const fish = completing(generateDaily(DAY, ME, profileFromBits(0, 0)));
    w.put(
      ME,
      fish.map((f, i) => caught(DAY_FIRST + 600n + BigInt(i), f)),
    );
    expect((await authorize(w.v, { player: ME, day: DAY })).ok).toBe(true);
  });

  it('a rod bought during the day does not either, nor one bought the day after', async () => {
    const w = world({ rods: 0b1100 });
    // rod 2 was bought today, rod 3 tomorrow; the claim is made tomorrow
    w.put(ME, [
      { block: DAY_FIRST + 900n, removed: false, kind: 'rod', rod: 2 },
      { block: NEXT_FIRST + 900n, removed: false, kind: 'rod', rod: 3 },
    ]);
    w.st.head = NEXT_FIRST + 5_000n;
    const check = await checkDay(w.v, ME, DAY, { number: w.st.head - 5n, timestamp: w.ts(w.st.head - 5n) });
    expect(check.set).toEqual(generateDaily(DAY, ME, profileFromBits(0, 0)));
    // while a rod owned since before the day is part of the profile
    const w2 = world({ rods: 0b100 });
    const c2 = await checkDay(w2.v, ME, DAY, { number: w2.st.head - 5n, timestamp: w2.ts(w2.st.head - 5n) });
    expect(c2.set).toEqual(generateDaily(DAY, ME, profileFromBits(0, 0b100)));
  });

  it('the starter rod and the starting waters are always there', () => {
    const p = profileFromBits(0, 0);
    expect(p.rods).toHaveLength(1);
    expect(p.unlocked).toEqual(LOCATIONS.filter((l) => l.unlock.type === 'start').map((l) => l.id));
  });
});

describe('when there is nothing to authorize', () => {
  it('already claimed', async () => {
    const w = world();
    w.complete(ME);
    w.st.claimed.add(`${ME}:${DAY}`);
    expect(await authorize(w.v, { player: ME, day: DAY })).toMatchObject({ ok: false, code: 'already_claimed', status: 409 });
    expect(w.st.signed).toBe(0);
  });

  it('rewards are off, or the day is before the first one that pays', async () => {
    const w = world();
    w.complete(ME);
    w.st.firstDay = 0;
    expect(await authorize(w.v, { player: ME, day: DAY })).toMatchObject({ ok: false, code: 'not_active' });
    w.st.firstDay = DAY + 1;
    expect(await authorize(w.v, { player: ME, day: DAY })).toMatchObject({ ok: false, code: 'not_active' });
    expect(w.st.signed).toBe(0);
    w.st.firstDay = DAY;
    expect((await authorize(w.v, { player: ME, day: DAY })).ok).toBe(true);
  });

  it('its own key is no longer accepted by the contract', async () => {
    const w = world();
    w.complete(ME);
    w.st.signerAccepted = false;
    expect(await authorize(w.v, { player: ME, day: DAY })).toMatchObject({ ok: false, code: 'signer_not_accepted', status: 503 });
    expect(w.st.signed).toBe(0);
  });

  it('the day is over and so is the day after it', async () => {
    const w = world();
    w.complete(ME);
    w.st.head = blockAt((DAY + 2) * DAY_SECONDS) + 10n;
    expect(await authorize(w.v, { player: ME, day: DAY })).toMatchObject({ ok: false, code: 'day_expired', status: 410 });
    expect(w.st.signed).toBe(0);
  });

  it('the day has not begun', async () => {
    const w = world();
    expect(await authorize(w.v, { player: ME, day: DAY + 1 })).toMatchObject({ ok: false, code: 'day_not_started' });
    expect(await authorize(w.v, { player: ME, day: DAY + 400 })).toMatchObject({ ok: false, code: 'day_not_started' });
  });
});

describe('when the chain cannot be trusted', () => {
  it('any read that fails is a refusal, never a signature', async () => {
    for (const what of ['head', 'events', 'player', 'rewards', 'timestamp'] as const) {
      const w = world();
      w.complete(ME);
      w.st.broken = what;
      const r = await authorize(w.v, { player: ME, day: DAY });
      expect(r, what).toMatchObject({ ok: false, code: 'chain_unavailable', status: 503 });
      expect(w.st.signed, what).toBe(0);
      // and it works again when the node does
      w.st.broken = null;
      expect((await authorize(w.v, { player: ME, day: DAY })).ok, what).toBe(true);
    }
  });

  it('a node whose clock is far from the server’s is not believed', async () => {
    const w = world();
    w.complete(ME);
    w.st.skew = 3_600;
    expect(await authorize(w.v, { player: ME, day: DAY })).toMatchObject({ ok: false, code: 'chain_unavailable' });
    w.st.skew = -3_600;
    expect(await authorize(w.v, { player: ME, day: DAY })).toMatchObject({ ok: false, code: 'chain_unavailable' });
    expect(w.st.signed).toBe(0);
    w.st.skew = 30;
    expect((await authorize(w.v, { player: ME, day: DAY })).ok).toBe(true);
  });

  it('a failing signer is a refusal too', async () => {
    const w = world();
    w.complete(ME);
    w.v.sign = async () => {
      throw new Error('kms down');
    };
    expect(await authorize(w.v, { player: ME, day: DAY })).toMatchObject({ ok: false, code: 'chain_unavailable' });
  });
});

describe('the endpoint', () => {
  const post = (body: unknown, headers: Record<string, string> = {}): Request => new Request('https://game.test/api/daily-reward', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
  const read = async (r: Response): Promise<{ status: number; body: { authorization?: { signature: string; player: string }; error?: { code: string; message: string; progress?: unknown } } }> => ({ status: r.status, body: (await r.json()) as never });

  it('answers a completed day with the authorization, and an incomplete one with the reason', async () => {
    const w = world();
    w.complete(ME);
    const handle = createHandler(() => w.v, { now: () => w.v.now() });
    const ok = await read(await handle(post({ player: ME, day: DAY })));
    expect(ok.status).toBe(200);
    expect(ok.body.authorization).toMatchObject({ player: ME, day: DAY, amount: 4 });
    const no = await read(await handle(post({ player: OTHER, day: DAY })));
    expect(no.status).toBe(422);
    expect(no.body.error).toMatchObject({ code: 'incomplete', progress: { done: 0, of: 3 } });
  });

  it('never tells its key, in an answer or in an error', async () => {
    const w = world();
    w.complete(ME);
    const handle = createHandler(() => w.v, { now: () => w.v.now() });
    for (const body of [{ player: ME, day: DAY }, { player: OTHER, day: DAY }, 'garbage', { player: ME, day: DAY + 1 }]) {
      const text = await (await handle(post(body))).text();
      expect(text.toLowerCase()).not.toContain(KEY.slice(2, 34));
      expect(text.toLowerCase()).not.toContain(KEY.slice(34));
    }
  });

  it('refuses anything but a POST of a small JSON body', async () => {
    const w = world();
    const handle = createHandler(() => w.v, { now: () => w.v.now() });
    expect((await handle(new Request('https://game.test/api/daily-reward'))).status).toBe(405);
    expect((await read(await handle(post('not json')))).body.error?.code).toBe('bad_request');
    expect((await handle(post({ player: ME, day: DAY, pad: 'x'.repeat(2_000) }))).status).toBe(400);
    expect((await handle(post({ player: ME }))).status).toBe(400);
    expect(w.st.signed).toBe(0);
  });

  it('says so when it is not configured, and signs nothing', async () => {
    const handle = createHandler(() => null);
    const r = await read(await handle(post({ player: ME, day: DAY })));
    expect(r.status).toBe(503);
    expect(r.body.error?.code).toBe('not_configured');
  });

  it('asks the chain once for a burst of the same question', async () => {
    const w = world();
    w.complete(ME);
    const handle = createHandler(() => w.v, { now: () => w.v.now() });
    const answers = await Promise.all(Array.from({ length: 8 }, () => handle(post({ player: ME, day: DAY }))));
    expect(answers.every((a) => a.status === 200)).toBe(true);
    expect(w.st.signed).toBe(1);
    expect(w.st.asked.player).toHaveLength(1);
    // and again shortly after: the answer is repeated
    expect((await handle(post({ player: ME, day: DAY }))).status).toBe(200);
    expect(w.st.signed).toBe(1);
  });

  it('does not repeat an answer that came from a failed read', async () => {
    const w = world();
    w.complete(ME);
    const handle = createHandler(() => w.v, { now: () => w.v.now() });
    w.st.broken = 'events';
    expect((await handle(post({ player: ME, day: DAY }))).status).toBe(503);
    w.st.broken = null;
    expect((await handle(post({ player: ME, day: DAY }))).status).toBe(200);
  });

  it('limits how often one client and one account may ask', async () => {
    const w = world();
    let t = 1_000_000;
    const handle = createHandler(() => w.v, { now: () => t, perClient: 5, perPlayer: 3, cacheMs: 0 });
    const from = (ip: string, player: Address): Promise<Response> => handle(post({ player, day: DAY }, { 'x-forwarded-for': `${ip}, 10.0.0.1` }));
    // one account, asked from many addresses
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await from(`1.1.1.${i}`, ME)).status);
    expect(statuses).toEqual([422, 422, 422, 429, 429]);
    // one address, asking about many accounts
    const many: number[] = [];
    for (let i = 0; i < 7; i++) many.push((await from('2.2.2.2', `0x${(i + 1).toString(16).padStart(40, '0')}` as Address)).status);
    expect(many.filter((s) => s === 429)).toHaveLength(2);
    // a minute later both may ask again
    t += 61_000;
    expect((await from('2.2.2.2', ME)).status).toBe(422);
  });

  it('answers a browser on another origin only when that origin is allowed', async () => {
    const w = world();
    const handle = createHandler(() => w.v, { now: () => w.v.now(), allowOrigin: 'https://game.example' });
    const ok = await handle(post({ player: ME, day: DAY }, { origin: 'https://game.example' }));
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://game.example');
    const no = await handle(post({ player: ME, day: DAY }, { origin: 'https://evil.example' }));
    expect(no.headers.get('access-control-allow-origin')).toBeNull();
    expect((await handle(new Request('https://game.test/api/daily-reward', { method: 'OPTIONS', headers: { origin: 'https://game.example' } }))).status).toBe(204);
  });
});

describe('configuration', () => {
  it('needs a key, and the rewards contract', () => {
    expect(verifierFrom({})).toMatchObject({ missing: expect.any(String) });
    expect(verifierFrom({ DAILY_REWARD_CONTRACT: CONTRACT })).toEqual({ missing: 'DAILY_REWARD_SIGNER_KEY' });
    expect(verifierFrom({ DAILY_REWARD_CONTRACT: CONTRACT, DAILY_REWARD_SIGNER_KEY: 'hunter2' })).toEqual({ missing: 'DAILY_REWARD_SIGNER_KEY' });
    expect(verifierFrom({ DAILY_REWARD_CONTRACT: CONTRACT, DAILY_REWARD_SIGNER_KEY: KEY, DAILY_REWARD_CHAIN_ID: '424242' })).toMatchObject({ missing: expect.stringContaining('424242') });
  });

  it('is built from the environment, and keeps the key out of what it exposes', () => {
    const made = verifierFrom({ DAILY_REWARD_CONTRACT: CONTRACT, DAILY_REWARD_SIGNER_KEY: KEY, DAILY_REWARD_CONFIRMATIONS: '12', DAILY_REWARD_TTL_SECONDS: '120' });
    if ('missing' in made) throw new Error(made.missing);
    expect(made.verifier.config).toMatchObject({ chainId: 20994, contract: CONTRACT, signer: account.address, confirmations: 12n, ttlSeconds: 120 });
    expect(JSON.stringify(made.verifier.config, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(KEY.slice(2));
    // nonsense falls back to the defaults instead of switching a safety off
    const odd = verifierFrom({ DAILY_REWARD_CONTRACT: CONTRACT, DAILY_REWARD_SIGNER_KEY: KEY, DAILY_REWARD_CONFIRMATIONS: '-3', DAILY_REWARD_TTL_SECONDS: '999999' });
    if ('missing' in odd) throw new Error(odd.missing);
    expect(odd.verifier.config).toMatchObject({ confirmations: 5n, ttlSeconds: 600 });
  });
});

describe('the rate limiter', () => {
  it('counts per key within a moving window', () => {
    let t = 0;
    const ok = rateLimiter(2, 1_000, () => t);
    expect([ok('a'), ok('a'), ok('a'), ok('b')]).toEqual([true, true, false, true]);
    t = 999;
    expect(ok('a')).toBe(false);
    t = 1_000;
    expect(ok('a')).toBe(true);
  });

  it('does not grow without bound', () => {
    const ok = rateLimiter(1, 1_000, () => 0, 100);
    for (let i = 0; i < 1_000; i++) ok(`k${i}`);
    // the newest keys are still remembered
    expect(ok('k999')).toBe(false);
    // the oldest were dropped
    expect(ok('k0')).toBe(true);
  });
});

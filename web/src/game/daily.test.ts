import { describe, expect, it } from 'vitest';
import { landFish, sellFish, type CastTicket } from './actions';
import { LOCATIONS, SPECIALS, SPECIES, TUNING } from './content';
import {
  DAILY,
  DAILY_REWARD,
  DAY_MS,
  LOCAL_PLAYER,
  challengeId,
  describeGoal,
  expectedDistinct,
  freshDaily,
  generateDaily,
  goalHint,
  mergeCatches,
  profileOf,
  progressLabel,
  progressOf,
  recordCatch,
  rewardEnergy,
  rollDaily,
  setProgress,
  streakAfter,
  streakOn,
  utcDay,
  weightShare,
  type DailyGoal,
  type DayCatch,
  type Profile,
} from './daily';
import { totals } from './equipment';
import { speciesOdds } from './generate';
import { speciesLocations } from './progress';
import { freshSave, loadSave } from './save';
import { RODS } from '../tackle/catalog';
import type { Save } from './types';

const DAY = 20_780;
const NOON = DAY * DAY_MS + 12 * 3_600_000;
const ME = '0x00000000000000000000000000000000000000Aa';

const NEW: Profile = { unlocked: [0], rods: ['willow'] };
const RIVER: Profile = { unlocked: [0, 1], rods: ['willow', 'carbon'] };
const MID: Profile = { unlocked: [0, 1, 2, 5], rods: ['willow', 'carbon', 'flyrod'] };
const LATE: Profile = { unlocked: [0, 1, 2, 3, 4, 5, 6, 7], rods: RODS.map((r) => r.id) };
const PROFILES = [NEW, RIVER, MID, LATE];
const DAYS = Array.from({ length: 150 }, (_, i) => DAY + i);

const fish = (id: string, speciesId: number, weight: number, locationId: number): DayCatch => ({ id, speciesId, weight, locationId });

describe('the UTC day', () => {
  it('turns at 00:00 UTC and nowhere else', () => {
    const midnight = Date.UTC(2026, 10, 24);
    expect(utcDay(midnight)).toBe(utcDay(midnight - 1) + 1);
    expect(utcDay(midnight)).toBe(utcDay(midnight + DAY_MS - 1));
    expect(utcDay(Date.UTC(2026, 10, 23, 23, 59, 59))).toBe(utcDay(Date.UTC(2026, 10, 23, 0, 0, 0)));
  });
});

describe('generating the day', () => {
  it('gives exactly three challenges: an easy, a medium and a hard one', () => {
    for (const p of PROFILES) {
      for (const d of DAYS) {
        const set = generateDaily(d, ME, p);
        expect(set.day).toBe(d);
        expect(set.version).toBe(DAILY.version);
        expect(set.challenges.map((c) => c.tier)).toEqual(['easy', 'medium', 'hard']);
        expect(new Set(set.challenges.map((c) => c.id)).size).toBe(3);
      }
    }
  });

  it('is deterministic: the same day, player and profile give the same set, in any order of asking', () => {
    const a = generateDaily(DAY, ME, MID);
    generateDaily(DAY + 1, ME, MID);
    generateDaily(DAY, '0xbb', LATE);
    expect(generateDaily(DAY, ME, MID)).toEqual(a);
    // the address is the same account however it is written
    expect(generateDaily(DAY, ME.toLowerCase(), MID)).toEqual(a);
    // and a profile is a set of things, not a list in some order
    expect(generateDaily(DAY, ME, { unlocked: [5, 2, 1, 0], rods: ['flyrod', 'willow', 'carbon'] })).toEqual(a);
  });

  it('changes from day to day and from player to player', () => {
    const ids = (set: ReturnType<typeof generateDaily>): string => set.challenges.map((c) => c.id).join('|');
    expect(new Set(DAYS.map((d) => ids(generateDaily(d, ME, LATE)))).size).toBeGreaterThan(30);
    const players = Array.from({ length: 40 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`);
    expect(new Set(players.map((p) => ids(generateDaily(DAY, p, LATE)))).size).toBeGreaterThan(10);
    // neighbouring days are not near copies of each other
    const same = DAYS.slice(1).filter((d, i) => ids(generateDaily(d, ME, LATE)) === ids(generateDaily(DAYS[i], ME, LATE))).length;
    expect(same).toBeLessThan(DAYS.length / 5);
  });

  it('ids are stable and versioned, and say what the goal is', () => {
    expect(challengeId('easy', { kind: 'catch', count: 3 })).toBe('d1.easy.catch.n3');
    expect(challengeId('easy', { kind: 'catch', count: 3, loc: 1 })).toBe('d1.easy.catch.l1.n3');
    expect(challengeId('medium', { kind: 'species', speciesId: 5, count: 1 })).toBe('d1.medium.species.s5.n1');
    expect(challengeId('medium', { kind: 'rarity', min: 2, count: 1 })).toBe('d1.medium.rarity.r2.n1');
    expect(challengeId('hard', { kind: 'weight', grams: 400, loc: 0 })).toBe('d1.hard.weight.l0.g400');
    expect(challengeId('hard', { kind: 'distinct', count: 3, loc: 0 }, 2)).toBe('d2.hard.distinct.l0.n3');
    for (const c of generateDaily(DAY, ME, LATE).challenges) {
      expect(c.id).toBe(challengeId(c.tier, c.goal));
      expect(c.id.startsWith(`d${DAILY.version}.`)).toBe(true);
    }
  });

  it('asks only for waters the player has opened', () => {
    for (const p of PROFILES) {
      const open = new Set([0, ...p.unlocked]);
      for (const d of DAYS) {
        for (const c of generateDaily(d, ME, p).challenges) {
          expect(open.has(c.at)).toBe(true);
          if ('loc' in c.goal && c.goal.loc !== undefined) expect(open.has(c.goal.loc)).toBe(true);
          // a species goal names a fish that lives in the water it was sized for
          if (c.goal.kind === 'species') expect(speciesLocations(c.goal.speciesId).some((l) => l.id === c.at)).toBe(true);
        }
      }
    }
  });

  it('a locked water never appears, even when the player owns the rod for it', () => {
    const p: Profile = { unlocked: [0], rods: RODS.map((r) => r.id) };
    for (const d of DAYS) for (const c of generateDaily(d, ME, p).challenges) expect(c.at).toBe(0);
    // every player has the pond, whatever the profile says
    for (const d of DAYS.slice(0, 20)) for (const c of generateDaily(d, ME, { unlocked: [], rods: [] }).challenges) expect(c.at).toBe(0);
  });

  it('never asks for a hidden or a special fish', () => {
    const specials = new Set(SPECIALS.map((s) => s.speciesId));
    for (const p of PROFILES) {
      for (const d of DAYS) {
        for (const c of generateDaily(d, ME, p).challenges) {
          if (c.goal.kind !== 'species') continue;
          expect(SPECIES[c.goal.speciesId].hidden).toBeFalsy();
          expect(specials.has(c.goal.speciesId)).toBe(false);
        }
      }
    }
  });

  it('keeps every challenge inside its energy budget', () => {
    for (const p of PROFILES) {
      for (const d of DAYS) {
        for (const c of generateDaily(d, ME, p).challenges) {
          // the one exception is written into the rules: in a dear water a single fish is the whole easy challenge
          const oneFish = LOCATIONS[c.at].energyCost / (TUNING.baseBite / 100);
          const limit = c.tier === 'easy' ? Math.max(DAILY.budget.easy, oneFish) : DAILY.budget[c.tier];
          expect(c.energy).toBeLessThanOrEqual(limit + 0.05);
          expect(c.energy).toBeGreaterThan(0);
        }
      }
    }
  });

  it('sizes all three for one water, so a single sitting can finish them', () => {
    for (const p of PROFILES) for (const d of DAYS) expect(new Set(generateDaily(d, ME, p).challenges.map((c) => c.at)).size).toBe(1);
  });

  it('never asks the same thing twice in a day', () => {
    for (const p of PROFILES) {
      for (const d of DAYS) {
        const kinds = generateDaily(d, ME, p).challenges.map((c) => c.goal.kind);
        expect(kinds.filter((k) => k === 'distinct').length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('a weight goal is a real weight of that water: reachable, and not a formality', () => {
    for (const p of PROFILES) {
      for (const d of DAYS) {
        for (const c of generateDaily(d, ME, p).challenges) {
          if (c.goal.kind !== 'weight') continue;
          const loc = LOCATIONS[c.goal.loc!];
          const species = speciesOdds(loc, 0).map((o) => ({ id: o.speciesId, p: o.p }));
          const share = weightShare({ species, weightBonus: 0 }, c.goal.grams);
          expect(share).toBeGreaterThan(0.1);
          expect(share).toBeLessThanOrEqual(DAILY.weightMaxShare + 0.01);
          expect(c.goal.grams).toBeLessThanOrEqual(Math.max(...loc.pool.map(([id]) => SPECIES[id].maxWeight)));
        }
      }
    }
  });

  it('asks for a Rare fish only when a rod in hand makes it likely enough', () => {
    const rare = (p: Profile): { at: number; rod?: string }[] => DAYS.flatMap((d) => generateDaily(d, ME, p).challenges.filter((c) => c.goal.kind === 'rarity').map((c) => ({ at: c.at, rod: c.rod })));
    // the pond has no Rare fish; with the starter rod the river's are too few
    expect(rare(NEW)).toEqual([]);
    expect(rare({ unlocked: [0, 1], rods: ['willow'] })).toEqual([]);
    // a rod that favours rare fish makes it a fair ask on the river
    const mid = rare(MID);
    expect(mid.length).toBeGreaterThan(0);
    for (const r of mid) expect(r).toEqual({ at: 1, rod: 'flyrod' });
    // every one that was asked for is likely per cast, with the rod it names
    for (const p of PROFILES) {
      for (const r of rare(p)) {
        const loc = LOCATIONS[r.at];
        const t = totals(RODS.find((x) => x.id === (r.rod ?? 'willow'))!, null, loc);
        const share = speciesOdds(loc, t.total.rarity).reduce((a, o) => a + (SPECIES[o.speciesId].rarity >= DAILY.rare ? o.p : 0), 0);
        expect((loc.energyCost / ((t.biteChance / 100) * share)) * 0.99).toBeLessThanOrEqual(DAILY.budget.medium);
      }
    }
  });

  it('scales with the player: more waters and better rods widen what a day can ask', () => {
    const kinds = (p: Profile): Set<string> => new Set(DAYS.flatMap((d) => generateDaily(d, ME, p).challenges.map((c) => `${c.goal.kind}@${c.at}`)));
    expect([...kinds(NEW)].every((k) => k.endsWith('@0'))).toBe(true);
    expect(kinds(LATE).size).toBeGreaterThan(kinds(MID).size - 1);
    expect(kinds(MID).size).toBeGreaterThan(kinds(RIVER).size);
    expect(kinds(RIVER).size).toBeGreaterThan(kinds(NEW).size);
    const heaviest = (p: Profile): number => Math.max(...DAYS.flatMap((d) => generateDaily(d, ME, p).challenges.map((c) => (c.goal.kind === 'weight' ? c.goal.grams : 0))));
    expect(heaviest(MID)).toBeGreaterThan(heaviest(NEW));
  });
});

describe('the numbers behind a goal', () => {
  it('expected fish until N different species', () => {
    // two equally likely species: the first is new, the second takes two more on average
    expect(expectedDistinct([0.5, 0.5], 1)).toBeCloseTo(1);
    expect(expectedDistinct([0.5, 0.5], 2)).toBeCloseTo(3);
    // probabilities that do not add up to one (the rest is some other fish) only slow it down
    expect(expectedDistinct([0.25, 0.25], 1)).toBeCloseTo(2);
    expect(expectedDistinct([1], 2)).toBe(Infinity);
  });

  it('share of fish over a weight follows the weight roll', () => {
    const roach = { species: [{ id: 0, p: 1 }], weightBonus: 0 };
    expect(weightShare(roach, SPECIES[0].minWeight)).toBeCloseTo(1);
    expect(weightShare(roach, SPECIES[0].maxWeight + 1)).toBe(0);
    // half way up the range: min(u1, u2) ≥ 0.5 a quarter of the time
    expect(weightShare(roach, (SPECIES[0].minWeight + SPECIES[0].maxWeight) / 2)).toBeCloseTo(0.25);
  });
});

describe('progress', () => {
  const day = [fish('1', 0, 120, 0), fish('2', 2, 450, 0), fish('3', 5, 3200, 1), fish('4', 7, 1500, 1), fish('5', 0, 90, 0)];

  it('counts each kind of goal', () => {
    expect(progressOf({ kind: 'catch', count: 3 }, day)).toEqual({ have: 3, need: 3, done: true });
    expect(progressOf({ kind: 'catch', count: 3, loc: 1 }, day)).toEqual({ have: 2, need: 3, done: false });
    expect(progressOf({ kind: 'species', speciesId: 0, count: 2 }, day)).toEqual({ have: 2, need: 2, done: true });
    expect(progressOf({ kind: 'species', speciesId: 6, count: 1 }, day)).toEqual({ have: 0, need: 1, done: false });
    expect(progressOf({ kind: 'distinct', count: 4 }, day)).toEqual({ have: 4, need: 4, done: true });
    expect(progressOf({ kind: 'distinct', count: 3, loc: 0 }, day)).toEqual({ have: 2, need: 3, done: false });
    // Zander is Rare; Pike is Uncommon
    expect(progressOf({ kind: 'rarity', min: 2, count: 1 }, day)).toEqual({ have: 1, need: 1, done: true });
    expect(progressOf({ kind: 'rarity', min: 3, count: 1 }, day).done).toBe(false);
    expect(progressOf({ kind: 'weight', grams: 3000, loc: 1 }, day).done).toBe(true);
    // the heaviest pond fish is 450 g: the river's pike does not count for a pond goal
    expect(progressOf({ kind: 'weight', grams: 500, loc: 0 }, day)).toEqual({ have: 450, need: 500, done: false });
    expect(progressOf({ kind: 'catch', count: 1 }, [])).toEqual({ have: 0, need: 1, done: false });
  });

  it('one fish counts for every challenge it fits', () => {
    const set = { version: 1, day: DAY, challenges: [
      { id: 'a', tier: 'easy' as const, goal: { kind: 'catch', count: 1, loc: 1 } as DailyGoal, at: 1, energy: 1 },
      { id: 'b', tier: 'medium' as const, goal: { kind: 'rarity', min: 2, count: 1 } as DailyGoal, at: 1, energy: 1 },
      { id: 'c', tier: 'hard' as const, goal: { kind: 'weight', grams: 1200, loc: 1 } as DailyGoal, at: 1, energy: 1 },
    ] };
    expect(setProgress(set, []).done).toBe(0);
    const p = setProgress(set, [fish('9', 7, 1500, 1)]);
    expect(p.done).toBe(3);
    expect(p.complete).toBe(true);
  });

  it('a fish reported twice counts once', () => {
    const once = mergeCatches([], [fish('7', 0, 100, 0)]);
    const twice = mergeCatches(once, [fish('7', 0, 100, 0)]);
    expect(twice).toBe(once);
    const many = mergeCatches(once, [fish('7', 0, 100, 0), fish('8', 0, 100, 0), fish('8', 0, 100, 0)]);
    expect(many.map((c) => c.id)).toEqual(['7', '8']);
    expect(progressOf({ kind: 'catch', count: 3 }, many)).toEqual({ have: 2, need: 3, done: false });
  });

  it('completion never goes back as the day goes on', () => {
    const set = generateDaily(DAY, ME, LATE);
    let catches: DayCatch[] = [];
    let before = setProgress(set, catches).each.map((p) => p.done);
    for (let i = 0; i < 60; i++) {
      catches = mergeCatches(catches, [fish(`f${i}`, LOCATIONS[i % 8].pool[i % 5][0], 100 + i * 137, i % 8)]);
      const now = setProgress(set, catches).each.map((p) => p.done);
      before.forEach((was, k) => was && expect(now[k]).toBe(true));
      before = now;
    }
  });

  it('reads well', () => {
    expect(describeGoal({ kind: 'catch', count: 1, loc: 3 })).toBe('Catch a fish in Northern Sea');
    expect(describeGoal({ kind: 'catch', count: 3 })).toBe('Catch 3 fish');
    expect(describeGoal({ kind: 'species', speciesId: 5, count: 1 })).toBe('Catch a Pike');
    expect(describeGoal({ kind: 'distinct', count: 3, loc: 0 })).toBe('Catch 3 different species in Village Pond');
    expect(describeGoal({ kind: 'rarity', min: 2, count: 1 })).toBe('Catch a Rare or better fish');
    expect(describeGoal({ kind: 'weight', grams: 1500, loc: 2 })).toBe('Land a fish of 1.5 kg or more in Deep Lake');
    expect(progressLabel({ kind: 'catch', count: 3 }, { have: 1, need: 3, done: false })).toBe('1/3');
    expect(progressLabel({ kind: 'weight', grams: 400 }, { have: 320, need: 400, done: false })).toBe('best so far 320 g');
    expect(goalHint({ id: 'x', tier: 'medium', goal: { kind: 'species', speciesId: 5, count: 1 }, at: 1, energy: 6 })).toBe('Lives in Forest River');
    expect(goalHint({ id: 'x', tier: 'medium', goal: { kind: 'rarity', min: 2, count: 1 }, at: 1, energy: 6, rod: 'flyrod' })).toBe('Good odds in Forest River with the Taiga Fly Rod');
    expect(goalHint({ id: 'x', tier: 'hard', goal: { kind: 'weight', grams: 400, loc: 0 }, at: 0, energy: 6 })).toBeNull();
  });
});

describe('the local game’s day', () => {
  it('fixes the set when the day is first seen and keeps it all day, whatever the player gains', () => {
    const morning = rollDaily(freshDaily(), DAY * DAY_MS + 60_000, LOCAL_PLAYER, NEW);
    expect(morning.day).toBe(DAY);
    expect(morning.set).toEqual(generateDaily(DAY, LOCAL_PLAYER, NEW));
    // by the evening the player has opened every water: today's challenges stay what they were
    const evening = rollDaily(morning, DAY * DAY_MS + 23 * 3_600_000, LOCAL_PLAYER, LATE);
    expect(evening).toBe(morning);
  });

  it('starts over at 00:00 UTC: a new set, an empty list, the streak carried', () => {
    let d = rollDaily(freshDaily(), NOON, LOCAL_PLAYER, NEW);
    d = { ...d, catches: [fish('1', 0, 100, 0)], streak: { day: DAY, count: 4 } };
    const last = rollDaily(d, (DAY + 1) * DAY_MS - 1, LOCAL_PLAYER, NEW);
    expect(last).toBe(d);
    const next = rollDaily(d, (DAY + 1) * DAY_MS, LOCAL_PLAYER, NEW);
    expect(next.day).toBe(DAY + 1);
    expect(next.catches).toEqual([]);
    expect(next.set).toEqual(generateDaily(DAY + 1, LOCAL_PLAYER, NEW));
    expect(next.streak).toEqual({ day: DAY, count: 4 });
  });

  it('a set drawn by older rules is drawn again', () => {
    const d = rollDaily(freshDaily(), NOON, LOCAL_PLAYER, NEW);
    const old = { ...d, set: { ...d.set!, version: DAILY.version - 1 }, catches: [fish('1', 0, 100, 0)] };
    const re = rollDaily(old, NOON + 1, LOCAL_PLAYER, NEW);
    expect(re.set!.version).toBe(DAILY.version);
    // the day's fish are still the day's fish
    expect(re.catches).toHaveLength(1);
  });

  it('records a fish once', () => {
    let d = recordCatch(freshDaily(), fish('1', 0, 100, 0), NOON, LOCAL_PLAYER, NEW);
    expect(d.catches).toHaveLength(1);
    const again = recordCatch(d, fish('1', 0, 100, 0), NOON + 5, LOCAL_PLAYER, NEW);
    expect(again).toBe(d);
    d = recordCatch(d, fish('2', 1, 200, 0), NOON + 9, LOCAL_PLAYER, NEW);
    expect(d.catches.map((c) => c.id)).toEqual(['1', '2']);
  });

  it('yesterday’s fish are not today’s', () => {
    const d = recordCatch(freshDaily(), fish('1', 0, 100, 0), NOON, LOCAL_PLAYER, NEW);
    const next = recordCatch(d, fish('2', 0, 100, 0), NOON + DAY_MS, LOCAL_PLAYER, NEW);
    expect(next.day).toBe(DAY + 1);
    expect(next.catches.map((c) => c.id)).toEqual(['2']);
  });
});

describe('the streak', () => {
  it('grows by a day at a time and only once a day', () => {
    let s = streakAfter({ day: 0, count: 0 }, DAY);
    expect(s).toEqual({ day: DAY, count: 1 });
    expect(streakAfter(s, DAY)).toBe(s);
    s = streakAfter(s, DAY + 1);
    expect(s).toEqual({ day: DAY + 1, count: 2 });
    // a day missed: it starts again
    expect(streakAfter(s, DAY + 3)).toEqual({ day: DAY + 3, count: 1 });
  });

  it('is alive today and tomorrow, then gone', () => {
    const s = { day: DAY, count: 5 };
    expect(streakOn(s, DAY)).toBe(5);
    expect(streakOn(s, DAY + 1)).toBe(5);
    expect(streakOn(s, DAY + 2)).toBe(0);
    expect(streakOn({ day: 0, count: 0 }, DAY)).toBe(0);
  });

  it('completing the day’s set counts the day, once', () => {
    let d = rollDaily(freshDaily(), NOON, LOCAL_PLAYER, NEW);
    const loc = d.set!.challenges[0].at;
    expect(loc).toBe(0);
    // every pond species at its top weight: whatever the day asks of the pond, this does it
    let n = 0;
    for (let round = 0; round < 4; round++) for (const [id] of LOCATIONS[0].pool) d = recordCatch(d, fish(`f${n++}`, id, SPECIES[id].maxWeight, 0), NOON + n, LOCAL_PLAYER, NEW);
    expect(setProgress(d.set!, d.catches).complete).toBe(true);
    expect(d.streak).toEqual({ day: DAY, count: 1 });
  });
});

describe('the day inside the save', () => {
  const ticket = (locationId: number): CastTicket => ({ locationId, totals: totals(RODS[0], null, LOCATIONS[locationId]) });
  const land = (s: Save, speciesId: number, weight: number, at: number): Save => landFish(s, ticket(0), { speciesId, weight, isSpecial: false }, 'B', at).save;

  it('landing a fish writes it into the day, drawn from what the player had before it', () => {
    const s0 = freshSave(NOON);
    const s1 = land(s0, 0, 200, NOON);
    expect(s1.daily.day).toBe(DAY);
    expect(s1.daily.set).toEqual(generateDaily(DAY, LOCAL_PLAYER, profileOf(s0)));
    expect(s1.daily.catches).toEqual([{ id: s1.fish[0].id, speciesId: 0, weight: 200, locationId: 0 }]);
    const s2 = land(s1, 1, 300, NOON + 1000);
    expect(s2.daily.catches).toHaveLength(2);
    expect(s2.daily.set).toBe(s1.daily.set);
  });

  it('selling the fish leaves the day as it is', () => {
    let s = land(freshSave(NOON), 0, 200, NOON);
    s = land(s, 1, 300, NOON + 1000);
    const before = s.daily;
    for (const f of [...s.fish]) s = sellFish(s, [f.id], NOON + 3_600_000).save;
    expect(s.fish).toHaveLength(0);
    expect(s.daily).toBe(before);
    expect(setProgress(s.daily.set!, s.daily.catches)).toEqual(setProgress(before.set!, before.catches));
  });

  it('survives a reload: the set, the progress and the streak come back as they were', () => {
    let s = land(freshSave(NOON), 0, 200, NOON);
    s = { ...land(s, 2, 650, NOON + 1000), daily: { ...s.daily, streak: { day: DAY - 1, count: 3 } } };
    s = land(s, 1, 880, NOON + 2000);
    const back = loadSave(JSON.stringify(s), NOON + 5000);
    expect(back.status).toBe('ok');
    expect(back.save.daily).toEqual(s.daily);
    // and the next fish after the reload is added to the same day, not to a new one
    const more = land(back.save, 3, 1000, NOON + 9000);
    expect(more.daily.catches).toHaveLength(s.daily.catches.length + 1);
    expect(more.daily.set).toEqual(s.daily.set);
  });

  it('a save from before the feature loads with an empty day', () => {
    const old = { ...freshSave(NOON) } as Partial<Save>;
    delete old.daily;
    const loaded = loadSave(JSON.stringify(old), NOON);
    expect(loaded.status).toBe('ok');
    expect(loaded.save.daily).toEqual(freshDaily());
    expect(land(loaded.save, 0, 200, NOON).daily.catches).toHaveLength(1);
  });

  it('changes nothing else: no XP, PEARL or energy comes with a completed day', () => {
    let s = freshSave(NOON);
    let n = 0;
    for (let round = 0; round < 4; round++) for (const [id] of LOCATIONS[0].pool) s = land(s, id, SPECIES[id].maxWeight, NOON + n++);
    expect(setProgress(s.daily.set!, s.daily.catches).complete).toBe(true);
    // XP is the catches' own, PEARL is untouched, energy was never spent by landFish
    expect(s.xp).toBe(4 * (10 + 10 + 10 + 20 + 40));
    expect(s.pearl).toBe(0);
    expect(s.energy).toBe(TUNING.maxEnergy);
    expect(s.claimed).toEqual([]);
  });
});

describe('the reward that is not there yet', () => {
  it('is switched off', () => {
    expect(DAILY_REWARD.enabled).toBe(false);
    expect(DAILY_REWARD.fullSet).toEqual({ kind: 'energy', amount: 4 });
  });

  it('would never lift energy over the bar', () => {
    expect(rewardEnergy(10)).toBe(4);
    expect(rewardEnergy(TUNING.maxEnergy - 1)).toBe(1);
    expect(rewardEnergy(TUNING.maxEnergy)).toBe(0);
    expect(rewardEnergy(TUNING.maxEnergy + 5)).toBe(0);
  });
});

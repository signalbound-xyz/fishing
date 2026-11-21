/** Checks of the balance lab itself: that its shortcuts agree with the game rules they stand for. */
import { beforeAll, describe, expect, it } from 'vitest';
import { rollQuality } from '../src/game/chainOutcome';
import { LOCATIONS, QUALITIES, SPECIES } from '../src/game/content';
import { hookWindow, reelParams } from '../src/game/minigame';
import { locationSpecies } from '../src/game/progress';
import { LURES, RODS } from '../src/tackle/catalog';
import { PATTERNS, PLAYERS, REEL_CONFIGS, WORLD_NOW, career, castModel, contractQuality, cupRun, expectedTop, hookStats, hookWindowAt, mulberry32, reelAt, setFightsPerCell, weekEnergy, type Scenario, type World } from './lab';
import { WORLDS } from './scenarios';

// 150 fights per cell instead of 1,500: these tests check the bookkeeping, not the rates
beforeAll(() => setFightsPerCell(150));

const scenario = (over: Partial<Scenario> = {}): Scenario => ({ rules: 'chain', player: 'average', reel: 'current', world: WORLD_NOW, pattern: PATTERNS.daily, start: 'new', days: 40, ...over });
const spentAll = (r: ReturnType<typeof career>): number => r.spent.rods + r.spent.lures + r.spent.repairs + r.spent.refills + r.spent.locations;

describe('reel configurations', () => {
  it('a whole difficulty is the game\'s own fight, and a fraction lies between its neighbours', () => {
    for (let d = 0; d <= 5; d++) {
      expect(reelAt(d, 0.2)).toEqual(reelParams(d as 0, 0.2));
      expect(hookWindowAt(d)).toBe(hookWindow(d as 0));
    }
    const mid = reelAt(3.5, 0.2);
    const a = reelParams(3, 0.2);
    const b = reelParams(4, 0.2);
    expect(mid.surge).toBeCloseTo((a.surge + b.surge) / 2);
    expect(mid.tell).toBeCloseTo((a.tell + b.tell) / 2);
    expect(mid.green).toEqual(a.green);
    expect(hookWindowAt(4.5)).toBeCloseTo((hookWindow(4) + hookWindow(5)) / 2);
  });

  it('every configuration keeps the order of the levels and stays inside the game\'s range', () => {
    for (const c of Object.values(REEL_CONFIGS)) {
      for (let d = 0; d < 5; d++) expect(c.levels[d + 1]).toBeGreaterThanOrEqual(c.levels[d]);
      expect(c.levels[0]).toBeGreaterThanOrEqual(0);
      expect(c.levels[5]).toBeLessThanOrEqual(5);
    }
    expect(REEL_CONFIGS.current.levels).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('model players', () => {
  it('a shorter window is missed more often, and a slower player misses more', () => {
    for (const p of Object.values(PLAYERS)) for (let d = 0; d < 5; d++) expect(hookStats(p, d + 1).miss).toBeGreaterThan(hookStats(p, d).miss - 1e-12);
    for (let d = 0; d <= 5; d++) {
      expect(hookStats(PLAYERS.beginner, d).miss).toBeGreaterThan(hookStats(PLAYERS.average, d).miss);
      expect(hookStats(PLAYERS.average, d).miss).toBeGreaterThan(hookStats(PLAYERS.experienced, d).miss);
      const h = hookStats(PLAYERS.average, d);
      expect(h.clean + h.miss).toBeLessThanOrEqual(1);
      expect(h.reaction).toBeLessThan(h.window);
    }
  });

  it('the contract quality shares are exactly the contract\'s roll', () => {
    const cfg = { config: { qualityPerCatch: 150, qualityPerRarity: 300, blendChancePpm: 0, blendMaxWins: 0 }, locations: [], species: [], specials: [] };
    for (const [rodCatch, rarity] of [[0, 0], [0, 5], [9, 0], [9, 4], [-4, 3], [7, 2]]) {
      const counted = [0, 0, 0, 0, 0];
      for (let roll = 0; roll < 10_000; roll++) counted[rollQuality(cfg, rodCatch, rarity, roll)]++;
      const q = contractQuality(rodCatch, rarity);
      QUALITIES.forEach((k, i) => expect(q[k]).toBeCloseTo(counted[i] / 10_000, 10));
    }
  });
});

describe('cast model', () => {
  it('on the contracts every bite is a fish; in the local game some are lost', () => {
    for (const loc of LOCATIONS) {
      const chain = castModel('chain', 'beginner', 'current', WORLD_NOW, loc.id, { rod: RODS[0], lure: null });
      const local = castModel('local', 'beginner', 'current', WORLD_NOW, loc.id, { rod: RODS[0], lure: null });
      expect(chain.landed).toBeCloseTo(chain.bite, 10);
      expect(chain.tries).toBeGreaterThanOrEqual(1);
      expect(local.landed).toBeLessThan(local.bite);
      expect(local.landed + local.bite * (local.hookLost + local.fightLost)).toBeCloseTo(local.bite, 10);
      expect(chain.lines.reduce((a, l) => a + l.p, 0)).toBeCloseTo(1, 10);
    }
  });

  it('a payout multiplier scales what fish sell for, and nothing else', () => {
    const half: World = { ...WORLD_NOW, name: 'half at the sea', payout: WORLD_NOW.payout.map((v, i) => (i === 3 ? 0.5 : v)) };
    const a = castModel('chain', 'average', 'current', WORLD_NOW, 3, { rod: RODS[4], lure: LURES[3] });
    const b = castModel('chain', 'average', 'current', half, 3, { rod: RODS[4], lure: LURES[3] });
    expect(b.gross).toBeCloseTo(a.gross / 2, 8);
    expect(b.upkeep).toBe(a.upkeep);
    expect(b.xp).toBe(a.xp);
    expect(castModel('chain', 'average', 'current', half, 0, { rod: RODS[0], lure: null }).gross).toBeCloseTo(castModel('chain', 'average', 'current', WORLD_NOW, 0, { rod: RODS[0], lure: null }).gross, 8);
  });

  it('more casts never lower the expected best ten', () => {
    const m = castModel('chain', 'average', 'current', WORLD_NOW, 4, { rod: RODS[3], lure: LURES[5] });
    let last = 0;
    for (const casts of [5, 20, 80, 320, 5000]) {
      const v = expectedTop(m, casts);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
    // with enough casts all ten are the most valuable species
    expect(expectedTop(m, 1e9)).toBeCloseTo(10 * Math.max(...m.lines.map((l) => l.points)), 6);
  });
});

describe('worlds and patterns', () => {
  it('a week of energy is what regenerates between sittings plus the refills', () => {
    expect(weekEnergy(PATTERNS.daily, WORLD_NOW)).toBe(140);
    expect(weekEnergy(PATTERNS.everyOtherDay, WORLD_NOW)).toBe(70);
    expect(weekEnergy(PATTERNS.twice, WORLD_NOW)).toBe(280);
    expect(weekEnergy(PATTERNS.thrice, WORLD_NOW)).toBe(336);
    expect(weekEnergy(PATTERNS.keen, WORLD_NOW)).toBe(336 + 2 * 20 * 7);
    const bar40 = WORLDS.find((w) => w.name === 'Bar of 40')!;
    expect(weekEnergy(PATTERNS.daily, bar40)).toBe(280);
    expect(weekEnergy(PATTERNS.thrice, bar40)).toBe(336);
  });

  it('the scenarios start from the deployed game and at least one gives 10–15 late casts a bar', () => {
    expect(WORLDS[0]).toBe(WORLD_NOW);
    expect(WORLD_NOW.energyCost).toEqual(LOCATIONS.map((l) => l.energyCost));
    const lateCasts = (w: World): number[] => LOCATIONS.filter((l) => l.energyCost >= 3).map((l) => Math.floor(w.maxEnergy / w.energyCost[l.id]));
    expect(lateCasts(WORLD_NOW).every((c) => c < 10)).toBe(true);
    expect(WORLDS.filter((w) => lateCasts(w).every((c) => c >= 10 && c <= 16)).length).toBeGreaterThanOrEqual(1);
    // the neutral variant pays in proportion to the cheaper cast
    const neutral = WORLDS.find((w) => w.name === 'Cost cap 2, neutral')!;
    LOCATIONS.forEach((l) => expect(neutral.payout[l.id] * l.energyCost).toBeCloseTo(neutral.energyCost[l.id], 10));
  });

  it('every species can be met somewhere, so the collection can be finished', () => {
    const met = new Set(LOCATIONS.flatMap(locationSpecies));
    expect(SPECIES.filter((s) => !met.has(s.id)).map((s) => s.name)).toEqual([]);
  });
});

describe('careers', () => {
  it('the same seed plays the same career', () => {
    const a = career(scenario(), 7);
    const b = career(scenario(), 7);
    expect(a.marks).toEqual(b.marks);
    expect(a.earned).toBe(b.earned);
    expect(career(scenario(), 8).earned).not.toBe(a.earned);
  });

  it('PEARL is conserved: what is in hand is what came in less what went out', () => {
    for (const sc of [scenario(), scenario({ rules: 'local', player: 'beginner', buyLocations: true, days: 60 }), scenario({ pattern: PATTERNS.keen, days: 30 })]) {
      const r = career(sc, 3);
      expect(r.save.pearl).toBe(r.earned + r.rewards - spentAll(r));
      expect(r.earnedByDay.reduce((a, x) => a + x, 0)).toBe(r.earned);
    }
    const v = career(scenario({ start: 'veteran', pattern: PATTERNS.grinder, days: 14 }), 3);
    expect(v.save.pearl).toBe(20_000 + v.earned + v.rewards - spentAll(v));
  });

  it('never spends more energy than the bar, the clock and the refills give', () => {
    for (const [pattern, days] of [[PATTERNS.daily, 30], [PATTERNS.thrice, 30], [PATTERNS.grinder, 20]] as const) {
      const r = career(scenario({ pattern, days, start: 'veteran' }), 5);
      const regen = (days * 86_400) / WORLD_NOW.regenSeconds;
      expect(r.energy).toBeLessThanOrEqual(WORLD_NOW.maxEnergy + regen + r.refills * WORLD_NOW.maxEnergy);
      expect(r.refills).toBeLessThanOrEqual(pattern.refills * days);
      expect(r.sittings.reduce((a, s) => a + s.energy, 0)).toBe(r.energy);
      expect(r.sittings.reduce((a, s) => a + s.casts, 0)).toBe(r.casts);
    }
    const daily = career(scenario({ days: 30, start: 'veteran' }), 5);
    expect(daily.energy).toBeLessThanOrEqual(30 * WORLD_NOW.maxEnergy);
  });

  it('on the contracts every bite is landed; in the local game the rest are lost at the hook or in the fight', () => {
    const chain = career(scenario({ player: 'beginner' }), 9);
    expect(chain.landed).toBe(chain.bites);
    const local = career(scenario({ rules: 'local', player: 'beginner' }), 9);
    expect(local.landed).toBeLessThan(local.bites);
    // every bite ends one way: landed, or lost once at the hook or in the fight
    expect(local.landed + local.hookMissed + local.fightsLost).toBe(local.bites);
  });

  it('a bigger bar helps the once-a-day player and not the one who never wastes energy', () => {
    const bar40 = WORLDS.find((w) => w.name === 'Bar of 40')!;
    const days = 28;
    const energy = (world: World, pattern: (typeof PATTERNS)[keyof typeof PATTERNS]): number => career(scenario({ world, pattern, days, start: 'veteran' }), 2).energy;
    expect(energy(bar40, PATTERNS.daily)).toBeGreaterThan(energy(WORLD_NOW, PATTERNS.daily) * 1.8);
    expect(energy(bar40, PATTERNS.thrice)).toBeLessThan(energy(WORLD_NOW, PATTERNS.thrice) * 1.1);
  });

  it('a veteran owns everything from the first day', () => {
    const r = career(scenario({ start: 'veteran', days: 7 }), 1);
    expect(r.save.permanentUnlocks).toHaveLength(LOCATIONS.length);
    expect(Object.keys(r.save.rods)).toHaveLength(RODS.length);
    expect(r.weeks).toHaveLength(1);
    expect(r.weeks[0]).toBeGreaterThan(0);
  });
});

describe('the cup', () => {
  it('two players given the same draw meet the same fish', () => {
    const setup = { locId: 4, rod: RODS[3], lure: LURES[2], waterTier: 2, casts: 30, counted: 10 };
    const a = cupRun(setup, 'beginner', mulberry32(5), mulberry32(1));
    const b = cupRun(setup, 'experienced', mulberry32(5), mulberry32(2));
    expect(a.perfect).toBe(b.perfect);
    expect(a.total).toBeLessThanOrEqual(a.perfect);
    expect(b.total).toBeLessThanOrEqual(b.perfect);
    expect(b.landed).toBeGreaterThan(a.landed);
  });
});

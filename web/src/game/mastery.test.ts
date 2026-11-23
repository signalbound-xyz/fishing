import { describe, expect, it } from 'vitest';
import { landFish, sellFish, type CastTicket } from './actions';
import { LOCATIONS, SPECIALS, SPECIES } from './content';
import { levelOf } from './economy';
import { totals } from './equipment';
import { MASTERY, TIERS, allMastery, locationMastery, masterySummary, ordinarySpecies, percent, trophyWeight } from './mastery';
import { freshSave, loadSave } from './save';
import { RODS } from '../tackle/catalog';
import type { Save } from './types';

const NOW = Date.UTC(2026, 10, 13, 12);
type Dex = Save['dex'];
const POND = LOCATIONS[0];

/** An encyclopedia with every ordinary species of a water at the given count and share of its top weight. */
function dexOf(locId: number, count: (rarity: number) => number, share: number): Dex {
  const dex: Dex = {};
  for (const id of ordinarySpecies(LOCATIONS[locId])) dex[id] = { count: count(SPECIES[id].rarity), best: Math.ceil(SPECIES[id].maxWeight * share), firstAt: 0 };
  return dex;
}
const enough = (rarity: number): number => MASTERY.catches[rarity];

describe('the species mastery asks for', () => {
  it('are the pool without hidden species, and never a special collectible', () => {
    const specials = new Set(SPECIALS.map((s) => s.speciesId));
    for (const loc of LOCATIONS) {
      const ids = ordinarySpecies(loc);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(loc.pool.some(([p]) => p === id)).toBe(true);
        expect(SPECIES[id].hidden).toBeFalsy();
        expect(specials.has(id)).toBe(false);
      }
    }
    // Forest River's Albino Pike and Phantom Waters' two ghosts are hidden: a bonus, not a requirement
    expect(ordinarySpecies(LOCATIONS[1])).toEqual([2, 5, 6, 7, 8]);
    expect(ordinarySpecies(LOCATIONS[7])).toEqual([31, 32, 33]);
  });

  it('every water has a species for each tier to ask about', () => {
    for (const m of allMastery({})) {
      expect(m.species.length).toBeGreaterThan(0);
      expect(m.species.some((s) => s.master)).toBe(true);
    }
  });
});

describe('location mastery', () => {
  it('starts at nothing', () => {
    const m = locationMastery({}, POND);
    expect(m.level).toBe(0);
    expect(m.current).toBe('explorer');
    expect(m.progress).toBe(0);
    expect(m.tiers.map((t) => t.done)).toEqual([false, false, false]);
  });

  it('Explorer: every ordinary species discovered once', () => {
    const dex = dexOf(0, () => 1, 0.1);
    delete dex[4];
    const part = locationMastery(dex, POND);
    expect(part.level).toBe(0);
    expect(part.progress).toBeCloseTo(4 / 5);
    dex[4] = { count: 1, best: 1000, firstAt: 0 };
    const full = locationMastery(dex, POND);
    expect(full.level).toBe(1);
    expect(full.current).toBe('angler');
  });

  it('Experienced Angler: each species the number of times its rarity asks for', () => {
    expect(MASTERY.catches).toEqual([20, 12, 6, 3, 1, 1]);
    const dex = dexOf(0, enough, 0.1);
    expect(locationMastery(dex, POND).level).toBe(2);
    // one Roach short
    dex[0].count = 19;
    const m = locationMastery(dex, POND);
    expect(m.level).toBe(1);
    expect(m.species.find((s) => s.speciesId === 0)!.angler).toEqual({ have: 19, need: 20, done: false });
    // 19 of 20 for one of five species
    expect(m.progress).toBeCloseTo((4 + 19 / 20) / 5);
  });

  it('counts catches over the requirement as the requirement, so one species cannot stand in for another', () => {
    const dex = dexOf(0, () => 1, 0.1);
    dex[0].count = 500;
    const m = locationMastery(dex, POND);
    expect(m.species[0].angler.have).toBe(20);
    expect(m.progress).toBeLessThan(0.5);
  });

  it('Master: a personal best of 70% of the top weight, for species up to Epic', () => {
    const dex = dexOf(0, enough, MASTERY.trophyShare);
    expect(locationMastery(dex, POND).level).toBe(3);
    expect(locationMastery(dex, POND).current).toBeNull();
    expect(locationMastery(dex, POND).progress).toBe(1);
    // a gram under the trophy weight is not a trophy
    dex[3].best = trophyWeight(3) - 1;
    const m = locationMastery(dex, POND);
    expect(m.level).toBe(2);
    expect(m.species.find((s) => s.speciesId === 3)!.master!.done).toBe(false);
    expect(trophyWeight(3)).toBe(1750); // Tench, 2.5 kg at most
  });

  it('asks no trophy of Legendary and Mythic fish', () => {
    // Taimen Rapids: the Taimen is Legendary
    const rapids = locationMastery({}, LOCATIONS[4]);
    expect(rapids.species.find((s) => s.speciesId === 9)!.master).toBeNull();
    const dex = dexOf(4, enough, MASTERY.trophyShare);
    dex[9].best = SPECIES[9].minWeight;
    expect(locationMastery(dex, LOCATIONS[4]).level).toBe(3);
  });

  it('tiers complete in order: trophies alone are not mastery', () => {
    // every trophy landed, but only one fish of each species
    const m = locationMastery(dexOf(0, () => 1, 1), POND);
    expect(m.tiers.map((t) => t.met)).toEqual([true, false, true]);
    expect(m.tiers.map((t) => t.done)).toEqual([true, false, false]);
    expect(m.level).toBe(1);
    expect(m.current).toBe('angler');
  });

  it('the requirements are configuration', () => {
    const easy = { ...MASTERY, catches: [2, 2, 2, 1, 1, 1], trophyShare: 0.5 };
    const dex = dexOf(0, () => 2, 0.5);
    expect(locationMastery(dex, POND).level).toBe(1);
    expect(locationMastery(dex, POND, easy).level).toBe(3);
  });

  it('a hidden or special fish neither helps nor is needed', () => {
    const river = LOCATIONS[1];
    const dex = dexOf(1, enough, MASTERY.trophyShare);
    expect(locationMastery(dex, river).level).toBe(3);
    dex[35] = { count: 9, best: 13000, firstAt: 0 }; // Albino Pike
    dex[20] = { count: 1, best: 6000, firstAt: 0 }; // Golden Koi
    const m = locationMastery(dex, river);
    expect(m.level).toBe(3);
    expect(m.species.map((s) => s.speciesId)).toEqual([2, 5, 6, 7, 8]);
  });

  it('a species shared by two waters counts in both', () => {
    const dex: Dex = { 2: { count: 20, best: 600, firstAt: 0 } }; // Perch: pond and river
    expect(locationMastery(dex, POND).species.find((s) => s.speciesId === 2)!.angler.done).toBe(true);
    expect(locationMastery(dex, LOCATIONS[1]).species.find((s) => s.speciesId === 2)!.angler.done).toBe(true);
  });

  it('never reads 100% before it is done', () => {
    expect(percent(0.999, false)).toBe(99);
    expect(percent(1, true)).toBe(100);
    expect(percent(0.426, false)).toBe(42);
  });
});

describe('mastery over all waters', () => {
  it('sums the waters up', () => {
    const dex = { ...dexOf(0, enough, MASTERY.trophyShare), ...dexOf(2, enough, 0.1), ...dexOf(3, () => 1, 0.1) };
    const all = allMastery(dex);
    expect(all).toHaveLength(LOCATIONS.length);
    const s = masterySummary(all);
    expect(s.locations).toBe(8);
    expect(s.master).toBe(1);
    expect(s.angler).toBe(2);
    expect(s.explorer).toBe(3);
    expect(s.tiers).toBe(3 + 2 + 1);
    expect(s.tiersTotal).toBe(8 * TIERS.length);
    expect(s.title).toBe('Master of 1 water');
    expect(masterySummary(allMastery({})).title).toBe('No water explored yet');
  });
});

describe('mastery and the rest of the game', () => {
  const ticket = (locationId: number): CastTicket => ({ locationId, totals: totals(RODS[0], null, LOCATIONS[locationId]) });
  const land = (s: Save, speciesId: number, weight: number, at: number): Save => landFish(s, ticket(0), { speciesId, weight, isSpecial: false }, 'B', at).save;

  it('grows with catches and changes neither XP nor PEARL', () => {
    let s = freshSave(NOW);
    for (let i = 0; i < 5; i++) s = land(s, i, SPECIES[i].minWeight, NOW + i);
    expect(locationMastery(s.dex, POND).level).toBe(1);
    const before = JSON.stringify(s);
    allMastery(s.dex);
    masterySummary(allMastery(s.dex));
    expect(JSON.stringify(s)).toBe(before);
    // XP is what the five catches gave, nothing on top
    expect(s.xp).toBe(10 + 10 + 10 + 20 + 40);
    expect(levelOf(s.xp)).toBe(1);
    expect(s.pearl).toBe(0);
  });

  it('a sold fish keeps its place in mastery', () => {
    let s = freshSave(NOW);
    for (let i = 0; i < 5; i++) s = land(s, i, SPECIES[i].maxWeight, NOW + i);
    const held = locationMastery(s.dex, POND);
    expect(held.tiers[2].met).toBe(true);
    for (const f of [...s.fish]) s = sellFish(s, [f.id], NOW + 3_600_000).save;
    expect(s.fish).toHaveLength(0);
    expect(locationMastery(s.dex, POND)).toEqual(held);
  });

  it('progress made before the feature existed counts: an old save is read as it is', () => {
    // a save written by a client that knew nothing about mastery: just the encyclopedia
    const old = { ...freshSave(NOW), dex: dexOf(0, enough, 0.9) } as Partial<Save>;
    delete (old as Record<string, unknown>).daily;
    const loaded = loadSave(JSON.stringify(old), NOW);
    expect(loaded.status).toBe('ok');
    expect(locationMastery(loaded.save.dex, POND).level).toBe(3);
  });
});

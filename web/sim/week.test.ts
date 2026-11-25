import { describe, expect, it } from 'vitest';
import { mulberry32 } from './lab';
import { EXAMPLE_WEEK, RUSH_HOURS, TARGET_HITS, eligible, entries, fitBase, hourShares, huntsOf, outlook, playHunt, playWeeks } from './week';

const hunts = huntsOf(EXAMPLE_WEEK);
/** The crowd the repository's week file is set for: the testnet's handful of players, and a few more. */
const PLANNED = 10;

describe('the weekly season, simulated', () => {
  it('the week file carries the base chances the model fits to its crowd', () => {
    for (const h of hunts) expect(h.baseChance, h.name).toBe(fitBase(h, PLANNED));
  });

  it('a fitted hunt expects the hits it is set for, whatever the crowd', () => {
    for (const h of hunts) {
      for (const n of [10, 100, 1000, 10_000]) {
        const o = outlook(h, n, fitBase(h, n)!);
        expect(o.hits).toBeCloseTo(TARGET_HITS[h.difficulty], 1);
        expect(o.noWinner).toBeCloseTo(Math.exp(-TARGET_HITS[h.difficulty]), 2);
      }
    }
  });

  it('each hunt is open to fewer anglers than the one before, and never to nobody', () => {
    const open = hunts.map((h) => eligible(h, 1000));
    expect(open[0]).toBe(1000);
    expect(open[1]).toBeLessThanOrEqual(open[0]);
    expect(open[2]).toBeLessThan(open[1]);
    expect(open[2]).toBeGreaterThan(0);
    // newcomers fish the first two and not the third
    expect(entries(hunts[0])[0]).not.toBeNull();
    expect(entries(hunts[2])[0]).toBeNull();
  });

  it('the casts of a day add up to a day, with the opening rush on the first', () => {
    const s = hourShares(72);
    for (let d = 0; d < 3; d++) expect(s.slice(d * 24, d * 24 + 24).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(s[0]).toBeGreaterThan(s[RUSH_HOURS]);
    expect(s[30]).toBeCloseTo(1 / 24, 9);
  });

  it('the harder the hunt, the longer it tends to last and the less often it ends in its first two hours', () => {
    const o = hunts.map((h) => outlook(h, 1000, fitBase(h, 1000)!));
    expect(o[0].early).toBeGreaterThan(o[1].early);
    expect(o[1].early).toBeGreaterThan(o[2].early);
    expect(o[2].medianHours!).toBeGreaterThan(o[1].medianHours!);
    expect(o[1].medianHours!).toBeGreaterThan(o[0].medianHours!);
    // no hunt is, more often than not, over within two hours of opening
    for (const x of o) expect(x.early).toBeLessThan(0.5);
  });

  it('sampled hunts agree with the worked-out ones', () => {
    const rng = mulberry32(7);
    for (const h of hunts) {
      const base = fitBase(h, 1000)!;
      const o = outlook(h, 1000, base);
      const N = 20_000;
      let none = 0;
      let early = 0;
      for (let i = 0; i < N; i++) {
        const r = playHunt(h, 1000, base, rng);
        if (r.winner < 0) none++;
        else if (r.hours <= RUSH_HOURS) early++;
      }
      expect(none / N).toBeCloseTo(o.noWinner, 1);
      expect(early / N).toBeCloseTo(o.early, 1);
    }
  });

  it('a week is three independent hunts', () => {
    const rng = mulberry32(11);
    const bases = hunts.map((h) => fitBase(h, 1000));
    const w = playWeeks(hunts, bases, 1000, rng, 20_000);
    expect(w.winners.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    const all = hunts.reduce((p, h) => p * (1 - Math.exp(-TARGET_HITS[h.difficulty])), 1);
    expect(w.winners[3]).toBeCloseTo(all, 1);
    expect(w.allEarly).toBeLessThan(0.05);
  });
});

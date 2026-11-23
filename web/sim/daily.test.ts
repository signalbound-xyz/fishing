import { describe, expect, it } from 'vitest';
import { TUNING } from '../src/game/content';
import { generateDaily } from '../src/game/daily';
import { DAILY_PROFILES, dayStats, playDay } from './daily';
import { mulberry32, setFightsPerCell } from './lab';

// the seconds per cast come from simulated fights; fewer of them keep this test quick, and energy does not depend on them
setFightsPerCell(150);

describe('what a day of challenges costs', () => {
  const stats = DAILY_PROFILES.map((p) => ({ ...p, s: dayStats(p.profile, mulberry32(11), 60, 15) }));

  it('every set can be finished', () => {
    for (const p of DAILY_PROFILES) {
      for (let d = 0; d < 40; d++) {
        const run = playDay(generateDaily(21_000 + d, 'sim', p.profile), mulberry32(d + 1));
        expect(run.casts).toBeLessThan(400);
      }
    }
  });

  it('takes about half a bar on average, for a new player and a late one alike', () => {
    for (const { s } of stats) {
      expect(s.energyMean).toBeGreaterThan(5);
      expect(s.energyMean).toBeLessThan(0.55 * TUNING.maxEnergy);
    }
  });

  it('nine days in ten fit into one full bar', () => {
    for (const { s } of stats) {
      expect(s.energyP90).toBeLessThanOrEqual(TUNING.maxEnergy);
      expect(s.withinBar).toBeGreaterThan(0.9);
    }
  });

  it('is one sitting in one water, a few minutes long', () => {
    for (const { s } of stats) {
      expect(s.oneWater).toBe(1);
      expect(s.minutesMean).toBeGreaterThan(1.5);
      expect(s.minutesMean).toBeLessThan(10);
    }
  });
});

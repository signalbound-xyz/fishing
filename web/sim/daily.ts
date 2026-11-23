/**
 * What a day of challenges costs a player: a model player fishes for the day's set until it is done, on the
 * contracts' rules (every bite is a fish). Built on the lab's cast model, so the seconds per cast are the same
 * assumptions as everywhere else in the audit (see lab.ts: they are a model, not measurements).
 */
import { rollWeight } from '../src/game/generate';
import { LOCATIONS, SPECIES } from '../src/game/content';
import { generateDaily, setProgress, type DailySet, type DayCatch, type Profile } from '../src/game/daily';
import { RODS, rodById } from '../src/tackle/catalog';
import { WORLD_NOW, castModel, type PlayerName } from './lab';

export interface DayRun {
  energy: number;
  casts: number;
  seconds: number;
  /** Waters fished in. */
  waters: number;
}

/**
 * Fishes for one set: always for the hardest challenge still open, in the water it was sized for, with the starter
 * rod and no lure (or the rod a Rare goal was sized for). Every fish counts for every challenge it fits.
 */
export function playDay(set: DailySet, rng: () => number, player: PlayerName = 'average', maxCasts = 400): DayRun {
  const order = [2, 1, 0];
  const catches: DayCatch[] = [];
  const waters = new Set<number>();
  let energy = 0;
  let casts = 0;
  let seconds = 0;
  for (; casts < maxCasts; ) {
    const p = setProgress(set, catches);
    if (p.complete) break;
    const c = set.challenges[order.find((i) => !p.each[i].done)!];
    const rod = (c.rod ? rodById(c.rod) : undefined) ?? RODS[0];
    const m = castModel('chain', player, 'current', WORLD_NOW, c.at, { rod, lure: null });
    waters.add(c.at);
    casts++;
    energy += LOCATIONS[c.at].energyCost;
    seconds += m.seconds;
    if (rng() >= m.bite) continue;
    let x = rng();
    let id = m.lines[m.lines.length - 1].id;
    for (const l of m.lines) {
      if (x < l.p) {
        id = l.id;
        break;
      }
      x -= l.p;
    }
    catches.push({ id: `f${casts}`, speciesId: id, weight: rollWeight(SPECIES[id], m.totals.total.weight, rng), locationId: c.at });
  }
  return { energy, casts, seconds, waters: waters.size };
}

/** Model players at four points of the game: the waters they have opened and the rods they own. */
export const DAILY_PROFILES: { name: string; note: string; profile: Profile }[] = [
  { name: 'New player', note: 'Village Pond, Willow Rod', profile: { unlocked: [0], rods: ['willow'] } },
  { name: 'Level 3', note: 'pond and river, Carbon Spinner', profile: { unlocked: [0, 1], rods: ['willow', 'carbon'] } },
  { name: 'Mid game', note: 'pond, river, Deep Lake, Golden Lake; Taiga Fly Rod', profile: { unlocked: [0, 1, 2, 5], rods: ['willow', 'carbon', 'flyrod'] } },
  { name: 'Late game', note: 'every water, every rod', profile: { unlocked: [0, 1, 2, 3, 4, 5, 6, 7], rods: RODS.map((r) => r.id) } },
];

export interface DayStats {
  days: number;
  energyMean: number;
  energyMedian: number;
  energyP90: number;
  castsMean: number;
  minutesMean: number;
  minutesP90: number;
  /** Share of days done within one full bar. */
  withinBar: number;
  /** Share of days fished in a single water. */
  oneWater: number;
}

const quantile = (xs: number[], q: number): number => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];
const mean = (xs: number[]): number => xs.reduce((a, x) => a + x, 0) / xs.length;

/** `days` consecutive days of a profile, each played `runs` times. */
export function dayStats(profile: Profile, rng: () => number, days = 120, runs = 25, firstDay = 20_800, player: PlayerName = 'average', bar = WORLD_NOW.maxEnergy): DayStats {
  const all: DayRun[] = [];
  for (let d = 0; d < days; d++) {
    const set = generateDaily(firstDay + d, 'sim', profile);
    for (let i = 0; i < runs; i++) all.push(playDay(set, rng, player));
  }
  const energy = all.map((r) => r.energy);
  const minutes = all.map((r) => r.seconds / 60);
  return {
    days,
    energyMean: mean(energy),
    energyMedian: quantile(energy, 0.5),
    energyP90: quantile(energy, 0.9),
    castsMean: mean(all.map((r) => r.casts)),
    minutesMean: mean(minutes),
    minutesP90: quantile(minutes, 0.9),
    withinBar: all.filter((r) => r.energy <= bar).length / all.length,
    oneWater: all.filter((r) => r.waters === 1).length / all.length,
  };
}

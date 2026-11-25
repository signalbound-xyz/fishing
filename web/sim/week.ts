/**
 * A weekly season, simulated: three hunts one after another, each played hour by hour. `pnpm sim:week` runs it and
 * writes the weekly tables of SEASON_HUNT_BALANCE.md.
 *
 * It stands on the season simulation (sim/hunt.ts): the same model anglers, the same crowd, the contract's own
 * arithmetic for the chance of a cast. What a week adds is what a week is about: WHO may enter each hunt (its
 * level and its waters), and WHEN in a hunt the casts are made, because a hunt that is over two hours after it
 * opens is the thing a week of three hunts is meant to survive.
 *
 * The hunts are read from a week file of the repository, so the tables are about the rules that would be created,
 * not about a copy of them.
 */
import { readFileSync } from 'node:fs';
import { LOCATIONS, TUNING } from '../src/game/content';
import { CHANCE_UNIT, MAX_CHANCE, chanceOf, type HuntOdds } from '../src/game/hunt';
import { planWeek, type Difficulty, type PlannedHunt, type WeekFile } from '../src/game/week';
import { ANGLERS, crowd } from './hunt';

export function readWeek(id: string): WeekFile {
  return JSON.parse(readFileSync(new URL(`../../contracts/script/seasons/weeks/${id}.json`, import.meta.url), 'utf8')) as WeekFile;
}

/** The week file the tables are written for. */
export const EXAMPLE_WEEK = '2026-w50';

/**
 * ASSUMPTIONS about the model anglers of sim/hunt.ts that a single season did not need: the game level of each
 * kind, and the waters it has opened (Village Pond is open to everybody, Forest River from level 3, Deep Lake
 * after 8 species, Northern Sea from level 8).
 */
export const LEVEL = [2, 5, 8, 12];
export const OPENED = [[0], [0, 1, 2], [0, 1, 2, 3], [0, 1, 2, 3]];

/**
 * ASSUMPTION: of the anglers who fish a hunt on its first day, this share is waiting for it to open and makes that
 * day's casts in its first two hours. Everybody else, and everybody on the later days, is spread evenly over the
 * day. It is the opening rush: the higher it is, the more hunts end right after they open.
 */
export const EAGER = 0.15;
export const RUSH_HOURS = 2;

/** Hits a hunt is set for, by difficulty: what its base chance is fitted to. Fewer makes it last longer and end empty more often. */
export const TARGET_HITS: Record<Difficulty, number> = { easy: 3, medium: 2.5, hard: 2 };

const ENERGY_PER_HOUR = 3600 / (30 * 60);

export const oddsOf = (h: PlannedHunt, base = h.baseChance): HuntOdds => ({ baseChance: base, maxBonus: h.maxBonus, rodBonus: h.rodBonus, lureBonus: h.lureBonus, waterBonus: h.waterBonus });

/** How one kind of angler fishes a hunt, or null when it cannot enter. */
export interface Entry {
  water: number;
  /** Seasonal casts a day. */
  casts: number;
  /** The chance of one cast as a multiple of the base chance. */
  mult: number;
}

/**
 * What a kind of angler does in a hunt: nothing when its level is too low, its rod is not allowed or it has opened
 * none of the hunt's waters; otherwise it fishes the water that gives it the most chance a day, counting what the
 * water's energy lets it cast.
 */
export function entryOf(h: PlannedHunt, kind: number): Entry | null {
  const a = ANGLERS[kind];
  if (h.minLevel > 1 && LEVEL[kind] < h.minLevel) return null;
  if (h.rods.length > 0 && !h.rods.includes(a.rod)) return null;
  const days = h.durationHours / 24;
  // a full bar at the start of the hunt, and what comes back while it runs
  const energyPerDay = (TUNING.maxEnergy + h.durationHours * ENERGY_PER_HOUR) / days;
  let best: Entry | null = null;
  for (const water of h.waters) {
    if (!OPENED[kind].includes(water)) continue;
    const casts = Math.min(a.wants, h.dailyAttempts, energyPerDay / LOCATIONS[water].energyCost);
    const mult = chanceOf(oddsOf(h, 1_000_000), a.rod, a.lure, water) / 1_000_000;
    if (!best || casts * mult > best.casts * best.mult) best = { water, casts, mult };
  }
  return best;
}

export const entries = (h: PlannedHunt): (Entry | null)[] => ANGLERS.map((_, i) => entryOf(h, i));

/** Anglers of a crowd of `n` who can enter the hunt. */
export function eligible(h: PlannedHunt, n: number): number {
  const e = entries(h);
  return crowd(n).reduce((sum, people, i) => sum + (e[i] ? people : 0), 0);
}

/** Seasonal casts a crowd of `n` makes in the hunt if nobody hooks the fish before it ends. */
export function castsInHunt(h: PlannedHunt, n: number): number {
  const e = entries(h);
  return crowd(n).reduce((sum, people, i) => sum + (e[i] ? people * e[i].casts * (h.durationHours / 24) : 0), 0);
}

/** The same casts, each counted at its multiple of the base chance: times the base chance, the hits to expect. */
export function weightedCasts(h: PlannedHunt, n: number): number {
  const e = entries(h);
  return crowd(n).reduce((sum, people, i) => sum + (e[i] ? people * e[i].casts * e[i].mult * (h.durationHours / 24) : 0), 0);
}

/**
 * The base chance, in billionths, at which a crowd of `n` hooks the hunt's fish `hits` times on average. Never
 * above what the contract takes for the hunt's cap, and null when nobody in such a crowd can enter.
 */
export function fitBase(h: PlannedHunt, n: number, hits = TARGET_HITS[h.difficulty]): number | null {
  const w = weightedCasts(h, n);
  if (w <= 0) return null;
  const most = Math.floor((MAX_CHANCE * 100) / (100 + h.maxBonus));
  return Math.max(1, Math.min(Math.round((hits / w) * CHANCE_UNIT), most));
}

/** The share of a day's casts made in each hour of the hunt: `[hour] → share of that day's casts`. */
export function hourShares(hours: number): number[] {
  const out: number[] = [];
  for (let t = 0; t < hours; t++) {
    const firstDay = t < 24;
    const even = 1 / 24;
    out.push(firstDay ? (t < RUSH_HOURS ? EAGER / RUSH_HOURS : 0) + (1 - EAGER) * even : even);
  }
  return out;
}

/** Hits to expect in each hour of the hunt, from a crowd of `n` at base chance `base`. */
export function hazard(h: PlannedHunt, n: number, base: number): number[] {
  const e = entries(h);
  const people = crowd(n);
  const perDay = ANGLERS.reduce((sum, _, i) => sum + (e[i] ? (people[i] * e[i].casts * chanceOf(oddsOf(h, base), ANGLERS[i].rod, ANGLERS[i].lure, e[i].water)) / CHANCE_UNIT : 0), 0);
  return hourShares(h.durationHours).map((share) => perDay * share);
}

export interface HuntOutlook {
  eligible: number;
  /** Casts made if the hunt runs to its end. */
  casts: number;
  /** Hits to expect over the whole hunt. */
  hits: number;
  winner: number;
  noWinner: number;
  /** The chance that the fish is hooked within the first two hours. */
  early: number;
  /** Hours from the opening by which half of the hunts are over; null when fewer than half ever are. */
  medianHours: number | null;
  /** Hours to the first hit, on average, among the hunts that have one. */
  meanHours: number;
  /** Seasonal casts made before the winning one, on average, among the hunts that have a winner. */
  castsBeforeWin: number;
  /** Share of the wins by kind of angler. */
  wins: number[];
  /** Share of the casts by kind of angler. */
  castShare: number[];
}

/**
 * What to expect of one hunt, worked out and not sampled: each cast is an independent draw with a small chance,
 * so the number of hits in an hour is Poisson and the time of the first one follows from the hours' sums. The
 * sampled play below (`playHunt`) is checked against this in week.test.ts.
 */
export function outlook(h: PlannedHunt, n: number, base: number): HuntOutlook {
  const e = entries(h);
  const people = crowd(n);
  const lam = hazard(h, n, base);
  const total = lam.reduce((a, b) => a + b, 0);
  const shares = hourShares(h.durationHours);
  const castsPerDay = people.reduce((sum, p, i) => sum + (e[i] ? p * e[i].casts : 0), 0);

  let cum = 0;
  let median: number | null = null;
  let meanSum = 0;
  let castsSum = 0;
  let castsCum = 0;
  for (let t = 0; t < lam.length; t++) {
    const before = Math.exp(-cum);
    const inHour = before * (1 - Math.exp(-lam[t]));
    // within an hour the first hit falls, to a good approximation, in its middle
    meanSum += inHour * (t + 0.5);
    castsSum += inHour * (castsCum + (castsPerDay * shares[t]) / 2);
    if (median === null && 1 - Math.exp(-(cum + lam[t])) >= 0.5) median = lam[t] > 0 ? t + (Math.LN2 - cum) / lam[t] : t;
    cum += lam[t];
    castsCum += castsPerDay * shares[t];
  }
  const winner = 1 - Math.exp(-total);
  const weights = ANGLERS.map((_, i) => (e[i] ? people[i] * e[i].casts * e[i].mult : 0));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const castsBy = ANGLERS.map((_, i) => (e[i] ? people[i] * e[i].casts : 0));
  return {
    eligible: eligible(h, n),
    casts: castsInHunt(h, n),
    hits: total,
    winner,
    noWinner: 1 - winner,
    early: 1 - Math.exp(-lam.slice(0, RUSH_HOURS).reduce((a, b) => a + b, 0)),
    medianHours: median,
    meanHours: winner > 0 ? meanSum / winner : 0,
    castsBeforeWin: winner > 0 ? castsSum / winner : 0,
    wins: weights.map((w) => (wsum ? w / wsum : 0)),
    castShare: castsBy.map((c) => (castsPerDay ? c / castsPerDay : 0)),
  };
}

// ------------------------------------------------------------------ sampled play

type Rng = () => number;

function poisson(lambda: number, rng: Rng): number {
  if (lambda <= 0) return 0;
  if (lambda > 40) {
    const z = Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
  }
  const limit = Math.exp(-lambda);
  let k = 0;
  for (let p = rng(); p > limit; p *= rng()) k++;
  return k;
}

export interface HuntPlay {
  /** Index into ANGLERS of the winner's kind, or -1 when nobody hooked the fish. */
  winner: number;
  /** Hours from the opening to the winning cast. */
  hours: number;
}

/** One hunt, hour by hour: the first hour with a hit ends it, and the earliest hit of that hour is any of them. */
export function playHunt(h: PlannedHunt, n: number, base: number, rng: Rng): HuntPlay {
  const e = entries(h);
  const people = crowd(n);
  const shares = hourShares(h.durationHours);
  const perDay = ANGLERS.map((a, i) => (e[i] ? (people[i] * e[i].casts * chanceOf(oddsOf(h, base), a.rod, a.lure, e[i].water)) / CHANCE_UNIT : 0));
  for (let t = 0; t < shares.length; t++) {
    const hits = perDay.map((x) => poisson(x * shares[t], rng));
    const total = hits.reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    let pick = Math.floor(rng() * total);
    let winner = 0;
    while (pick >= hits[winner]) pick -= hits[winner++];
    return { winner, hours: t + (1 - Math.pow(1 - rng(), 1 / total)) };
  }
  return { winner: -1, hours: h.durationHours };
}

export interface WeekStats {
  weeks: number;
  /** Share of the weeks with 0, 1, 2 and 3 winners. */
  winners: number[];
  /** Share of the weeks in which every hunt was over within two hours of its opening. */
  allEarly: number;
  /** Share of the weeks in which at least one hunt was still being fished a day after it opened. */
  oneLastsADay: number;
  /** BLEND paid to winners in an average week, as a share of the pool. */
  paidShare: number;
}

/** Whole weeks: the three hunts are independent of each other, each with its own base chance. */
export function playWeeks(hunts: PlannedHunt[], bases: (number | null)[], n: number, rng: Rng, weeks: number): WeekStats {
  const winners = [0, 0, 0, 0];
  let allEarly = 0;
  let lasts = 0;
  let paid = 0;
  const pool = hunts.reduce((sum, h) => sum + h.prize, 0);
  for (let w = 0; w < weeks; w++) {
    let won = 0;
    let early = 0;
    let long = false;
    hunts.forEach((h, i) => {
      const base = bases[i];
      const r = base === null ? { winner: -1, hours: h.durationHours } : playHunt(h, n, base, rng);
      if (r.winner >= 0) {
        won++;
        paid += h.prize;
        if (r.hours <= RUSH_HOURS) early++;
      }
      if (base !== null && r.hours > 24) long = true;
    });
    winners[won]++;
    if (early === hunts.length) allEarly++;
    if (long) lasts++;
  }
  return { weeks, winners: winners.map((x) => x / weeks), allEarly: allEarly / weeks, oneLastsADay: lasts / weeks, paidShare: pool ? paid / weeks / pool : 0 };
}

/** The planned hunts of a week file, with their dates and prizes. */
export const huntsOf = (id = EXAMPLE_WEEK): PlannedHunt[] => planWeek(readWeek(id)).hunts;

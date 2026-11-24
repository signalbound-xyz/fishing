/**
 * Season Hunt, simulated: who wins a season, how often nobody does, and what tackle buys. `pnpm sim:hunt` runs it
 * and writes the tables of SEASON_HUNT_BALANCE.md.
 *
 * The chance of an attempt is the contract's own arithmetic (src/game/hunt.ts, checked against the contract). The
 * anglers are a MODEL: who shows up, with what tackle and how often they cast are assumptions written down in
 * ANGLERS below, not measurements. The conclusions that matter are the ones that hold however the mix is drawn.
 */
import { LURES, RODS } from '../src/tackle/catalog';
import { LOCATIONS, SPECIES, TUNING, XP_BY_RARITY } from '../src/game/content';
import { speciesOdds } from '../src/game/generate';
import { CHANCE_UNIT, MAX_CHANCE, atLeastOnce, chanceOf, type HuntOdds } from '../src/game/hunt';

export const SEASON_DAYS = 7;
export const DAILY_ATTEMPTS = 20;
/** Energy a wallet has over a season: a full bar, and a point every half hour (the contracts' rate, in every build). */
const ENERGY_PER_DAY = 86_400 / (30 * 60);
export const seasonEnergy = (days: number): number => TUNING.maxEnergy + days * ENERGY_PER_DAY;

const rod = (id: string): number => RODS.findIndex((r) => r.id === id);
const lure = (id: string): number => LURES.findIndex((l) => l.id === id);

/** One way of drawing the bonus table. `base` is filled in by calibration. */
export interface Config {
  name: string;
  note: string;
  odds: Omit<HuntOdds, 'baseChance'>;
}

// by id: Willow, Carbon Spinner, Ironwood, Taiga Fly, Deep Troller, Pearl Master
const ROD_BONUS = [0, 30, 20, 60, 30, 80];
// by id: Silver Spoon, Copper Spinner, Feather Fly, Glow Jig, Topwater Popper, Abyss Spoon
const LURE_BONUS = [20, 30, 60, 20, 10, 80];
// by id: Village Pond, Forest River, Deep Lake, Northern Sea
const WATER_BONUS = [0, 10, 25, 40];
const times = (row: number[], k: number): number[] => row.map((x) => Math.round(x * k));

export const CONFIGS: Config[] = [
  { name: 'Flat', note: 'tackle changes nothing', odds: { maxBonus: 0, rodBonus: ROD_BONUS, lureBonus: LURE_BONUS, waterBonus: WATER_BONUS } },
  { name: 'Gentle', note: 'the same bonuses, capped at +100% (2×)', odds: { maxBonus: 100, rodBonus: ROD_BONUS, lureBonus: LURE_BONUS, waterBonus: WATER_BONUS } },
  { name: 'Recommended', note: 'capped at +200% (3×)', odds: { maxBonus: 200, rodBonus: ROD_BONUS, lureBonus: LURE_BONUS, waterBonus: WATER_BONUS } },
  { name: 'Steep', note: 'every bonus doubled, capped at +400% (5×)', odds: { maxBonus: 400, rodBonus: times(ROD_BONUS, 2), lureBonus: times(LURE_BONUS, 2), waterBonus: times(WATER_BONUS, 2) } },
];
export const RECOMMENDED = CONFIGS[2];

/** A kind of player. ASSUMPTIONS: the tackle, how many casts a day they want, and their share of the crowd. */
export interface Angler {
  name: string;
  has: string;
  rod: number;
  lure: number | null;
  water: number;
  /** Seasonal casts a day they would make, before the daily cap and the energy. */
  wants: number;
  share: number;
}

export const ANGLERS: Angler[] = [
  { name: 'Newcomer', has: 'Willow Rod, bare hook, Village Pond', rod: rod('willow'), lure: null, water: 0, wants: 8, share: 0.55 },
  { name: 'Regular', has: 'Carbon Spinner, Copper Spinner, Forest River', rod: rod('carbon'), lure: lure('spinner'), water: 1, wants: 14, share: 0.3 },
  { name: 'Enthusiast', has: 'Taiga Fly, Feather Fly, Deep Lake', rod: rod('flyrod'), lure: lure('fly'), water: 2, wants: 18, share: 0.12 },
  { name: 'Best equipped', has: 'Pearl Master, Abyss Spoon, Northern Sea', rod: rod('pearlmaster'), lure: lure('abyss'), water: 3, wants: 20, share: 0.03 },
];

/** Casts a day one angler of this kind really makes: what they want, the daily cap, and the energy the water costs. */
export function castsPerDay(a: Angler, days = SEASON_DAYS, cap = DAILY_ATTEMPTS): number {
  const energy = seasonEnergy(days) / days / LOCATIONS[a.water].energyCost;
  return Math.min(a.wants, cap, energy);
}

/** How many anglers of each kind a crowd of `n` holds: whole people, the shares kept as well as `n` allows. */
export function crowd(n: number): number[] {
  const raw = ANGLERS.map((a) => a.share * n);
  const out = raw.map(Math.floor);
  let left = n - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length][1]]++;
  return out;
}

/** The chance multiplier of each kind of angler under a config, 1 = the base chance. */
export const multipliers = (c: Config): number[] => ANGLERS.map((a) => chanceOf({ ...c.odds, baseChance: 1_000_000 }, a.rod, a.lure, a.water) / 1_000_000);

/** Attempts over a season weighted by their multiplier: the season's total chance is this times the base chance. */
export function weightedAttempts(c: Config, n: number, days = SEASON_DAYS): number {
  const mult = multipliers(c);
  return crowd(n).reduce((sum, people, i) => sum + people * castsPerDay(ANGLERS[i], days) * days * mult[i], 0);
}

/**
 * The base chance, in billionths, at which a crowd of `n` hooks the target `expected` times over the season on
 * average. With 3 the chance that nobody does is e⁻³ ≈ 5%. Never above what the contract allows for the config.
 */
export function calibrate(c: Config, n: number, expected = 3, days = SEASON_DAYS): number {
  const base = Math.round((expected / weightedAttempts(c, n, days)) * CHANCE_UNIT);
  const most = Math.floor((MAX_CHANCE * 100) / (100 + c.odds.maxBonus));
  return Math.max(1, Math.min(base, most));
}

// ------------------------------------------------------------------ sampling

type Rng = () => number;

function poisson(lambda: number, rng: Rng): number {
  if (lambda > 40) {
    // normal approximation, Box-Muller
    const z = Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
  }
  const limit = Math.exp(-lambda);
  let k = 0;
  for (let p = rng(); p > limit; p *= rng()) k++;
  return k;
}

/** Hits among `n` attempts of chance `p` each. Exact for small `n`, Poisson where `p` is tiny and `n` large. */
function hitsAmong(n: number, p: number, rng: Rng): number {
  if (n <= 0 || p <= 0) return 0;
  if (n <= 400) {
    let k = 0;
    for (let i = 0; i < n; i++) if (rng() < p) k++;
    return k;
  }
  return Math.min(n, poisson(n * p, rng));
}

export interface SeasonResult {
  /** Index into ANGLERS of the winner's kind, or -1 when nobody hooked the target. */
  winner: number;
  /** Attempts made before the winning one. */
  attemptsBefore: number;
  /** 0-based day of the win. */
  day: number;
}

/** One season, day by day. Within a day the casts of all anglers are taken to be evenly mixed. */
export function playSeason(c: Config, base: number, people: number[], rng: Rng, days = SEASON_DAYS): SeasonResult {
  const odds = { ...c.odds, baseChance: base };
  let before = 0;
  for (let day = 0; day < days; day++) {
    const hits: number[] = [];
    let total = 0;
    let made = 0;
    for (let i = 0; i < ANGLERS.length; i++) {
      const a = ANGLERS[i];
      const n = Math.round(people[i] * castsPerDay(a, days));
      const h = hitsAmong(n, chanceOf(odds, a.rod, a.lure, a.water) / CHANCE_UNIT, rng);
      hits.push(h);
      total += h;
      made += n;
    }
    if (total > 0) {
      // the earliest of the day's hits is equally likely to be any of them
      let pick = Math.floor(rng() * total);
      let winner = 0;
      while (pick >= hits[winner]) pick -= hits[winner++];
      // where the earliest of `total` evenly spread hits falls in the day
      const first = 1 - Math.pow(1 - rng(), 1 / total);
      return { winner, attemptsBefore: before + Math.floor(first * made), day };
    }
    before += made;
  }
  return { winner: -1, attemptsBefore: before, day: days };
}

export interface CellStats {
  seasons: number;
  noWinner: number;
  /** Share of the seasons that had a winner, by kind of angler. */
  wins: number[];
  medianAttempts: number;
  meanAttempts: number;
  medianDay: number;
  /** Share of the won seasons that were over within the first day. */
  firstDay: number;
}

export function runSeasons(c: Config, base: number, n: number, rng: Rng, seasons: number, days = SEASON_DAYS): CellStats {
  const people = crowd(n);
  const wins = ANGLERS.map(() => 0);
  const attempts: number[] = [];
  const dayOf: number[] = [];
  let none = 0;
  for (let s = 0; s < seasons; s++) {
    const r = playSeason(c, base, people, rng, days);
    if (r.winner < 0) {
      none++;
      continue;
    }
    wins[r.winner]++;
    attempts.push(r.attemptsBefore + 1);
    dayOf.push(r.day + 1);
  }
  attempts.sort((a, b) => a - b);
  dayOf.sort((a, b) => a - b);
  const won = attempts.length;
  return {
    seasons,
    noWinner: none / seasons,
    wins: wins.map((w) => (won ? w / won : 0)),
    medianAttempts: won ? attempts[Math.floor(won / 2)] : 0,
    meanAttempts: won ? attempts.reduce((a, b) => a + b, 0) / won : 0,
    medianDay: won ? dayOf[Math.floor(won / 2)] : 0,
    firstDay: won ? dayOf.filter((d) => d === 1).length / won : 0,
  };
}

// ------------------------------------------------------------------ what a season costs a player

export interface Cost {
  casts: number;
  energy: number;
  /** Share of the energy a wallet has over the season. */
  energyShare: number;
  /** PEARL for the lures used up, whole packs. */
  lures: number;
  /** PEARL of rod repair the casts wear off. */
  repair: number;
  /** PEARL to own the rod, once. */
  rodPrice: number;
  /** This angler's own chance to hook the target at least once in the season, were nobody else fishing. */
  alone: number;
}

export function seasonCost(c: Config, base: number, a: Angler, days = SEASON_DAYS): Cost {
  const casts = Math.round(castsPerDay(a, days) * days);
  const energy = casts * LOCATIONS[a.water].energyCost;
  const r = RODS[a.rod];
  const l = a.lure === null ? null : LURES[a.lure];
  return {
    casts,
    energy,
    energyShare: energy / seasonEnergy(days),
    lures: l ? Math.ceil(casts / l.wear) * l.price : 0,
    repair: r.wear > 0 ? Math.round(((r.repair ?? 0) * casts) / r.wear) : 0,
    rodPrice: r.price,
    alone: atLeastOnce(chanceOf({ ...c.odds, baseChance: base }, a.rod, a.lure, a.water), casts),
  };
}

/** XP an ordinary cast at the Village Pond brings on average, every bite landed (an upper bound). */
export function pondXpPerCast(): number {
  const perCatch = speciesOdds(LOCATIONS[0], 0).reduce((sum, o) => sum + o.p * XP_BY_RARITY[SPECIES[o.speciesId].rarity], 0);
  return (TUNING.baseBite / 100) * perCatch;
}

/**
 * Many wallets in one hand: `wallets` extra newcomers, each casting the full daily cap with free tackle, join a
 * crowd of `n`. Their share of the season's total chance is the chance that one of them is the winner.
 */
export function sybilShare(c: Config, n: number, wallets: number, days = SEASON_DAYS): number {
  const honest = weightedAttempts(c, n, days);
  const mine = wallets * Math.min(DAILY_ATTEMPTS, seasonEnergy(days) / days) * days;
  return mine / (mine + honest);
}

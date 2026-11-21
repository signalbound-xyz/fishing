/**
 * The balance lab: a configurable simulation of whole careers and single sittings, built on the real game rules
 * (src/game). `pnpm sim:audit` runs the scenarios in scenarios.ts through it and writes BALANCE_AUDIT.md.
 *
 * Nothing here changes a rule. A scenario that tries other numbers (energy costs, a bigger bar, a gentler fight)
 * overrides them inside the simulation only; the game and the contracts keep what they have.
 *
 * Everything a "player" does here is a model: reaction times, misses and choices are assumptions written down in
 * PLAYERS and in the policy below. They are not measurements. The measurements come from the telemetry
 * (src/telemetry), and the two should be compared before any number is changed.
 */
import { LURES, RODS, type TackleItem } from '../src/tackle/catalog';
import { buyLocation, buyLure, buyRod, claimAchievement, equipLure, equipRod, hookFish, landFish, repairRod, rodBroken, rodRepairPrice, rollBite, sellFish, setActiveSpecial, startCast } from '../src/game/actions';
import { LOCATIONS, QUALITIES, QUALITY_MULT, SPECIALS, SPECIES, TUNING, XP_BY_RARITY, special } from '../src/game/content';
import { levelOf, xpForLevel } from '../src/game/economy';
import { totals, type Totals } from '../src/game/equipment';
import { CALM, MAX_TICKS, PULL, TICK_MS, U, WARN, basePoints, fightParams, fightStart, fightTick, pointsFor } from '../src/game/fight';
import { pickSpecies, rollWeight, speciesOdds } from '../src/game/generate';
import { CLEAN_HOOK_HEAD_START, CLEAN_HOOK_SHARE, difficultyOf, hookWindow, reelParams, simulateFight, type Difficulty, type ReelParams, type Skill } from '../src/game/minigame';
import { achievements, canEnter, holdsSpecial, isUnlocked } from '../src/game/progress';
import { freshSave } from '../src/game/save';
import { WEEK_MS, weekId, weekTotal } from '../src/game/tournament';
import type { Quality, Rarity, Save } from '../src/game/types';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

// ------------------------------------------------------------------ model players

/** How a model player sets the hook: reaction times are log-normal around `median`; `lapse` is the share of bites not watched at all. */
export interface HookSkill {
  median: number;
  sigma: number;
  lapse: number;
}

export interface Player {
  name: string;
  fight: Skill;
  hook: HookSkill;
  /** Seconds spent on the catch card (read it, keep or sell) before the next cast. */
  between: number;
}

/**
 * Three model players. ASSUMPTIONS, not data: "beginner" is the old "novice" of BALANCE.md, "experienced" its
 * "experienced", "average" sits between them. Hook reactions are a guess at a person reacting to the float
 * (simple visual reaction is about 0.25 s; finding the button costs more). Replace with telemetry when there is some.
 */
export const PLAYERS = {
  beginner: { name: 'Beginner', fight: { lag: 0.32, noise: 0.08, miss: 0.2 }, hook: { median: 0.6, sigma: 0.4, lapse: 0.05 }, between: 5 },
  average: { name: 'Average', fight: { lag: 0.25, noise: 0.06, miss: 0.1 }, hook: { median: 0.45, sigma: 0.32, lapse: 0.02 }, between: 3.5 },
  experienced: { name: 'Experienced', fight: { lag: 0.18, noise: 0.04, miss: 0.04 }, hook: { median: 0.33, sigma: 0.25, lapse: 0.01 }, between: 2.5 },
} satisfies Record<string, Player>;
export type PlayerName = keyof typeof PLAYERS;
export const PLAYER_NAMES = Object.keys(PLAYERS) as PlayerName[];

// ------------------------------------------------------------------ reel difficulty configurations

/**
 * A reel configuration maps the game's difficulty level (fish rarity + water tier, 0–5) onto an effective one,
 * which may sit between two levels: the fight parameters are then interpolated between the game's own tables.
 * So every configuration is made of fights the game already has, and applying one later is a table edit.
 */
export interface ReelConfig {
  name: string;
  note: string;
  /** Effective difficulty for each of the game's levels 0–5. */
  levels: [number, number, number, number, number, number];
}

export const REEL_CONFIGS = {
  current: { name: 'Current', note: 'the game as it is: 0 / 1 / 2 / 3 / 4 / 5', levels: [0, 1, 2, 3, 4, 5] },
  firmerEarly: { name: 'Firmer early', note: 'levels 0–1 fight like 1–1.5: 1 / 1.5 / 2 / 3 / 4 / 5', levels: [1, 1.5, 2, 3, 4, 5] },
  softerLate: { name: 'Softer late', note: 'levels 4–5 fight like 3.5–4: 0 / 1 / 2 / 3 / 3.5 / 4', levels: [0, 1, 2, 3, 3.5, 4] },
  flatter: { name: 'Flatter', note: 'both: 1 / 1.5 / 2 / 3 / 3.5 / 4', levels: [1, 1.5, 2, 3, 3.5, 4] },
  narrow: { name: 'Narrow', note: 'every fish between 2 and 3.5: 2 / 2.25 / 2.5 / 3 / 3.25 / 3.5', levels: [2, 2.25, 2.5, 3, 3.25, 3.5] },
} satisfies Record<string, ReelConfig>;
export type ReelName = keyof typeof REEL_CONFIGS;

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;
const pair = (a: [number, number], b: [number, number], f: number): [number, number] => [lerp(a[0], b[0], f), lerp(a[1], b[1], f)];

/** Fight parameters at a possibly fractional difficulty: the game's tables, interpolated. */
export function reelAt(eff: number, zone: number, ease = 0): ReelParams {
  const lo = Math.max(0, Math.min(5, Math.floor(eff))) as Difficulty;
  const hi = Math.min(5, lo + 1) as Difficulty;
  const f = Math.max(0, Math.min(1, eff - lo));
  const a = reelParams(lo, zone, ease);
  if (f === 0 || hi === lo) return a;
  const b = reelParams(hi, zone, ease);
  return { green: a.green, rise: a.rise, fall: a.fall, surge: lerp(a.surge, b.surge, f), reel: lerp(a.reel, b.reel, f), drift: lerp(a.drift, b.drift, f), calm: pair(a.calm, b.calm, f), tell: lerp(a.tell, b.tell, f), pull: pair(a.pull, b.pull, f) };
}

export function hookWindowAt(eff: number): number {
  const lo = Math.max(0, Math.min(5, Math.floor(eff))) as Difficulty;
  const hi = Math.min(5, lo + 1) as Difficulty;
  return lerp(hookWindow(lo), hookWindow(hi), Math.max(0, Math.min(1, eff - lo)));
}

// ------------------------------------------------------------------ the hook and the fight, as rates

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, error below 1e-7). */
function phi(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

export interface HookStats {
  /** Chance the window runs out. */
  miss: number;
  /** Chance of a clean hook (the fight starts closer), of all bites. */
  clean: number;
  /** Mean reaction of the hooks that were set, seconds. */
  reaction: number;
  window: number;
}

export function hookStats(p: Player, eff: number): HookStats {
  const w = hookWindowAt(eff);
  const { median, sigma, lapse } = p.hook;
  const mu = Math.log(median);
  const inTime = phi((Math.log(w) - mu) / sigma);
  const clean = phi((Math.log(w * CLEAN_HOOK_SHARE) - mu) / sigma);
  // mean of a log-normal truncated at the window
  const reaction = (Math.exp(mu + (sigma * sigma) / 2) * phi((Math.log(w) - mu - sigma * sigma) / sigma)) / Math.max(1e-9, inTime);
  return { miss: 1 - (1 - lapse) * inTime, clean: (1 - lapse) * clean, reaction, window: w };
}

export interface FightStats {
  land: number;
  snapped: number;
  slack: number;
  /** Share of each grade among the fish landed. */
  q: Record<Quality, number>;
  /** Mean length of a landed fight and of a lost one, seconds. */
  seconds: number;
  secondsLost: number;
}

export const FIGHTS_PER_CELL = 1500;
let fightsPerCell = FIGHTS_PER_CELL;
const fightCache = new Map<string, FightStats>();
/** Fewer fights per cell make the lab fast and noisy: for its own tests only. Clears what was cached. */
export function setFightsPerCell(n: number): void {
  fightsPerCell = n;
  fightCache.clear();
  modelCache.clear();
}

/** How a model player does against one kind of fight: FIGHTS_PER_CELL fights with the game's own fight code, cached. */
export function fightStats(player: PlayerName, eff: number, zone: number, ease = 0, headStart = 0): FightStats {
  const key = `${player}:${eff.toFixed(2)}:${zone.toFixed(3)}:${ease}:${headStart}`;
  const hit = fightCache.get(key);
  if (hit) return hit;
  const rng = mulberry32(hash(key));
  const params = reelAt(eff, zone, ease);
  const q: Record<Quality, number> = { D: 0, C: 0, B: 0, A: 0, S: 0 };
  let land = 0;
  let snapped = 0;
  let seconds = 0;
  let secondsLost = 0;
  for (let i = 0; i < fightsPerCell; i++) {
    const f = simulateFight(params, rng, PLAYERS[player].fight, headStart);
    if (f.landed) {
      land++;
      q[f.quality]++;
      seconds += f.seconds;
    } else {
      if (f.lost === 'snapped') snapped++;
      secondsLost += f.seconds;
    }
  }
  const lost = fightsPerCell - land;
  for (const k of QUALITIES) q[k] /= Math.max(1, land);
  const out = { land: land / fightsPerCell, snapped: snapped / fightsPerCell, slack: (lost - snapped) / fightsPerCell, q, seconds: seconds / Math.max(1, land), secondsLost: secondsLost / Math.max(1, lost) };
  fightCache.set(key, out);
  return out;
}

/** The contract's quality roll (CatchMath.rollQuality with the deployed config): share of each grade. */
export function contractQuality(rodCatch: number, rarity: number): Record<Quality, number> {
  const shift = rodCatch * 150 - rarity * 300;
  const below = (limit: number): number => Math.max(0, Math.min(1, (limit - shift) / 10_000));
  const d = below(1_500);
  const c = below(4_500);
  const b = below(7_500);
  const a = below(9_200);
  return { D: d, C: c - d, B: b - c, A: a - b, S: 1 - a };
}

const qualityMean = (q: Record<Quality, number>): number => QUALITIES.reduce((sum, k) => sum + q[k] * QUALITY_MULT[k], 0);
function pickQuality(q: Record<Quality, number>, rng: () => number): Quality {
  let x = rng();
  for (const k of QUALITIES) {
    if (x < q[k]) return k;
    x -= q[k];
  }
  return 'B';
}

// ------------------------------------------------------------------ rules and world

/**
 * What the hook and the fight decide.
 * - 'chain': production. The contract rolls the catch and its quality; a missed hook or a lost fight is another
 *   try (three at most, each easier), so skill costs time, not fish.
 * - 'local': the browser game. A missed hook or a lost fight loses the fish, and quality is how well it was fought.
 */
export type Rules = 'chain' | 'local';

export interface World {
  name: string;
  note: string;
  /** Energy per cast, by location id. */
  energyCost: number[];
  maxEnergy: number;
  /** Seconds per point of energy. */
  regenSeconds: number;
  refillPrice: number;
  refillGrowth: number;
  /** Multiplier on what a fish sells for, by the location it was caught at. 1 = as in the game. */
  payout: number[];
}

const COSTS_NOW = LOCATIONS.map((l) => l.energyCost);
const ones = (): number[] => LOCATIONS.map(() => 1);
/** Production values: the bar and the regeneration are the contract's (the local game regenerates faster on purpose). */
export const WORLD_NOW: World = { name: 'Current', note: 'the game as deployed: 20 energy, 1 per 30 min, casts cost 1–4', energyCost: COSTS_NOW, maxEnergy: 20, regenSeconds: 30 * 60, refillPrice: TUNING.refillPrice, refillGrowth: TUNING.refillGrowth, payout: ones() };

/** Seconds that do not depend on the player. ASSUMPTIONS for the two transaction waits; the rest is read off the client code. */
export const TIMING = {
  castAnimation: 0.9,
  /** Mean of biteDelay(): 2–5 s in calm and choppy water, 3–7 s in rough water. */
  biteWait: (tier: number): number => (tier >= 2 ? 5 : 3.5),
  noBiteMessage: 2.6,
  /** A missed hook or a lost fight on the contracts: the fish bites again after 2.9–4.3 s. */
  retryWait: 3.6,
  /** Sending cast() and reel(): signing plus two blocks. Not measured. */
  txCast: 4,
  txReel: 4,
};

// ------------------------------------------------------------------ one cast, as expected values and as a sample

export interface Loadout {
  rod: TackleItem;
  lure: TackleItem | null;
}

interface SpeciesLine {
  id: number;
  p: number;
  rarity: Rarity;
  /** Effective difficulty of the fight under the reel configuration. */
  eff: number;
  /** Chance that a bite of this species ends in the keepnet. */
  land: number;
  /** Mean tournament points of one landed. */
  points: number;
}

export interface CastModel {
  totals: Totals;
  bite: number;
  lines: SpeciesLine[];
  /** Per cast: chance a fish ends in the keepnet. */
  landed: number;
  /** Of the bites: lost at the hook, lost in the fight (local rules; zero on the contracts). */
  hookLost: number;
  fightLost: number;
  /** Mean tries per bite (contracts: retries; local: always 1). */
  tries: number;
  /** PEARL per cast from selling everything landed at once (fresh bonus included), before upkeep. */
  gross: number;
  /** Lure wear and rod repair per cast. */
  upkeep: number;
  xp: number;
  /** Tournament points per landed fish. */
  score: number;
  /** Wall-clock seconds per cast. */
  seconds: number;
  /** Quality mix of landed fish. */
  quality: Record<Quality, number>;
}

/** Mean of the price weight factor: weight = (min + range·min(u1,u2))·(1 + bonus), factor = weight / mean weight, clamped 0.4–3. */
function weightFactor(speciesId: number, weightBonus: number, clampLo: number, clampHi: number): number {
  const s = SPECIES[speciesId];
  const avg = s.minWeight + (s.maxWeight - s.minWeight) / 3;
  // numeric mean over the density 2(1−u) of min(u1,u2)
  let sum = 0;
  const steps = 64;
  for (let i = 0; i < steps; i++) {
    const u = (i + 0.5) / steps;
    const w = Math.min(s.maxWeight, (s.minWeight + (s.maxWeight - s.minWeight) * u) * (1 + weightBonus / 100));
    sum += 2 * (1 - u) * Math.max(clampLo, Math.min(clampHi, w / avg));
  }
  return sum / steps;
}

const RARITY_POINTS = [10, 25, 60, 150, 400, 800];
const modelCache = new Map<string, CastModel>();

/**
 * The expected result of one cast with a loadout at a location: analytic over the species pool, with the model
 * player's hook and fight rates. The water's special fish is in it at its base chance and is sold like the rest,
 * as in BALANCE.md: a player keeps one specimen for its bonus and sells the others.
 */
export function castModel(rules: Rules, player: PlayerName, reel: ReelName, world: World, locId: number, lo: Loadout, active: string | null = null): CastModel {
  const key = `${rules}:${player}:${reel}:${world.name}:${locId}:${lo.rod.id}:${lo.lure?.id ?? '-'}:${active ?? '-'}`;
  const hit = modelCache.get(key);
  if (hit) return hit;
  const loc = LOCATIONS[locId];
  const pl = PLAYERS[player];
  const cfg = REEL_CONFIGS[reel];
  const t = totals(lo.rod, lo.lure, loc, active ? special(active) ?? null : null);
  const bite = t.biteChance / 100;
  const quick = 1 - Math.min(0.4, Math.max(0, t.lure.catch) * 0.03);
  // the water's special fish bites first, at its base chance (a specimen is already in hand, so the rest are sold)
  const sp = loc.special ? special(loc.special) : undefined;
  const spChance = sp?.chance ?? 0;
  const line = (id: number, p: number): SpeciesLine => ({ id, p, rarity: SPECIES[id].rarity, eff: cfg.levels[difficultyOf(SPECIES[id].rarity, loc.tier)], land: 1, points: 0 });
  const lines: SpeciesLine[] = speciesOdds(loc, t.total.rarity, t.hiddenMult).map((o) => line(o.speciesId, o.p * (1 - spChance)));
  if (sp) lines.push(line(sp.speciesId, spChance));
  let landed = 0;
  let hookLost = 0;
  let fightLost = 0;
  let tries = 0;
  let gross = 0;
  let xp = 0;
  let score = 0;
  let fightSeconds = 0;
  const quality: Record<Quality, number> = { D: 0, C: 0, B: 0, A: 0, S: 0 };
  for (const l of lines) {
    const hk = hookStats(pl, l.eff);
    let land: number;
    let q: Record<Quality, number>;
    let secs: number;
    let nTries: number;
    if (rules === 'local') {
      const clean = fightStats(player, l.eff, t.zone, 0, CLEAN_HOOK_HEAD_START);
      const plain = fightStats(player, l.eff, t.zone, 0, 0);
      const pClean = hk.clean;
      const pPlain = 1 - hk.miss - hk.clean;
      land = pClean * clean.land + pPlain * plain.land;
      q = { D: 0, C: 0, B: 0, A: 0, S: 0 };
      for (const k of QUALITIES) q[k] = (pClean * clean.land * clean.q[k] + pPlain * plain.land * plain.q[k]) / Math.max(1e-9, land);
      secs = hk.miss * hk.window + pClean * (hk.reaction + clean.land * clean.seconds + (1 - clean.land) * clean.secondsLost) + pPlain * (hk.reaction + plain.land * plain.seconds + (1 - plain.land) * plain.secondsLost);
      hookLost += l.p * hk.miss;
      fightLost += l.p * (1 - hk.miss - land);
      nTries = 1;
    } else {
      // up to three tries; each lost fight or missed hook is one, and the fish is hauled in after the third
      land = 1;
      q = contractQuality(t.rod.catch, l.rarity);
      secs = 0;
      nTries = 0;
      let reach = 1; // chance this try happens
      for (let a = 0; a < 3 && reach > 1e-6; a++) {
        const clean = fightStats(player, l.eff, t.zone, a, CLEAN_HOOK_HEAD_START);
        const plain = fightStats(player, l.eff, t.zone, a, 0);
        const pClean = hk.clean;
        const pPlain = 1 - hk.miss - hk.clean;
        const win = pClean * clean.land + pPlain * plain.land;
        nTries += reach;
        secs += reach * (hk.miss * hk.window + pClean * (hk.reaction + clean.land * clean.seconds + (1 - clean.land) * clean.secondsLost) + pPlain * (hk.reaction + plain.land * plain.seconds + (1 - plain.land) * plain.secondsLost));
        const again = 1 - win;
        if (a < 2) secs += reach * again * TIMING.retryWait;
        reach *= again;
      }
      // whatever is left after three tries is hooked without a window and hauled in: count a hook and no fight
      secs += reach * pl.hook.median;
    }
    landed += l.p * land;
    tries += l.p * nTries;
    fightSeconds += l.p * secs;
    const sp = SPECIES[l.id];
    gross += l.p * land * sp.basePrice * weightFactor(l.id, t.total.weight, 0.4, 3) * qualityMean(q);
    l.land = land;
    l.points = RARITY_POINTS[l.rarity] * weightFactor(l.id, t.total.weight, 0.7, 1.5) * qualityMean(q);
    score += l.p * land * l.points;
    xp += l.p * land * XP_BY_RARITY[l.rarity];
    for (const k of QUALITIES) quality[k] += l.p * land * q[k];
  }
  for (const k of QUALITIES) quality[k] /= Math.max(1e-9, landed);
  const tx = rules === 'chain' ? TIMING.txCast : 0;
  const seconds = tx + TIMING.castAnimation + TIMING.biteWait(loc.tier) * quick + (1 - bite) * TIMING.noBiteMessage + bite * (fightSeconds + landed * ((rules === 'chain' ? TIMING.txReel : 0) + pl.between) + (1 - landed) * TIMING.noBiteMessage);
  const out: CastModel = {
    totals: t,
    bite,
    lines,
    landed: bite * landed,
    hookLost,
    fightLost,
    tries,
    gross: bite * gross * (1 + TUNING.freshBonus) * world.payout[locId],
    upkeep: (lo.lure ? lo.lure.price / lo.lure.wear : 0) + (lo.rod.wear ? (lo.rod.repair ?? 0) / lo.rod.wear : 0),
    xp: bite * xp,
    score: score / Math.max(1e-9, landed),
    seconds,
    quality,
  };
  modelCache.set(key, out);
  return out;
}

export const netPerEnergy = (m: CastModel, world: World, locId: number): number => (m.gross - m.upkeep) / world.energyCost[locId];

/**
 * Roughly what the best `counted` catches of `casts` casts add up to: the expected number of each species, taken
 * from the most valuable down. It ignores the spread inside a species, so it is a way to rank waters, not a forecast.
 */
export function expectedTop(m: CastModel, casts: number, counted = 10): number {
  const rows = m.lines.map((l) => ({ n: casts * m.bite * l.p * l.land, points: l.points })).sort((a, b) => b.points - a.points);
  let left = counted;
  let sum = 0;
  for (const r of rows) {
    const take = Math.min(left, r.n);
    sum += take * r.points;
    left -= take;
    if (left <= 0) break;
  }
  return sum;
}

/** The loadout with the best net PEARL per cast at a location, among the given rods and all lures. */
export function bestLoadout(
  rules: Rules,
  player: PlayerName,
  reel: ReelName,
  world: World,
  locId: number,
  rods: TackleItem[] = RODS,
  lures: (TackleItem | null)[] = [null, ...LURES],
  active: string | null = null,
  /** Energy of a week, to fish for championship points with; left out, the loadout is the best for PEARL. */
  weekEnergy?: number,
): { lo: Loadout; model: CastModel } {
  const worth = (m: CastModel): number => (weekEnergy ? expectedTop(m, weekEnergy / world.energyCost[locId]) : m.gross - m.upkeep);
  let best: { lo: Loadout; model: CastModel } | null = null;
  for (const rod of rods)
    for (const lure of lures) {
      const model = castModel(rules, player, reel, world, locId, { rod, lure }, active);
      if (!best || worth(model) > worth(best.model)) best = { lo: { rod, lure }, model };
    }
  return best!;
}

// ------------------------------------------------------------------ whole careers, day by day

/** When a model player sits down to fish, and how much they are willing to buy. */
export interface Pattern {
  name: string;
  note: string;
  /** Hours of the day (0–24) at which a sitting starts. */
  hours: number[];
  /** Play only every n-th day. */
  everyDays?: number;
  /** Energy refills bought per day at most, while the price is below what the energy is expected to earn. */
  refills: number;
}

export const PATTERNS = {
  everyOtherDay: { name: 'Every other day', note: 'one sitting every second day', hours: [20], everyDays: 2, refills: 0 },
  daily: { name: 'Once a day', note: 'one sitting in the evening', hours: [20], refills: 0 },
  twice: { name: 'Twice a day', note: 'morning and evening', hours: [8, 20], refills: 0 },
  thrice: { name: 'Three check-ins', note: 'every eight hours: no energy is ever wasted', hours: [7, 15, 23], refills: 0 },
  keen: { name: 'Keen', note: 'three check-ins and up to two refills a day', hours: [7, 15, 23], refills: 2 },
  grinder: { name: 'Grinder', note: 'a check-in every four hours and up to four refills a day', hours: [0, 4, 8, 12, 16, 20], refills: 4 },
} satisfies Record<string, Pattern>;
export type PatternName = keyof typeof PATTERNS;

/** Energy a pattern has to spend in a week: what regenerates between its sittings, plus its refills. */
export function weekEnergy(p: Pattern, w: World): number {
  const every = p.everyDays ?? 1;
  const gapHours = (24 * every) / p.hours.length;
  const perSitting = Math.min(w.maxEnergy, (gapHours * 3600) / w.regenSeconds);
  return (7 * (p.hours.length * perSitting + p.refills * w.maxEnergy)) / every;
}

export interface Scenario {
  rules: Rules;
  player: PlayerName;
  reel: ReelName;
  world: World;
  pattern: Pattern;
  /** 'new': a fresh save. 'veteran': every water open, every rod owned, level 15, a full collection of specials. */
  start: 'new' | 'veteran';
  days: number;
  /** Buy access to the secret waters for PEARL when it is on offer (local game only; the contracts have no such purchase). */
  buyLocations?: boolean;
  /** What the player fishes for: PEARL (default), or weekly championship points. */
  goal?: 'pearl' | 'score';
}

/** Where a career stood at a milestone. */
export interface Snapshot {
  day: number;
  species: number;
  achievements: number;
  rods: number;
  locations: number;
  specials: number;
  pearl: number;
}

export interface Sitting {
  day: number;
  casts: number;
  energy: number;
  seconds: number;
}

export interface CareerResult {
  /** Day (1-based) on which each milestone was reached. */
  marks: Record<string, number>;
  /** Energy spent when it was reached. */
  energyAt: Record<string, number>;
  sittings: Sitting[];
  casts: number;
  energy: number;
  landed: number;
  hookMissed: number;
  fightsLost: number;
  bites: number;
  /** PEARL from selling fish, from achievements; and spent on rods, lures, repairs, refills, locations. */
  earned: number;
  rewards: number;
  spent: { rods: number; lures: number; repairs: number; refills: number; locations: number };
  refills: number;
  /** PEARL earned by selling fish on each day (index 0 = day 1). */
  earnedByDay: number[];
  /** Weekly championship totals, one per whole week played. */
  weeks: number[];
  /** The state at chosen milestones (level 12, the end). */
  snapshots: Record<string, Snapshot>;
  save: Save;
}

const DAY = 86_400_000;
/** Day 1 starts on a week boundary, so simulated weeks are whole weeks. */
const T0 = weekId(Date.UTC(2027, 0, 7)) * WEEK_MS;

export function veteranSave(now: number): Save {
  let s: Save = { ...freshSave(now), blendWins: 99, xp: xpForLevel(15), pearl: 20_000, permanentUnlocks: LOCATIONS.map((l) => l.id), specialsFound: SPECIALS.map((x) => x.id) };
  s.rods = Object.fromEntries(RODS.map((r) => [r.id, { durability: r.wear }]));
  for (const sp of SPECIES) s.dex[sp.id] = { count: 1, best: sp.minWeight, firstAt: now };
  // one specimen of each special in hand, so its bonus can be used
  s.fish = SPECIALS.map((x, i) => ({ id: `v${i}`, speciesId: x.speciesId, rarity: SPECIES[x.speciesId].rarity, weight: SPECIES[x.speciesId].minWeight, quality: 'B' as Quality, locationId: 0, caughtAt: now - DAY, sellPrice: 0, tournamentScore: 0, isFavorite: true, isSpecial: true }));
  s.claimed = achievements(s).map((a) => a.id);
  return s;
}

/** Which special bonus is worth most at a location: tried in turn through the cast model. */
function bestActive(sc: Scenario, s: Save, locId: number, lo: Loadout): string | null {
  let best: string | null = null;
  let bestNet = castModel(sc.rules, sc.player, sc.reel, sc.world, locId, lo, null).gross;
  for (const sp of SPECIALS) {
    if (!holdsSpecial(s, sp.id)) continue;
    const g = castModel(sc.rules, sc.player, sc.reel, sc.world, locId, lo, sp.id).gross;
    if (g > bestNet) {
      bestNet = g;
      best = sp.id;
    }
  }
  return best;
}

/**
 * Plays a career day by day with a sensible, greedy player: fishes where the net PEARL per energy is best with
 * the tackle it owns, spends half of its sittings hunting a special fish it still lacks, sells every ordinary
 * fish at once, claims rewards, repairs, and buys rods in price order as soon as it can pay for them.
 */
export function career(sc: Scenario, seed: number): CareerResult {
  const rng = mulberry32(seed);
  const { world, pattern } = sc;
  let now = T0;
  let s: Save = sc.start === 'veteran' ? veteranSave(now) : { ...freshSave(now), blendWins: 99 };
  let energy = world.maxEnergy;
  let energyClock = now;
  const res: CareerResult = { marks: {}, energyAt: {}, sittings: [], casts: 0, energy: 0, landed: 0, hookMissed: 0, fightsLost: 0, bites: 0, earned: 0, rewards: 0, spent: { rods: 0, lures: 0, repairs: 0, refills: 0, locations: 0 }, refills: 0, earnedByDay: [], weeks: [], snapshots: {}, save: s };
  let day = 1;
  const mark = (k: string): void => {
    res.marks[k] ??= day;
    res.energyAt[k] ??= res.energy;
  };
  const snapshot = (k: string): void => {
    res.snapshots[k] ??= { day, species: Object.keys(s.dex).length, achievements: s.claimed.length, rods: Object.keys(s.rods).length, locations: s.permanentUnlocks.length, specials: s.specialsFound.length, pearl: s.pearl };
  };
  const settle = (to: number): void => {
    energy = Math.min(world.maxEnergy, energy + (to - energyClock) / 1000 / world.regenSeconds);
    energyClock = to;
  };

  const shop = (): void => {
    for (const a of achievements(s)) {
      if (a.done && !a.claimed) {
        const r = claimAchievement(s, a.id);
        s = r.save;
        res.rewards += r.reward;
      }
    }
    if (achievements(s).every((a) => a.claimed)) mark('all achievements');
    for (const rod of RODS) {
      if (s.rods[rod.id] && rodBroken(s, rod.id) && s.pearl >= rodRepairPrice(s, rod.id)) {
        res.spent.repairs += rodRepairPrice(s, rod.id);
        s = repairRod(s, rod.id);
      }
    }
    if (sc.buyLocations) {
      for (const loc of LOCATIONS) {
        if (loc.purchase && !isUnlocked(s, loc) && levelOf(s.xp) >= loc.purchase.level && s.pearl >= loc.purchase.price) {
          s = buyLocation(s, loc.id);
          res.spent.locations += loc.purchase.price;
          mark(`open:${loc.name}`);
          mark(`bought:${loc.name}`);
        }
      }
    }
    for (const rod of [...RODS].sort((a, b) => a.price - b.price)) {
      if (!s.rods[rod.id] && s.pearl >= rod.price) {
        const keep = s.equipped.rod;
        s = equipRod(buyRod(s, rod.id), keep);
        res.spent.rods += rod.price;
        mark(`rod:${rod.name}`);
      }
    }
    if (RODS.every((r) => s.rods[r.id])) mark('every rod');
    if (res.marks['every rod'] !== undefined && res.marks['all achievements'] !== undefined && Object.keys(s.dex).length === SPECIES.length) mark('nothing left');
  };

  const budget = weekEnergy(pattern, world);
  type Plan = { locId: number; lo: Loadout; model: CastModel; active: string | null };

  /**
   * With every rod bought PEARL has nothing left to buy, so the player turns collector: it fishes where a species
   * it has not met is most likely per point of energy, with whatever tackle and special bonus make it likeliest.
   */
  const collect = (open: typeof LOCATIONS, rods: TackleItem[], lures: (TackleItem | null)[]): Plan | null => {
    let pick: (Plan & { value: number }) | null = null;
    const actives = [null, ...SPECIALS.filter((x) => holdsSpecial(s, x.id)).map((x) => x.id)];
    for (const l of open)
      for (const rod of rods)
        for (const lure of lures)
          for (const active of actives) {
            const m = castModel(sc.rules, sc.player, sc.reel, world, l.id, { rod, lure }, active);
            const value = (m.bite * m.lines.reduce((a, x) => (s.dex[x.id] ? a : a + x.p * x.land), 0)) / world.energyCost[l.id];
            if (value > 0 && (!pick || value > pick.value)) pick = { locId: l.id, lo: { rod, lure }, model: m, active, value };
          }
    return pick;
  };

  /** Where to fish this sitting, and with what. Lures count if they are owned or can be paid for three times over. */
  const plan = (): Plan | null => {
    const open = LOCATIONS.filter((l) => canEnter(s, l) && world.energyCost[l.id] <= world.maxEnergy);
    const rods = RODS.filter((r) => s.rods[r.id] && !rodBroken(s, r.id));
    const lures: (TackleItem | null)[] = [null, ...LURES.filter((l) => s.lures[l.id] || s.pearl >= l.price * 3)];
    if (open.length === 0 || rods.length === 0) return null;
    if (sc.goal !== 'score' && RODS.every((r) => s.rods[r.id]) && Object.keys(s.dex).length < SPECIES.length) {
      const c = collect(open, rods, lures);
      if (c) return c;
    }
    const options = open.map((l) => {
      const b = bestLoadout(sc.rules, sc.player, sc.reel, world, l.id, rods, lures, null, sc.goal === 'score' ? budget : undefined);
      return { locId: l.id, ...b, value: sc.goal === 'score' ? expectedTop(b.model, budget / world.energyCost[l.id]) : netPerEnergy(b.model, world, l.id) };
    });
    const hunting = options.filter((o) => LOCATIONS[o.locId].special && !s.specialsFound.includes(LOCATIONS[o.locId].special!));
    const pool = hunting.length && rng() < 0.5 ? hunting : options;
    const pick = pool.reduce((a, b) => (b.value > a.value ? b : a));
    const active = bestActive(sc, s, pick.locId, pick.lo);
    return { locId: pick.locId, lo: pick.lo, model: castModel(sc.rules, sc.player, sc.reel, world, pick.locId, pick.lo, active), active };
  };

  const cfg = REEL_CONFIGS[sc.reel];
  const pl = PLAYERS[sc.player];
  /** Refills bought so far today. */
  let refillsOn = 0;

  const sit = (): void => {
    settle(now);
    shop();
    let p = plan();
    if (!p) return;
    const sitting: Sitting = { day, casts: 0, energy: 0, seconds: 0 };
    let refillsToday = refillsOn;
    for (;;) {
      const cost = world.energyCost[p.locId];
      if (Math.floor(energy + 1e-9) < cost) {
        const price = world.refillPrice * world.refillGrowth ** refillsToday;
        // a refill is bought only while the energy it gives is expected to earn clearly more than it costs
        const worth = (world.maxEnergy - energy) * netPerEnergy(p.model, world, p.locId);
        if (refillsToday < pattern.refills && s.pearl >= price && worth > price * 1.25) {
          s = { ...s, pearl: s.pearl - price };
          res.spent.refills += price;
          res.refills++;
          refillsToday++;
          energy = world.maxEnergy;
          continue;
        }
        break;
      }
      // tackle for this cast: the plan's rod, lure and bonus; a lure is bought when the last one wore out
      if (s.equipped.rod !== p.lo.rod.id) s = equipRod(s, p.lo.rod.id);
      const lure = p.lo.lure;
      if (lure && !s.lures[lure.id]) {
        if (s.pearl >= lure.price) {
          s = buyLure(s, lure.id);
          res.spent.lures += lure.price;
        } else {
          const again = plan();
          if (!again) break;
          p = again;
          continue;
        }
      }
      if ((s.equipped.lure ?? null) !== (lure?.id ?? null)) s = equipLure(s, lure?.id ?? null);
      if (s.activeSpecial !== p.active) s = setActiveSpecial(s, p.active);
      if (rodBroken(s, s.equipped.rod)) {
        shop();
        const again = plan();
        if (!again) break;
        p = again;
        continue;
      }
      // the rules keep their own energy bar; the scenario's bar is kept here
      s = { ...s, location: p.locId, energy: TUNING.maxEnergy, energyAt: now };
      const c = startCast(s, now);
      s = c.save;
      energy -= cost;
      sitting.casts++;
      sitting.energy += cost;
      res.casts++;
      res.energy += cost;
      const loc = LOCATIONS[p.locId];
      const quick = 1 - Math.min(0.4, Math.max(0, c.ticket.totals.lure.catch) * 0.03);
      let secs = (sc.rules === 'chain' ? TIMING.txCast : 0) + TIMING.castAnimation + TIMING.biteWait(loc.tier) * quick;
      if (!rollBite(c.ticket, rng)) secs += TIMING.noBiteMessage;
      else {
        res.bites++;
        const h = hookFish(s, c.ticket, rng);
        const sp = SPECIES[h.speciesId];
        const eff = cfg.levels[difficultyOf(sp.rarity, loc.tier)];
        const hk = hookStats(pl, eff);
        let quality: Quality | null = null;
        for (let attempt = 0; ; attempt++) {
          const forced = sc.rules === 'chain' && attempt >= 3;
          if (forced) {
            secs += pl.hook.median;
            quality = 'B';
            break;
          }
          const u = rng();
          if (u < hk.miss) {
            res.hookMissed++;
            secs += hk.window;
            if (sc.rules === 'local') break;
            secs += TIMING.retryWait;
            continue;
          }
          const clean = u < hk.miss + hk.clean;
          const f = fightStats(sc.player, eff, c.ticket.totals.zone, sc.rules === 'chain' ? Math.min(attempt, 2) : 0, clean ? CLEAN_HOOK_HEAD_START : 0);
          secs += hk.reaction;
          if (rng() < f.land) {
            secs += f.seconds;
            quality = pickQuality(f.q, rng);
            break;
          }
          res.fightsLost++;
          secs += f.secondsLost;
          if (sc.rules === 'local') break;
          if (attempt >= 2) {
            quality = 'B';
            break;
          }
          secs += TIMING.retryWait;
        }
        if (quality === null) secs += TIMING.noBiteMessage;
        else {
          // on the contracts the grade is the contract's roll, whatever the fight was like
          if (sc.rules === 'chain') quality = pickQuality(contractQuality(c.ticket.totals.rod.catch, sp.rarity), rng);
          secs += (sc.rules === 'chain' ? TIMING.txReel : 0) + pl.between;
          const l = landFish(s, c.ticket, h, quality, now);
          s = l.save;
          res.landed++;
          // one specimen of a special is kept for its bonus; the others are sold like any fish
          if (!l.fish.isSpecial || s.fish.filter((f) => f.speciesId === l.fish.speciesId).length > 1) {
            const sold = sellFish(s, [l.fish.id], now);
            const paid = Math.round(sold.earned * world.payout[p.locId]);
            s = { ...sold.save, pearl: sold.save.pearl - sold.earned + paid };
            res.earned += paid;
            res.earnedByDay[day - 1] = (res.earnedByDay[day - 1] ?? 0) + paid;
          }
          if (l.fish.isSpecial) mark(`special:${sp.name}`);
          for (const id of l.unlocked) mark(`open:${LOCATIONS[id].name}`);
          if (l.levelUp) for (let lv = levelOf(s.xp); lv >= 2 && res.marks[`level ${lv}`] === undefined; lv--) mark(`level ${lv}`);
          if (l.levelUp && levelOf(s.xp) >= 12) snapshot('level 12');
          if (Object.keys(s.dex).length === SPECIES.length) mark('every species');
          if (s.permanentUnlocks.length === LOCATIONS.length) mark('every location');
          if (l.unlocked.length || l.levelUp || l.newSpecies) {
            shop();
            const again = plan();
            if (again) p = again;
          }
        }
      }
      sitting.seconds += secs;
      now += secs * 1000;
      settle(now);
    }
    refillsOn = refillsToday;
    if (sitting.casts > 0) res.sittings.push(sitting);
    shop();
  };

  for (day = 1; day <= sc.days; day++) {
    refillsOn = 0;
    res.earnedByDay[day - 1] ??= 0;
    if ((day - 1) % (pattern.everyDays ?? 1) !== 0) continue;
    for (const hour of pattern.hours) {
      now = Math.max(now, T0 + (day - 1) * DAY + hour * 3_600_000);
      sit();
    }
  }
  const firstWeek = weekId(T0);
  for (let w = 0; w < Math.floor(sc.days / 7); w++) res.weeks.push(weekTotal(s.weeks[firstWeek + w]));
  day = sc.days;
  snapshot('end');
  res.save = s;
  return res;
}

// ------------------------------------------------------------------ small statistics

export const median = (xs: number[]): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : NaN);
export const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};

/** Runs a scenario `runs` times with different seeds. */
export function careers(sc: Scenario, runs: number, seed = 1): CareerResult[] {
  return Array.from({ length: runs }, (_, i) => career(sc, seed * 7919 + i * 104729));
}

/** Median day of a milestone across runs, and in how many runs it was reached at all. */
export function milestone(rs: CareerResult[], key: string): { day: number | null; reached: number; energy: number | null } {
  const got = rs.filter((r) => r.marks[key] !== undefined);
  if (got.length * 2 < rs.length) return { day: null, reached: got.length, energy: null };
  return { day: median(got.map((r) => r.marks[key])), reached: got.length, energy: median(got.map((r) => r.energyAt[key])) };
}

// ------------------------------------------------------------------ the cup: a tournament fight, by skill

export interface CupSetup {
  locId: number;
  rod: TackleItem;
  lure: TackleItem | null;
  /** Added to the fish's rarity to get the difficulty of the fight. */
  waterTier: number;
  casts: number;
  counted: number;
}

/**
 * Plays one tournament fight (the integer machine the contract replays, game/fight.ts) the way simulateFight plays
 * the free one: holds the middle of the green, lets go when it notices a warning (unless it misses it), takes up
 * slack during a jerk, all `lag` late and with a reading error.
 */
function cupFight(seed: bigint, d: number, green: number, skill: Skill, rng: () => number): { landed: boolean; ticks: number; good: number } {
  const p = fightParams(d, green);
  const st = fightStart(seed);
  const seen: { tension: number; mood: number }[] = [];
  const lag = Math.round((skill.lag * 1000) / TICK_MS);
  const aim = (p.lo + p.hi) / 2;
  let err = 0;
  let missed = false;
  let last = CALM;
  for (let i = 0; i < MAX_TICKS && st.result === 'fighting'; i++) {
    if (st.mood === WARN && last !== WARN) missed = rng() < skill.miss;
    last = st.mood;
    seen.push({ tension: st.tension, mood: st.mood });
    if (i % 4 === 0) err = (rng() - 0.5) * 2 * skill.noise * U;
    const was = seen[Math.max(0, seen.length - 1 - lag)];
    const tension = was.tension + err;
    const alarmed = was.mood === PULL || (was.mood === WARN && !missed);
    fightTick(st, alarmed ? tension < p.lo : tension < aim, p);
  }
  return { landed: st.result === 'landed', ticks: st.ticks, good: st.good };
}

const QUALITY_INDEX: Record<Quality, number> = { D: 0, C: 1, B: 2, A: 3, S: 4 };

/** One player's tournament: `casts` fish drawn like the contract draws them (no special fish), each fought by the model player. */
export function cupRun(setup: CupSetup, player: PlayerName, draw: () => number, rng: () => number): { total: number; landed: number; green: number; perfect: number; seconds: number } {
  const loc = LOCATIONS[setup.locId];
  const t = totals(setup.rod, setup.lure, loc);
  const odds = speciesOdds(loc, t.total.rarity, 1);
  const green = Math.round(t.zone * 125_000);
  const points: number[] = [];
  const bases: number[] = [];
  let landed = 0;
  let good = 0;
  let ticks = 0;
  // a cup cast is two transactions, the wait for the bite, the hook and the fight
  let seconds = setup.casts * (TIMING.txCast + TIMING.castAnimation + TIMING.biteWait(setup.waterTier) + PLAYERS[player].hook.median + TIMING.txReel + PLAYERS[player].between);
  for (let i = 0; i < setup.casts; i++) {
    // `draw` decides the fish and the fight's seed, `rng` only how the player plays: two players given the same
    // `draw` meet the same fish
    const sp = pickSpecies(odds, draw);
    const weight = rollWeight(sp, t.total.weight, draw);
    const q = QUALITY_INDEX[pickQuality(contractQuality(t.rod.catch, sp.rarity), draw)];
    const base = basePoints(sp.rarity, sp.minWeight, sp.maxWeight, weight, q);
    let seed = 0n;
    for (let k = 0; k < 8; k++) seed = (seed << 32n) | BigInt(Math.floor(draw() * 4294967296));
    const f = cupFight(seed, Math.min(5, sp.rarity + setup.waterTier), green, PLAYERS[player].fight, rng);
    bases.push(base);
    seconds += (f.ticks * TICK_MS) / 1000;
    if (f.landed) {
      landed++;
      good += f.good;
      ticks += f.ticks;
      points.push(pointsFor(base, f.ticks, f.good));
    }
  }
  const top = (xs: number[]): number => [...xs].sort((a, b) => b - a).slice(0, setup.counted).reduce((a, x) => a + x, 0);
  return { total: top(points), landed: landed / setup.casts, green: ticks ? good / ticks : 0, perfect: top(bases), seconds };
}

// ------------------------------------------------------------------ location mastery: how long a tier takes

export interface MasteryRule {
  /** Catches of an ordinary species for the "regular" tier, by its rarity (Common … Mythic). */
  times: number[];
  /** A "trophy" is a specimen of at least this share of the species' maximum weight. */
  trophy: number;
  /** Trophies are asked of species up to this rarity; rarer ones are a matter of luck alone. */
  trophyMaxRarity: number;
}

/**
 * Casts until each mastery tier of a water is reached, on the contracts (every bite is a fish). The tiers build on
 * each other: "known" is every species of the pool met once (the existing collection achievement, hidden species
 * included); "regular" adds `times` catches of every ordinary species; "trophy" adds a trophy-sized specimen of
 * every ordinary species up to `trophyMaxRarity`.
 */
export function masteryCasts(locId: number, lo: Loadout, rule: MasteryRule, rng: () => number, maxCasts = 400_000): { known: number; regular: number; trophy: number } {
  const loc = LOCATIONS[locId];
  const m = castModel('chain', 'average', 'current', WORLD_NOW, locId, lo);
  const pool = loc.pool.map(([id]) => id);
  const ordinary = pool.filter((id) => !SPECIES[id].hidden);
  const sized = ordinary.filter((id) => SPECIES[id].rarity <= rule.trophyMaxRarity);
  const count = new Map<number, number>();
  const bestShare = new Map<number, number>();
  const done = { known: 0, regular: 0, trophy: 0 };
  for (let casts = 1; casts <= maxCasts; casts++) {
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
    const sp = SPECIES[id];
    count.set(id, (count.get(id) ?? 0) + 1);
    bestShare.set(id, Math.max(bestShare.get(id) ?? 0, rollWeight(sp, m.totals.total.weight, rng) / sp.maxWeight));
    if (!done.known && pool.every((s) => count.has(s))) done.known = casts;
    if (done.known && !done.regular && ordinary.every((s) => (count.get(s) ?? 0) >= rule.times[SPECIES[s].rarity])) done.regular = casts;
    if (done.regular && !done.trophy && sized.every((s) => (bestShare.get(s) ?? 0) >= rule.trophy)) done.trophy = casts;
    if (done.trophy) break;
  }
  return { known: done.known || maxCasts, regular: done.regular || maxCasts, trophy: done.trophy || maxCasts };
}

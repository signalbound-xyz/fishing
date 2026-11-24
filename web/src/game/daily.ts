/**
 * Daily challenges: three fishing goals a day (easy, medium, hard), the same all day and new at 00:00 UTC.
 *
 * Everything here is a pure function. `generateDaily` turns a day, a player and what that player had at the start
 * of the day (waters and rods) into the day's three challenges, always the same three for the same input.
 * `progressOf` reads a challenge off the list of fish landed that day. Where that list comes from is not this
 * module's business: the local game keeps it in the save, the contracts' side reads it from `Caught` events
 * (play/dailyChain.ts).
 *
 * How a goal is kept honest: every candidate is sized as "expected energy with the starter rod and no lure, every
 * bite landed" at a water the player has, and thrown out when that is over the tier's budget, or when it hangs on
 * one lucky fish that one player in ten would not see within a full bar. Better tackle only helps, with one
 * exception that is why the rods are part of the input: a Rare fish is asked for only when a rod the player owns
 * makes it likely enough.
 *
 * A full day pays +4 energy, claimed by hand (game/dailyReward.ts). Single challenges pay nothing, and nothing
 * here pays PEARL.
 */
import { RODS, rodById, type TackleItem } from '../tackle/catalog';
import { LOCATIONS, SPECIES, TUNING, special } from './content';
import { totals } from './equipment';
import { speciesOdds } from './generate';
import type { DailyChallenge, DailyGoal, DailySet, DailyState, DailyTier, DayCatch, LocationDef, Rarity, Save } from './types';

export type { DailyChallenge, DailyGoal, DailySet, DailyState, DailyTier, DayCatch };

export const DAY_MS = 86_400_000;
export const utcDay = (ms: number): number => Math.floor(ms / DAY_MS);
export const dayStartMs = (day: number): number => day * DAY_MS;

/** The rules, in one place for later balancing. `pnpm sim:daily` reports what they cost a player. */
export const DAILY = {
  /** Part of every challenge id and of the seed. Bump it when a rule below changes what a day's set is. */
  version: 1,
  /** Expected energy one challenge may ask for, by tier (starter rod, no lure, every bite landed). */
  budget: { easy: 5, medium: 8, hard: 10 } as Record<DailyTier, number>,
  /** A goal that hangs on one lucky fish must be done within this much energy by nine players in ten. */
  luckEnergy: TUNING.maxEnergy,
  /** "Catch a small number of fish": never more than this. */
  maxCatch: 5,
  /** A weight goal has to be a goal: at most this share of the water's fish may reach it. */
  weightMaxShare: 0.65,
  /** Of the round weights a water can afford, only this many of the heaviest are asked for: the hard one is hard. */
  weightChoices: 2,
  /** "A Rare fish" means this rarity or better. */
  rare: 2 as Rarity,
  /** How often a water is the day's water, relative to the others: cheap waters more often, so a day costs less. */
  focusWeight: (energyCost: number): number => 4 / energyCost,
};

/**
 * The reward for all three challenges of a day. Who checks the day and how the energy is given depends on where
 * the game runs (game/dailyReward.ts): a verifier and a contract on the chain, the save in the local game.
 * Progress shown in a browser, a local save and the telemetry log are never proof for the chain's reward.
 */
export const DAILY_REWARD = {
  /** For all three challenges of a day. */
  fullSet: { kind: 'energy' as const, amount: 4 },
  /**
   * Local game: the first UTC day that pays (24 November 2026). Days completed before it stay what they were, a
   * badge and a streak. On the contracts the first day is set on the contract (`DailyRewards.firstDay`).
   */
  localFirstDay: 20_781,
};

// ------------------------------------------------------------------ what the player has

/** What generation depends on. On the contracts it is rebuilt as of the day's first block, so every device agrees. */
export interface Profile {
  /** Location ids the player can fish at. */
  unlocked: number[];
  /** Rods owned, by id. */
  rods: string[];
}

export function profileOf(s: Pick<Save, 'permanentUnlocks' | 'rods'>): Profile {
  return { unlocked: LOCATIONS.filter((l) => s.permanentUnlocks.includes(l.id)).map((l) => l.id), rods: RODS.filter((r) => s.rods[r.id]).map((r) => r.id) };
}

// ------------------------------------------------------------------ odds at a water

interface Water {
  loc: LocationDef;
  cost: number;
  /** Chance that a cast brings a fish, 0..1. */
  bite: number;
  /** Chance of each pool species per landed fish. They add up to a little under 1: the rest is the water's special. */
  species: { id: number; p: number }[];
  weightBonus: number;
}

function waterWith(loc: LocationDef, rod: TackleItem): Water {
  const t = totals(rod, null, loc, null);
  const sp = loc.special ? special(loc.special) : undefined;
  const rest = 1 - (sp?.chance ?? 0);
  return { loc, cost: loc.energyCost, bite: t.biteChance / 100, species: speciesOdds(loc, t.total.rarity, t.hiddenMult).map((o) => ({ id: o.speciesId, p: o.p * rest })), weightBonus: t.total.weight };
}

/** Energy that `fish` landed fish are expected to take at this water. */
const energyFor = (w: Water, fish: number): number => (fish / w.bite) * w.cost;

/** Energy within which nine players in ten have seen a fish that turns up once in `1/share` catches. */
function luckEnergy(w: Water, share: number): number {
  const perCast = w.bite * share;
  if (perCast >= 1) return w.cost;
  if (perCast <= 0) return Infinity;
  return Math.ceil(Math.log(0.1) / Math.log(1 - perCast)) * w.cost;
}

/** Landed fish expected until `n` different species are in the net. */
export function expectedDistinct(ps: number[], n: number): number {
  if (n > ps.filter((p) => p > 0).length) return Infinity;
  const memo = new Map<number, number>();
  const go = (mask: number, have: number): number => {
    if (have >= n) return 0;
    const hit = memo.get(mask);
    if (hit !== undefined) return hit;
    let fresh = 0;
    let next = 0;
    ps.forEach((p, i) => {
      if (mask & (1 << i) || p <= 0) return;
      fresh += p;
      next += p * go(mask | (1 << i), have + 1);
    });
    // a fish of a species already in the net changes nothing: wait for a new one
    const e = (1 + next) / fresh;
    memo.set(mask, e);
    return e;
  };
  return go(0, 0);
}

/** Share of a water's fish that weigh `grams` or more. Weights are rolled as min + range × min(u1, u2). */
export function weightShare(w: Pick<Water, 'species' | 'weightBonus'>, grams: number): number {
  return w.species.reduce((a, { id, p }) => {
    const s = SPECIES[id];
    if (grams > s.maxWeight) return a;
    const u = Math.max(0, Math.min(1, (grams / (1 + w.weightBonus / 100) - s.minWeight) / (s.maxWeight - s.minWeight)));
    return a + p * (1 - u) ** 2;
  }, 0);
}

/** Round weights a goal can name: 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10ⁿ grams. */
const NICE = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
function niceWeights(min: number, max: number): number[] {
  const out: number[] = [];
  for (let scale = 10; scale <= 1_000_000; scale *= 10) for (const m of NICE) if (m * scale >= min && m * scale <= max) out.push(Math.round(m * scale));
  return out;
}

// ------------------------------------------------------------------ ids and text

/** e.g. `d1.easy.catch.l1.n3`, `d1.medium.species.s5.n1`, `d1.hard.weight.l0.g400`. */
export function challengeId(tier: DailyTier, g: DailyGoal, version: number = DAILY.version): string {
  const parts = [`d${version}`, tier, g.kind];
  if ('loc' in g && g.loc !== undefined) parts.push(`l${g.loc}`);
  if (g.kind === 'species') parts.push(`s${g.speciesId}`);
  if (g.kind === 'rarity') parts.push(`r${g.min}`);
  parts.push(g.kind === 'weight' ? `g${g.grams}` : `n${g.count}`);
  return parts.join('.');
}

const RARITY = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic'];
const kg = (grams: number): string => (grams < 1000 ? `${grams} g` : `${(grams / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })} kg`);
const inWater = (loc: number | undefined): string => (loc === undefined ? '' : ` in ${LOCATIONS[loc].name}`);

/** The challenge in one line, as the card shows it. */
export function describeGoal(g: DailyGoal): string {
  switch (g.kind) {
    case 'catch':
      return `${g.count === 1 ? 'Catch a fish' : `Catch ${g.count} fish`}${inWater(g.loc)}`;
    case 'species':
      return g.count === 1 ? `Catch a ${SPECIES[g.speciesId].name}` : `Catch ${g.count} ${SPECIES[g.speciesId].name}`;
    case 'distinct':
      return `Catch ${g.count} different species${inWater(g.loc)}`;
    case 'rarity':
      return g.count === 1 ? `Catch a ${RARITY[g.min]} or better fish` : `Catch ${g.count} ${RARITY[g.min]} or better fish`;
    case 'weight':
      return `Land a fish of ${kg(g.grams)} or more${inWater(g.loc)}`;
  }
}

/** Where to go for it, when the goal itself does not say. */
export function goalHint(c: DailyChallenge): string | null {
  const g = c.goal;
  if ('loc' in g && g.loc !== undefined) return null;
  const where = LOCATIONS[c.at].name;
  if (g.kind === 'species') return `Lives in ${where}`;
  if (g.kind === 'rarity') return `Good odds in ${where}${c.rod ? ` with the ${rodById(c.rod)?.name ?? c.rod}` : ''}`;
  return 'Any water counts';
}

// ------------------------------------------------------------------ progress

export interface Progress {
  have: number;
  need: number;
  done: boolean;
}

/** Joins two lists of the day's catches. A fish already in the list is not added again: a fish counts once. */
export function mergeCatches(known: DayCatch[], more: DayCatch[]): DayCatch[] {
  if (more.length === 0) return known;
  const seen = new Set(known.map((c) => c.id));
  const out = [...known];
  for (const c of more) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out.length === known.length ? known : out;
}

export function progressOf(g: DailyGoal, catches: DayCatch[]): Progress {
  const here = 'loc' in g && g.loc !== undefined ? catches.filter((c) => c.locationId === g.loc) : catches;
  let have: number;
  let need: number;
  switch (g.kind) {
    case 'catch':
      [have, need] = [here.length, g.count];
      break;
    case 'species':
      [have, need] = [here.filter((c) => c.speciesId === g.speciesId).length, g.count];
      break;
    case 'distinct':
      [have, need] = [new Set(here.map((c) => c.speciesId)).size, g.count];
      break;
    case 'rarity':
      [have, need] = [here.filter((c) => (SPECIES[c.speciesId]?.rarity ?? 0) >= g.min).length, g.count];
      break;
    case 'weight':
      [have, need] = [here.reduce((a, c) => Math.max(a, c.weight), 0), g.grams];
      break;
  }
  return { have: Math.min(have, need), need, done: have >= need };
}

/** "2/3", or for a weight goal the heaviest fish so far. */
export function progressLabel(g: DailyGoal, p: Progress): string {
  if (g.kind !== 'weight') return `${p.have}/${p.need}`;
  return p.done ? `${kg(p.need)} reached` : p.have > 0 ? `best so far ${kg(p.have)}` : 'nothing yet';
}

export interface SetProgress {
  each: Progress[];
  done: number;
  complete: boolean;
}

export function setProgress(set: DailySet, catches: DayCatch[]): SetProgress {
  const each = set.challenges.map((c) => progressOf(c.goal, catches));
  const done = each.filter((p) => p.done).length;
  return { each, done, complete: done === each.length };
}

// ------------------------------------------------------------------ generation

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  // neighbouring days differ in one character: stir, so that their sets have nothing in common
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

type Candidate = Omit<DailyChallenge, 'id' | 'tier'>;
const round1 = (x: number): number => Math.round(x * 10) / 10;

/** Every goal of a tier that fits its budget at one water. `best` is the same water with the owned rod that is kindest to rare fish. */
function candidatesAt(tier: DailyTier, w: Water, best: { water: Water; rod: TackleItem }): Candidate[] {
  const budget = DAILY.budget[tier];
  const at = w.loc.id;
  const out: Candidate[] = [];
  if (tier === 'easy') {
    // as many as the budget buys, and at least one: in the dearest waters a single fish is the whole challenge
    const count = Math.max(1, Math.min(DAILY.maxCatch, Math.floor((budget * w.bite) / w.cost)));
    const energy = round1(energyFor(w, count));
    out.push({ goal: { kind: 'catch', count }, at, energy }, { goal: { kind: 'catch', count, loc: at }, at, energy });
  }
  if (tier === 'medium') {
    for (const { id, p } of w.species) {
      const sp = SPECIES[id];
      if (sp.hidden || sp.special || p <= 0) continue;
      const energy = energyFor(w, 1 / p);
      if (energy <= budget && luckEnergy(w, p) <= DAILY.luckEnergy) out.push({ goal: { kind: 'species', speciesId: id, count: 1 }, at, energy: round1(energy) });
    }
    const two = energyFor(
      w,
      expectedDistinct(
        w.species.map((s) => s.p),
        2,
      ),
    );
    if (two <= budget) out.push({ goal: { kind: 'distinct', count: 2 }, at, energy: round1(two) });
    // a Rare fish: only with a rod in hand that makes it likely enough
    const b = best.water;
    const share = b.species.reduce((a, s) => a + (SPECIES[s.id].rarity >= DAILY.rare ? s.p : 0), 0);
    if (share > 0) {
      const energy = energyFor(b, 1 / share);
      if (energy <= budget && luckEnergy(b, share) <= DAILY.luckEnergy) {
        out.push({ goal: { kind: 'rarity', min: DAILY.rare, count: 1 }, at, energy: round1(energy), ...(best.rod.id === RODS[0].id ? {} : { rod: best.rod.id }) });
      }
    }
  }
  if (tier === 'hard') {
    const light = Math.min(...w.species.map((s) => SPECIES[s.id].minWeight));
    const heavy = Math.max(...w.species.map((s) => SPECIES[s.id].maxWeight));
    const weights: Candidate[] = [];
    for (const grams of niceWeights(light, heavy)) {
      const share = weightShare(w, grams);
      if (share <= 0 || share > DAILY.weightMaxShare) continue;
      const energy = energyFor(w, 1 / share);
      if (energy <= budget && luckEnergy(w, share) <= DAILY.luckEnergy) weights.push({ goal: { kind: 'weight', grams, loc: at }, at, energy: round1(energy) });
    }
    out.push(...weights.slice(-DAILY.weightChoices));
    const three = energyFor(
      w,
      expectedDistinct(
        w.species.map((s) => s.p),
        3,
      ),
    );
    if (three <= budget) out.push({ goal: { kind: 'distinct', count: 3, loc: at }, at, energy: round1(three) });
  }
  return out;
}

/** One candidate: first a kind of goal, then one of that kind, so that a kind with many variants does not crowd out the rest. */
function pick(list: Candidate[], rng: () => number): Candidate {
  const kinds = [...new Set(list.map((c) => c.goal.kind))];
  const kind = kinds[Math.floor(rng() * kinds.length)];
  const of = list.filter((c) => c.goal.kind === kind);
  return of[Math.floor(rng() * of.length)];
}

/**
 * The day's three challenges for a player. Deterministic: the same day, player key and profile give the same set,
 * whatever the device. `playerKey` is the wallet address on the contracts and a constant in the local game.
 *
 * One water is drawn as the day's water and all three goals are sized there, so that one sitting can finish them
 * together. Only a water with an affordable goal in every tier can be the day's water. The pond always is one;
 * the waters where a cast costs 3 or 4 energy are not, because a bar of 20 has no room for three goals there.
 */
export function generateDaily(day: number, playerKey: string, profile: Profile): DailySet {
  const rng = mulberry32(hash(`daily:${DAILY.version}:${day}:${playerKey.toLowerCase()}`));
  const starter = RODS[0];
  const rods = [starter, ...RODS.filter((r) => r.id !== starter.id && profile.rods.includes(r.id))];
  const rare = (w: Water): number => w.species.reduce((a, s) => a + (SPECIES[s.id].rarity >= DAILY.rare ? s.p : 0), 0);
  const isDistinct = (c: Candidate): boolean => c.goal.kind === 'distinct';
  const hosts = LOCATIONS.filter((l) => l.id === 0 || profile.unlocked.includes(l.id)).flatMap((loc) => {
    const base = waterWith(loc, starter);
    let best = { water: base, rod: starter };
    for (const rod of rods) {
      const w = waterWith(loc, rod);
      if (rare(w) > rare(best.water) + 1e-9) best = { water: w, rod };
    }
    const lists = { easy: candidatesAt('easy', base, best), medium: candidatesAt('medium', base, best), hard: candidatesAt('hard', base, best) };
    // two "different species" goals on one day would be one goal asked twice, so one of the two must have another kind
    const ok = lists.easy.length > 0 && lists.medium.length > 0 && lists.hard.length > 0 && (lists.medium.some((c) => !isDistinct(c)) || lists.hard.some((c) => !isDistinct(c)));
    return ok ? [{ base, lists }] : [];
  });

  const weights = hosts.map((w) => DAILY.focusWeight(w.base.cost));
  let x = rng() * weights.reduce((a, b) => a + b, 0);
  let host = hosts[hosts.length - 1];
  for (let i = 0; i < hosts.length; i++) {
    if (x < weights[i]) {
      host = hosts[i];
      break;
    }
    x -= weights[i];
  }
  const make = (tier: DailyTier, c: Candidate): DailyChallenge => ({ id: challengeId(tier, c.goal), tier, ...c });
  if (!host) {
    // unreachable while the pond is open to everybody; kept so that a broken catalog cannot leave a day without a set
    const one = (tier: DailyTier): DailyChallenge => make(tier, { goal: { kind: 'catch', count: 1 }, at: 0, energy: 0 });
    return { version: DAILY.version, day, challenges: [one('easy'), one('medium'), one('hard')] };
  }
  const { lists } = host;
  const easy = pick(lists.easy, rng);
  const mediumFree = lists.medium.some((c) => !isDistinct(c));
  const hard = pick(mediumFree ? lists.hard : lists.hard.filter((c) => !isDistinct(c)), rng);
  const medium = pick(isDistinct(hard) ? lists.medium.filter((c) => !isDistinct(c)) : lists.medium, rng);
  return { version: DAILY.version, day, challenges: [make('easy', easy), make('medium', medium), make('hard', hard)] };
}

// ------------------------------------------------------------------ the local game's day

export const freshDaily = (): DailyState => ({ day: 0, set: null, catches: [], streak: { day: 0, count: 0 }, rewards: { earned: [], claimed: [] } });

/** The streak as of `today`: it lives while the last full day is today or yesterday. */
export const streakOn = (streak: DailyState['streak'], today: number): number => (streak.count > 0 && (streak.day === today || streak.day === today - 1) ? streak.count : 0);

/** The streak after `day` was completed in full. Completing the same day again changes nothing. */
export function streakAfter(streak: DailyState['streak'], day: number): DailyState['streak'] {
  if (streak.day === day && streak.count > 0) return streak;
  return { day, count: streak.day === day - 1 && streak.count > 0 ? streak.count + 1 : 1 };
}

/** The day numbers in a stored list, whatever else a hand-edited save put there. */
const days = (raw: unknown): number[] => (Array.isArray(raw) ? [...new Set(raw.filter((x): x is number => Number.isInteger(x) && x > 0))] : []);
/** Only today and yesterday can still be claimed, so nothing older is kept. */
const recent = (list: number[], today: number): number[] => list.filter((d) => d === today || d === today - 1);

/** The local game's reward book as of `today`: the days it still has to remember. */
export function localRewards(d: Pick<DailyState, 'rewards'>, today: number): NonNullable<DailyState['rewards']> {
  return { earned: recent(days(d.rewards?.earned), today), claimed: recent(days(d.rewards?.claimed), today) };
}

/** Is the stored day complete? Today's completion is read off the day itself; it is written down when the day turns. */
const completeNow = (d: DailyState): boolean => !!d.set && d.set.day === d.day && setProgress(d.set, d.catches).complete;

/** Local game: was `day` completed in full, as far as this save knows? Only a day from `localFirstDay` on can pay. */
export function localEarned(d: DailyState, day: number): boolean {
  if (day < DAILY_REWARD.localFirstDay) return false;
  return (day === d.day && completeNow(d)) || days(d.rewards?.earned).includes(day);
}
export const localClaimed = (d: DailyState, day: number): boolean => days(d.rewards?.claimed).includes(day);

/**
 * Local game: writes down that the reward of `day` was taken. The rules (complete, unclaimed, in time, room in the
 * bar) are the caller's (game/actions.ts, `claimDailyReward`); a day already written is not written twice.
 */
export function markLocalClaim(d: DailyState, day: number, today: number): DailyState {
  const book = localRewards(d, today);
  if (book.claimed.includes(day)) return d;
  return { ...d, rewards: { earned: book.earned, claimed: recent([...book.claimed, day], today) } };
}

/**
 * The daily state as of `now`: a new UTC day starts with an empty list and a freshly drawn set, fixed for the day
 * from what the player has at that moment. Returns the same object when nothing had to change.
 *
 * When the day turns, a day that was completed is written into the reward book: its catches are dropped here, and
 * its reward stays claimable for one more day.
 */
export function rollDaily(d: DailyState, now: number, playerKey: string, profile: Profile): DailyState {
  const today = utcDay(now);
  if (d.day === today && d.set && d.set.version === DAILY.version && d.set.day === today) return d;
  const book = localRewards(d, today);
  const earned = d.day !== today && localEarned(d, d.day) ? recent([...book.earned, d.day], today) : book.earned;
  return { day: today, set: generateDaily(today, playerKey, profile), catches: d.day === today ? d.catches : [], streak: d.streak, rewards: { earned: [...new Set(earned)], claimed: book.claimed } };
}

/** Adds a landed fish to the day. `profile` is what the player had before this fish, in case it is the day's first. */
export function recordCatch(d: DailyState, c: DayCatch, now: number, playerKey: string, profile: Profile): DailyState {
  const r = rollDaily(d, now, playerKey, profile);
  const catches = mergeCatches(r.catches, [c]);
  if (catches === r.catches) return r;
  const complete = !!r.set && setProgress(r.set, catches).complete;
  return { ...r, catches, streak: complete ? streakAfter(r.streak, r.day) : r.streak };
}

/** The player key of the local game: there is one player per browser. */
export const LOCAL_PLAYER = 'local';

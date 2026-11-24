/**
 * Season Hunt: the rules a client needs, as plain arithmetic. The contract (contracts/src/SeasonHunt.sol) is what
 * decides; everything here mirrors it so that the page can explain an attempt before it is made, and is checked
 * against the contract's own numbers in hunt.test.ts.
 *
 * A season names one target fish and a prize. A seasonal cast is an ordinary cast made through the hunt; on top of
 * the ordinary catch it is one attempt at the target, with a chance that depends on the rod, the lure and the water.
 * The first attempt, in the order the casts entered the chain, that hooks the target wins the whole prize.
 */

/** Chances are whole numbers of billionths, as in the contract. */
export const CHANCE_UNIT = 1_000_000_000;
/** No attempt, with any tackle, is more likely than one in ten. */
export const MAX_CHANCE = 100_000_000;

/** What decides the chance of an attempt. Bonuses are percentages of the base chance, indexed by id. */
export interface HuntOdds {
  baseChance: number;
  /** Cap on the bonuses added up, in percent of the base chance. */
  maxBonus: number;
  rodBonus: readonly number[];
  lureBonus: readonly number[];
  waterBonus: readonly number[];
}

/** The parts of an attempt's bonus, in percent of the base chance. `lure` is null for a bare hook. */
export function bonusParts(o: HuntOdds, rod: number, lure: number | null, water: number): { rod: number; lure: number; water: number; total: number; capped: boolean } {
  const r = o.rodBonus[rod] ?? 0;
  const l = lure === null ? 0 : (o.lureBonus[lure] ?? 0);
  const w = o.waterBonus[water] ?? 0;
  const sum = r + l + w;
  return { rod: r, lure: l, water: w, total: Math.min(sum, o.maxBonus), capped: sum > o.maxBonus };
}

/** The chance of one attempt, in billionths: the contract's `chance(id, rod, lure + 1, water)`. */
export function chanceOf(o: HuntOdds, rod: number, lure: number | null, water: number): number {
  return Math.floor((o.baseChance * (100 + bonusParts(o, rod, lure, water).total)) / 100);
}

/** The most any tackle can reach in this season. */
export const bestChance = (o: HuntOdds): number => Math.floor((o.baseChance * (100 + o.maxBonus)) / 100);

/** The chance that at least one of `attempts` attempts hooks the target, 0…1. */
export function atLeastOnce(chance: number, attempts: number): number {
  return 1 - Math.pow(1 - chance / CHANCE_UNIT, attempts);
}

/** "1 in 4,800": how a chance is shown. Odds read truer than a percentage with three zeroes after the point. */
export function oddsText(chance: number): string {
  if (chance <= 0) return 'no chance';
  const n = CHANCE_UNIT / chance;
  const rounded = n >= 10_000 ? Math.round(n / 100) * 100 : n >= 1000 ? Math.round(n / 10) * 10 : Math.round(n);
  return `1 in ${rounded.toLocaleString('en-US')}`;
}

/** "×1.6": a chance against the base chance. */
export function timesText(o: HuntOdds, chance: number): string {
  const x = chance / o.baseChance;
  return `×${(Math.round(x * 100) / 100).toString()}`;
}

/** A share 0…1 as a percentage that never pretends to more precision than it has. */
export function shareText(p: number): string {
  const pct = p * 100;
  if (pct <= 0) return '0%';
  if (pct < 0.1) return 'under 0.1%';
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

/** The season's states, in the order of the contract's enum. */
export const HUNT_STATUS = ['upcoming', 'active', 'closing', 'winner', 'expired', 'cancelled'] as const;
export type HuntStatus = (typeof HUNT_STATUS)[number];

/** What a season's state is called on the page. */
export const STATUS_LABEL: Record<HuntStatus, string> = {
  upcoming: 'Upcoming',
  active: 'Active',
  closing: 'Closing',
  winner: 'Winner found',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

/** The ids set in a bit mask, lowest first. */
export function idsOf(mask: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 16; i++) if ((mask >> i) & 1) out.push(i);
  return out;
}

/** The game level a total of XP makes: level L starts at 50·L·(L−1). */
export function levelOfXp(xp: number): number {
  let level = 1;
  while (50 * (level + 1) * level <= xp) level++;
  return level;
}

// ------------------------------------------------------------------ the drand beacon

/** A drand network, as the beacon contract holds it. */
export interface DrandNet {
  genesis: number;
  period: number;
  /** Seconds between a cast and the earliest round it can be bound to. */
  margin: number;
}

/** The round an attempt cast at `castTime` (the block's timestamp) is bound to: DrandBeacon.roundAt. */
export function drandRound(net: DrandNet, castTime: number): number {
  const t = castTime + net.margin;
  if (t <= net.genesis) return 1;
  return Math.floor((t - net.genesis + net.period - 1) / net.period) + 1;
}

/** When that round is made, in unix seconds. */
export const drandTime = (net: DrandNet, round: number): number => net.genesis + (round - 1) * net.period;

/** `2h 05m`, `4d 3h`, `45s`: what is left of a countdown. */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

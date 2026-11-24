/**
 * A player's fishing career by water: how many casts and catches each of the eight locations has seen.
 *
 * The lifetime totals are not here. They are in the player's state (casts, catches, the encyclopedia, the records:
 * `Save`), which on the contracts is read straight from the game and is the same on every device. What the state
 * does not keep is where: a species lives in more than one water, a sold fish is gone from the keepnet, so neither
 * the encyclopedia nor the keepnet can say how many fish came out of which water. The game's events can: `Casted`,
 * `Caught` and `Missed` each name the player and the location.
 *
 * On the contracts this module folds those events into counts per water (`CareerLog`). The log remembers the last
 * block it has read, so a range is folded once however often it is offered, and a reload reads on from where the
 * last one stopped. What makes the result more than a hope: after every read the counts are held against the
 * contract's own counters as of the same block (`check`). They add up, or the page says they do not.
 *
 * In the local game the save counts by water itself, from the day this was added (`Save.career`); what was fished
 * before that is in the lifetime totals and belongs to no water.
 *
 * Pure: the chain is behind the small `CareerReader`, the cache is a string. play/career.ts supplies both.
 */
import { LOCATIONS, SPECIES } from './content';
import { levelOf, xpForLevel } from './economy';
import type { CatchRecord, LocationDef, Rarity, Save, WaterCount } from './types';

export type { WaterCount };
export type Waters = Record<number, WaterCount>;

export const emptyWater = (): WaterCount => ({ casts: 0, catches: 0, misses: 0, species: {} });

/** What the game's events say about one player. An expired cast names no water and adds nothing here. */
export type CareerEvent = { kind: 'cast'; locationId: number } | { kind: 'catch'; locationId: number; speciesId: number } | { kind: 'miss'; locationId: number };

/** Counts with `events` added. Nothing here knows whether an event was seen before: the caller offers each once. */
export function addEvents(waters: Waters, events: readonly CareerEvent[]): Waters {
  if (events.length === 0) return waters;
  const out: Waters = { ...waters };
  for (const e of events) {
    const w = out[e.locationId] === waters[e.locationId] ? { ...(waters[e.locationId] ?? emptyWater()) } : out[e.locationId];
    if (e.kind === 'cast') w.casts++;
    else if (e.kind === 'miss') w.misses++;
    else {
      w.catches++;
      w.species = { ...w.species, [e.speciesId]: (w.species[e.speciesId] ?? 0) + 1 };
    }
    out[e.locationId] = w;
  }
  return out;
}

export const totalsOf = (waters: Waters): { casts: number; catches: number } =>
  Object.values(waters).reduce((a, w) => ({ casts: a.casts + w.casts, catches: a.catches + w.catches }), { casts: 0, catches: 0 });

/** Fish landed per cast, 0..1; null before the first cast. */
export const catchRate = (catches: number, casts: number): number | null => (casts > 0 ? Math.min(1, catches / casts) : null);

/** "62.5%", or a dash when there is nothing to divide by. */
export const fmtRate = (r: number | null): string => (r === null ? '—' : `${(Math.round(r * 1000) / 10).toLocaleString('en-US')}%`);

// ------------------------------------------------------------------ the lifetime numbers (the player's state)

export interface RarityCount {
  rarity: Rarity;
  /** Species of this rarity in the catalog, and how many of them the player has discovered. */
  species: number;
  discovered: number;
  /** Fish of this rarity ever landed: the encyclopedia counts every one, sold or not. */
  caught: number;
}

export interface Lifetime {
  catches: number;
  casts: number;
  rate: number | null;
  discovered: number;
  species: number;
  biggest: CatchRecord | null;
  /** Legendary and Mythic fish ever landed. */
  legendary: number;
  mythic: number;
  unlocked: number;
  waters: number;
  level: number;
  xp: number;
  /** XP into the current level, and what the level takes. */
  levelXp: number;
  levelNeeds: number;
  byRarity: RarityCount[];
}

/**
 * The lifetime numbers, read off the player's state and nothing else. On the contracts that state is the game's
 * own (casts, catches, the encyclopedia, the records), so these are the same on every device and do not depend on
 * what is in the keepnet today.
 */
export function lifetime(s: Save): Lifetime {
  const byRarity: RarityCount[] = ([0, 1, 2, 3, 4, 5] as Rarity[]).map((rarity) => {
    const of = SPECIES.filter((sp) => sp.rarity === rarity);
    return { rarity, species: of.length, discovered: of.filter((sp) => s.dex[sp.id]).length, caught: of.reduce((n, sp) => n + (s.dex[sp.id]?.count ?? 0), 0) };
  });
  const level = levelOf(s.xp);
  return {
    catches: s.stats.catches,
    casts: s.stats.casts,
    rate: catchRate(s.stats.catches, s.stats.casts),
    discovered: Object.keys(s.dex).length,
    species: SPECIES.length,
    biggest: s.records.overall,
    legendary: byRarity[4].caught,
    mythic: byRarity[5].caught,
    unlocked: s.permanentUnlocks.length,
    waters: LOCATIONS.length,
    level,
    xp: s.xp,
    levelXp: s.xp - xpForLevel(level),
    levelNeeds: xpForLevel(level + 1) - xpForLevel(level),
    byRarity,
  };
}

// ------------------------------------------------------------------ one water, for the page

export interface WaterStats {
  locationId: number;
  casts: number;
  catches: number;
  /** Casts that got no bite. Counted on the contracts only. */
  misses: number;
  rate: number | null;
  /** The species landed here most often; the lower id wins a tie, so the answer does not flicker. */
  top: { speciesId: number; count: number } | null;
  /** Every species landed here, most frequent first. */
  species: { speciesId: number; count: number }[];
  /** This water's catches against the busiest water's, 0..1: the length of its bar. */
  share: number;
}

/** All locations, the ones with no activity included, in the catalog's order. */
export function waterStats(waters: Waters, locations: readonly LocationDef[] = LOCATIONS): WaterStats[] {
  const most = Math.max(0, ...locations.map((l) => waters[l.id]?.catches ?? 0));
  return locations.map((l) => {
    const w = waters[l.id] ?? emptyWater();
    const species = Object.entries(w.species)
      .map(([id, count]) => ({ speciesId: Number(id), count }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count || a.speciesId - b.speciesId);
    return { locationId: l.id, casts: w.casts, catches: w.catches, misses: w.misses, rate: catchRate(w.catches, w.casts), top: species[0] ?? null, species, share: most > 0 ? w.catches / most : 0 };
  });
}

// ------------------------------------------------------------------ the log of a player on a chain

export const CAREER_VERSION = 1;

/** Block numbers are decimal strings: JSON has no bigint. */
export interface CareerLog {
  v: number;
  /** The first block of the history: the game's deployment. */
  from: string;
  /** The last block folded in; `from − 1` while nothing has been read. */
  to: string;
  /** Hash of block `to`, to notice a chain that changed under the cache. Empty until a read has reached its end. */
  hash: string;
  waters: Waters;
  /** The contract's own lifetime counters as of block `to`: what the events have to add up to. Null until read. */
  check: { casts: number; catches: number } | null;
}

export const emptyCareer = (from: bigint): CareerLog => ({ v: CAREER_VERSION, from: from.toString(), to: (from - 1n).toString(), hash: '', waters: {}, check: null });

export interface Range {
  from: bigint;
  to: bigint;
  events: readonly CareerEvent[];
}

/**
 * Folds the events of blocks `from..to` into the log. Only the range that starts right after the log's last block
 * is taken: a range read twice, an overlapping one or one with a gap before it changes nothing. That is what keeps
 * a count from doubling, whatever the caller does.
 */
export function foldRange(log: CareerLog, r: Range): CareerLog {
  if (r.from !== BigInt(log.to) + 1n || r.to < r.from) return log;
  return { ...log, to: r.to.toString(), hash: '', check: null, waters: addEvents(log.waters, r.events) };
}

export type Completeness =
  /** Every cast and catch the contract counts is in the log. */
  | { state: 'complete' }
  /** The contract's counters could not be read at the log's block, so nothing says whether the log is whole. */
  | { state: 'unverified' }
  /** The events add up to something else than the contract's counters. `casts`, `catches`: what is missing (negative: too many). */
  | { state: 'mismatch'; casts: number; catches: number };

export function completeness(log: CareerLog): Completeness {
  if (!log.check) return { state: 'unverified' };
  const sum = totalsOf(log.waters);
  return sum.casts === log.check.casts && sum.catches === log.check.catches ? { state: 'complete' } : { state: 'mismatch', casts: log.check.casts - sum.casts, catches: log.check.catches - sum.catches };
}

// ------------------------------------------------------------------ the cache

const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const blockString = (v: unknown): v is string => typeof v === 'string' && /^-?\d{1,30}$/.test(v);

function parseWaters(raw: unknown): Waters | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: Waters = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(k);
    if (!Number.isInteger(id) || id < 0 || id > 255 || typeof v !== 'object' || v === null) return null;
    const w = v as Record<string, unknown>;
    if (!count(w.casts) || !count(w.catches) || !count(w.misses) || typeof w.species !== 'object' || w.species === null) return null;
    const species: Record<number, number> = {};
    for (const [sk, sv] of Object.entries(w.species as Record<string, unknown>)) {
      if (!Number.isInteger(Number(sk)) || !count(sv)) return null;
      species[Number(sk)] = sv;
    }
    out[id] = { casts: w.casts, catches: w.catches, misses: w.misses, species };
  }
  return out;
}

/**
 * Where a log is kept in the browser: one per chain, game contract and account, so another wallet, another network
 * or a redeployed game never reads the counts of the one before.
 */
export const careerKey = (chainId: number, game: string, account: string): string => `onchain-fishing:career:${chainId}:${game.toLowerCase()}:${account.toLowerCase()}`;

export const serializeCareer = (log: CareerLog): string => JSON.stringify(log);

/**
 * A cached log, or null when the text is not one, is of another version or starts at another block than the game
 * does now. A cache that cannot be trusted is thrown away and the chain is read again: it has it all.
 */
export function parseCareer(json: string | null, from: bigint): CareerLog | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== CAREER_VERSION || o.from !== from.toString() || !blockString(o.to) || typeof o.hash !== 'string') return null;
  if (BigInt(o.to) < from - 1n) return null;
  const waters = parseWaters(o.waters);
  if (!waters) return null;
  const c = o.check as Record<string, unknown> | null | undefined;
  const check = c && count(c.casts) && count(c.catches) ? { casts: c.casts, catches: c.catches } : null;
  return { v: CAREER_VERSION, from: o.from, to: o.to, hash: o.hash, waters, check };
}

// ------------------------------------------------------------------ reading the chain

/** What the sync needs from a chain, for one player. Both ends of a range are included. */
export interface CareerReader {
  head(): Promise<bigint>;
  hash(block: bigint): Promise<string>;
  events(from: bigint, to: bigint): Promise<CareerEvent[]>;
  /** The contract's lifetime counters of the player as of `block`. */
  totals(block: bigint): Promise<{ casts: number; catches: number }>;
}

export interface SyncOptions {
  /** Blocks per log query. The Fluent RPC refuses more than 100,000. */
  chunk?: bigint;
  /** Log queries in flight at once. */
  parallel?: number;
  /** Blocks under the head that are left for the next read: what is folded is never taken back. */
  confirmations?: bigint;
  /** After every batch: the log so far, and how much of the history has been read, 0..1. */
  onProgress?: (log: CareerLog, done: number) => void;
  /** Asked before every batch; true ends the read where it is (the account changed, the page was left). */
  stop?: () => boolean;
}

export interface Synced {
  log: CareerLog;
  /** The chain no longer has the block the cache ended at: the cache was dropped and the history read again. */
  reorged: boolean;
  /** `stop` ended the read before the head was reached. */
  stopped: boolean;
}

export const CAREER_CHUNK = 90_000n;
export const CAREER_CONFIRMATIONS = 5n;

/**
 * Reads the history on from where `log` stops, up to `confirmations` under the head, then holds the counts against
 * the contract's counters at that same block. Throws when the chain cannot be read; everything folded until then
 * has been handed to `onProgress`, and the next call reads on from there.
 */
export async function syncCareer(r: CareerReader, log: CareerLog, o: SyncOptions = {}): Promise<Synced> {
  const chunk = o.chunk ?? CAREER_CHUNK;
  const parallel = Math.max(1, o.parallel ?? 3);
  const first = BigInt(log.from);
  const head = await r.head();
  const safe = head - (o.confirmations ?? CAREER_CONFIRMATIONS);
  let cur = log;
  let reorged = false;

  // the cache ends at a block this chain still has, with the hash it had: otherwise the history is read again
  if (cur.hash !== '' && BigInt(cur.to) >= first && BigInt(cur.to) <= head && (await r.hash(BigInt(cur.to))).toLowerCase() !== cur.hash.toLowerCase()) {
    cur = emptyCareer(first);
    reorged = true;
  }

  const start = BigInt(cur.to) + 1n;
  if (start <= safe) {
    const ranges: [bigint, bigint][] = [];
    for (let a = start; a <= safe; a += chunk) ranges.push([a, a + chunk - 1n < safe ? a + chunk - 1n : safe]);
    const all = Number(safe - first + 1n);
    for (let i = 0; i < ranges.length; i += parallel) {
      if (o.stop?.()) return { log: cur, reorged, stopped: true };
      const got = await Promise.all(ranges.slice(i, i + parallel).map(async ([from, to]) => ({ from, to, events: await r.events(from, to) })));
      // in block order: a range is only taken right after the one before it
      for (const g of got) cur = foldRange(cur, g);
      o.onProgress?.(cur, all > 0 ? Math.min(1, Number(BigInt(cur.to) - first + 1n) / all) : 1);
    }
  }

  // the end of the read: the block's hash for the next visit, and the contract's word on what the counts should be
  if (BigInt(cur.to) >= first && (cur.hash === '' || cur.check === null)) {
    const at = BigInt(cur.to);
    const hash = cur.hash !== '' ? cur.hash : await r.hash(at);
    const check = cur.check ?? (await r.totals(at).catch(() => null));
    cur = { ...cur, hash, check };
    o.onProgress?.(cur, 1);
  }
  return { log: cur, reorged, stopped: false };
}

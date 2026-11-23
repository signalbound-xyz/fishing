/**
 * Daily challenges on the contracts: a player's day, read from the game's events.
 *
 * The contracts store nothing about challenges, and they do not need to: the `Caught` event names the player, the
 * fish, its species, weight and water, and the block it is in says when. A day's progress is the list of those
 * events between the first block of the UTC day and the next day's first block. `LocationUnlocked` and
 * `RodBought` in the same range say what the player gained during the day, which is how every device arrives at
 * the same "what the player had when the day began", and so at the same three challenges.
 *
 * This module is the pure half: the log of a day, how events are folded into it (a fish counts once however often
 * it is read), how the day's first block is found, and what the logs say about the set, its completion and the
 * streak. The chain is behind the small `ChainReader` interface; play/daily.ts supplies the real one and the tests
 * a fake.
 *
 * Trust: the log is a cache of public chain data in this browser. It is good for showing progress. It is not proof
 * for a reward: whoever pays one has to check the catches themselves.
 */
import { RODS } from '../tackle/catalog';
import { generateDaily, mergeCatches, setProgress, type DailySet, type DayCatch, type Profile } from './daily';

export const DAY_SECONDS = 86_400;

/** One UTC day of one player. Block numbers are decimal strings: JSON has no bigint. */
export interface DayLog {
  day: number;
  /** The day's first block. */
  from: string;
  /** The last block read; `from − 1` when nothing has been read yet. */
  to: string;
  /** The day is over and read to its last block: nothing will ever be added. */
  closed: boolean;
  catches: DayCatch[];
  /** Location ids unlocked during the day. */
  unlocked: number[];
  /** Rods bought during the day, by index in the catalog. */
  rods: number[];
}

export type DayEvent = { kind: 'catch'; fish: DayCatch } | { kind: 'unlock'; locationId: number } | { kind: 'rod'; rod: number };

export const emptyLog = (day: number, from: bigint): DayLog => ({ day, from: from.toString(), to: (from - 1n).toString(), closed: false, catches: [], unlocked: [], rods: [] });

const union = (a: number[], b: number[]): number[] => (b.every((x) => a.includes(x)) ? a : [...new Set([...a, ...b])].sort((x, y) => x - y));

/**
 * Folds events read up to block `to` into a log. Reading a range twice, or two overlapping ranges, changes
 * nothing: a fish is known by its id, an unlock and a rod by what they are.
 */
export function applyEvents(log: DayLog, events: DayEvent[], to: bigint, closed = false): DayLog {
  const fish: DayCatch[] = [];
  const unlocked: number[] = [];
  const rods: number[] = [];
  for (const e of events) {
    if (e.kind === 'catch') fish.push(e.fish);
    else if (e.kind === 'unlock') unlocked.push(e.locationId);
    else rods.push(e.rod);
  }
  const reach = to > BigInt(log.to) ? to.toString() : log.to;
  return { ...log, to: reach, closed: log.closed || closed, catches: mergeCatches(log.catches, fish), unlocked: union(log.unlocked, unlocked), rods: union(log.rods, rods) };
}

// ------------------------------------------------------------------ reading the chain

export interface Head {
  number: bigint;
  /** Seconds. */
  timestamp: number;
}

/** What the reader needs from a chain. `events` is for one player, both ends included. */
export interface ChainReader {
  head(): Promise<Head>;
  timestamp(block: bigint): Promise<number>;
  events(from: bigint, to: bigint): Promise<DayEvent[]>;
}

/** Blocks asked for in one log query. The Fluent RPC refuses more than 100,000. */
export const CHUNK = 50_000n;
/** Blocks under the head that are shown but not yet written to the cache. */
export const CONFIRMATIONS = 2n;

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/**
 * The first block whose timestamp is `ts` (seconds) or later, never below `floor`; `head.number + 1` when the
 * chain has not reached that moment. A guess from the block time lands next to it, so this is a handful of reads.
 */
export async function firstBlockAt(r: ChainReader, ts: number, head: Head, floor: bigint, blockSeconds = 1): Promise<bigint> {
  if (head.timestamp < ts) return head.number + 1n;
  let hi = head.number;
  let lo = max(floor, hi - BigInt(Math.ceil((head.timestamp - ts) / blockSeconds)) - 8n);
  let step = 64n;
  // walk down until a block from before `ts` is found
  for (;;) {
    if ((await r.timestamp(lo)) < ts) break;
    if (lo <= floor) return floor;
    hi = lo;
    lo = max(floor, lo - step);
    step *= 4n;
  }
  // a block a little above the guess is usually already past `ts`: that leaves a short stretch to halve
  if (hi - lo > 32n) {
    const near = lo + 32n;
    if ((await r.timestamp(near)) >= ts) hi = near;
    else lo = near;
  }
  while (hi - lo > 1n) {
    const mid = lo + (hi - lo) / 2n;
    if ((await r.timestamp(mid)) >= ts) hi = mid;
    else lo = mid;
  }
  return hi;
}

async function eventsBetween(r: ChainReader, from: bigint, to: bigint): Promise<DayEvent[]> {
  const out: DayEvent[] = [];
  for (let a = from; a <= to; a += CHUNK) out.push(...(await r.events(a, min(to, a + CHUNK - 1n))));
  return out;
}

/**
 * Reads on from where `log` stops, up to block `last` (the head, or the day's last block when the day is over).
 * `confirmed` is what may be cached: everything `CONFIRMATIONS` blocks under the head. `live` adds the newest
 * blocks on top, for the screen. Throws when the chain cannot be read; the caller keeps the log it had.
 */
export async function readDay(r: ChainReader, log: DayLog, last: bigint, head: bigint, dayOver: boolean): Promise<{ confirmed: DayLog; live: DayLog }> {
  if (log.closed) return { confirmed: log, live: log };
  const safe = min(last, head - CONFIRMATIONS);
  let confirmed = log;
  if (safe > BigInt(log.to)) confirmed = applyEvents(log, await eventsBetween(r, BigInt(log.to) + 1n, safe), safe, dayOver && safe === last);
  else if (dayOver && safe === last && BigInt(log.to) >= last) confirmed = { ...log, closed: true };
  let live = confirmed;
  if (last > BigInt(confirmed.to)) live = applyEvents(confirmed, await eventsBetween(r, BigInt(confirmed.to) + 1n, last), last);
  return { confirmed, live };
}

// ------------------------------------------------------------------ what the logs say

/** What the player had before the days in `since`: what they have now, less what those days brought. */
export function profileBefore(now: Profile, since: DayLog[]): Profile {
  const unlocked = new Set(since.flatMap((l) => l.unlocked));
  const rods = new Set(since.flatMap((l) => l.rods.map((i) => RODS[i]?.id)));
  return { unlocked: now.unlocked.filter((id) => !unlocked.has(id)), rods: now.rods.filter((id) => !rods.has(id)) };
}

/** The set of a logged day. `start` is what the player had when that day began. */
export const setOf = (log: DayLog, address: string, start: Profile): DailySet => generateDaily(log.day, address, start);

export interface Streak {
  /** Days in a row with all three done, today included once it is complete. */
  count: number;
  /** True when the count stopped because there were no more logs to look at, not because a day was missed. */
  open: boolean;
}

/**
 * The streak, checked against the chain day by day. `today` is the current day's log, `earlier` the days before it,
 * newest first with no gaps, each read to its end. For every day the set is rebuilt from what the player had when
 * that day began, and the day counts only when the day's own catches complete it.
 */
export function streakFrom(address: string, now: Profile, today: DayLog, earlier: DayLog[]): Streak {
  let start = profileBefore(now, [today]);
  let count = setProgress(setOf(today, address, start), today.catches).complete ? 1 : 0;
  let day = today.day;
  for (const log of earlier) {
    if (log.day !== day - 1 || !log.closed) return { count, open: true };
    start = profileBefore(start, [log]);
    if (!setProgress(setOf(log, address, start), log.catches).complete) return { count, open: false };
    count++;
    day = log.day;
  }
  return { count, open: true };
}

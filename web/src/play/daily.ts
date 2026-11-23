/**
 * Daily challenges in the browser: where the day's catches come from, and the one view the interface reads.
 *
 * Local game: the save keeps the day (game/daily.ts, written by landFish). This module only turns the page at
 * 00:00 UTC.
 *
 * On the contracts: after every read of the player's state the day's events are read on from where the last read
 * stopped (game/dailyLog.ts). The confirmed part is cached in localStorage per account, so a reload starts from
 * the cache and asks the chain only for the blocks since. If the chain cannot be read, the page shows the cache as
 * it is, marked as possibly behind, or nothing at all on a device that has no cache: never a guess. Completion is
 * only ever what confirmed `Caught` events add up to. The telemetry log plays no part in it.
 */
import { pad, parseEventLogs, toEventSelector, type AbiEvent, type Address } from 'viem';
import { fishingGameAbi } from '../abi';
import { publicClient } from '../clients';
import { CHAIN_ID, LOCAL_GAME, deployment } from '../config';
import { DAILY, LOCAL_PLAYER, DAY_MS, generateDaily, profileOf, rollDaily, setProgress, streakOn, utcDay, type DailyChallenge, type DailySet, type DayCatch, type Profile, type SetProgress } from '../game/daily';
import { DAY_SECONDS, emptyLog, firstBlockAt, profileBefore, readDay, streakFrom, type ChainReader, type DayEvent, type DayLog, type Head, type Streak } from '../game/dailyLog';
import { currentTotals, landFish } from '../game/actions';
import { emit, state } from '../store';
import { commit, getSave } from './state';

const CHAIN = !LOCAL_GAME;

// ------------------------------------------------------------------ the chain, as the reader sees it

const EVENTS = ['Caught', 'LocationUnlocked', 'RodBought'] as const;
const eventAbi = fishingGameAbi.filter((x): x is Extract<(typeof fishingGameAbi)[number], { type: 'event' }> => x.type === 'event' && (EVENTS as readonly string[]).includes(x.name));
const TOPICS = eventAbi.map((e) => toEventSelector(e as AbiEvent));

/** Exported so it can be tried against a real chain by hand; the app goes through `syncDaily`. */
export function reader(player: Address): ChainReader {
  const game = deployment!.game;
  return {
    async head(): Promise<Head> {
      const b = await publicClient.getBlock({ blockTag: 'latest' });
      return { number: b.number, timestamp: Number(b.timestamp) };
    },
    async timestamp(block: bigint): Promise<number> {
      return Number((await publicClient.getBlock({ blockNumber: block })).timestamp);
    },
    /** One query for the three events: the player is the first indexed argument of each. */
    async events(from: bigint, to: bigint): Promise<DayEvent[]> {
      const logs = await publicClient.request({
        method: 'eth_getLogs',
        params: [{ address: game, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [TOPICS, pad(player)] }],
      });
      const out: DayEvent[] = [];
      for (const l of parseEventLogs({ abi: fishingGameAbi, logs: logs as never })) {
        if (l.eventName === 'Caught') out.push({ kind: 'catch', fish: { id: l.args.fishId.toString(), speciesId: l.args.speciesId, weight: l.args.weight, locationId: l.args.locationId } });
        else if (l.eventName === 'LocationUnlocked') out.push({ kind: 'unlock', locationId: l.args.locationId });
        else if (l.eventName === 'RodBought') out.push({ kind: 'rod', rod: l.args.rod });
      }
      return out;
    },
  };
}

// ------------------------------------------------------------------ the cache (per device; public chain data only)

const STORE_VERSION = 1;
/** Days kept per account: enough for the streak to be counted without reading old days again. */
const KEEP_DAYS = 40;
/** How far back the streak is looked for on a device that has no cache. */
const STREAK_LOOKBACK = 30;

const logsKey = (a: string): string => `onchain-fishing:daily:${CHAIN_ID}:${deployment?.game.toLowerCase()}:${a.toLowerCase()}`;
const blocksKey = `onchain-fishing:day-blocks:${CHAIN_ID}`;

function readJson<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
}
function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* a cache only: the chain has it all */
  }
}

function loadLogs(address: string): Map<number, DayLog> {
  const stored = readJson<{ v: number; days: DayLog[] }>(logsKey(address));
  const out = new Map<number, DayLog>();
  if (stored?.v === STORE_VERSION && Array.isArray(stored.days)) for (const l of stored.days) if (l && typeof l.day === 'number' && Array.isArray(l.catches)) out.set(l.day, l);
  return out;
}
function saveLogs(address: string, logs: Map<number, DayLog>): void {
  const days = [...logs.values()].sort((a, b) => b.day - a.day).slice(0, KEEP_DAYS);
  writeJson(logsKey(address), { v: STORE_VERSION, days });
}

/** The first block of a UTC day, remembered once the chain has got there. */
async function dayBlock(r: ChainReader, day: number, head: Head): Promise<bigint> {
  const known = readJson<Record<string, string>>(blocksKey) ?? {};
  if (known[day]) return BigInt(known[day]);
  const floor = BigInt(deployment?.startBlock ?? 0);
  const block = await firstBlockAt(r, day * DAY_SECONDS, head, floor);
  // not written while the day has not begun on the chain: the answer would be "after the head", which moves
  if (block <= head.number) {
    const keep = Object.fromEntries(
      Object.entries({ ...known, [day]: block.toString() })
        .sort((a, b) => Number(b[0]) - Number(a[0]))
        .slice(0, KEEP_DAYS + 2),
    );
    writeJson(blocksKey, keep);
  }
  return block;
}

// ------------------------------------------------------------------ the state on the contracts

interface ChainDay {
  address: string;
  day: number;
  /** What is on screen: the confirmed log plus the newest blocks. Null until something has been read or found in the cache. */
  log: DayLog | null;
  set: DailySet | null;
  /** The last read failed: `log` is the cache, possibly behind the chain. */
  stale: boolean;
  failed: boolean;
  streak: Streak | null;
}
let chainDay: ChainDay | null = null;
let syncing: Promise<void> | null = null;
let again: { address: Address; profile: Profile } | null = null;

/**
 * Reads the player's day on from the cache. Called after every read of the player's state, with what the player has
 * now: the chain is asked after the state was, so the events cover everything the state already shows.
 */
export function syncDaily(address: Address, profile: Profile): Promise<void> {
  if (!CHAIN || !deployment) return Promise.resolve();
  if (syncing) {
    // one read at a time; the newest request runs when the current one is done
    again = { address, profile };
    return syncing;
  }
  syncing = (async () => {
    try {
      await syncOnce(address, profile);
    } finally {
      syncing = null;
      const next = again;
      again = null;
      if (next) void syncDaily(next.address, next.profile);
    }
  })();
  return syncing;
}

/** Resolves when the read in flight is done, or after `ms` at the latest. For the catch card: it waits a moment for the day to catch up. */
export function dailySettled(ms = 2500): Promise<void> {
  if (!syncing) return Promise.resolve();
  return Promise.race([syncing.catch(() => undefined), new Promise<void>((r) => setTimeout(r, ms))]);
}

async function syncOnce(address: Address, profile: Profile): Promise<void> {
  const me = address.toLowerCase();
  const day = utcDay(Date.now());
  const logs = loadLogs(me);
  if (!chainDay || chainDay.address !== me || chainDay.day !== day) {
    const cached = logs.get(day) ?? null;
    chainDay = { address: me, day, log: cached, set: cached ? generateDaily(day, me, profileBefore(profile, [cached])) : null, stale: !!cached, failed: false, streak: null };
    emit();
  }
  const mine = chainDay;
  const r = reader(address);
  try {
    const head = await r.head();
    const from = await dayBlock(r, day, head);
    // the day ends where the next one begins; while that is in the future this is simply the head
    const end = await firstBlockAt(r, (day + 1) * DAY_SECONDS, head, from);
    const cached = logs.get(day);
    const base = cached && cached.from === from.toString() ? cached : emptyLog(day, from);
    const { confirmed, live } = await readDay(r, base, end - 1n, head.number, end <= head.number);
    logs.set(day, confirmed);
    saveLogs(me, logs);
    if (chainDay !== mine) return;
    mine.log = live;
    mine.set = generateDaily(day, me, profileBefore(profile, [live]));
    mine.stale = false;
    mine.failed = false;
    emit();
    await countStreak(r, mine, profile, logs, head);
  } catch (e) {
    console.warn('[daily] could not read the day from the chain', e);
    if (chainDay !== mine) return;
    mine.stale = mine.log !== null;
    mine.failed = true;
    emit();
  }
}

/** Walks back day by day while the days are complete, reading from the chain those this device has not kept. */
async function countStreak(r: ChainReader, mine: ChainDay, profile: Profile, logs: Map<number, DayLog>, head: Head): Promise<void> {
  if (!mine.log) return;
  const floorBlock = BigInt(deployment?.startBlock ?? 0);
  const earlier: DayLog[] = [];
  let streak = streakFrom(mine.address, profile, mine.log, earlier);
  for (let back = 1; back <= STREAK_LOOKBACK && streak.open; back++) {
    const day = mine.day - back;
    let log = logs.get(day);
    if (!log?.closed) {
      const from = await dayBlock(r, day, head);
      const end = await dayBlock(r, day + 1, head);
      // nothing before the game was deployed
      if (end <= floorBlock) break;
      const base = log && log.from === from.toString() ? log : emptyLog(day, from);
      log = (await readDay(r, base, end - 1n, head.number, true)).confirmed;
      logs.set(day, log);
      saveLogs(mine.address, logs);
      if (!log.closed) break;
    }
    earlier.push(log);
    streak = streakFrom(mine.address, profile, mine.log, earlier);
    if (chainDay !== mine) return;
  }
  if (chainDay !== mine) return;
  // a walk that ran out of days to look at, not out of completed ones, is a streak of "at least this many"
  mine.streak = streak;
  emit();
}

// ------------------------------------------------------------------ the local game's day

/** Local game: turns the page when the UTC day has changed, and fixes the new day's set from what the player has now. */
function rollLocalDay(now: number): void {
  const s = getSave();
  const next = rollDaily(s.daily, now, LOCAL_PLAYER, profileOf(s));
  if (next !== s.daily) commit({ ...s, daily: next });
}

/** Once a second. Returns true on the contracts when the day has changed and the player's state should be read again. */
export function tickDaily(now = Date.now()): boolean {
  if (!CHAIN) {
    rollLocalDay(now);
    return false;
  }
  return !!state.wallet && !!chainDay && chainDay.address === state.wallet.address.toLowerCase() && chainDay.day !== utcDay(now) && !syncing;
}

// ------------------------------------------------------------------ the view

export interface DailyView {
  /** 'guest': nobody is signed in. 'loading': the day is being read. 'error': it could not be read and this device has no copy. */
  status: 'guest' | 'loading' | 'error' | 'ready';
  day: number;
  set: DailySet | null;
  catches: DayCatch[];
  progress: SetProgress | null;
  /** Days in a row, or null while it is not known. */
  streak: number | null;
  /** The streak was counted as far back as this device looks: it may be longer. */
  streakOpen: boolean;
  /** The numbers are this device's last copy: the chain could not be read just now. */
  stale: boolean;
  /** Seconds until 00:00 UTC. */
  resetIn: number;
}

export function dailyView(now = Date.now()): DailyView {
  const day = utcDay(now);
  const resetIn = Math.max(0, Math.ceil(((day + 1) * DAY_MS - now) / 1000));
  const none = { day, set: null, catches: [], progress: null, streak: null, streakOpen: false, stale: false, resetIn };
  if (!CHAIN) {
    const d = getSave().daily;
    if (!d || d.day !== day || !d.set || d.set.version !== DAILY.version) return { ...none, status: 'loading' };
    return { ...none, status: 'ready', set: d.set, catches: d.catches, progress: setProgress(d.set, d.catches), streak: streakOn(d.streak, day) };
  }
  const me = state.wallet?.address.toLowerCase();
  if (!me) return { ...none, status: 'guest' };
  const c = chainDay;
  if (!c || c.address !== me || c.day !== day) return { ...none, status: 'loading' };
  if (!c.log || !c.set) return { ...none, status: c.failed ? 'error' : 'loading' };
  return { ...none, status: 'ready', set: c.set, catches: c.log.catches, progress: setProgress(c.set, c.log.catches), streak: c.streak?.count ?? null, streakOpen: !!c.streak?.open && c.streak.count >= STREAK_LOOKBACK, stale: c.stale };
}

/** The challenges a given fish completed: done with it, not done without it. For the catch card. */
export function completedBy(fishId: string, now = Date.now()): DailyChallenge[] {
  const v = dailyView(now);
  if (v.status !== 'ready' || !v.set || !v.catches.some((c) => c.id === fishId)) return [];
  const without = setProgress(
    v.set,
    v.catches.filter((c) => c.id !== fishId),
  );
  return v.set.challenges.filter((_, i) => v.progress!.each[i].done && !without.each[i].done);
}

// ------------------------------------------------------------------ what to celebrate

let seen: { key: string; done: Set<string>; full: boolean } | null = null;

/**
 * The challenges completed since the last look, and whether that completed the set. The first look at a day only
 * takes note of what is already done: a reload, or a day finished on another device, is not celebrated again.
 */
export function takeCompletions(v: DailyView): { done: DailyChallenge[]; full: boolean } {
  if (v.status !== 'ready' || !v.set || !v.progress) return { done: [], full: false };
  // a copy from the cache and a fresh read are two different looks: what the fresh one adds was done elsewhere
  const key = `${CHAIN ? (state.wallet?.address.toLowerCase() ?? '') : LOCAL_PLAYER}:${v.day}:${v.stale ? 'cache' : 'read'}:${v.set.challenges.map((c) => c.id).join(',')}`;
  const now = new Set(v.set.challenges.filter((_, i) => v.progress!.each[i].done).map((c) => c.id));
  if (!seen || seen.key !== key) {
    seen = { key, done: now, full: v.progress.complete };
    return { done: [], full: false };
  }
  const fresh = v.set.challenges.filter((c) => now.has(c.id) && !seen!.done.has(c.id));
  const full = v.progress.complete && !seen.full;
  seen = { key, done: now, full: v.progress.complete };
  return { done: fresh, full };
}

// On the dev server, local game only: `fishingDaily.land(speciesId, grams, locationId)` in the console lands a fish
// without a cast, to see the challenges move and the celebration play.
if (import.meta.env.DEV && !CHAIN) {
  (window as unknown as Record<string, unknown>).fishingDaily = {
    view: dailyView,
    land(speciesId: number, weight: number, locationId: number = getSave().location): void {
      const s = getSave();
      commit(landFish(s, { locationId, totals: currentTotals(s, locationId) }, { speciesId, weight, isSpecial: false }, 'B', Date.now()).save);
    },
  };
}

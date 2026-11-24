/**
 * The player's career by water, in the browser: where the counts come from and the one view the Stats page reads.
 * The rules are in game/career.ts.
 *
 * Local game: the save counts by water itself (`Save.career`), since the day that was added.
 *
 * On the contracts: the game's `Casted`, `Caught` and `Missed` events of the signed-in account, read from the
 * game's first block on. The folded counts are cached in localStorage per chain, game contract and account, so the
 * history is read once per device and after that only the blocks since. Nothing is read while the Stats page is
 * closed. The telemetry log plays no part in any of it, and neither does the keepnet: a fish that was sold or
 * sent away is still in the events.
 */
import { pad, parseEventLogs, toEventSelector, type AbiEvent, type Address } from 'viem';
import { fishingGameAbi } from '../abi';
import { publicClient } from '../clients';
import { CHAIN_ID, LOCAL_GAME, deployment } from '../config';
import { careerKey, completeness, emptyCareer, parseCareer, serializeCareer, syncCareer, totalsOf, waterStats, type CareerEvent, type CareerLog, type CareerReader, type WaterStats } from '../game/career';
import { emit, state } from '../store';
import { getSave } from './state';

const CHAIN = !LOCAL_GAME;

// ------------------------------------------------------------------ the chain, as the sync sees it

const EVENTS = ['Casted', 'Caught', 'Missed'] as const;
const TOPICS = fishingGameAbi.filter((x) => x.type === 'event' && (EVENTS as readonly string[]).includes(x.name)).map((e) => toEventSelector(e as AbiEvent));

/** Exported so it can be tried against a real chain by hand; the app goes through `syncMyCareer`. */
export function careerReader(player: Address): CareerReader {
  const game = deployment!.game;
  return {
    head: () => publicClient.getBlockNumber({ cacheTime: 0 }),
    async hash(block) {
      return (await publicClient.getBlock({ blockNumber: block })).hash;
    },
    /** One query for the three events: the player is the first indexed argument of each. */
    async events(from, to) {
      const logs = await publicClient.request({
        method: 'eth_getLogs',
        params: [{ address: game, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [TOPICS, pad(player)] }],
      });
      const out: CareerEvent[] = [];
      for (const l of parseEventLogs({ abi: fishingGameAbi, logs: logs as never })) {
        // a log the node itself marks as removed is not history
        if ((l as { removed?: boolean }).removed) continue;
        if (l.eventName === 'Casted') out.push({ kind: 'cast', locationId: l.args.locationId });
        else if (l.eventName === 'Caught') out.push({ kind: 'catch', locationId: l.args.locationId, speciesId: l.args.speciesId });
        else if (l.eventName === 'Missed') out.push({ kind: 'miss', locationId: l.args.locationId });
      }
      return out;
    },
    async totals(block) {
      const p = await publicClient.readContract({ address: game, abi: fishingGameAbi, functionName: 'playerOf', args: [player], blockNumber: block });
      return { casts: p.casts, catches: p.catches };
    },
  };
}

// ------------------------------------------------------------------ the cache (per device; public chain data only)

const startBlock = (): bigint => BigInt(deployment?.startBlock ?? 0);
const keyOf = (account: string): string => careerKey(CHAIN_ID, deployment?.game ?? '', account);

function load(account: string): CareerLog | null {
  try {
    return parseCareer(localStorage.getItem(keyOf(account)), startBlock());
  } catch {
    return null;
  }
}
function keep(account: string, log: CareerLog): void {
  try {
    localStorage.setItem(keyOf(account), serializeCareer(log));
  } catch {
    /* a cache only: the chain has it all */
  }
}

// ------------------------------------------------------------------ the state on the contracts

interface Mine {
  address: string;
  /** What has been folded so far; in the middle of a read it has no end hash yet. */
  log: CareerLog;
  /** The last log that was read to its end. It stays on screen while a newer read runs. */
  settled: CareerLog | null;
  /** A read is running. */
  reading: boolean;
  /** How much of the history the running read has covered, 0..1. */
  progress: number;
  /** The last read failed; `log` is what was read before it. */
  failed: boolean;
}
let mine: Mine | null = null;
let running: Promise<void> | null = null;
/** The Stats page is open: only then is the history read. */
let wanted = false;
/**
 * The read stops a few blocks short of the head (game/career.ts), so a cast made seconds ago is not in it yet.
 * While the page is open and the player's state is ahead of the history, it looks again, a few times.
 */
const CATCH_UP_MS = 4_000;
const CATCH_UP_TRIES = 5;
let catchUps = 0;
let catchUpTimer: ReturnType<typeof setTimeout> | null = null;

function catchUp(): void {
  if (catchUpTimer !== null || !wanted) return;
  const v = careerView();
  if (v.status !== 'complete' || (v.pending.casts === 0 && v.pending.catches === 0)) {
    catchUps = 0;
    return;
  }
  if (catchUps >= CATCH_UP_TRIES) return;
  catchUps++;
  catchUpTimer = setTimeout(() => {
    catchUpTimer = null;
    syncMyCareer();
  }, CATCH_UP_MS);
}

/** The Stats page says whether it is on screen. Opening it starts a read. */
export function wantCareer(on: boolean): void {
  if (wanted === on) return;
  wanted = on;
  catchUps = 0;
  if (!on && catchUpTimer !== null) {
    clearTimeout(catchUpTimer);
    catchUpTimer = null;
  }
  if (on) syncMyCareer();
}

/** Reads the signed-in account's history on from its cache. Called when the page opens and after every refresh. */
export function syncMyCareer(): void {
  if (!CHAIN || !wanted || !deployment) return;
  const address = state.wallet?.address.toLowerCase();
  if (!address) {
    mine = null;
    return;
  }
  if (mine?.address !== address) {
    // another account: its own cache, or nothing; never the counts of the one before
    const log = load(address) ?? emptyCareer(startBlock());
    mine = { address, log, settled: log.hash !== '' ? log : null, reading: false, progress: 0, failed: false };
    emit();
  }
  if (running) return;
  const me = mine;
  me.reading = true;
  emit();
  running = (async () => {
    try {
      const done = await syncCareer(careerReader(address as Address), me.log, {
        stop: () => mine !== me || !wanted,
        onProgress: (log, progress) => {
          me.log = log;
          me.progress = progress;
          keep(address, log);
          emit();
        },
      });
      me.log = done.log;
      me.failed = false;
      // the cache was dropped under a changed chain: what was on screen is no longer history
      if (done.reorged) me.settled = null;
      if (!done.stopped) {
        keep(address, done.log);
        if (done.log.hash !== '') me.settled = done.log;
      }
    } catch (e) {
      console.warn('[career] could not read the history', e);
      me.failed = true;
    } finally {
      me.reading = false;
      running = null;
      emit();
      // the account changed while this one was being read
      if (mine !== me) syncMyCareer();
      else catchUp();
    }
  })();
}

// ------------------------------------------------------------------ the view

export interface CareerView {
  /** Where the counts by water come from. */
  source: 'local' | 'chain';
  /**
   * 'guest': nobody is signed in. 'reading': the history is being read and is not whole yet. 'complete': every
   * cast and catch is given to a water. 'partial': some are not, and `gap` says how many. 'unverified': read to
   * the end, but the contract's counters could not be read to hold it against. 'error': nothing could be read.
   */
  status: 'guest' | 'reading' | 'complete' | 'partial' | 'unverified' | 'error';
  waters: WaterStats[];
  /** Casts and catches that are given to a water. */
  counted: { casts: number; catches: number };
  /** Lifetime casts and catches that no water can be named for. Zero when the history is whole. */
  gap: { casts: number; catches: number };
  /**
   * On the contracts, with a whole history: casts and catches the player's state already has and the history,
   * which stops a few blocks short of the head, does not yet. They are counted within seconds.
   */
  pending: { casts: number; catches: number };
  /** 0..1 while the history is being read. */
  progress: number;
  /** A newer read failed: the counts are this device's last copy. */
  stale: boolean;
  /** Local game: when counting by water began, ms. */
  since: number | null;
}

export function careerView(): CareerView {
  if (!CHAIN) {
    const s = getSave();
    const waters = s.career.waters;
    const counted = totalsOf(waters);
    const gap = { casts: Math.max(0, s.stats.casts - counted.casts), catches: Math.max(0, s.stats.catches - counted.catches) };
    return { source: 'local', status: gap.casts || gap.catches ? 'partial' : 'complete', waters: waterStats(waters), counted, gap, pending: { casts: 0, catches: 0 }, progress: 1, stale: false, since: s.career.since };
  }
  const address = state.wallet?.address.toLowerCase();
  const none = { source: 'chain' as const, waters: waterStats({}), counted: { casts: 0, catches: 0 }, gap: { casts: 0, catches: 0 }, pending: { casts: 0, catches: 0 }, progress: 0, stale: false, since: null };
  if (!address) return { ...none, status: 'guest' };
  const m = mine?.address === address ? mine : null;
  if (!m) return { ...none, status: 'reading' };
  // a read that has reached its end stays on screen while the blocks since are read; a first read shows what it has
  const log = m.settled ?? m.log;
  const counted = totalsOf(log.waters);
  const base = { ...none, waters: waterStats(log.waters), counted, progress: m.progress, stale: m.failed };
  // a history that has not reached its end is never shown as whole, whatever it adds up to
  if (!m.settled) return { ...base, status: m.failed && !m.reading ? 'error' : 'reading' };
  const c = completeness(log);
  if (c.state === 'complete') {
    // whole as of its last block; the state on screen may be a few blocks newer
    const now = getSave().stats;
    return { ...base, status: 'complete', pending: { casts: Math.max(0, now.casts - counted.casts), catches: Math.max(0, now.catches - counted.catches) }, progress: 1 };
  }
  if (c.state === 'unverified') return { ...base, status: 'unverified', progress: 1 };
  return { ...base, status: 'partial', gap: { casts: Math.max(0, c.casts), catches: Math.max(0, c.catches) }, progress: 1 };
}

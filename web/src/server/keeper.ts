/**
 * The operator's keeper: finishes, for the players, the two things that are lost when nobody sends a transaction
 * in time.
 *
 *   - A seasonal cast that hooked the season's fish counts only once `SeasonHunt.settle` has recorded it, within
 *     the season's settle window. The player's own page does that; a closed tab does not. The keeper finds such
 *     attempts and records them.
 *   - An ordinary cast is landed by `reel`, for as long as the chain keeps the hash of its randomness block
 *     (8,191 blocks on Fluent). After that the fish is gone. The keeper reels in casts that are about to expire.
 *     Asked to drain, it reels in every cast in the water, which is how the water becomes still before a change
 *     of rules or of the game's code (contracts/script/Water.s.sol).
 *
 * Both calls are open to anyone and neither can change a result: the randomness of an attempt and of a cast is
 * fixed when they are made, a hit goes to the player who cast it and a fish to the player who cast for it. So the
 * keeper's key is a gas wallet and nothing else. It owns nothing in the game, and losing it loses its gas.
 *
 * Which attempts are worth a transaction is decided off the chain, with the contract's own arithmetic
 * (game/hunt.ts, replayed against the contract in hunt.test.ts): one read of the beacon per round, not one per
 * attempt. A hit found that way is still put to the contract (`outcome`) before anything is sent, and a
 * disagreement is reported, never acted on.
 *
 * This module has no I/O of its own: the chain, the drand relays and the clock are passed in. The real ones are in
 * server/keeperChain.ts; the tests pass fakes.
 */
import { drandRound, drandTime, huntHit, type DrandNet } from '../game/hunt';
import { firstBlockAt, type Head } from '../game/dailyLog';

type Address = `0x${string}`;
type Hex = `0x${string}`;

// ------------------------------------------------------------------ what the keeper reads and sends

/** A season, as far as the keeper cares. */
export interface KeeperSeason {
  id: number;
  start: number;
  end: number;
  /** Seconds after a cast in which its hit can be recorded. */
  settleWindow: number;
  funded: boolean;
  cancelled: boolean;
  /** A hit is recorded; `winnerSeq` holds the catch for now. */
  hooked: boolean;
  winnerSeq: number;
}

/** One seasonal cast, from the hunt's log. */
export interface SeasonAttempt {
  season: number;
  seq: number;
  player: Address;
  /** Billionths, as the contract computed it at the cast. */
  chance: number;
  /** The block and the time of the cast: they decide which randomness is the attempt's. */
  block: bigint;
  time: number;
}

/** Where the hunt takes its randomness from. */
export interface BeaconFacts {
  scheme: string;
  /** Set for the "drand" scheme. `chainHash` without 0x, as the relays want it. */
  drand: (DrandNet & { chainHash: string }) | null;
}

/** What the beacon says for an attempt. 'wait': not there yet. 'lost': it existed and can no longer be had. */
export type Randomness = { kind: 'value'; value: Hex } | { kind: 'wait' } | { kind: 'lost' };

export interface HuntChain {
  address: Address;
  beacon(): Promise<BeaconFacts>;
  /** Every season that could still have a hit to record: the keeper filters by time itself. */
  seasons(): Promise<KeeperSeason[]>;
  season(id: number): Promise<KeeperSeason>;
  /** The seasonal casts of one season in a range of blocks, both ends included. */
  attempts(season: number, from: bigint, to: bigint): Promise<SeasonAttempt[]>;
  randomness(a: SeasonAttempt, proof: Hex): Promise<Randomness>;
  /** The contract's own word on an attempt. */
  outcome(a: SeasonAttempt, proof: Hex): Promise<'hit' | 'miss' | 'wait' | 'lost'>;
  /** Sends `settle` and waits for it. Throws when it was not mined successfully. */
  settle(a: SeasonAttempt, proof: Hex): Promise<void>;
}

/** A cast in the water. `targetBlock` 0: there is none. `counted`: it is in the game's `castsInWater`. */
export interface WaterCast {
  targetBlock: bigint;
  counted: boolean;
}

export interface KeeperChain {
  chainId: number;
  /** The game's first block: nothing is looked for below it. */
  startBlock: bigint;
  head(): Promise<Head>;
  timestamp(block: bigint): Promise<number>;
  /** How long after its randomness block a cast can still be landed here: 8,191 blocks, or 256 without EIP-2935. */
  reelWindow(head: bigint): Promise<bigint>;
  /** `Casted` events in a range of blocks, both ends included. */
  casted(from: bigint, to: bigint): Promise<{ player: Address; targetBlock: bigint }[]>;
  castOf(player: Address): Promise<WaterCast>;
  /** Sends `reelFor` and waits for it. Throws when it was not mined successfully. */
  reelFor(player: Address): Promise<void>;
  /** The game's own count, or null on a release that does not keep one. */
  water(): Promise<{ paused: boolean; inWater: number } | null>;
  /** The account that pays for the transactions, or null when there is none (a dry run). */
  operator(): Promise<{ address: Address; balanceWei: bigint } | null>;
  hunt: HuntChain | null;
}

export interface Keeper {
  chain: KeeperChain;
  /** The signature of a drand round, or null while the network has not made it. */
  drand(chainHash: string, round: number): Promise<Hex | null>;
  /** ms. Real time: drand runs on it, not on the chain's clock. */
  now(): number;
  /** Attempts already known to have missed, so that a warm instance does not look at them again. */
  misses?: Set<string>;
}

export interface RunOptions {
  /** Reel in every cast in the water, not only those about to expire. */
  drain?: boolean;
  /** Look and report; send nothing. */
  dryRun?: boolean;
  /** A cast is reeled in once fewer than this many blocks are left of its window. */
  rescueBlocks?: bigint;
  /** Drain only: the block to look for casts from, when some may be older than the reel window. */
  from?: bigint;
  /** False once the run is out of time: what is left is left for the next run. */
  shouldContinue?: () => boolean;
}

export interface KeeperReport {
  head: number;
  dryRun: boolean;
  drain: boolean;
  hunt: {
    /** Seasons whose hits can still be recorded. */
    seasons: number;
    /** Attempts looked at in this run. */
    attempts: number;
    /** Attempts whose randomness is not there yet. */
    waiting: number;
    hits: number;
    /** Hits recorded by this run. */
    settled: number;
    /** Hits that somebody else recorded first, or that an earlier attempt beat. */
    beaten: number;
    /** Hits whose settle window had closed. */
    late: number;
    /** Attempts this arithmetic calls a hit and the contract does not: a bug to look at, nothing is sent. */
    mismatches: number;
  };
  casts: {
    /** Casts in the water that this run looked at. */
    seen: number;
    /** Landed by this run. */
    reeled: number;
    /** Reeled in with their randomness gone (drain only): the cast leaves the water, there is no fish. */
    expired: number;
    /** Still in the water after this run, of those it looked at. */
    left: number;
    /** The window on this chain, blocks. */
    window: number;
  };
  /** Transactions that failed and were not somebody else's success. */
  failed: number;
  /** Work left because the run was out of time. */
  skipped: number;
  water: { paused: boolean; inWater: number } | null;
  operator: { address: Address; balance: string } | null;
  /** What a person should look at. Never a secret. */
  notes: string[];
}

// ------------------------------------------------------------------ constants

/** A hit is not sent when fewer than this many seconds are left of its window: it would not be mined in time. */
const SETTLE_MARGIN_SECONDS = 20;
/** Blocks asked for in one log query. */
const LOG_CHUNK = 5_000n;
/** Blocks around a range of logs, for a chain whose blocks are not exactly a second apart. */
const SLACK = 64n;
/** Under this balance the report says so (0.002 ETH: a few hundred transactions on Fluent). */
const LOW_BALANCE_WEI = 2_000_000_000_000_000n;
const MAX_MISSES = 50_000;

const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const message = (e: unknown): string => String((e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? e).slice(0, 300);

async function chunked<T>(from: bigint, to: bigint, read: (a: bigint, b: bigint) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let a = from; a <= to; a += LOG_CHUNK) out.push(...(await read(a, min(to, a + LOG_CHUNK - 1n))));
  return out;
}

// ------------------------------------------------------------------ the run

/** One pass: the hits of the season hunt, then the casts. Reads fail the run; a failed transaction is counted. */
export async function runKeeper(k: Keeper, opts: RunOptions = {}): Promise<KeeperReport> {
  const go = opts.shouldContinue ?? (() => true);
  const head = await k.chain.head();
  const report: KeeperReport = {
    head: Number(head.number),
    dryRun: !!opts.dryRun,
    drain: !!opts.drain,
    hunt: { seasons: 0, attempts: 0, waiting: 0, hits: 0, settled: 0, beaten: 0, late: 0, mismatches: 0 },
    casts: { seen: 0, reeled: 0, expired: 0, left: 0, window: 0 },
    failed: 0,
    skipped: 0,
    water: null,
    operator: null,
    notes: [],
  };

  const operator = await k.chain.operator();
  if (operator) {
    report.operator = { address: operator.address, balance: weiText(operator.balanceWei) };
    if (operator.balanceWei < LOW_BALANCE_WEI) report.notes.push(`the keeper's balance is low: ${weiText(operator.balanceWei)} ETH at ${operator.address}`);
  } else if (!opts.dryRun) {
    throw new Error('no keeper key: nothing can be sent (run it dry to look only)');
  }

  if (k.chain.hunt) await settleHits(k, k.chain.hunt, head, opts, report, go);
  await reelCasts(k, head, opts, report, go);

  report.water = await k.chain.water();
  if (opts.drain && report.water && report.water.inWater !== 0 && !opts.dryRun) {
    report.notes.push(
      report.water.paused
        ? `${report.water.inWater} cast(s) are still in the water: run the drain again (a cast can be reeled in two blocks after it was made), or with --from <block> if some are older than the reel window`
        : `${report.water.inWater} cast(s) are in the water and casting is not paused, so new ones keep coming: pause first (contracts/script/Water.s.sol)`,
    );
  }
  return report;
}

function weiText(wei: bigint): string {
  const s = wei.toString().padStart(19, '0');
  return `${s.slice(0, -18)}.${s.slice(-18, -12)}`;
}

// ------------------------------------------------------------------ the season hunt

const missKey = (hunt: Address, a: { season: number; seq: number }): string => `${hunt.toLowerCase()}:${a.season}:${a.seq}`;

async function settleHits(k: Keeper, hunt: HuntChain, head: Head, opts: RunOptions, report: KeeperReport, go: () => boolean): Promise<void> {
  const nowSeconds = k.now() / 1000;
  const seasons = (await hunt.seasons()).filter((s) => s.funded && !s.cancelled && head.timestamp >= s.start && head.timestamp <= s.end + s.settleWindow);
  if (seasons.length === 0) return;
  const beacon = await hunt.beacon();
  const reader = { head: () => k.chain.head(), timestamp: (b: bigint) => k.chain.timestamp(b), events: async () => [] };

  for (const season of seasons) {
    report.hunt.seasons++;
    // an attempt's window is open while the chain's clock is within `settleWindow` of its cast
    const oldest = head.timestamp - season.settleWindow;
    const from = max(k.chain.startBlock, (await firstBlockAt(reader, oldest, head, k.chain.startBlock)) - SLACK);
    const all = await chunked(from, head.number, (a, b) => hunt.attempts(season.id, a, b));
    // an attempt at or after the one that holds the catch cannot win; a known miss stays a miss
    const open = all
      .filter((a) => !(season.hooked && a.seq >= season.winnerSeq) && !k.misses?.has(missKey(hunt.address, a)))
      .sort((a, b) => a.seq - b.seq);
    report.hunt.attempts += open.length;

    // attempts that share their randomness are read together
    const groups = new Map<string, SeasonAttempt[]>();
    for (const a of open) {
      const key = beacon.drand ? `r${drandRound(beacon.drand, a.time)}` : `b${a.block}`;
      groups.set(key, [...(groups.get(key) ?? []), a]);
    }
    const hits: { a: SeasonAttempt; proof: Hex }[] = [];
    for (const group of groups.values()) {
      if (!go()) {
        report.skipped += group.length;
        continue;
      }
      let proof: Hex = '0x';
      if (beacon.drand) {
        const round = drandRound(beacon.drand, group[0].time);
        const signature = nowSeconds < drandTime(beacon.drand, round) ? null : await k.drand(beacon.drand.chainHash, round);
        if (!signature) {
          report.hunt.waiting += group.length;
          continue;
        }
        proof = signature;
      }
      const rnd = await hunt.randomness(group[0], proof);
      if (rnd.kind === 'wait') {
        report.hunt.waiting += group.length;
        continue;
      }
      for (const a of group) {
        const hit = rnd.kind === 'value' && huntHit({ randomness: rnd.value, chainId: k.chain.chainId, hunt: hunt.address, season: a.season, seq: a.seq, player: a.player }, a.chance);
        if (hit) hits.push({ a, proof });
        else remember(k, missKey(hunt.address, a));
      }
    }
    report.hunt.hits += hits.length;

    // the earliest hit is the one that wins; a later one matters only while no earlier one can be recorded
    hits.sort((x, y) => x.a.seq - y.a.seq);
    for (const { a, proof } of hits) {
      if (head.timestamp > a.time + season.settleWindow - SETTLE_MARGIN_SECONDS) {
        report.hunt.late++;
        report.notes.push(`season ${a.season}: attempt ${a.seq} of ${a.player} hooked the target and its settle window has closed`);
        continue;
      }
      if (!go()) {
        report.skipped++;
        break;
      }
      const said = await hunt.outcome(a, proof);
      if (said === 'wait') {
        report.hunt.waiting++;
        break; // a later hit must not be recorded over an earlier one that is only seconds away
      }
      if (said !== 'hit') {
        report.hunt.mismatches++;
        report.notes.push(`season ${a.season}: attempt ${a.seq} is a hit by the keeper's arithmetic and "${said}" by the contract; nothing was sent`);
        continue;
      }
      if (opts.dryRun) {
        report.notes.push(`season ${a.season}: attempt ${a.seq} of ${a.player} hooked the target and is not recorded (dry run: nothing sent)`);
        break;
      }
      try {
        await hunt.settle(a, proof);
        report.hunt.settled++;
      } catch (e) {
        // the player's own page, or anybody else, may have been first: only a hit still unrecorded is a failure
        const now_ = await hunt.season(a.season).catch(() => null);
        if (now_?.hooked && now_.winnerSeq <= a.seq) report.hunt.beaten++;
        else {
          report.failed++;
          report.notes.push(`season ${a.season}: recording attempt ${a.seq} failed: ${message(e)}`);
        }
      }
      break; // with this one recorded, no later attempt can win
    }
  }
}

function remember(k: Keeper, key: string): void {
  if (!k.misses) return;
  if (k.misses.size >= MAX_MISSES) k.misses.clear();
  k.misses.add(key);
}

// ------------------------------------------------------------------ the casts

async function reelCasts(k: Keeper, head: Head, opts: RunOptions, report: KeeperReport, go: () => boolean): Promise<void> {
  const window = await k.chain.reelWindow(head.number);
  report.casts.window = Number(window);
  // time for the player's own page first; then enough runs of the keeper to get it done
  const rescue = opts.rescueBlocks ?? (window > 2_000n ? 900n : 96n);
  // a cast older than this is reeled in: its window is about to close
  const dueAge = window > rescue ? window - rescue : 1n;

  // `Casted` is emitted a few blocks before the randomness block, so the range is a little wider than the window
  const from = max(k.chain.startBlock, opts.drain ? (opts.from ?? head.number - min(head.number, window + SLACK)) : head.number - min(head.number, window + SLACK));
  const to = opts.drain ? head.number : head.number - min(head.number, dueAge);
  if (to < from) return;
  const logs = await chunked(from, to, (a, b) => k.chain.casted(a, b));
  // a player has one cast at a time: the last event is the one that may still be in the water
  const latest = new Map<string, { player: Address; targetBlock: bigint }>();
  for (const l of logs) latest.set(l.player.toLowerCase(), l);

  for (const l of latest.values()) {
    const cast = await k.chain.castOf(l.player);
    if (cast.targetBlock === 0n || cast.targetBlock !== l.targetBlock) continue; // reeled in, or cast again since
    report.casts.seen++;
    const age = head.number - cast.targetBlock;
    const expired = age >= window;
    // the reel is mined in a later block than this one, and the contract wants the block after the target
    const ready = age >= 1n;
    const due = opts.drain ? ready && (!expired || cast.counted) : age >= dueAge && !expired;
    if (!due) {
      // an expired cast holds nothing: the player's next cast clears it, and a drain does when the water must be still
      if (opts.drain || !expired) report.casts.left++;
      continue;
    }
    if (opts.dryRun) {
      report.casts.left++;
      continue;
    }
    if (!go()) {
      report.skipped++;
      report.casts.left++;
      continue;
    }
    try {
      await k.chain.reelFor(l.player);
      if (expired) report.casts.expired++;
      else report.casts.reeled++;
    } catch (e) {
      // the player may have reeled in at the same moment: only a cast still in the water is a failure
      const now_ = await k.chain.castOf(l.player).catch(() => null);
      if (now_ && now_.targetBlock !== cast.targetBlock) continue;
      report.failed++;
      report.casts.left++;
      report.notes.push(`reeling in the cast of ${l.player} failed: ${message(e)}`);
    }
  }
}

/**
 * The verifier of the daily reward: decides, from the chain alone, whether a player completed all three challenges
 * of a UTC day, and if so signs the authorization the DailyRewards contract accepts (game/dailyReward.ts).
 *
 * It is asked with two things only, a player address and a day. Everything else it reads itself:
 *   - the player's waters and rods, at one confirmed block;
 *   - the player's `Caught`, `LocationUnlocked` and `RodBought` events from the first block of the day to that
 *     block, which give the day's catches and what the player had when the day began;
 *   - whether rewards are on, whether this one is already claimed, and whether its own key is still accepted.
 * The day's three challenges are then drawn by the same function the game's interface uses (`generateDaily`) and
 * read off the catches by the same `setProgress`. Nothing a browser says about catches or progress is an input,
 * so there is nothing to forge: a request is a question, not a claim.
 *
 * It is conservative where the chain is uncertain: only blocks `confirmations` under the head count, a log
 * marked removed is ignored, a fish counts once whatever the node repeats, and any failed or inconsistent read is
 * an error for the caller, never a signature.
 *
 * This module has no I/O of its own: the chain and the signer are passed in (`ChainFacts`, `sign`). The HTTP side
 * and the real chain are in server/http.ts and server/chain.ts; the tests pass fakes.
 */
import { LOCATIONS } from '../game/content';
import { DAILY, generateDaily, mergeCatches, setProgress, type DailySet, type DayCatch, type Profile } from '../game/daily';
import { DAY_SECONDS, firstBlockAt, profileBefore, type ChainReader, type Head } from '../game/dailyLog';
import { CLAIM_DAYS, REWARD_ENERGY, rewardTypedData, type RewardAuthorization, type RewardTerms } from '../game/dailyReward';
import { RODS } from '../tackle/catalog';

type Address = `0x${string}`;
type Hex = `0x${string}`;

// ------------------------------------------------------------------ what the verifier reads

/** One event of a player, with where the chain has it. */
export type PlayerEvent = { block: bigint; removed: boolean } & (
  | { kind: 'catch'; fish: DayCatch }
  | { kind: 'unlock'; locationId: number }
  | { kind: 'rod'; rod: number }
);

/** The chain as the verifier needs it. Every read may throw; the verifier then refuses. */
export interface ChainFacts {
  head(): Promise<Head>;
  /** Seconds. */
  timestamp(block: bigint): Promise<number>;
  /** The player's `Caught`, `LocationUnlocked` and `RodBought` events, both ends included. */
  events(player: Address, from: bigint, to: bigint): Promise<PlayerEvent[]>;
  /** The player's unlocked waters and owned rods (bit per id, as the game stores them), at `block`. */
  player(player: Address, block: bigint): Promise<{ unlocks: number; rods: number }>;
  /** The rewards contract, as of now: what the claim will meet. */
  rewards(player: Address, day: number, signer: Address): Promise<{ firstDay: number; claimed: boolean; signerAccepted: boolean }>;
}

export interface VerifierConfig {
  chainId: number;
  /** The DailyRewards contract the authorization is for. */
  contract: Address;
  /** The address of the signing key. */
  signer: Address;
  /** Blocks under the head that are not trusted yet. */
  confirmations: bigint;
  /** How long an authorization is good for, seconds. Short: it is asked for at the moment of the claim. */
  ttlSeconds: number;
  /** The game's first block: nothing is looked for below it. */
  startBlock: bigint;
  /** The chain's clock may differ from the server's by this much, seconds; further apart, the node is not trusted. */
  maxClockSkew: number;
}

export interface Verifier {
  config: VerifierConfig;
  chain: ChainFacts;
  /** Signs the EIP-712 message with the verifier's key. */
  sign(data: ReturnType<typeof rewardTypedData>): Promise<Hex>;
  /** ms */
  now(): number;
  /** First blocks of days, remembered: a day's first block never changes once the chain is past it. */
  dayBlocks?: Map<number, bigint>;
}

// ------------------------------------------------------------------ answers

export type RefusalCode =
  | 'bad_request'
  | 'not_active'
  | 'day_not_started'
  | 'day_expired'
  | 'already_claimed'
  | 'incomplete'
  | 'signer_not_accepted'
  | 'chain_unavailable';

export interface Refusal {
  ok: false;
  code: RefusalCode;
  /** For the player: what is wrong and what to do. */
  message: string;
  /** HTTP status. */
  status: number;
  /** For 'incomplete': how far the day is, as the chain has it. */
  progress?: { done: number; of: number };
}
export interface Granted {
  ok: true;
  authorization: RewardAuthorization;
}
export type Verdict = Granted | Refusal;

const refuse = (code: RefusalCode, status: number, message: string, progress?: Refusal['progress']): Refusal => ({ ok: false, code, status, message, ...(progress ? { progress } : {}) });

// ------------------------------------------------------------------ the request

export const isAddress = (x: unknown): x is Address => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x);

/** The two things a request may say. Anything else in it is not read. */
export function parseRequest(body: unknown): { player: Address; day: number } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { player, day } = body as { player?: unknown; day?: unknown };
  if (!isAddress(player) || typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 1_000_000) return null;
  return { player: player.toLowerCase() as Address, day };
}

// ------------------------------------------------------------------ the day, from the chain

/** The player's profile from the game's bit masks: the same lists the interface builds from its own read. */
export function profileFromBits(unlocks: number, rods: number): Profile {
  return {
    unlocked: LOCATIONS.filter((l) => l.unlock.type === 'start' || (unlocks >> l.id) & 1).map((l) => l.id),
    rods: RODS.filter((_, i) => i === 0 || (rods >> i) & 1).map((r) => r.id),
  };
}

export interface DayCheck {
  set: DailySet;
  catches: DayCatch[];
  done: number;
  complete: boolean;
  /** The block everything was read at. */
  asOf: bigint;
}

async function dayBlock(v: Verifier, reader: ChainReader, day: number, head: Head): Promise<bigint> {
  const known = v.dayBlocks?.get(day);
  if (known !== undefined) return known;
  const block = await firstBlockAt(reader, day * DAY_SECONDS, head, v.config.startBlock);
  // remembered only once the chain is past it: before that the answer is "after the head", which moves
  if (block <= head.number) v.dayBlocks?.set(day, block);
  return block;
}

/** Events are asked for in ranges the node accepts. */
const CHUNK = 50_000n;

/**
 * The player's day as the confirmed chain has it. `safe` is the newest block that counts. Throws when the chain
 * cannot be read.
 */
export async function checkDay(v: Verifier, player: Address, day: number, safe: Head): Promise<DayCheck> {
  const reader: ChainReader = { head: async () => safe, timestamp: (b) => v.chain.timestamp(b), events: async () => [] };
  const from = await dayBlock(v, reader, day, safe);
  const state = await v.chain.player(player, safe.number);
  if (from > safe.number) {
    // the day has no confirmed block yet: nothing was caught in it
    const set = generateDaily(day, player, profileFromBits(state.unlocks, state.rods));
    return { set, catches: [], done: 0, complete: false, asOf: safe.number };
  }
  // the day ends where the next one begins; while that is ahead of the chain, at the newest block that counts
  const next = await dayBlock(v, reader, day + 1, safe);
  const last = next - 1n < safe.number ? next - 1n : safe.number;

  const events: PlayerEvent[] = [];
  for (let a = from; a <= safe.number; a += CHUNK) {
    const b = a + CHUNK - 1n < safe.number ? a + CHUNK - 1n : safe.number;
    for (const e of await v.chain.events(player, a, b)) {
      // a node must not hand back what was not asked for; if it does, it is not counted
      if (e.removed || e.block < a || e.block > b) continue;
      events.push(e);
    }
  }
  // what the player has at `safe`, less everything gained since the day began, is what the day began with
  const gained = { unlocked: [] as number[], rods: [] as number[] };
  let catches: DayCatch[] = [];
  for (const e of events) {
    if (e.kind === 'unlock') gained.unlocked.push(e.locationId);
    else if (e.kind === 'rod') gained.rods.push(e.rod);
    else if (e.block <= last) catches = mergeCatches(catches, [e.fish]);
  }
  const start = profileBefore(profileFromBits(state.unlocks, state.rods), [{ day, from: from.toString(), to: safe.number.toString(), closed: false, catches: [], ...gained }]);
  const set = generateDaily(day, player, start);
  const p = setProgress(set, catches);
  return { set, catches, done: p.done, complete: p.complete, asOf: safe.number };
}

// ------------------------------------------------------------------ the decision

/**
 * Answers one request. Never throws: a read that fails is `chain_unavailable`, and a signature is only made after
 * every check has passed on data the verifier read itself.
 */
export async function authorize(v: Verifier, body: unknown): Promise<Verdict> {
  const req = parseRequest(body);
  if (!req) return refuse('bad_request', 400, 'Send a player address and a UTC day number.');
  const { player, day } = req;
  const c = v.config;
  try {
    const nowSeconds = Math.floor(v.now() / 1000);
    const head = await v.chain.head();
    // a node that is behind (or ahead) in time would put catches in the wrong day
    if (Math.abs(head.timestamp - nowSeconds) > c.maxClockSkew) return refuse('chain_unavailable', 503, 'The chain could not be read reliably just now. Try again in a moment.');
    const today = Math.floor(head.timestamp / DAY_SECONDS);
    if (day > today) return refuse('day_not_started', 400, 'That day has not begun.');
    if (today > day + CLAIM_DAYS - 1) return refuse('day_expired', 410, 'That reward has expired: a day can be claimed until the end of the next UTC day.');

    const on = await v.chain.rewards(player, day, c.signer);
    if (on.firstDay <= 0 || day < on.firstDay) return refuse('not_active', 409, 'There is no energy reward for that day.');
    if (on.claimed) return refuse('already_claimed', 409, 'This reward is already claimed.');
    if (!on.signerAccepted) return refuse('signer_not_accepted', 503, 'Rewards are paused. Your completed day is not lost: try again later.');

    const safeNumber = head.number - c.confirmations;
    if (safeNumber < c.startBlock) return refuse('chain_unavailable', 503, 'The chain could not be read reliably just now. Try again in a moment.');
    const safe: Head = { number: safeNumber, timestamp: await v.chain.timestamp(safeNumber) };
    const check = await checkDay(v, player, day, safe);
    if (!check.complete) {
      return refuse('incomplete', 422, `${check.done} of ${check.set.challenges.length} challenges are confirmed on chain for that day. A fresh catch can take a few seconds to count.`, { done: check.done, of: check.set.challenges.length });
    }

    // good until the claim window closes, and never for long: it is fetched at the moment of the claim
    const windowEnd = (day + CLAIM_DAYS) * DAY_SECONDS - 1;
    const deadline = Math.min(nowSeconds + c.ttlSeconds, windowEnd);
    if (deadline <= nowSeconds) return refuse('day_expired', 410, 'That reward has expired.');
    const terms: RewardTerms = { player, day, rules: DAILY.version, amount: REWARD_ENERGY, deadline };
    const signature = await v.sign(rewardTypedData(c.chainId, c.contract, terms));
    return { ok: true, authorization: { ...terms, chainId: c.chainId, contract: c.contract, signer: c.signer, signature } };
  } catch (e) {
    console.warn('[daily-reward] could not verify', player, day, e instanceof Error ? e.message : e);
    return refuse('chain_unavailable', 503, 'The chain could not be read just now. Try again in a moment.');
  }
}

// ------------------------------------------------------------------ rate limiting

/**
 * A sliding count per key, in memory. On a serverless host each instance has its own, so this slows a flood down
 * rather than stopping it; the host's own rate limiting belongs in front (web/DAILY_REWARDS.md).
 */
export function rateLimiter(max: number, windowMs: number, now: () => number = Date.now, maxKeys = 10_000) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const t = now();
    const recent = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(t);
    // re-inserted, so the map's order is "least recently seen first" and the oldest key is the one dropped
    hits.delete(key);
    hits.set(key, recent);
    if (hits.size > maxKeys) hits.delete(hits.keys().next().value as string);
    return true;
  };
}

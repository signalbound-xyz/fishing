/**
 * What this browser remembers of the reel fight for the cast in the water, when the game runs on the contracts.
 *
 * A hooked fish gets one fight (contracts/src/ReelJudge.sol). The contract can only hold a recording it is sent to
 * that, so the page holds itself to it: the moment a fight starts it is written down here, and its recording when
 * it ends. A page that comes back to the same cast (a reload, a closed tab, a failed transaction) then sends that
 * recording, or, for a fight that was walked away from, the empty one that lets the fish go. It does not start
 * the fight again.
 *
 * This is a rule the page keeps, not a proof. Whoever clears the entry, or uses another browser, gets the fight
 * again, exactly as a program that never had this page would: the fight is public arithmetic on a public seed.
 * What the contract does guarantee is narrower and is stated in ARCHITECTURE.md.
 *
 * One entry per chain, game and account; the storage is passed in. When the browser stores nothing (private
 * mode, quota) the entry lives for as long as the page does.
 */
import type { Hex } from 'viem';
import type { KV } from './prefs';

export interface FightScope {
  chainId: number;
  game: string;
  address: string;
}

export interface FightRecord {
  /** The cast the fight belongs to (FishingGame's per-player nonce). */
  nonce: string;
  /** The recording, once the fight is over; absent while it is being fought, or after it was walked away from. */
  inputs?: Hex;
  /** Whether the page saw the fish reach the pier. The contract replays the recording and decides for itself. */
  landed?: boolean;
}

export const fightKey = (s: FightScope): string => `onchain-fishing:fight:${s.chainId}:${s.game.toLowerCase()}:${s.address.toLowerCase()}`;

function browserStore(): KV | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Entries the browser would not store. */
const unsaved = new Map<string, FightRecord>();

const isHex = (x: unknown): x is Hex => typeof x === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(x);

export function parseFightRecord(raw: string | null): FightRecord | null {
  if (!raw) return null;
  try {
    const x = JSON.parse(raw) as Record<string, unknown>;
    if (typeof x !== 'object' || x === null || typeof x.nonce !== 'string' || !/^\d+$/.test(x.nonce)) return null;
    const rec: FightRecord = { nonce: x.nonce };
    if (isHex(x.inputs)) {
      rec.inputs = x.inputs;
      rec.landed = x.landed === true;
    }
    return rec;
  } catch {
    return null;
  }
}

/** The fight this browser knows of for cast `nonce`, or null: no fight of that cast was started here. */
export function fightOf(scope: FightScope, nonce: bigint, kv: KV | null = browserStore()): FightRecord | null {
  const key = fightKey(scope);
  let rec = unsaved.get(key) ?? null;
  if (!rec && kv) {
    try {
      rec = parseFightRecord(kv.getItem(key));
    } catch {
      rec = null;
    }
  }
  return rec && rec.nonce === nonce.toString() ? rec : null;
}

function put(scope: FightScope, rec: FightRecord, kv: KV | null): void {
  const key = fightKey(scope);
  try {
    if (!kv) throw new Error('no storage');
    kv.setItem(key, JSON.stringify(rec));
    unsaved.delete(key);
  } catch {
    unsaved.set(key, rec);
  }
}

/** The fight for cast `nonce` begins. From here on this cast has had its try, whatever happens to the page. */
export function fightStarted(scope: FightScope, nonce: bigint, kv: KV | null = browserStore()): void {
  put(scope, { nonce: nonce.toString() }, kv);
}

/** The fight is over: this is the recording that will be sent, and no other. */
export function fightEnded(scope: FightScope, nonce: bigint, inputs: Hex, landed: boolean, kv: KV | null = browserStore()): void {
  put(scope, { nonce: nonce.toString(), inputs, landed }, kv);
}

/**
 * What is sent for a fight this browser knows of: its recording, or the empty one for a fight that was started
 * and never finished (the fish was left on the line).
 */
export const recordingOf = (rec: FightRecord): Hex => rec.inputs ?? '0x';

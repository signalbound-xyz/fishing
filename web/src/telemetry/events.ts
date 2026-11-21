/**
 * Gameplay telemetry: what is recorded. Pure data, no storage and no DOM.
 *
 * Telemetry only observes. Nothing in game/ reads it, and no rule depends on it: deleting the log changes nothing
 * in the game. It holds no wallet address, no account id and no balances; it stays in this browser (see
 * recorder.ts) and is never sent anywhere.
 */

/** Where the game ran: on the localStorage save or on the contracts. The fight is the same; what it decides is not. */
export type GameMode = 'local' | 'chain';

export type Grade = 'D' | 'C' | 'B' | 'A' | 'S';

export type EventBody =
  | { e: 'session_start' }
  /** `duration` is active play: from the start to the last recorded action, ms. */
  | { e: 'session_end'; duration: number; reason: 'closed' | 'idle' | 'lost' }
  /** A cast went out. `energy` is what is left after paying `cost`. */
  | { e: 'cast'; loc: number; cost: number; rod: string; lure: string | null; level: number; energy: number }
  /** The wait is over: did anything bite. */
  | { e: 'bite'; ok: boolean; loc: number }
  /** The float dipped. `reaction` in seconds, null when the window (`window`, seconds) ran out. `d` is the fight difficulty 0–5. */
  | { e: 'hook'; ok: boolean; reaction: number | null; window: number; clean: boolean; d: number }
  /**
   * A reel fight ended. `green` is the width of the green band (share of the gauge), `attempt` is 0 for the first
   * try at this fish, `replay` marks a fight played after the contract had already settled the catch.
   */
  | { e: 'fight'; result: 'landed' | 'snapped' | 'slack'; seconds: number; accuracy: number; d: number; green: number; attempt: number; replay: boolean }
  | { e: 'catch'; loc: number; species: number; rarity: number; quality: Grade; weight: number; price: number; score: number; special: boolean; newSpecies: boolean }
  /** After a cast the energy left does not pay for another one here. */
  | { e: 'energy_out'; loc: number; cost: number; left: number }
  /** `price` is PEARL, except for kind 'pearl' (PEARL bought at the exchange), where it is the BLEND paid. */
  | { e: 'purchase'; kind: 'rod' | 'lure' | 'repair' | 'refill' | 'location' | 'pearl'; id: string; price: number }
  | { e: 'unlock'; loc: number; how: 'progress' | 'purchase' }
  | { e: 'sale'; fish: number; earned: number }
  | { e: 'level'; level: number };

/** `t`: ms since the epoch. `s`: the session it belongs to (the ms that session began). `m`: game mode. */
export type TelemetryEvent = EventBody & { t: number; s: number; m: GameMode };

export interface TelemetryLog {
  version: 1;
  /** Events thrown away because the log was full (the oldest go first). */
  dropped: number;
  events: TelemetryEvent[];
}

export const LOG_VERSION = 1;
export const emptyLog = (): TelemetryLog => ({ version: LOG_VERSION, dropped: 0, events: [] });

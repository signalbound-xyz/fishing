/**
 * The telemetry recorder: sessions, a bounded log and its storage. The storage and the clock are injected, so the
 * same code runs in the browser and in the tests.
 *
 * A session begins with the first recorded action after the page opens, and again after a long pause. It ends
 * when the page is hidden or closed, or (looking back) when the next action comes after such a pause. Its length
 * is active play: from its start to its last action. A session the browser never got to close (a crash, a killed
 * tab) is closed on the next visit at its last action.
 */
import { LOG_VERSION, emptyLog, type EventBody, type GameMode, type TelemetryEvent, type TelemetryLog } from './events';

export interface LogStore {
  read(): string | null;
  write(value: string): void;
}

/** A pause this long between two actions splits them into two sessions. */
export const IDLE_GAP_MS = 10 * 60_000;
/** About 0.6 MB of JSON at most; the oldest events are dropped first. */
export const MAX_EVENTS = 5_000;

export function parseLog(raw: string | null): TelemetryLog {
  if (!raw) return emptyLog();
  try {
    const v = JSON.parse(raw) as Partial<TelemetryLog>;
    if (v && v.version === LOG_VERSION && Array.isArray(v.events)) return { version: LOG_VERSION, dropped: Number(v.dropped) || 0, events: v.events };
  } catch {
    /* an unreadable log is the same as none: telemetry is never worth an error */
  }
  return emptyLog();
}

export class Recorder {
  /** Not written yet. Kept apart so that another tab's writes are merged with, not overwritten. */
  private pending: TelemetryEvent[] = [];
  private session: number | null = null;
  private lastAt = 0;

  constructor(
    private readonly store: LogStore,
    private readonly mode: GameMode,
    private readonly clock: () => number = Date.now,
    private readonly maxEvents = MAX_EVENTS,
  ) {
    this.closeLost();
  }

  /** A session left open by an earlier visit ends where its last action was. */
  private closeLost(): void {
    const { events } = parseLog(this.store.read());
    const last = events[events.length - 1];
    if (!last || last.e === 'session_end') return;
    this.pending.push({ e: 'session_end', duration: last.t - last.s, reason: 'lost', t: last.t, s: last.s, m: last.m });
    this.flush();
  }

  private push(body: EventBody, t: number): void {
    this.pending.push({ ...body, t, s: this.session ?? t, m: this.mode });
  }

  private end(reason: 'closed' | 'idle'): void {
    if (this.session === null) return;
    this.push({ e: 'session_end', duration: this.lastAt - this.session, reason }, this.lastAt);
    this.session = null;
  }

  /** Records one action. Opens a session when none is open, or when the last action is too long ago. */
  track(body: EventBody): void {
    const now = this.clock();
    if (this.session !== null && now - this.lastAt > IDLE_GAP_MS) this.end('idle');
    if (this.session === null) {
      this.session = now;
      this.push({ e: 'session_start' }, now);
    }
    this.lastAt = now;
    this.push(body, now);
  }

  /** The page is going away (or to the background): the session ends at its last action. */
  close(): void {
    this.end('closed');
    this.flush();
  }

  /** Writes what is pending: re-reads the stored log first, so two tabs add to one log. */
  flush(): void {
    if (this.pending.length === 0) return;
    const log = parseLog(this.store.read());
    log.events.push(...this.pending);
    const over = log.events.length - this.maxEvents;
    if (over > 0) {
      log.events.splice(0, over);
      log.dropped += over;
    }
    try {
      this.store.write(JSON.stringify(log));
      this.pending = [];
    } catch {
      // storage is full or blocked: keep the newest in memory, within the same bound
      if (this.pending.length > this.maxEvents) this.pending.splice(0, this.pending.length - this.maxEvents);
    }
  }

  /** Everything recorded so far, stored and pending. */
  log(): TelemetryLog {
    const log = parseLog(this.store.read());
    log.events.push(...this.pending);
    return log;
  }

  /** Forgets everything. The open session, if any, goes on from here. */
  clear(): void {
    this.pending = [];
    try {
      this.store.write(JSON.stringify(emptyLog()));
    } catch {
      /* nothing to do */
    }
    if (this.session !== null) {
      const now = this.clock();
      this.session = now;
      this.lastAt = now;
      this.push({ e: 'session_start' }, now);
    }
  }
}

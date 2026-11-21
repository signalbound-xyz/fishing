/** Turns a telemetry log into the numbers the balance work asks about. Pure: a function of the events alone. */
import type { GameMode, Grade, TelemetryEvent, TelemetryLog } from './events';

export interface FightRow {
  /** Difficulty 0–5, or -1 for the total. */
  d: number;
  fights: number;
  landed: number;
  snapped: number;
  slack: number;
  /** Mean length of a landed fight, seconds. */
  seconds: number;
  /** Mean share of a landed fight spent in the green. */
  accuracy: number;
}

export interface HookRow {
  d: number;
  bites: number;
  missed: number;
  clean: number;
  /** Reaction times of the hooks that were set, seconds. */
  median: number | null;
  p90: number | null;
}

export interface LocationRow {
  loc: number;
  casts: number;
  energy: number;
  bites: number;
  noBite: number;
  caught: number;
  /** Sell price of everything landed here (before the fresh-catch bonus). */
  pearl: number;
}

export interface SessionRow {
  start: number;
  /** Active play, ms. */
  duration: number;
  casts: number;
  caught: number;
  /** The last cast of the session left no energy for another one. */
  outOfEnergy: boolean;
  reason: 'closed' | 'idle' | 'lost' | 'open';
}

export interface Summary {
  events: number;
  dropped: number;
  from: number | null;
  to: number | null;
  sessions: SessionRow[];
  sessionStats: { count: number; totalMs: number; medianMs: number; meanMs: number; longestMs: number; medianCasts: number; outOfEnergy: number };
  casts: number;
  energy: number;
  bites: { yes: number; no: number };
  hooks: HookRow;
  hooksByDifficulty: HookRow[];
  fights: FightRow;
  fightsByDifficulty: FightRow[];
  /** Fights that were a first try at their fish: the honest landing rate where a lost fight is retried. */
  firstTries: FightRow;
  catches: number;
  /** Landed fish by rarity, Common … Mythic. */
  byRarity: number[];
  byQuality: Record<Grade, number>;
  specials: number;
  newSpecies: number;
  locations: LocationRow[];
  energyOut: number;
  purchases: { kind: string; id: string; count: number; pearl: number }[];
  pearlSpent: number;
  unlocks: { loc: number; how: 'progress' | 'purchase'; t: number }[];
  levels: { level: number; t: number }[];
  sales: { fish: number; earned: number };
  /** Sell price of everything landed, per point of energy spent. */
  pearlPerEnergy: number | null;
}

const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);
/** Nearest-rank quantile of a sorted list. */
export const quantile = (xs: number[], q: number): number | null => (xs.length === 0 ? null : xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(q * xs.length) - 1))]);
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);

interface FightAcc {
  fights: number;
  landed: number;
  snapped: number;
  slack: number;
  seconds: number[];
  accuracy: number[];
}
const newFight = (): FightAcc => ({ fights: 0, landed: 0, snapped: 0, slack: 0, seconds: [], accuracy: [] });
const fightRow = (d: number, a: FightAcc): FightRow => ({ d, fights: a.fights, landed: a.landed, snapped: a.snapped, slack: a.slack, seconds: mean(a.seconds), accuracy: mean(a.accuracy) });
function addFight(a: FightAcc, ev: Extract<TelemetryEvent, { e: 'fight' }>): void {
  a.fights++;
  a[ev.result]++;
  if (ev.result === 'landed') {
    a.seconds.push(ev.seconds);
    a.accuracy.push(ev.accuracy);
  }
}

interface HookAcc {
  bites: number;
  missed: number;
  clean: number;
  reactions: number[];
}
const newHook = (): HookAcc => ({ bites: 0, missed: 0, clean: 0, reactions: [] });
function hookRow(d: number, a: HookAcc): HookRow {
  const r = sorted(a.reactions);
  return { d, bites: a.bites, missed: a.missed, clean: a.clean, median: quantile(r, 0.5), p90: quantile(r, 0.9) };
}

/** `mode` keeps only the events of one game mode; sessions are then counted from those events alone. */
export function summarize(log: TelemetryLog, mode?: GameMode): Summary {
  const events = sorted2(mode ? log.events.filter((e) => e.m === mode) : log.events);
  const sessions = new Map<number, SessionRow & { last: number; lastCast: number; lastOut: number }>();
  const session = (ev: TelemetryEvent) => {
    let s = sessions.get(ev.s);
    if (!s) {
      s = { start: ev.s, duration: 0, casts: 0, caught: 0, outOfEnergy: false, reason: 'open', last: ev.s, lastCast: 0, lastOut: 0 };
      sessions.set(ev.s, s);
    }
    return s;
  };
  const fights = newFight();
  const firstTries = newFight();
  const fightsBy = new Map<number, FightAcc>();
  const hooks = newHook();
  const hooksBy = new Map<number, HookAcc>();
  const locs = new Map<number, LocationRow>();
  const loc = (id: number): LocationRow => {
    let l = locs.get(id);
    if (!l) {
      l = { loc: id, casts: 0, energy: 0, bites: 0, noBite: 0, caught: 0, pearl: 0 };
      locs.set(id, l);
    }
    return l;
  };
  const purchases = new Map<string, { kind: string; id: string; count: number; pearl: number }>();
  const out: Summary = {
    events: events.length,
    dropped: log.dropped,
    from: events[0]?.t ?? null,
    to: events[events.length - 1]?.t ?? null,
    sessions: [],
    sessionStats: { count: 0, totalMs: 0, medianMs: 0, meanMs: 0, longestMs: 0, medianCasts: 0, outOfEnergy: 0 },
    casts: 0,
    energy: 0,
    bites: { yes: 0, no: 0 },
    hooks: hookRow(-1, hooks),
    hooksByDifficulty: [],
    fights: fightRow(-1, fights),
    fightsByDifficulty: [],
    firstTries: fightRow(-1, firstTries),
    catches: 0,
    byRarity: [0, 0, 0, 0, 0, 0],
    byQuality: { D: 0, C: 0, B: 0, A: 0, S: 0 },
    specials: 0,
    newSpecies: 0,
    locations: [],
    energyOut: 0,
    purchases: [],
    pearlSpent: 0,
    unlocks: [],
    levels: [],
    sales: { fish: 0, earned: 0 },
    pearlPerEnergy: null,
  };
  let value = 0;
  for (const ev of events) {
    const s = session(ev);
    s.last = Math.max(s.last, ev.t);
    switch (ev.e) {
      case 'session_start':
        break;
      case 'session_end':
        s.duration = ev.duration;
        s.reason = ev.reason;
        break;
      case 'cast': {
        out.casts++;
        out.energy += ev.cost;
        s.casts++;
        s.lastCast = ev.t;
        const l = loc(ev.loc);
        l.casts++;
        l.energy += ev.cost;
        break;
      }
      case 'bite':
        if (ev.ok) out.bites.yes++;
        else out.bites.no++;
        if (ev.ok) loc(ev.loc).bites++;
        else loc(ev.loc).noBite++;
        break;
      case 'hook': {
        let by = hooksBy.get(ev.d);
        if (!by) hooksBy.set(ev.d, (by = newHook()));
        for (const a of [hooks, by]) {
          a.bites++;
          if (!ev.ok) a.missed++;
          if (ev.clean) a.clean++;
          if (ev.ok && ev.reaction !== null) a.reactions.push(ev.reaction);
        }
        break;
      }
      case 'fight': {
        let by = fightsBy.get(ev.d);
        if (!by) fightsBy.set(ev.d, (by = newFight()));
        addFight(fights, ev);
        addFight(by, ev);
        if (ev.attempt === 0) addFight(firstTries, ev);
        break;
      }
      case 'catch': {
        out.catches++;
        s.caught++;
        out.byRarity[ev.rarity] = (out.byRarity[ev.rarity] ?? 0) + 1;
        out.byQuality[ev.quality]++;
        if (ev.special) out.specials++;
        if (ev.newSpecies) out.newSpecies++;
        value += ev.price;
        const l = loc(ev.loc);
        l.caught++;
        l.pearl += ev.price;
        break;
      }
      case 'energy_out':
        out.energyOut++;
        s.lastOut = ev.t;
        break;
      case 'purchase': {
        const k = `${ev.kind}:${ev.id}`;
        const p = purchases.get(k) ?? { kind: ev.kind, id: ev.id, count: 0, pearl: 0 };
        p.count++;
        p.pearl += ev.price;
        purchases.set(k, p);
        // PEARL bought for BLEND is not PEARL spent
        if (ev.kind !== 'pearl') out.pearlSpent += ev.price;
        break;
      }
      case 'unlock':
        out.unlocks.push({ loc: ev.loc, how: ev.how, t: ev.t });
        break;
      case 'level':
        out.levels.push({ level: ev.level, t: ev.t });
        break;
      case 'sale':
        out.sales.fish += ev.fish;
        out.sales.earned += ev.earned;
        break;
    }
  }
  out.sessions = [...sessions.values()]
    .map(({ last, lastCast, lastOut, ...s }) => ({
      ...s,
      // a session that is still open (or was never closed) has run up to its last action
      duration: s.reason === 'open' ? last - s.start : s.duration,
      outOfEnergy: lastCast > 0 && lastOut >= lastCast,
    }))
    .sort((a, b) => a.start - b.start);
  const durations = sorted(out.sessions.map((s) => s.duration));
  out.sessionStats = {
    count: out.sessions.length,
    totalMs: durations.reduce((a, x) => a + x, 0),
    medianMs: quantile(durations, 0.5) ?? 0,
    meanMs: mean(durations),
    longestMs: durations[durations.length - 1] ?? 0,
    medianCasts: quantile(sorted(out.sessions.map((s) => s.casts)), 0.5) ?? 0,
    outOfEnergy: out.sessions.filter((s) => s.outOfEnergy).length,
  };
  out.hooks = hookRow(-1, hooks);
  out.hooksByDifficulty = [...hooksBy.entries()].sort((a, b) => a[0] - b[0]).map(([d, a]) => hookRow(d, a));
  out.fights = fightRow(-1, fights);
  out.firstTries = fightRow(-1, firstTries);
  out.fightsByDifficulty = [...fightsBy.entries()].sort((a, b) => a[0] - b[0]).map(([d, a]) => fightRow(d, a));
  out.locations = [...locs.values()].sort((a, b) => a.loc - b.loc);
  out.purchases = [...purchases.values()].sort((a, b) => b.pearl - a.pearl);
  out.pearlPerEnergy = out.energy > 0 ? value / out.energy : null;
  return out;
}

/** By time, keeping the recorded order of events with the same timestamp. */
function sorted2(events: TelemetryEvent[]): TelemetryEvent[] {
  return events.map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i).map((x) => x.e);
}

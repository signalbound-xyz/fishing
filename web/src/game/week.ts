/**
 * A weekly season: three hunts of the Season Hunt contract, one after another, shown to the player as one event.
 *
 * The contract knows nothing of weeks. A hunt is one of its seasons (contracts/src/SeasonHunt.sol): its own target
 * fish, waters, bonus table, dates, prize, winner and claim. A week is a grouping kept beside the contracts:
 *
 *   the week file   contracts/script/seasons/weeks/<id>.json   what the organiser writes: the title, the start
 *                                                              and the rules of the three hunts
 *   the record      deployments/weeks/<chainId>/<id>.json      written by the script that creates the hunts:
 *                                                              which three on-chain seasons they became
 *   the registry    src/generated/weeks.ts                     the two joined by `pnpm sync`, for the client
 *
 * The registry says which seasons belong together and what the week is called. Everything that matters about a
 * hunt (when it runs, what it pays, who won, whether the prize was claimed) is read from the contract and never
 * from the registry; a registry that disagrees with the chain is shown as what the chain says.
 */
import { MAX_CHANCE, type HuntStatus } from './hunt';

export const WEEK_VERSION = 1;
/** A weekly season is exactly this many hunts. */
export const HUNTS_PER_WEEK = 3;

/** The most a ticket can cost, in whole PEARL: the script's bound (contracts/script/SeasonHunt.s.sol). */
export const MAX_TICKET_PEARL = 1e9;

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

// ------------------------------------------------------------------ the week file

/** One hunt of a week file: a season's rules, with its place in the week instead of dates. */
export interface WeekFileHunt {
  name: string;
  description: string;
  difficulty: Difficulty;
  /** Hours from the week's start to the hunt's start. */
  startHour: number;
  durationHours: number;
  /** Percent of the week's prize pool. The three add up to 100. */
  prizeShare: number;
  speciesId: number;
  waters: number[];
  /** Rod ids that may be used; empty = any rod. */
  rods: number[];
  minLevel: number;
  /**
   * Whole PEARL a wallet burns once to fish this hunt; left out (or 0) the hunt is free. Needs a hunt contract
   * that sells tickets: the script refuses the file on one that does not.
   */
  ticketPearl?: number;
  dailyAttempts: number;
  /** Chance of an attempt with no bonus, in billionths. */
  baseChance: number;
  /** Cap on the bonuses added up, in percent of the base chance. */
  maxBonus: number;
  rodBonus: number[];
  lureBonus: number[];
  waterBonus: number[];
}

export interface WeekFile {
  version: number;
  /** Also the file's name: lower-case letters, digits and dashes. */
  id: string;
  title: string;
  description: string;
  theme?: string;
  /** `2026-12-07T00:00:00Z`: UTC, to the second, in exactly this form. */
  start: string;
  /** How long the week is; every hunt ends inside it. */
  days: number;
  /** BLEND for the three hunts together. */
  totalPrizeBlend: number;
  /** Seconds after a cast in which its hit can be recorded, for every hunt of the week. */
  settleWindowSeconds: number;
  hunts: WeekFileHunt[];
}

/** What the game has, to check a week file against. */
export interface Catalog {
  species: number;
  locations: number;
  rods: number;
  lures: number;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/** Unix seconds of `2026-12-07T00:00:00Z`, or null when the text is not a date in that form. */
export function unixOf(iso: string): number | null {
  const m = ISO.exec(iso);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(t);
  // 31 February is not 3 March
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  return t / 1000;
}

/** A hunt of a week file with its dates and its prize worked out. */
export interface PlannedHunt extends WeekFileHunt {
  /** Unix seconds. */
  start: number;
  end: number;
  /** BLEND. */
  prize: number;
}

export interface WeekPlan {
  id: string;
  title: string;
  start: number;
  end: number;
  totalPrize: number;
  hunts: PlannedHunt[];
}

/** The dates and prizes a week file stands for. Call `validateWeek` first: a broken file gives nonsense here. */
export function planWeek(f: WeekFile): WeekPlan {
  const start = unixOf(f.start) ?? 0;
  return {
    id: f.id,
    title: f.title,
    start,
    end: start + f.days * 86_400,
    totalPrize: f.totalPrizeBlend,
    hunts: f.hunts.map((h) => ({ ...h, start: start + h.startHour * 3600, end: start + (h.startHour + h.durationHours) * 3600, prize: (f.totalPrizeBlend * h.prizeShare) / 100 })),
  };
}

const whole = (x: unknown, min: number, max: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;
const text = (x: unknown, max: number): x is string => typeof x === 'string' && x.trim().length > 0 && x.length <= max;

/**
 * Everything that is wrong with a week file, in words; empty when it can be created. The script that creates the
 * hunts (contracts/script/SeasonHunt.s.sol) checks the same things against the chain; this is the same list for the
 * tests and for the registry, so that a file that cannot be created is found before anybody holds a key.
 */
export function validateWeek(f: WeekFile, cat: Catalog): string[] {
  const bad: string[] = [];
  if (f.version !== WEEK_VERSION) bad.push(`version must be ${WEEK_VERSION}`);
  if (typeof f.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(f.id)) bad.push('id must be lower-case letters, digits and dashes, 40 at most');
  if (!text(f.title, 60)) bad.push('title is missing or longer than 60 characters');
  if (typeof f.description !== 'string' || f.description.length > 400) bad.push('description is missing or longer than 400 characters');
  if (f.theme !== undefined && !text(f.theme, 24)) bad.push('theme is empty or longer than 24 characters');
  const start = typeof f.start === 'string' ? unixOf(f.start) : null;
  if (start === null) bad.push('start must be a UTC time like 2026-12-07T00:00:00Z');
  if (!whole(f.days, 1, 31)) bad.push('days must be a whole number, 1 to 31');
  if (!whole(f.totalPrizeBlend, 1, 1e12)) bad.push('totalPrizeBlend must be a whole number of BLEND above zero');
  if (!whole(f.settleWindowSeconds, 60, 7 * 86_400)) bad.push('settleWindowSeconds must be between a minute and seven days');
  if (!Array.isArray(f.hunts) || f.hunts.length !== HUNTS_PER_WEEK) {
    bad.push(`a week is exactly ${HUNTS_PER_WEEK} hunts`);
    return bad;
  }

  let shares = 0;
  let prevEnd = 0;
  f.hunts.forEach((h, i) => {
    const at = `hunt ${i + 1}`;
    if (!text(h.name, 60)) bad.push(`${at}: name is missing or longer than 60 characters`);
    if (typeof h.description !== 'string' || h.description.length > 400) bad.push(`${at}: description is missing or longer than 400 characters`);
    if (!DIFFICULTIES.includes(h.difficulty)) bad.push(`${at}: difficulty must be easy, medium or hard`);
    if (!whole(h.startHour, 0, 31 * 24) || !whole(h.durationHours, 1, 31 * 24)) {
      bad.push(`${at}: startHour and durationHours must be whole hours`);
    } else {
      if (h.startHour < prevEnd) bad.push(i === 0 ? `${at}: starts before the week` : `${at}: starts before hunt ${i} ends: hunts of a week do not overlap and are listed in order`);
      prevEnd = h.startHour + h.durationHours;
      if (whole(f.days, 1, 31) && prevEnd > f.days * 24) bad.push(`${at}: ends after the week does`);
    }
    if (!whole(h.prizeShare, 1, 100)) bad.push(`${at}: prizeShare must be a whole percent, 1 to 100`);
    else shares += h.prizeShare;
    if (!whole(h.speciesId, 0, cat.species - 1)) bad.push(`${at}: species ${h.speciesId} is not in the game (${cat.species} species)`);
    if (!Array.isArray(h.waters) || h.waters.length === 0) bad.push(`${at}: no waters`);
    else {
      if (h.waters.some((w) => !whole(w, 0, Math.min(15, cat.locations - 1)))) bad.push(`${at}: a water that is not in the game (${cat.locations} locations)`);
      if (new Set(h.waters).size !== h.waters.length) bad.push(`${at}: a water is listed twice`);
    }
    if (!Array.isArray(h.rods) || h.rods.some((r) => !whole(r, 0, Math.min(15, cat.rods - 1)))) bad.push(`${at}: a rod that is not in the game (${cat.rods} rods)`);
    if (!whole(h.minLevel, 0, 255)) bad.push(`${at}: minLevel must be 0 to 255`);
    if (h.ticketPearl !== undefined && !whole(h.ticketPearl, 0, MAX_TICKET_PEARL)) bad.push(`${at}: ticketPearl must be a whole number of PEARL, ${MAX_TICKET_PEARL} at most`);
    if (!whole(h.dailyAttempts, 1, 65_535)) bad.push(`${at}: dailyAttempts must be at least 1`);
    if (!whole(h.maxBonus, 0, 65_535)) bad.push(`${at}: maxBonus must be a whole percent`);
    if (!whole(h.baseChance, 1, MAX_CHANCE)) bad.push(`${at}: baseChance must be 1 to ${MAX_CHANCE} billionths`);
    else if (whole(h.maxBonus, 0, 65_535) && Math.floor((h.baseChance * (100 + h.maxBonus)) / 100) > MAX_CHANCE) bad.push(`${at}: with the best tackle an attempt would be more likely than one in ten`);
    for (const [name, row, count] of [
      ['rodBonus', h.rodBonus, cat.rods],
      ['lureBonus', h.lureBonus, cat.lures],
      ['waterBonus', h.waterBonus, cat.locations],
    ] as const) {
      if (!Array.isArray(row) || row.length > 16 || row.some((x) => !whole(x, 0, 65_535))) bad.push(`${at}: ${name} must be at most 16 whole percents`);
      else if (row.length > count) bad.push(`${at}: ${name} has a bonus for something the game does not have`);
    }
  });
  if (shares !== 100) bad.push(`the prize shares add up to ${shares}%, not 100%`);
  return bad;
}

// ------------------------------------------------------------------ the registry

/** One week of the registry: which on-chain seasons are its hunts, in order, and what the week is called. */
export interface WeekEntry {
  id: string;
  title: string;
  description: string;
  theme?: string;
  /** Unix seconds, as planned. What a hunt really does is the contract's. */
  start: number;
  end: number;
  hunts: { seasonId: number; difficulty: Difficulty }[];
}

// ------------------------------------------------------------------ a hunt, as the page tells it

/** What of an on-chain season the grouping needs. `play/hunt.ts` reads it from the contract. */
export interface HuntFacts {
  id: number;
  name: string;
  start: number;
  end: number;
  settleWindow: number;
  speciesId: number;
  prize: number;
  /** Who put the prize up; null while it is not in. */
  sponsor: string | null;
  /** The contract's status when it was last read. */
  status: HuntStatus;
  /** When the recorded hit stands for good, or when a hunt without one expires. */
  finalAt: number;
  winner: { player: string; seq: number } | null;
  paid: boolean;
  returned: boolean;
}

/** A season's state at `now`: the contract's status, moved on by the clock between reads. */
export function statusAt(s: Pick<HuntFacts, 'status' | 'start' | 'end' | 'settleWindow' | 'sponsor'>, now: number): HuntStatus {
  if (s.status === 'cancelled' || s.status === 'winner' || s.status === 'expired') return s.status;
  if (now < s.start) return 'upcoming';
  if (!s.sponsor) return 'cancelled';
  if (now < s.end) return 'active';
  return now <= s.end + s.settleWindow ? 'closing' : 'expired';
}

/** Nothing can change who won any more. */
export const finalAt = (s: Pick<HuntFacts, 'status' | 'start' | 'end' | 'settleWindow' | 'sponsor' | 'winner' | 'finalAt'>, now: number): boolean =>
  s.winner ? now > s.finalAt : statusAt(s, now) === 'expired';

/**
 * What a hunt's card says.
 *
 *   upcoming   it has not started; nobody can cast
 *   active     casts are taken
 *   pending    casting is over or the fish is hooked, and the result can still change: awaiting finalization
 *   winner     it has a winner, for good
 *   none       it ended and nobody hooked the fish, for good
 *   off        it was called off, or it started without its prize and so never ran
 *   missing    the registry names a season the contract does not have
 */
export type CardStatus = 'upcoming' | 'active' | 'pending' | 'winner' | 'none' | 'off' | 'missing';

export const CARD_LABEL: Record<CardStatus, string> = {
  upcoming: 'Upcoming',
  active: 'Active',
  pending: 'Pending finalization',
  winner: 'Winner found',
  none: 'No winner',
  off: 'Called off',
  missing: 'Not announced',
};

export function cardStatus(s: HuntFacts | null, now: number): CardStatus {
  if (!s) return 'missing';
  const st = statusAt(s, now);
  if (st === 'cancelled') return 'off';
  if (st === 'upcoming') return 'upcoming';
  if (st === 'active') return 'active';
  if (st === 'expired') return 'none';
  if (st === 'closing') return 'pending';
  return now > s.finalAt ? 'winner' : 'pending';
}

/** The result of the hunt is known and cannot change. */
export const concluded = (c: CardStatus): boolean => c === 'winner' || c === 'none' || c === 'off';

/** Whether a seasonal cast can be made in this hunt at `now`. Nothing else may arm the pond. */
export const takesCasts = (s: HuntFacts | null, now: number): boolean => cardStatus(s, now) === 'active';

/** Where a hunt's prize is. */
export type PrizeState = 'unfunded' | 'escrow' | 'claimable' | 'claimed' | 'returnable' | 'returned';

export const PRIZE_LABEL: Record<PrizeState, string> = {
  unfunded: 'not funded yet',
  escrow: 'held in escrow',
  claimable: 'waiting for the winner to claim',
  claimed: 'claimed by the winner',
  returnable: 'back to the sponsor: not taken yet',
  returned: 'returned to the sponsor',
};

export function prizeState(s: HuntFacts, now: number): PrizeState {
  if (!s.sponsor) return 'unfunded';
  if (s.returned) return 'returned';
  if (s.paid) return 'claimed';
  const c = cardStatus(s, now);
  if (c === 'winner') return 'claimable';
  if (c === 'none' || c === 'off') return 'returnable';
  return 'escrow';
}

// ------------------------------------------------------------------ a week, as the page tells it

export interface WeekHunt<H extends HuntFacts = HuntFacts> {
  /** 0, 1, 2: the hunt's place in the week. */
  index: number;
  seasonId: number;
  difficulty: Difficulty | null;
  /** The season as the contract has it; null when it does not have it. */
  season: H | null;
  status: CardStatus;
}

/** What comes next in a week, to count down to. */
export interface NextEvent {
  kind: 'hunt-starts' | 'hunt-ends' | 'result-final';
  /** Unix seconds. */
  at: number;
  /** The hunt it is about. */
  index: number;
}

export type WeekState = 'upcoming' | 'running' | 'finalizing' | 'over';

export interface WeekView<H extends HuntFacts = HuntFacts> {
  /** The registry's id, or `season-<n>` for a season that belongs to no week. */
  id: string;
  title: string;
  description: string;
  theme?: string;
  /** From the hunts on the chain where there are any, else as the registry planned it. */
  start: number;
  end: number;
  hunts: WeekHunt<H>[];
  /** BLEND of the hunts the contract has, funded or not. */
  totalPrize: number;
  /** BLEND of the hunts whose prize is in the contract or was paid out of it. */
  fundedPrize: number;
  /** Hunts whose result is known for good. */
  concluded: number;
  state: WeekState;
  next: NextEvent | null;
  /** A single season from before weekly seasons: shown as a week of one hunt. */
  legacy: boolean;
}

function viewOf<H extends HuntFacts>(id: string, title: string, description: string, theme: string | undefined, planned: { start: number; end: number } | null, hunts: WeekHunt<H>[], now: number, legacy: boolean): WeekView<H> {
  const known = hunts.filter((h): h is WeekHunt<H> & { season: H } => !!h.season);
  const start = known.length ? Math.min(...known.map((h) => h.season.start), planned?.start ?? Infinity) : (planned?.start ?? 0);
  const end = known.length ? Math.max(...known.map((h) => h.season.end), planned?.end ?? 0) : (planned?.end ?? 0);
  const done = hunts.filter((h) => concluded(h.status) || h.status === 'missing').length;
  const active = hunts.find((h) => h.status === 'active');
  const upcoming = hunts.filter((h) => h.status === 'upcoming').sort((a, b) => a.season!.start - b.season!.start)[0];
  const pending = hunts.filter((h) => h.status === 'pending').sort((a, b) => a.season!.finalAt - b.season!.finalAt)[0];
  // what a player waits for: the end of the hunt being fished, else the start of the next one, else a result
  const next: NextEvent | null = active
    ? { kind: 'hunt-ends', at: active.season!.end, index: active.index }
    : upcoming
      ? { kind: 'hunt-starts', at: upcoming.season!.start, index: upcoming.index }
      : pending
        ? { kind: 'result-final', at: pending.season!.finalAt, index: pending.index }
        : null;
  const state: WeekState = done === hunts.length ? 'over' : now < start ? 'upcoming' : active || upcoming ? 'running' : 'finalizing';
  return {
    id,
    title,
    description,
    theme,
    start,
    end,
    hunts,
    totalPrize: known.reduce((sum, h) => sum + h.season.prize, 0),
    fundedPrize: known.reduce((sum, h) => sum + (h.season.sponsor ? h.season.prize : 0), 0),
    concluded: hunts.filter((h) => concluded(h.status)).length,
    state,
    next,
    legacy,
  };
}

/**
 * The weeks the page shows, newest first: every week of the registry with its three hunts as the contract has
 * them, and every other season of the contract as a week of its own. A season is never shown twice and never
 * dropped: what the registry does not claim is still there, under its own name.
 */
export function groupWeeks<H extends HuntFacts>(entries: readonly WeekEntry[], seasons: readonly H[], now: number): WeekView<H>[] {
  const byId = new Map(seasons.map((s) => [s.id, s]));
  const claimed = new Set<number>();
  const out: WeekView<H>[] = [];
  for (const e of entries) {
    const hunts = e.hunts.map((x, index): WeekHunt<H> => {
      // a season listed by two weeks belongs to the first
      const season = claimed.has(x.seasonId) ? null : (byId.get(x.seasonId) ?? null);
      claimed.add(x.seasonId);
      return { index, seasonId: x.seasonId, difficulty: x.difficulty, season, status: cardStatus(season, now) };
    });
    // by their real dates: a registry that lists them out of order does not reorder the week
    hunts.sort((a, b) => (a.season?.start ?? Infinity) - (b.season?.start ?? Infinity) || a.index - b.index);
    hunts.forEach((h, i) => (h.index = i));
    // a week none of whose hunts the contract has is a week of another deployment: nothing to show
    if (hunts.every((h) => !h.season)) continue;
    out.push(viewOf(e.id, e.title, e.description, e.theme, { start: e.start, end: e.end }, hunts, now, false));
  }
  for (const s of seasons) {
    if (claimed.has(s.id)) continue;
    out.push(viewOf(`season-${s.id}`, s.name, '', undefined, null, [{ index: 0, seasonId: s.id, difficulty: null, season: s, status: cardStatus(s, now) }], now, true));
  }
  return out.sort((a, b) => b.start - a.start);
}

/**
 * The week the page opens on: the one with a hunt being fished, else the latest that has started and is not over
 * (between two hunts, or waiting for its last result), else the next to start, else the latest of all.
 */
export function currentWeek<H extends HuntFacts>(weeks: readonly WeekView<H>[], now: number): WeekView<H> | null {
  const fished = weeks.find((w) => w.hunts.some((h) => h.status === 'active'));
  if (fished) return fished;
  const open = weeks.filter((w) => w.state === 'running' || w.state === 'finalizing').sort((a, b) => b.start - a.start)[0];
  if (open) return open;
  const soon = weeks.filter((w) => w.state === 'upcoming' && w.start > now).sort((a, b) => a.start - b.start)[0];
  return soon ?? weeks[0] ?? null;
}

/** The hunt of a week to open first: the one being fished, else the one awaiting its result, else the next, else the last. */
export function featuredHunt<H extends HuntFacts>(w: WeekView<H>): WeekHunt<H> | null {
  const by = (c: CardStatus): WeekHunt<H> | undefined => w.hunts.find((h) => h.status === c);
  return by('active') ?? by('pending') ?? by('upcoming') ?? w.hunts.filter((h) => h.season).at(-1) ?? w.hunts[0] ?? null;
}

/** Completed weeks, newest first: the archive. A week stays out of it until its last result is final. */
export const pastWeeks = <H extends HuntFacts>(weeks: readonly WeekView<H>[]): WeekView<H>[] => weeks.filter((w) => w.state === 'over');

/** Hunts whose prize `player` has won and not taken yet, across every week. */
export function claimable<H extends HuntFacts>(weeks: readonly WeekView<H>[], player: string | null | undefined, now: number): WeekHunt<H>[] {
  const me = player?.toLowerCase();
  if (!me) return [];
  return weeks.flatMap((w) => w.hunts).filter((h) => h.season && h.status === 'winner' && h.season.winner?.player.toLowerCase() === me && prizeState(h.season, now) === 'claimable');
}

/** `1/3 hunts concluded`. */
export const progressText = (w: Pick<WeekView, 'concluded' | 'hunts'>): string => `${w.concluded}/${w.hunts.length}`;

/** What the page as a whole is doing, from what was read. A failed re-read keeps the earlier data on the page. */
export type PageState = 'loading' | 'error' | 'stale' | 'empty' | 'ready';
export function pageState(read: { loaded: boolean; failed: boolean; seasons: number; weeks: number }): PageState {
  if (!read.loaded) return read.failed ? 'error' : 'loading';
  if (read.seasons === 0 && read.weeks === 0) return 'empty';
  return read.failed ? 'stale' : 'ready';
}

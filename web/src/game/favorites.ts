/**
 * Saved fish, and the Trophy Room that shows them.
 *
 * There is one thing a player decides about a fish, and the game rules do not care about it: **saved** (the star).
 * A saved fish is skipped by every Sell button until the star is taken off, and every saved fish hangs in the
 * Trophy Room. The room is therefore not a place and holds nothing: it is the saved fish of the keepnet, filtered,
 * sorted and shown a page at a time (`trophyFish`, `pageOf`). A fish is never copied into it.
 *
 * In the local game the star lives in the save (`FishInstance.isFavorite`, rules in game/actions.ts). On the
 * contracts it is a preference of this browser, kept per chain, collection and account (`Prefs`, stored by
 * play/prefs.ts): it guards the game's own Sell buttons and nothing else. The fish is an NFT and the contracts
 * know nothing of the star, so it is never proof that the account still owns the fish. That is why the stars are
 * checked against the keepnet after every successful read (`reconcile`), and only then.
 *
 * Before this the room had six numbered frames filled by hand (`showcase`, in the save and in the preferences).
 * Whatever hung there is a saved fish now: `legacyShowcaseIds` reads the old field wherever it is still stored.
 *
 * A public Trophy Room later needs exactly `Prefs.saved` from an account-based store in place of this browser's;
 * the fish themselves it reads from the chain.
 */
import type { FishInstance, Save } from './types';

// ------------------------------------------------------------------ the room, as a view of the keepnet

export type TrophySort = 'date' | 'rarity' | 'weight' | 'value';

export interface TrophyQuery {
  sort: TrophySort;
  /** A rarity, or -1 for all. */
  rarity: number;
  /** A location id, or -1 for all. */
  location: number;
}

export const ALL = -1;
export const defaultQuery = (): TrophyQuery => ({ sort: 'date', rarity: ALL, location: ALL });

/** How many trophies are drawn at first, and how many more each "Load more" adds. */
export const TROPHY_PAGE = 12;

const ORDER: Record<TrophySort, (a: FishInstance, b: FishInstance) => number> = {
  date: (a, b) => b.caughtAt - a.caughtAt,
  rarity: (a, b) => b.rarity - a.rarity || b.weight - a.weight,
  weight: (a, b) => b.weight - a.weight,
  value: (a, b) => b.sellPrice - a.sellPrice,
};

/** Every trophy: the saved fish of the keepnet, each once, in keepnet order. There is no limit. */
export function trophiesOf(s: Save): FishInstance[] {
  const seen = new Set<string>();
  return s.fish.filter((f) => f.isFavorite && !seen.has(f.id) && seen.add(f.id));
}

/** The trophies a query asks for, in its order. Fish that tie keep their keepnet order. */
export function trophyFish(s: Save, q: TrophyQuery = defaultQuery()): FishInstance[] {
  return trophiesOf(s)
    .filter((f) => (q.rarity === ALL || f.rarity === q.rarity) && (q.location === ALL || f.locationId === q.location))
    .sort(ORDER[q.sort]);
}

export interface Page<T> {
  /** What is drawn. */
  items: T[];
  /** How many are not drawn yet. */
  rest: number;
  /** How many the next "Load more" adds. */
  next: number;
}

/** The first `shown` of a list (at least one page), so a large room is never drawn whole. */
export function pageOf<T>(list: readonly T[], shown: number, size = TROPHY_PAGE): Page<T> {
  const n = Math.min(list.length, Math.max(size, Number.isFinite(shown) ? Math.floor(shown) : size));
  const rest = list.length - n;
  return { items: list.slice(0, n), rest, next: Math.min(size, rest) };
}

// ------------------------------------------------------------------ the six frames that came before

/** The fish ids in a stored `showcase` (six frames, an id or null each). Anything else in it is ignored. */
export function legacyShowcaseIds(raw: unknown): string[] {
  return Array.isArray(raw) ? ids(raw) : [];
}

// ------------------------------------------------------------------ preferences kept outside the save (contracts)

export const PREFS_VERSION = 2;

export interface Prefs {
  /** Ids of the saved fish. */
  saved: string[];
}

export const emptyPrefs = (): Prefs => ({ saved: [] });

function ids(raw: unknown): string[] {
  return Array.isArray(raw) ? [...new Set(raw.filter((x): x is string => typeof x === 'string' && x !== ''))] : [];
}

/**
 * Stored JSON as preferences; null when there is nothing readable (the caller then keeps what it has). Reads every
 * shape that was ever written: a bare list of ids, version 1 with its six frames (a displayed fish was always a
 * saved fish, and is one now), and version 2.
 */
export function parsePrefs(json: string | null): Prefs | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as unknown;
    if (Array.isArray(raw)) return { saved: ids(raw) };
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as { saved?: unknown; showcase?: unknown };
    return { saved: ids([...ids(o.saved), ...legacyShowcaseIds(o.showcase)]) };
  } catch {
    return null;
  }
}

export const serializePrefs = (p: Prefs): string => JSON.stringify({ v: PREFS_VERSION, saved: p.saved });

export interface Reconciled {
  prefs: Prefs;
  /** Saved fish that are gone (sold, transferred): they have left the Trophy Room. */
  dropped: string[];
  changed: boolean;
}

/**
 * Preferences checked against what the account holds right now. Call it only with an inventory that was really
 * read: a failed read says nothing about what the player owns, and must not empty the room.
 */
export function reconcile(p: Prefs, owned: Iterable<string>): Reconciled {
  const have = new Set(owned);
  const dropped = p.saved.filter((id) => !have.has(id));
  return dropped.length ? { prefs: { saved: p.saved.filter((id) => have.has(id)) }, dropped, changed: true } : { prefs: p, dropped, changed: false };
}

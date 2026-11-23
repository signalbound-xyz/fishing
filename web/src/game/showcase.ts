/**
 * The Trophy Room and the saved fish, as data.
 *
 * Two things a player decides about a fish, neither of which the game rules care about:
 * - **saved**: the star. A saved fish is skipped by every Sell button until the star is taken off.
 * - **on display**: one of six frames in the Trophy Room, in the order the player chose. A displayed fish is
 *   always saved; taking it down leaves the star on.
 *
 * In the local game both live in the save (`FishInstance.isFavorite`, `Save.showcase`) and the rules are in
 * game/actions.ts. On the contracts they are preferences of this browser, kept per chain, collection and account
 * (`Prefs`, stored by play/prefs.ts): they guard the game's own Sell buttons and nothing else. The fish is an NFT
 * and the contracts know nothing of the star, so neither is ever proof that the account still owns the fish. That
 * is why they are checked against the keepnet after every successful read (`reconcile`), and only then.
 *
 * A public Trophy Room later needs exactly `Prefs.showcase` (six ids, in order) from an account-based store in
 * place of this browser's; the fish themselves it reads from the chain.
 */

export const SHOWCASE_SLOTS = 6;

/** Six frames, left to right, top to bottom. A fish id, or null for an empty frame. */
export type Showcase = (string | null)[];

export const emptyShowcase = (): Showcase => Array.from({ length: SHOWCASE_SLOTS }, () => null);

/** Whatever was stored, as a valid showcase: six frames, ids only, no fish twice. */
export function cleanShowcase(raw: unknown): Showcase {
  const out = emptyShowcase();
  if (!Array.isArray(raw)) return out;
  const seen = new Set<string>();
  for (let i = 0; i < SHOWCASE_SLOTS; i++) {
    const id = raw[i] as unknown;
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    out[i] = id;
  }
  return out;
}

export const slotOf = (show: Showcase, id: string): number => show.indexOf(id);
export const freeSlot = (show: Showcase): number => show.indexOf(null);
export const shownCount = (show: Showcase): number => show.filter((x) => x !== null).length;
export const validSlot = (slot: number): boolean => Number.isInteger(slot) && slot >= 0 && slot < SHOWCASE_SLOTS;

/** `id` in frame `slot`, whatever hung there before. The caller has checked the slot and that the fish is not shown. */
export const withTrophy = (show: Showcase, id: string, slot: number): Showcase => show.map((x, i) => (i === slot ? id : x));
export const withoutTrophy = (show: Showcase, id: string): Showcase => show.map((x) => (x === id ? null : x));
/** Two frames trade places; either may be empty. */
export const swapped = (show: Showcase, a: number, b: number): Showcase => show.map((x, i) => (i === a ? show[b] : i === b ? show[a] : x));

/** Empties the frames whose fish is not in `owned`. Returns the same array when nothing changed. */
export function keepOwned(show: Showcase, owned: ReadonlySet<string>): { showcase: Showcase; dropped: string[] } {
  const dropped = show.filter((x): x is string => x !== null && !owned.has(x));
  return dropped.length ? { showcase: show.map((x) => (x !== null && owned.has(x) ? x : null)), dropped } : { showcase: show, dropped };
}

// ------------------------------------------------------------------ preferences kept outside the save (contracts)

export const PREFS_VERSION = 1;

export interface Prefs {
  /** Ids of the saved fish. */
  saved: string[];
  showcase: Showcase;
}

export const emptyPrefs = (): Prefs => ({ saved: [], showcase: emptyShowcase() });

const ids = (raw: unknown): string[] => (Array.isArray(raw) ? [...new Set(raw.filter((x): x is string => typeof x === 'string' && x !== ''))] : []);

/** Stored JSON as preferences; null when there is nothing readable (the caller then keeps what it has). */
export function parsePrefs(json: string | null): Prefs | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as unknown;
    // the first version of the favourites was a bare list of ids
    if (Array.isArray(raw)) return { saved: ids(raw), showcase: emptyShowcase() };
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as { saved?: unknown; showcase?: unknown };
    const showcase = cleanShowcase(o.showcase);
    // a displayed fish is a saved fish
    return { saved: ids([...ids(o.saved), ...showcase.filter((x): x is string => x !== null)]), showcase };
  } catch {
    return null;
  }
}

export const serializePrefs = (p: Prefs): string => JSON.stringify({ v: PREFS_VERSION, saved: p.saved, showcase: p.showcase });

export interface Reconciled {
  prefs: Prefs;
  /** Displayed fish that are gone (sold, transferred): their frames are now empty. */
  droppedTrophies: string[];
  /** Saved fish that are gone. */
  droppedSaved: string[];
  changed: boolean;
}

/**
 * Preferences checked against what the account holds right now. Call it only with an inventory that was really
 * read: a failed read says nothing about what the player owns, and must not empty the room.
 */
export function reconcile(p: Prefs, owned: Iterable<string>): Reconciled {
  const have = new Set(owned);
  const { showcase, dropped } = keepOwned(p.showcase, have);
  const shown = showcase.filter((x): x is string => x !== null);
  const saved = [...new Set([...p.saved.filter((id) => have.has(id)), ...shown])];
  const droppedSaved = p.saved.filter((id) => !have.has(id));
  const changed = dropped.length > 0 || saved.length !== p.saved.length || saved.some((id, i) => id !== p.saved[i]);
  return { prefs: changed ? { saved, showcase } : p, droppedTrophies: dropped, droppedSaved, changed };
}

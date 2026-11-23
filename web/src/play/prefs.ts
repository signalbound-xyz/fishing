/**
 * Where the saved fish and the Trophy Room are kept when the game runs on the contracts: this browser, one entry
 * per chain, fish collection and account. Fish ids are NFT ids, so the same number on another chain or another
 * collection is another fish, and another account's choices are nobody else's.
 *
 * These are preferences, not game state and not proof of anything (see game/showcase.ts). The storage is passed in,
 * so an account-based store can take this browser's place later without the rest noticing.
 */
import { emptyPrefs, parsePrefs, serializePrefs, type Prefs } from '../game/showcase';

export interface PrefsScope {
  chainId: number;
  /** The fish NFT contract. */
  collection: string;
  address: string;
}

/** The part of `Storage` this needs. */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const prefsKey = (s: PrefsScope): string => `onchain-fishing:prefs:${s.chainId}:${s.collection.toLowerCase()}:${s.address.toLowerCase()}`;
/** Where the favourites were kept before the Trophy Room: per account only. Read once, never written again. */
export const legacyFavsKey = (address: string): string => `onchain-fishing:favs:${address.toLowerCase()}`;

function browserStore(): KV | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The account's preferences. Nothing stored, or nothing readable, is an empty set: a broken entry is left where it
 * is until the player changes something.
 */
export function loadPrefs(scope: PrefsScope, kv: KV | null = browserStore()): Prefs {
  if (!kv) return emptyPrefs();
  try {
    return parsePrefs(kv.getItem(prefsKey(scope))) ?? parsePrefs(kv.getItem(legacyFavsKey(scope.address))) ?? emptyPrefs();
  } catch {
    return emptyPrefs();
  }
}

/** False when the browser would not store it (private mode, quota): the choice then lasts until the page is closed. */
export function storePrefs(scope: PrefsScope, prefs: Prefs, kv: KV | null = browserStore()): boolean {
  if (!kv) return false;
  try {
    kv.setItem(prefsKey(scope), serializePrefs(prefs));
    return true;
  } catch {
    return false;
  }
}

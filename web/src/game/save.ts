/**
 * Save data: the fresh save, validation and versioned migrations. Storage itself (localStorage today, a backend
 * later) lives in play/state.ts; this module only turns raw JSON into a valid current Save.
 *
 * Trust note: a local save is player-editable. Nothing in it may later be taken as proof of a legitimate catch,
 * reward or NFT eligibility; that has to come from a trusted backend or the chain.
 */
import { TUNING } from './content';
import { legacyShowcaseIds } from './favorites';
import type { Save } from './types';

export const SAVE_VERSION = 1;

export function freshSave(now: number): Save {
  return {
    version: SAVE_VERSION,
    seq: 0,
    pearl: 0,
    blend: 0,
    blendWins: 0,
    xp: 0,
    energy: TUNING.maxEnergy,
    energyAt: now,
    refills: { day: 0, count: 0 },
    rods: { willow: { durability: 0 } },
    lures: {},
    equipped: { rod: 'willow', lure: null },
    location: 0,
    fish: [],
    dex: {},
    permanentUnlocks: [0],
    specialsFound: [],
    dry: {},
    activeSpecial: null,
    records: { overall: null, byLocation: {} },
    weeks: {},
    claimed: [],
    stats: { casts: 0, catches: 0, escaped: 0, sold: 0, earned: 0 },
    daily: { day: 0, set: null, catches: [], streak: { day: 0, count: 0 }, rewards: { earned: [], claimed: [] } },
    career: { since: now, waters: {} },
  };
}

type Raw = Record<string, unknown>;
/** migrations[n] upgrades a save from version n to n + 1. */
export type Migration = (old: Raw) => Raw;

/** No schema changes yet. When Save changes: bump SAVE_VERSION and add the step from the previous version here. */
export const MIGRATIONS: Record<number, Migration> = {};

export interface Loaded {
  save: Save;
  /** 'fresh': nothing stored. 'ok': loaded as is. 'migrated': upgraded. 'newer': written by a newer client; kept untouched. 'corrupt': unreadable; kept untouched. */
  status: 'fresh' | 'ok' | 'migrated' | 'newer' | 'corrupt';
}

const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function validCareer(c: unknown): boolean {
  if (!isObj(c) || typeof c.since !== 'number' || !Number.isFinite(c.since) || !isObj(c.waters)) return false;
  return Object.entries(c.waters).every(([id, w]) => Number.isInteger(Number(id)) && isObj(w) && isCount(w.casts) && isCount(w.catches) && isCount(w.misses) && isObj(w.species) && Object.values(w.species).every(isCount));
}

/**
 * Turns stored JSON into a current Save. Never throws. A save that cannot be read or comes from a newer version
 * is reported, and the caller keeps the original bytes as a backup instead of overwriting them.
 */
export function loadSave(json: string | null, now: number, migrations = MIGRATIONS, current = SAVE_VERSION): Loaded {
  if (json === null || json === '') return { save: freshSave(now), status: 'fresh' };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { save: freshSave(now), status: 'corrupt' };
  }
  if (!isObj(raw) || typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) {
    return { save: freshSave(now), status: 'corrupt' };
  }
  if (raw.version > current) return { save: freshSave(now), status: 'newer' };
  let data = raw;
  const from = raw.version;
  for (let v = from; v < current; v++) {
    const step = migrations[v];
    if (!step) return { save: freshSave(now), status: 'corrupt' };
    try {
      data = { ...step(data), version: v + 1 };
    } catch {
      return { save: freshSave(now), status: 'corrupt' };
    }
  }
  // Fill anything missing from the fresh shape, so a field added without a migration cannot crash the game.
  const base = freshSave(now) as unknown as Raw;
  const merged: Raw = { ...base, ...data, version: current };
  // `career` is one of them: a save from before the counts by water existed gets an empty book that starts now
  for (const k of ['equipped', 'records', 'stats', 'refills', 'daily', 'career']) {
    merged[k] = { ...(base[k] as Raw), ...(isObj(data[k]) ? (data[k] as Raw) : {}) };
  }
  const save = merged as unknown as Save;
  // a book that is not one (a hand-edited save) is replaced by an empty one rather than believed or crashed on
  if (!validCareer(save.career)) save.career = { since: now, waters: {} };
  // The Trophy Room used to be six frames filled by hand (`showcase`). Now it is every saved fish, so what hung in
  // a frame becomes a saved fish (it always was one, whatever a hand-edited save says) and the frames are retired.
  // No version step: a save from either side of the change loads on the other, and nothing else is touched.
  const hung = new Set(legacyShowcaseIds(merged.showcase));
  delete merged.showcase;
  if (Array.isArray(save.fish) && save.fish.some((f) => hung.has(f.id) && !f.isFavorite)) save.fish = save.fish.map((f) => (hung.has(f.id) ? { ...f, isFavorite: true } : f));
  return { save, status: from === current ? 'ok' : 'migrated' };
}

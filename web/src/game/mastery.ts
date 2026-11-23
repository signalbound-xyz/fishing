/**
 * Location mastery: three tiers of permanent progress for every water, read from the encyclopedia.
 *
 * Nothing is stored for it. The encyclopedia (`Save.dex`) already keeps, per species, how many were landed and the
 * heaviest one, in the local save and on the contracts alike (GameLens.playerView), and selling a fish never
 * touches it. Mastery is a reading of those numbers, so everything caught before this feature existed counts, a
 * sold fish still counts, and there is no achievement state of our own that could disagree with the chain.
 *
 * It grants nothing: no XP, no PEARL, no energy. It is a badge.
 *
 * One limit of the data: the encyclopedia counts a species, not where it was caught. A species that lives in two
 * waters (Perch in the pond and the river) counts toward both.
 */
import { LOCATIONS, SPECIES } from './content';
import type { LocationDef, Rarity, Save } from './types';

/** The rules, in one place for later balancing. Sized in BALANCE_AUDIT.md, "Sizing location mastery". */
export const MASTERY = {
  /** Bump when a requirement changes, so that anything derived from it can tell the rule sets apart. */
  version: 1,
  /** Experienced Angler: landed fish of an ordinary species, by its rarity (Common … Mythic). */
  catches: [20, 12, 6, 3, 1, 1],
  /** Master: a personal best of at least this share of the species' maximum weight. */
  trophyShare: 0.7,
  /** Master asks it of species up to this rarity (Epic); a rarer fish of that size is luck alone. */
  trophyMaxRarity: 3,
};
export type MasteryRules = typeof MASTERY;

export type TierId = 'explorer' | 'angler' | 'master';

export const TIERS: { id: TierId; name: string; rule: string }[] = [
  { id: 'explorer', name: 'Explorer', rule: 'Discover every ordinary species of the water' },
  { id: 'angler', name: 'Experienced Angler', rule: 'Land each species many times: the rarer it is, the fewer it takes' },
  { id: 'master', name: 'Master', rule: 'A personal best of 70% of the top weight for every species up to Epic' },
];

/**
 * The species mastery asks for: the water's pool without its hidden species. The water's special collectible is
 * not in the pool at all. Hidden and special fish stay a bonus of the encyclopedia.
 */
export function ordinarySpecies(loc: LocationDef): number[] {
  return loc.pool.map(([id]) => id).filter((id) => !SPECIES[id].hidden && !SPECIES[id].special);
}

export interface Requirement {
  have: number;
  need: number;
  done: boolean;
}

export interface SpeciesMastery {
  speciesId: number;
  rarity: Rarity;
  /** 0 or 1 of 1: discovered. */
  explorer: Requirement;
  /** Landed fish. */
  angler: Requirement;
  /** Personal best against the trophy weight, grams. Null when the species is too rare to be asked for one. */
  master: Requirement | null;
}

export interface TierProgress {
  id: TierId;
  name: string;
  /** Its own requirements are met, whatever the tiers before it say. */
  met: boolean;
  /** Completed: met, and so is every tier before it. */
  done: boolean;
  /** 0..1 of its own requirements. */
  progress: number;
}

export interface LocationMastery {
  locationId: number;
  /** Tiers completed in order, 0–3. */
  level: number;
  /** The tier being worked on; null once the water is mastered. */
  current: TierId | null;
  tiers: TierProgress[];
  /** Progress of the current tier, 0..1; 1 once the water is mastered. */
  progress: number;
  species: SpeciesMastery[];
}

type Dex = Save['dex'];

/** The weight a species' personal best has to reach for Master, grams. */
export const trophyWeight = (speciesId: number, rules: MasteryRules = MASTERY): number => Math.ceil(SPECIES[speciesId].maxWeight * rules.trophyShare);

function speciesMastery(dex: Dex, speciesId: number, rules: MasteryRules): SpeciesMastery {
  const sp = SPECIES[speciesId];
  const e = dex[speciesId];
  const count = e?.count ?? 0;
  const best = e?.best ?? 0;
  const need = rules.catches[sp.rarity] ?? 1;
  const trophy = trophyWeight(speciesId, rules);
  return {
    speciesId,
    rarity: sp.rarity,
    explorer: { have: count > 0 ? 1 : 0, need: 1, done: count > 0 },
    angler: { have: Math.min(count, need), need, done: count >= need },
    master: sp.rarity <= rules.trophyMaxRarity ? { have: Math.min(best, trophy), need: trophy, done: best >= trophy } : null,
  };
}

/** Share of a list of requirements that is done, each one counted by how far along it is. */
function share(reqs: Requirement[]): number {
  if (reqs.length === 0) return 1;
  return reqs.reduce((a, r) => a + (r.done ? 1 : Math.min(1, r.have / r.need)), 0) / reqs.length;
}

export function locationMastery(dex: Dex, loc: LocationDef, rules: MasteryRules = MASTERY): LocationMastery {
  const species = ordinarySpecies(loc).map((id) => speciesMastery(dex, id, rules));
  const lists: Record<TierId, Requirement[]> = {
    explorer: species.map((s) => s.explorer),
    angler: species.map((s) => s.angler),
    master: species.flatMap((s) => (s.master ? [s.master] : [])),
  };
  let open = true;
  const tiers = TIERS.map((t): TierProgress => {
    const met = lists[t.id].every((r) => r.done);
    // in order: a later tier does not count until the ones before it do
    open = open && met;
    return { id: t.id, name: t.name, met, done: open, progress: met ? 1 : share(lists[t.id]) };
  });
  const level = tiers.filter((t) => t.done).length;
  const current = tiers[level] ?? null;
  return { locationId: loc.id, level, current: current?.id ?? null, tiers, progress: current ? current.progress : 1, species };
}

export const allMastery = (dex: Dex, rules: MasteryRules = MASTERY): LocationMastery[] => LOCATIONS.map((l) => locationMastery(dex, l, rules));

export interface MasterySummary {
  locations: number;
  /** Waters that have completed at least that tier. */
  explorer: number;
  angler: number;
  master: number;
  /** Tiers completed over all waters, of `locations × 3`. */
  tiers: number;
  tiersTotal: number;
  /** A one-line rank for the collection header. */
  title: string;
}

export function masterySummary(all: LocationMastery[]): MasterySummary {
  const at = (n: number): number => all.filter((m) => m.level >= n).length;
  const s = { locations: all.length, explorer: at(1), angler: at(2), master: at(3), tiers: all.reduce((a, m) => a + m.level, 0), tiersTotal: all.length * TIERS.length };
  const waters = (n: number): string => (n === s.locations ? 'every water' : `${n} ${n === 1 ? 'water' : 'waters'}`);
  const title = s.master ? `Master of ${waters(s.master)}` : s.angler ? `Experienced in ${waters(s.angler)}` : s.explorer ? `Explorer of ${waters(s.explorer)}` : 'No water explored yet';
  return { ...s, title };
}

/** A whole percentage that reads 100 only when the thing is really done. */
export const percent = (progress: number, done: boolean): number => (done ? 100 : Math.min(99, Math.floor(progress * 100)));

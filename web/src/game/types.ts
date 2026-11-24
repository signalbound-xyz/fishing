/** Shared types of the local game. Pure data: nothing here knows about the DOM, storage or a chain. */

/** 0 Common, 1 Uncommon, 2 Rare, 3 Epic, 4 Legendary, 5 Mythic. */
export type Rarity = 0 | 1 | 2 | 3 | 4 | 5;
export type Quality = 'D' | 'C' | 'B' | 'A' | 'S';
export type Rng = () => number;

export interface SpeciesDef {
  id: number;
  name: string;
  rarity: Rarity;
  /** Grams. */
  minWeight: number;
  maxWeight: number;
  /** PEARL for an average-weight, B-quality fish. */
  basePrice: number;
  color: number;
  /** Hidden species sit in a pool with a tiny weight; the Ghost Fish bonus multiplies it. */
  hidden?: boolean;
  /** Id of the special collectible this species is (see SPECIALS). */
  special?: string;
}

export type Water = 'still' | 'moving' | 'deep';

export type Unlock =
  | { type: 'start' }
  | { type: 'level'; level: number }
  | { type: 'species'; count: number }
  | { type: 'special'; special: string };

export interface LocationDef {
  id: number;
  name: string;
  water: Water;
  energyCost: number;
  /** How rough the water is, 0–2: added to a fish's rarity to get how hard it fights and how fast it must be hooked. */
  tier: number;
  /** Index into the scene palettes. */
  palette: number;
  /** [speciesId, pool weight] */
  pool: [number, number][];
  unlock: Unlock;
  /** Special collectible that can be hooked here. */
  special?: string;
  /** A second way in: permanent access for PEARL, on offer from this level. The level alone opens nothing. */
  purchase?: { level: number; price: number };
  /** Tackle ids that suit the place, shown as a hint. */
  recommended: string[];
  blurb: string;
  /**
   * Reserved for future exclusive waters: access that depends on currently HOLDING a collectible (later: owning
   * the NFT). Distinct from `unlock`, which is permanent once earned. No location uses it yet.
   */
  ownership?: { special: string };
}

export interface Effects {
  catch: number;
  rarity: number;
  weight: number;
}

export interface SpecialDef {
  id: string;
  speciesId: number;
  name: string;
  /** Chance per landed fish at a location that carries this special, 0..1. */
  chance: number;
  /** Until the first one is found, this many dry catches at eligible locations guarantee it. */
  pity: number;
  unlocksLocation: number;
  /** Passive bonus while this special sits in the active slot (and a specimen is still held). */
  bonus: { label: string; effects?: Partial<Effects>; locations?: number[]; hiddenMult?: number };
  lore: string;
}

export interface FishInstance {
  id: string;
  speciesId: number;
  rarity: Rarity;
  /** Grams. */
  weight: number;
  quality: Quality;
  locationId: number;
  /** ms since epoch */
  caughtAt: number;
  sellPrice: number;
  tournamentScore: number;
  isFavorite: boolean;
  isSpecial: boolean;
}

export interface CatchRecord {
  speciesId: number;
  weight: number;
  locationId: number;
  at: number;
}

export interface WeekEntry {
  score: number;
  speciesId: number;
  weight: number;
  quality: Quality;
  at: number;
}

/** A landed fish as the daily challenges see it. `id` is unique per fish (the NFT id on the contracts), so one catch is never counted twice. */
export interface DayCatch {
  id: string;
  speciesId: number;
  /** Grams. */
  weight: number;
  locationId: number;
}

/** What a daily challenge asks for. `loc` narrows it to one water; without it any water counts. */
export type DailyGoal =
  | { kind: 'catch'; count: number; loc?: number }
  | { kind: 'species'; speciesId: number; count: number }
  | { kind: 'distinct'; count: number; loc?: number }
  | { kind: 'rarity'; min: Rarity; count: number }
  | { kind: 'weight'; grams: number; loc?: number };

export type DailyTier = 'easy' | 'medium' | 'hard';

export interface DailyChallenge {
  /** Stable and versioned: the same goal has the same id on every device, and a changed rule set changes the prefix. */
  id: string;
  tier: DailyTier;
  goal: DailyGoal;
  /** The water it was sized for: a hint for the player, and where the estimate below holds. */
  at: number;
  /** Energy it is expected to take there, with the rod it was sized for and no lure. */
  energy: number;
  /** The rod it was sized for, when that is not the starter rod. */
  rod?: string;
}

export interface DailySet {
  version: number;
  /** UTC day number: floor(ms / 86,400,000). */
  day: number;
  challenges: DailyChallenge[];
}

/** The local game's daily state. On the contracts none of this is stored: it is read from the day's events. */
export interface DailyState {
  /** The UTC day `set` and `catches` belong to. */
  day: number;
  /** The day's challenges, fixed when the day is first seen so that they do not change under the player. */
  set: DailySet | null;
  catches: DayCatch[];
  /** The last day on which all three were completed, and how many days in a row that made. */
  streak: { day: number; count: number };
  /**
   * The reward book (game/dailyReward.ts): completed days written down when the day turned, and days whose reward
   * was taken. Only today and yesterday are kept. Absent in saves from before the reward existed.
   */
  rewards?: { earned: number[]; claimed: number[] };
}

/** What one water has seen of one player (game/career.ts). */
export interface WaterCount {
  casts: number;
  catches: number;
  /** Casts that got no bite. Counted on the contracts only. */
  misses: number;
  /** Fish landed here, by species id. */
  species: Record<number, number>;
}

export interface Save {
  version: number;
  seq: number;
  pearl: number;
  /** BLEND tokens fished out. A local counter for now: nothing is paid out. */
  blend: number;
  /** How many BLEND prizes this player has landed. */
  blendWins: number;
  xp: number;
  energy: number;
  /** When `energy` was last settled, ms. */
  energyAt: number;
  refills: { day: number; count: number };
  /** Owned rods and their durability left. */
  rods: Record<string, { durability: number }>;
  /** Owned lures and the casts they have left. */
  lures: Record<string, { casts: number }>;
  equipped: { rod: string; lure: string | null };
  location: number;
  fish: FishInstance[];
  /** Encyclopedia: permanent, survives selling every specimen. */
  dex: Record<number, { count: number; best: number; firstAt: number }>;
  /** Locations unlocked for good. Never revoked. */
  permanentUnlocks: number[];
  /** Specials ever landed (drives pity and the trophy shelf). */
  specialsFound: string[];
  /** Dry-catch counters per special, for pity. */
  dry: Record<string, number>;
  activeSpecial: string | null;
  records: { overall: CatchRecord | null; byLocation: Record<number, CatchRecord> };
  /** Weekly championship: the best ten catches of each week, by week id. Past weeks stay as the archive. */
  weeks: Record<number, WeekEntry[]>;
  /** Claimed achievement ids (rewards are granted once). */
  claimed: string[];
  stats: { casts: number; catches: number; escaped: number; sold: number; earned: number };
  /** Daily challenges of the local game. */
  daily: DailyState;
  /**
   * Local game: casts and catches by water, counted from `since` (ms) on. A save from before this existed gets an
   * empty book when it loads: what was fished earlier is in `stats` and belongs to no water. On the contracts this
   * stays empty; the same numbers are read from the game's events (game/career.ts).
   */
  career: { since: number; waters: Record<number, WaterCount> };
}

/**
 * The scenarios the balance audit runs (`pnpm sim:audit`). Edit or add entries here to try other numbers: nothing
 * in this file touches the game, and none of it is applied to the contracts.
 */
import { LOCATIONS } from '../src/game/content';
import { WORLD_NOW, type World } from './lab';

const now = WORLD_NOW.energyCost;
const cap = (max: number): number[] => now.map((c) => Math.min(c, max));

/** Alternative energy rules. The first is the deployed game. */
export const WORLDS: World[] = [
  WORLD_NOW,
  {
    ...WORLD_NOW,
    name: 'Cost cap 2',
    note: 'no cast costs more than 2 energy; everything else as deployed',
    energyCost: cap(2),
  },
  {
    ...WORLD_NOW,
    name: 'Cost cap 2, neutral',
    note: 'cost cap 2, and fish from the waters that got cheaper sell for proportionally less, so PEARL per energy is unchanged',
    energyCost: cap(2),
    payout: now.map((c) => Math.min(c, 2) / c),
  },
  {
    ...WORLD_NOW,
    name: 'Cost cap 3',
    note: 'no cast costs more than 3 energy',
    energyCost: cap(3),
  },
  {
    ...WORLD_NOW,
    name: 'Bar of 40',
    note: 'the bar holds 40 instead of 20; regeneration (48 a day) and costs unchanged; the first refill costs 300, what 40 energy costs today (100 + 200)',
    maxEnergy: 40,
    refillPrice: 300,
  },
  {
    ...WORLD_NOW,
    name: 'Bar of 48',
    note: 'the bar holds a whole day of regeneration (48); the first refill costs 460, what 48 energy costs today (100 + 200 + 8/20 of 400)',
    maxEnergy: 48,
    refillPrice: 460,
  },
];

/** The waters a late-game player fishes: everything that costs 3 or 4 energy today. */
export const LATE_LOCATIONS = LOCATIONS.filter((l) => l.energyCost >= 3).map((l) => l.id);

/** Landing-rate targets for the first try, set for manual testing (BALANCE.md): [beginner, experienced], as shares. */
export const REEL_TARGETS: Record<number, { beginner: [number, number]; experienced: [number, number]; seconds: [number, number] }> = {
  0: { beginner: [0.85, 0.95], experienced: [0.95, 0.99], seconds: [5, 8] },
  2: { beginner: [0.45, 0.65], experienced: [0.75, 0.9], seconds: [8, 15] },
};

/**
 * Cups for the Tournaments contract as it is deployed: a water, one rod and lure for everybody, how hard the fish
 * fight (`waterTier`, free to set per cup), a number of casts and how many of the best count.
 */
export const CUPS = [
  { name: 'Pond Cup: Willow Rod, Village Pond, calm (tier 0), 30 casts, best 10', locId: 0, rod: 'willow', lure: null, waterTier: 0, casts: 30, counted: 10 },
  { name: 'Pond Cup with rough-water fights: the same, tier 2', locId: 0, rod: 'willow', lure: null, waterTier: 2, casts: 30, counted: 10 },
  { name: 'Rapids Cup: Taiga Fly Rod + Feather Fly, Taimen Rapids, tier 2, 30 casts, best 10', locId: 4, rod: 'flyrod', lure: 'fly', waterTier: 2, casts: 30, counted: 10 },
  { name: 'Rapids Cup, gentler: the same, tier 1', locId: 4, rod: 'flyrod', lure: 'fly', waterTier: 1, casts: 30, counted: 10 },
  { name: 'Daily trial: Willow Rod, Forest River, tier 1, 5 casts, best 3', locId: 1, rod: 'willow', lure: null, waterTier: 1, casts: 5, counted: 3 },
  { name: 'Daily trial: Deep Troller + Glow Jig, Northern Sea, tier 2, 5 casts, best 3', locId: 3, rod: 'troller', lure: 'jig', waterTier: 2, casts: 5, counted: 3 },
];

/**
 * Location mastery tiers to size (section 15): catches of an ordinary species by its rarity (Common … Mythic),
 * how big a trophy is, and the rarest species a trophy is asked of (3 = Epic).
 */
export const MASTERY = { times: [20, 12, 6, 3, 1, 1], trophy: 0.7, trophyMaxRarity: 3 };

/**
 * Made-up seasons for looking at the Season Hunt page before a weekly season exists on a chain, and for the tests
 * of the grouping (game/week.test.ts). The page shows them on a development server with `?huntDemo=<scene>`;
 * nothing here is read from a contract or sent to one, and the production build does not include it.
 *
 * The rules are those of the repository's week file (contracts/script/seasons/weeks/2026-w50.json).
 */
import type { Address } from 'viem';
import type { HuntAttempt, HuntOdds, HuntSeason, HuntStatus } from '../hunt';
import type { Difficulty, WeekEntry } from '../week';

const HOUR = 3600;
const DAY = 86_400;
const SETTLE = 3600;
const SPONSOR = '0x5b0e5b0e5b0e5b0e5b0e5b0e5b0e5b0e5b0e5b0e' as Address;
export const OTHER = '0x0a11ce0a11ce0a11ce0a11ce0a11ce0a11ce0a11' as Address;
const THIRD = '0x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b' as Address;

interface Spec {
  name: string;
  description: string;
  difficulty: Difficulty;
  startHour: number;
  hours: number;
  prize: number;
  speciesId: number;
  waters: number[];
  minLevel: number;
  dailyAttempts: number;
  odds: HuntOdds;
}

const SPECS: Spec[] = [
  {
    name: 'The Gilded Guest',
    description: 'A golden carp is feeding in the shallows. Any rod will do, and the pond is as good a place as any.',
    difficulty: 'easy',
    startHour: 0,
    hours: 48,
    prize: 200,
    speciesId: 4,
    waters: [0, 1],
    minLevel: 0,
    dailyAttempts: 20,
    odds: { baseChance: 11_574_074, maxBonus: 50, rodBonus: [0, 10, 10, 20, 20, 30], lureBonus: [10, 10, 20, 10, 10, 30], waterBonus: [0, 10] },
  },
  {
    name: 'The Night Catfish',
    description: 'A wels catfish has come up from the deep. It can be met anywhere from the pond to the lake, and the lake is where it is at home.',
    difficulty: 'medium',
    startHour: 48,
    hours: 48,
    prize: 300,
    speciesId: 13,
    waters: [0, 1, 2],
    minLevel: 2,
    dailyAttempts: 16,
    odds: { baseChance: 8_256_275, maxBonus: 100, rodBonus: [0, 20, 20, 40, 30, 60], lureBonus: [10, 20, 40, 20, 10, 60], waterBonus: [0, 15, 30] },
  },
  {
    name: 'The Wandering Bluefin',
    description: 'A bluefin tuna has strayed inland. It keeps to moving and deep water, and the open sea suits it best. Good tackle counts for the most here, and it still guarantees nothing.',
    difficulty: 'hard',
    startHour: 96,
    hours: 72,
    prize: 500,
    speciesId: 19,
    waters: [1, 2, 3],
    minLevel: 3,
    dailyAttempts: 12,
    odds: { baseChance: 6_816_633, maxBonus: 200, rodBonus: [0, 30, 20, 60, 30, 80], lureBonus: [20, 30, 60, 20, 10, 80], waterBonus: [0, 0, 25, 40] },
  },
];

/** What happened to a hunt of a scene. */
type Fate =
  | { kind: 'plain'; funded?: boolean }
  /** Hooked `hoursIn` hours after the hunt opened, by `player`. */
  | { kind: 'hooked'; hoursIn: number; player: Address; paid?: boolean; trophy?: bigint }
  | { kind: 'nobody'; returned?: boolean }
  | { kind: 'off' };

function season(id: number, spec: Spec, weekStart: number, fate: Fate, now: number): HuntSeason {
  const start = weekStart + spec.startHour * HOUR;
  const end = start + spec.hours * HOUR;
  const funded = fate.kind !== 'plain' || fate.funded !== false;
  let winner: HuntAttempt | null = null;
  if (fate.kind === 'hooked') {
    const time = start + fate.hoursIn * HOUR;
    winner = { player: fate.player, seq: 137 + id, blockNumber: 43_000_000n + BigInt(Math.floor(time % 1_000_000)), time, rod: 3, lure: 2, water: spec.waters[spec.waters.length - 1] };
  }
  // what the contract's `status` would say at `now`
  let status: HuntStatus;
  if (fate.kind === 'off') status = 'cancelled';
  else if (now < start) status = 'upcoming';
  else if (!funded) status = 'cancelled';
  else if (winner && now >= winner.time) status = 'winner';
  else if (now < end) status = 'active';
  else status = now <= end + SETTLE ? 'closing' : 'expired';
  const hooked = status === 'winner' ? winner : null;
  return {
    id,
    name: spec.name,
    description: spec.description,
    start,
    end,
    speciesId: spec.speciesId,
    waters: spec.waters,
    rods: [],
    minLevel: spec.minLevel,
    dailyAttempts: spec.dailyAttempts,
    settleWindow: SETTLE,
    odds: spec.odds,
    prize: spec.prize,
    sponsor: funded ? SPONSOR : null,
    status,
    finalAt: hooked ? hooked.time + SETTLE : end + SETTLE,
    attempts: status === 'upcoming' ? 0 : hooked ? hooked.seq + 4 : 312 + id * 17,
    winner: hooked,
    paid: fate.kind === 'hooked' && !!fate.paid && !!hooked,
    returned: fate.kind === 'nobody' && !!fate.returned,
    trophyId: fate.kind === 'hooked' && hooked ? (fate.trophy ?? 0n) : 0n,
    attemptsLeft: status === 'active' ? Math.max(0, spec.dailyAttempts - 3) : 0,
    ticket: 0,
    ticketWei: 0n,
    hasTicket: false,
  };
}

export const DEMO_SCENES = ['upcoming', 'monday', 'early', 'midweek', 'friday', 'finalizing', 'over'] as const;
export type DemoScene = (typeof DEMO_SCENES)[number];

/** Hours from the week's start to `now`, and what became of its three hunts, by scene. */
function sceneOf(scene: string, me: Address): { hoursIn: number; fates: Fate[] } {
  const plain: Fate = { kind: 'plain' };
  switch (scene) {
    case 'upcoming':
      return { hoursIn: -27, fates: [plain, plain, plain] };
    case 'early':
      // the first fish was hooked forty minutes ago, on Monday morning: the result is not final yet
      return { hoursIn: 3, fates: [{ kind: 'hooked', hoursIn: 2.33, player: OTHER }, plain, plain] };
    case 'midweek':
      return { hoursIn: 61, fates: [{ kind: 'hooked', hoursIn: 9, player: OTHER, paid: true, trophy: 61n }, plain, plain] };
    case 'friday':
      return { hoursIn: 101, fates: [{ kind: 'hooked', hoursIn: 9, player: me }, { kind: 'nobody' }, plain] };
    case 'finalizing':
      return { hoursIn: 168.2, fates: [{ kind: 'hooked', hoursIn: 9, player: OTHER, paid: true, trophy: 61n }, { kind: 'hooked', hoursIn: 31, player: me }, plain] };
    case 'over':
      return { hoursIn: 190, fates: [{ kind: 'hooked', hoursIn: 9, player: OTHER, paid: true, trophy: 61n }, { kind: 'hooked', hoursIn: 31, player: me, paid: true, trophy: 64n }, { kind: 'nobody', returned: true }] };
    default:
      return { hoursIn: 5, fates: [plain, plain, plain] };
  }
}

export interface DemoWeeks {
  seasons: HuntSeason[];
  entries: WeekEntry[];
}

/**
 * A chain's worth of made-up seasons at `now`: a single season from before weekly seasons (id 0), a completed
 * week (ids 1 to 3) and the week of the scene (ids 4 to 6). `me` wins some of them, so that claiming can be seen.
 */
export function demoWeeks(scene: string, now: number, me: string | null): DemoWeeks {
  const player = (me ?? THIRD) as Address;
  const { hoursIn, fates } = sceneOf(scene, player);
  const start = Math.floor(now - hoursIn * HOUR);
  const before = start - 7 * DAY;
  const legacy: Spec = { ...SPECS[2], name: 'The Stray Taimen', description: 'A taimen has left the rapids and been seen in quieter water.', startHour: 0, hours: 168, prize: 1000, speciesId: 9, waters: [0, 1, 2, 3], minLevel: 0, dailyAttempts: 20 };
  const seasons = [
    season(0, legacy, before - 8 * DAY, { kind: 'hooked', hoursIn: 50, player: THIRD, paid: true, trophy: 40n }, now),
    season(1, SPECS[0], before, { kind: 'hooked', hoursIn: 4, player: OTHER, paid: true, trophy: 52n }, now),
    season(2, SPECS[1], before, { kind: 'nobody', returned: true }, now),
    season(3, SPECS[2], before, { kind: 'hooked', hoursIn: 20, player, paid: false }, now),
    ...SPECS.map((spec, i) => season(4 + i, spec, start, fates[i], now)),
  ];
  const entry = (id: string, title: string, description: string, at: number, first: number): WeekEntry => ({
    id,
    title,
    description,
    start: at,
    end: at + 7 * DAY,
    hunts: SPECS.map((spec, i) => ({ seasonId: first + i, difficulty: spec.difficulty })),
  });
  return {
    // newest first, as the contract lists them
    seasons: seasons.reverse(),
    entries: [
      entry('demo-before', 'The First Three', 'The week before this one.', before, 1),
      entry('demo-now', 'The Three Strays', 'Three fish have left their home waters this week, one after another. Each is a hunt of its own: the first angler to hook it takes that hunt’s prize.', start, 4),
    ],
  };
}

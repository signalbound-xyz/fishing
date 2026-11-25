import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LURES, RODS } from '../tackle/catalog';
import { LOCATIONS, SPECIES } from './content';
import { OTHER, demoWeeks } from './fixtures/weekDemo';
import { countdown, type HuntSeason } from './hunt';
import {
  HUNTS_PER_WEEK,
  cardStatus,
  claimable,
  concluded,
  currentWeek,
  featuredHunt,
  groupWeeks,
  pageState,
  pastWeeks,
  planWeek,
  prizeState,
  progressText,
  statusAt,
  takesCasts,
  unixOf,
  validateWeek,
  type Catalog,
  type WeekFile,
  type WeekView,
} from './week';

const CATALOG: Catalog = { species: SPECIES.length, locations: LOCATIONS.length, rods: RODS.length, lures: LURES.length };
const file = (): WeekFile => JSON.parse(readFileSync(new URL('../../../contracts/script/seasons/weeks/2026-w50.json', import.meta.url), 'utf8')) as WeekFile;

const NOW = 1_796_000_000;
const ME = '0x1111111111111111111111111111111111111111';
const HOUR = 3600;
const DAY = 86_400;

/** The week of a scene, as the page would group it at `now`. */
function scene(name: string, me: string | null = ME, now = NOW): { weeks: WeekView<HuntSeason>[]; week: WeekView<HuntSeason>; seasons: HuntSeason[] } {
  const demo = demoWeeks(name, now, me);
  const weeks = groupWeeks(demo.entries, demo.seasons, now);
  return { weeks, week: weeks.find((w) => w.id === 'demo-now')!, seasons: demo.seasons };
}

describe('the week file', () => {
  it('reads a UTC time and nothing that only looks like one', () => {
    expect(unixOf('2026-12-07T00:00:00Z')).toBe(1_796_601_600);
    expect(unixOf('1970-01-01T00:00:00Z')).toBe(0);
    expect(unixOf('2028-02-29T23:59:59Z')).toBe(1_835_481_599);
    for (const bad of ['2026-12-07', '2026-12-07 00:00:00Z', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-12-07T24:00:00Z', '2026-12-07T00:00:00+01:00']) expect(unixOf(bad), bad).toBeNull();
  });

  it('the week file of the repository can be created in this game', () => {
    expect(validateWeek(file(), CATALOG)).toEqual([]);
  });

  it('is three hunts, Monday to Sunday, 20%, 30% and 50% of the pool', () => {
    const plan = planWeek(file());
    expect(plan.hunts).toHaveLength(HUNTS_PER_WEEK);
    expect(new Date(plan.start * 1000).getUTCDay()).toBe(1); // a Monday
    expect(plan.end - plan.start).toBe(7 * DAY);
    expect(plan.hunts.map((h) => (h.start - plan.start) / DAY)).toEqual([0, 2, 4]);
    expect(plan.hunts.map((h) => (h.end - h.start) / DAY)).toEqual([2, 2, 3]);
    expect(plan.hunts.map((h) => h.prize)).toEqual([200, 300, 500]);
    expect(plan.hunts.reduce((sum, h) => sum + h.prize, 0)).toBe(plan.totalPrize);
    expect(plan.hunts.map((h) => h.difficulty)).toEqual(['easy', 'medium', 'hard']);
    expect(new Set(plan.hunts.map((h) => h.speciesId)).size).toBe(3);
  });

  it('a hunt is harder by more than its fish: who may enter, where, and what tackle is worth', () => {
    const [easy, medium, hard] = planWeek(file()).hunts;
    expect(easy.minLevel).toBeLessThan(medium.minLevel);
    expect(medium.minLevel).toBeLessThan(hard.minLevel);
    expect(easy.waters).toContain(0); // the pond, open to everybody
    expect(hard.waters).not.toContain(0);
    expect(easy.maxBonus).toBeLessThan(medium.maxBonus);
    expect(medium.maxBonus).toBeLessThan(hard.maxBonus);
    expect(easy.dailyAttempts).toBeGreaterThan(hard.dailyAttempts);
  });

  it('refuses a week that is not exactly three hunts', () => {
    const two = file();
    two.hunts.pop();
    expect(validateWeek(two, CATALOG)).toContain('a week is exactly 3 hunts');
    const four = file();
    four.hunts.push({ ...four.hunts[2] });
    expect(validateWeek(four, CATALOG)).toContain('a week is exactly 3 hunts');
  });

  it('refuses hunts that overlap or are out of order', () => {
    const overlap = file();
    overlap.hunts[1].startHour = 47;
    expect(validateWeek(overlap, CATALOG).join('\n')).toMatch(/hunt 2: starts before hunt 1 ends/);
    const swapped = file();
    [swapped.hunts[0], swapped.hunts[1]] = [swapped.hunts[1], swapped.hunts[0]];
    expect(validateWeek(swapped, CATALOG).join('\n')).toMatch(/starts before hunt 1 ends/);
    const late = file();
    late.hunts[2].durationHours = 73;
    expect(validateWeek(late, CATALOG)).toContain('hunt 3: ends after the week does');
  });

  it('a gap between two hunts is allowed: only overlaps are not', () => {
    const gap = file();
    gap.hunts[1].startHour = 50;
    gap.hunts[1].durationHours = 46;
    expect(validateWeek(gap, CATALOG)).toEqual([]);
  });

  it('refuses prizes that do not add up, and what the game does not have', () => {
    const shares = file();
    shares.hunts[0].prizeShare = 25;
    expect(validateWeek(shares, CATALOG)).toContain('the prize shares add up to 105%, not 100%');
    const species = file();
    species.hunts[2].speciesId = 999;
    expect(validateWeek(species, CATALOG).join('\n')).toMatch(/hunt 3: species 999 is not in the game/);
    const water = file();
    water.hunts[0].waters = [0, 12];
    expect(validateWeek(water, CATALOG).join('\n')).toMatch(/hunt 1: a water that is not in the game/);
    const twice = file();
    twice.hunts[0].waters = [0, 0];
    expect(validateWeek(twice, CATALOG)).toContain('hunt 1: a water is listed twice');
    const chance = file();
    chance.hunts[2].baseChance = 50_000_000;
    expect(validateWeek(chance, CATALOG)).toContain('hunt 3: with the best tackle an attempt would be more likely than one in ten');
    const date = file();
    date.start = 'next monday';
    expect(validateWeek(date, CATALOG)).toContain('start must be a UTC time like 2026-12-07T00:00:00Z');
    const version = file();
    version.version = 2;
    expect(validateWeek(version, CATALOG)).toContain('version must be 1');
  });
});

describe('a hunt over time', () => {
  const base = scene('monday').seasons.find((s) => s.id === 4)!;
  const upcoming = { ...base, status: 'upcoming' as const };

  it('moves from upcoming to active to its end by the clock alone', () => {
    expect(cardStatus(upcoming, upcoming.start - 1)).toBe('upcoming');
    expect(cardStatus(upcoming, upcoming.start)).toBe('active');
    expect(cardStatus(upcoming, upcoming.end - 1)).toBe('active');
    // casting is over, a late catch can still be recorded: not final yet
    expect(cardStatus(upcoming, upcoming.end)).toBe('pending');
    expect(cardStatus(upcoming, upcoming.end + upcoming.settleWindow)).toBe('pending');
    expect(cardStatus(upcoming, upcoming.end + upcoming.settleWindow + 1)).toBe('none');
  });

  it('a hooked fish is pending until its window is over, then it is a winner for good', () => {
    const time = base.start + HOUR;
    const hooked = { ...base, status: 'winner' as const, winner: { player: OTHER, seq: 3, blockNumber: 1n, time, rod: 0, lure: null, water: 0 }, finalAt: time + base.settleWindow };
    expect(cardStatus(hooked, time + 60)).toBe('pending');
    expect(concluded(cardStatus(hooked, time + 60))).toBe(false);
    expect(cardStatus(hooked, hooked.finalAt)).toBe('pending');
    expect(cardStatus(hooked, hooked.finalAt + 1)).toBe('winner');
    expect(concluded(cardStatus(hooked, hooked.finalAt + 1))).toBe(true);
  });

  it('a hunt that starts without its prize never runs', () => {
    const unfunded = { ...upcoming, sponsor: null };
    expect(cardStatus(unfunded, unfunded.start - 1)).toBe('upcoming');
    expect(prizeState(unfunded, unfunded.start - 1)).toBe('unfunded');
    expect(cardStatus(unfunded, unfunded.start)).toBe('off');
    expect(takesCasts(unfunded, unfunded.start + 60)).toBe(false);
  });

  it('a hunt called off stays off', () => {
    const off = { ...upcoming, status: 'cancelled' as const };
    for (const t of [off.start - 1, off.start + 1, off.end + DAY]) expect(cardStatus(off, t)).toBe('off');
  });

  it('only a hunt that is being fished takes casts', () => {
    expect(takesCasts(upcoming, upcoming.start - 1)).toBe(false);
    expect(takesCasts(upcoming, upcoming.start)).toBe(true);
    expect(takesCasts(upcoming, upcoming.end)).toBe(false);
    expect(takesCasts(null, NOW)).toBe(false);
    expect(statusAt(upcoming, upcoming.end + 1)).toBe('closing');
  });
});

describe('a week of three hunts', () => {
  it('shows exactly three hunts, in the order they run', () => {
    const { week } = scene('monday');
    expect(week.hunts).toHaveLength(3);
    expect(week.hunts.map((h) => h.index)).toEqual([0, 1, 2]);
    expect(week.hunts.map((h) => h.difficulty)).toEqual(['easy', 'medium', 'hard']);
    const starts = week.hunts.map((h) => h.season!.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    // no two of them run at the same time
    for (let i = 1; i < 3; i++) expect(week.hunts[i].season!.start).toBeGreaterThanOrEqual(week.hunts[i - 1].season!.end);
    expect(week.legacy).toBe(false);
  });

  it('orders the hunts by their dates on the chain, whatever order the registry lists them in', () => {
    const demo = demoWeeks('monday', NOW, ME);
    const entry = demo.entries.find((e) => e.id === 'demo-now')!;
    const shuffled = { ...entry, hunts: [entry.hunts[2], entry.hunts[0], entry.hunts[1]] };
    const [week] = groupWeeks([shuffled], demo.seasons, NOW).filter((w) => w.id === 'demo-now');
    expect(week.hunts.map((h) => h.seasonId)).toEqual([4, 5, 6]);
    expect(week.hunts.map((h) => h.index)).toEqual([0, 1, 2]);
  });

  it('before the week: three upcoming hunts and a countdown to the first', () => {
    const { week } = scene('upcoming');
    expect(week.state).toBe('upcoming');
    expect(week.hunts.map((h) => h.status)).toEqual(['upcoming', 'upcoming', 'upcoming']);
    expect(week.concluded).toBe(0);
    expect(progressText(week)).toBe('0/3');
    expect(week.next).toEqual({ kind: 'hunt-starts', at: week.hunts[0].season!.start, index: 0 });
    expect(countdown(week.next!.at - NOW)).toBe('1d 3h');
    expect(week.hunts.every((h) => !takesCasts(h.season, NOW))).toBe(true);
  });

  it('on Monday: the first hunt is fished, the others wait for their own days', () => {
    const { week } = scene('monday');
    expect(week.state).toBe('running');
    expect(week.hunts.map((h) => h.status)).toEqual(['active', 'upcoming', 'upcoming']);
    expect(week.next).toEqual({ kind: 'hunt-ends', at: week.hunts[0].season!.end, index: 0 });
    expect(featuredHunt(week)?.index).toBe(0);
    expect(week.hunts.map((h) => takesCasts(h.season, NOW))).toEqual([true, false, false]);
  });

  it('a fish hooked early does not start the next hunt', () => {
    const { week } = scene('early');
    // hooked forty minutes ago, on the first morning
    expect(week.hunts[0].status).toBe('pending');
    expect(week.hunts[1].status).toBe('upcoming');
    expect(week.hunts[2].status).toBe('upcoming');
    expect(week.hunts.some((h) => takesCasts(h.season, NOW))).toBe(false);
    // the next thing to wait for is the second hunt's own start, almost two days away
    expect(week.next?.kind).toBe('hunt-starts');
    expect(week.next?.index).toBe(1);
    expect(week.next!.at).toBe(week.start + 48 * HOUR);
    expect(week.next!.at - NOW).toBeGreaterThan(44 * HOUR);
    expect(week.state).toBe('running');
    expect(week.concluded).toBe(0);
    // and it is still not started an hour before it is due, final result or not
    const later = groupWeeks(demoWeeks('early', NOW, ME).entries, demoWeeks('early', NOW, ME).seasons, week.next!.at - HOUR).find((w) => w.id === 'demo-now')!;
    expect(later.hunts.map((h) => h.status)).toEqual(['winner', 'upcoming', 'upcoming']);
    expect(later.concluded).toBe(1);
  });

  it('midweek: one result is final, the second hunt is on, the third is still to come', () => {
    const { week } = scene('midweek');
    expect(week.hunts.map((h) => h.status)).toEqual(['winner', 'active', 'upcoming']);
    expect(week.concluded).toBe(1);
    expect(progressText(week)).toBe('1/3');
    expect(featuredHunt(week)?.index).toBe(1);
    expect(week.next).toEqual({ kind: 'hunt-ends', at: week.hunts[1].season!.end, index: 1 });
  });

  it('adds the three prizes up, and says how much of them is really in the contract', () => {
    const { week } = scene('monday');
    expect(week.totalPrize).toBe(1000);
    expect(week.fundedPrize).toBe(1000);
    const demo = demoWeeks('upcoming', NOW, ME);
    const seasons = demo.seasons.map((s) => (s.id === 5 ? { ...s, sponsor: null } : s));
    const week2 = groupWeeks(demo.entries, seasons, NOW).find((w) => w.id === 'demo-now')!;
    expect(week2.totalPrize).toBe(1000);
    expect(week2.fundedPrize).toBe(700);
  });

  it('three hunts, three results: a winner, nobody, and a hunt still on', () => {
    const { week } = scene('friday');
    expect(week.hunts.map((h) => h.status)).toEqual(['winner', 'none', 'active']);
    expect(week.concluded).toBe(2);
    expect(week.hunts[0].season!.winner!.player).toBe(ME);
    expect(week.hunts[1].season!.winner).toBeNull();
    expect(prizeState(week.hunts[0].season!, NOW)).toBe('claimable');
    expect(prizeState(week.hunts[1].season!, NOW)).toBe('returnable');
    expect(prizeState(week.hunts[2].season!, NOW)).toBe('escrow');
    expect(week.state).toBe('running');
  });

  it('stays the current week until its last result is final', () => {
    const { weeks, week } = scene('finalizing');
    expect(week.hunts.map((h) => h.status)).toEqual(['winner', 'winner', 'pending']);
    expect(week.state).toBe('finalizing');
    expect(week.next).toEqual({ kind: 'result-final', at: week.hunts[2].season!.finalAt, index: 2 });
    expect(currentWeek(weeks, NOW)?.id).toBe('demo-now');
    expect(pastWeeks(weeks).map((w) => w.id)).not.toContain('demo-now');
  });

  it('when every result is final the week is over, with each hunt its own winner and prize', () => {
    const { weeks, week } = scene('over');
    expect(week.state).toBe('over');
    expect(week.next).toBeNull();
    expect(progressText(week)).toBe('3/3');
    expect(week.hunts.map((h) => h.status)).toEqual(['winner', 'winner', 'none']);
    expect(week.hunts.map((h) => h.season!.winner?.player ?? null)).toEqual([OTHER, ME, null]);
    expect(week.hunts.map((h) => prizeState(h.season!, NOW))).toEqual(['claimed', 'claimed', 'returned']);
    expect(week.hunts.map((h) => h.season!.prize)).toEqual([200, 300, 500]);
    expect(pastWeeks(weeks).map((w) => w.id)).toContain('demo-now');
  });
});

describe('the weeks of a chain', () => {
  it('the page opens on the week being fished, else the one awaiting a result, else the next, else the latest', () => {
    expect(currentWeek(scene('monday').weeks, NOW)?.id).toBe('demo-now');
    expect(currentWeek(scene('finalizing').weeks, NOW)?.id).toBe('demo-now');
    expect(currentWeek(scene('upcoming').weeks, NOW)?.id).toBe('demo-now');
    expect(currentWeek(scene('over').weeks, NOW)?.id).toBe('demo-now');
    expect(currentWeek([], NOW)).toBeNull();
  });

  it('keeps every earlier season when a new week starts', () => {
    const { weeks } = scene('monday');
    expect(weeks.map((w) => w.id)).toEqual(['demo-now', 'demo-before', 'season-0']);
    const before = weeks.find((w) => w.id === 'demo-before')!;
    expect(before.state).toBe('over');
    expect(before.hunts.map((h) => h.status)).toEqual(['winner', 'none', 'winner']);
    expect(before.hunts.map((h) => h.season!.speciesId)).toEqual([4, 13, 19]);
    expect(before.totalPrize).toBe(1000);
    expect(pastWeeks(weeks).map((w) => w.id)).toEqual(['demo-before', 'season-0']);
  });

  it('a season from before weekly seasons is a week of one hunt, under its own name', () => {
    const { weeks } = scene('monday');
    const old = weeks.find((w) => w.id === 'season-0')!;
    expect(old.legacy).toBe(true);
    expect(old.title).toBe('The Stray Taimen');
    expect(old.hunts).toHaveLength(1);
    expect(old.hunts[0].difficulty).toBeNull();
    expect(old.hunts[0].status).toBe('winner');
    expect(old.totalPrize).toBe(1000);
    expect(progressText(old)).toBe('1/1');
  });

  it('with no registry at all every season is still there: what the live network has today', () => {
    const demo = demoWeeks('monday', NOW, ME);
    const weeks = groupWeeks([], demo.seasons, NOW);
    expect(weeks).toHaveLength(demo.seasons.length);
    expect(weeks.every((w) => w.legacy && w.hunts.length === 1)).toBe(true);
    expect(new Set(weeks.flatMap((w) => w.hunts.map((h) => h.seasonId))).size).toBe(demo.seasons.length);
  });

  it('never shows a season twice, and never loses one', () => {
    const demo = demoWeeks('monday', NOW, ME);
    // a second week claims a season of the first
    const greedy = { ...demo.entries[1], id: 'greedy', hunts: [demo.entries[0].hunts[0], demo.entries[1].hunts[1], demo.entries[1].hunts[2]] };
    const weeks = groupWeeks([demo.entries[0], greedy], demo.seasons, NOW);
    const shown = weeks.flatMap((w) => w.hunts.filter((h) => h.season).map((h) => h.seasonId));
    expect([...shown].sort()).toEqual(demo.seasons.map((s) => s.id).sort());
    expect(weeks.find((w) => w.id === 'greedy')!.hunts.map((h) => h.status)).toContain('missing');
  });

  it('a week of another deployment, none of whose seasons the contract has, is not shown', () => {
    const demo = demoWeeks('monday', NOW, ME);
    const foreign = { ...demo.entries[0], id: 'foreign', hunts: demo.entries[0].hunts.map((h, i) => ({ ...h, seasonId: 900 + i })) };
    const weeks = groupWeeks([foreign, ...demo.entries], demo.seasons, NOW);
    expect(weeks.map((w) => w.id)).not.toContain('foreign');
    expect(weeks).toHaveLength(3);
  });

  it('a registry that names a season the contract does not have shows that hunt as missing, not as made up', () => {
    const demo = demoWeeks('monday', NOW, ME);
    const seasons = demo.seasons.filter((s) => s.id !== 6);
    const week = groupWeeks(demo.entries, seasons, NOW).find((w) => w.id === 'demo-now')!;
    const missing = week.hunts.find((h) => h.seasonId === 6)!;
    expect(missing.status).toBe('missing');
    expect(missing.season).toBeNull();
    expect(week.totalPrize).toBe(500);
    expect(takesCasts(missing.season, NOW)).toBe(false);
  });

  it('gives the same winners and prizes when the same chain is read again', () => {
    // a reload reads the contract afresh: nothing of the result lives in the browser
    const reread = (): string => {
      const demo = demoWeeks('over', NOW, ME);
      const chain = JSON.parse(JSON.stringify(demo.seasons, (_, v) => (typeof v === 'bigint' ? v.toString() : v))) as HuntSeason[];
      return JSON.stringify(groupWeeks(demo.entries, chain, NOW).map((w) => [w.id, w.state, w.totalPrize, w.hunts.map((h) => [h.seasonId, h.status, h.season?.winner?.player ?? null, h.season?.prize, h.season?.paid, h.season?.returned])]));
    };
    expect(reread()).toBe(reread());
    expect(reread()).toContain(ME);
  });
});

describe('whose prize it is', () => {
  it('lists the prizes the signed-in account has won and not taken, across every week', () => {
    const { weeks } = scene('friday');
    const mine = claimable(weeks, ME, NOW);
    // this week's first hunt and last week's third
    expect(mine.map((h) => h.seasonId).sort()).toEqual([3, 4]);
    expect(mine.reduce((sum, h) => sum + h.season!.prize, 0)).toBe(700);
  });

  it('follows the wallet: another account sees its own prizes, and nobody sees any', () => {
    const { weeks } = scene('friday');
    expect(claimable(weeks, OTHER, NOW)).toEqual([]); // its prize was claimed already
    expect(claimable(weeks, null, NOW)).toEqual([]);
    expect(claimable(weeks, undefined, NOW)).toEqual([]);
    expect(claimable(weeks, ME.toUpperCase().replace('0X', '0x'), NOW).map((h) => h.seasonId).sort()).toEqual([3, 4]);
    // the same chain read for another account: the winners do not move
    const other = scene('friday', ME).weeks.flatMap((w) => w.hunts.map((h) => h.season?.winner?.player ?? null));
    expect(weeks.flatMap((w) => w.hunts.map((h) => h.season?.winner?.player ?? null))).toEqual(other);
  });

  it('a prize is not claimable before the result is final, nor after it was claimed', () => {
    // OTHER holds this week's first catch, hooked forty minutes ago: not final, so not claimable. What it can
    // claim is last week's prize.
    const early = scene('early', OTHER);
    expect(early.week.hunts[0].season!.winner!.player).toBe(OTHER);
    expect(claimable(early.weeks, OTHER, NOW).map((h) => h.seasonId)).toEqual([3]);
    expect(claimable(scene('over').weeks, ME, NOW).map((h) => h.seasonId)).toEqual([3]);
  });
});

describe('what the page is doing', () => {
  it('says so while it reads, when it cannot, and when a re-read failed', () => {
    expect(pageState({ loaded: false, failed: false, seasons: 0, weeks: 0 })).toBe('loading');
    expect(pageState({ loaded: false, failed: true, seasons: 0, weeks: 0 })).toBe('error');
    expect(pageState({ loaded: true, failed: false, seasons: 0, weeks: 0 })).toBe('empty');
    expect(pageState({ loaded: true, failed: false, seasons: 7, weeks: 3 })).toBe('ready');
    // the network dropped after a good read: what was read stays on the page
    expect(pageState({ loaded: true, failed: true, seasons: 7, weeks: 3 })).toBe('stale');
  });
});

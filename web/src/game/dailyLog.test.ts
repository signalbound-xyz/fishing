import { describe, expect, it } from 'vitest';
import { LOCATIONS, SPECIES } from './content';
import { generateDaily, setProgress, type DayCatch, type Profile } from './daily';
import { CHUNK, CONFIRMATIONS, DAY_SECONDS, applyEvents, emptyLog, firstBlockAt, profileBefore, readDay, setOf, streakFrom, type ChainReader, type DayEvent, type DayLog } from './dailyLog';

const DAY = 20_780;
const ME = '0x00000000000000000000000000000000000000aa';
/** A chain with one block a second: block GENESIS was mined at T0. */
const GENESIS = 1_000n;
const T0 = DAY * DAY_SECONDS - 5_000;
const blockAt = (ts: number): bigint => GENESIS + BigInt(ts - T0);
const DAY_FIRST = blockAt(DAY * DAY_SECONDS);

const fish = (id: string, speciesId = 0, weight = 200, locationId = 0): DayCatch => ({ id, speciesId, weight, locationId });
const caught = (id: string, speciesId = 0, weight = 200, locationId = 0): DayEvent => ({ kind: 'catch', fish: fish(id, speciesId, weight, locationId) });

/** A fake chain: events sit in blocks, and every question asked of it is written down. */
function chain(headBlock: bigint, events: [bigint, DayEvent][] = [], gaps: { from: bigint; seconds: number }[] = []) {
  const asked = { timestamps: 0, ranges: [] as [bigint, bigint][] };
  let head = headBlock;
  let broken = false;
  const ts = (b: bigint): number => T0 + Number(b - GENESIS) + gaps.filter((g) => b >= g.from).reduce((a, g) => a + g.seconds, 0);
  const r: ChainReader = {
    head: async () => {
      if (broken) throw new Error('rpc down');
      return { number: head, timestamp: ts(head) };
    },
    timestamp: async (b) => {
      if (broken) throw new Error('rpc down');
      asked.timestamps++;
      if (b > head) throw new Error(`block ${b} is not there yet`);
      return ts(b);
    },
    events: async (from, to) => {
      if (broken) throw new Error('rpc down');
      if (to - from + 1n > 100_000n) throw new Error('query exceeds max block range 100000');
      if (to > head) throw new Error('range past the head');
      asked.ranges.push([from, to]);
      return events.filter(([b]) => b >= from && b <= to).map(([, e]) => e);
    },
  };
  return {
    r,
    asked,
    ts,
    mine: (n: bigint, more: [bigint, DayEvent][] = []) => {
      head += n;
      events.push(...more);
    },
    add: (more: [bigint, DayEvent][]) => events.push(...more),
    breakIt: (v: boolean) => (broken = v),
    head: () => head,
  };
}
const headOf = async (c: ReturnType<typeof chain>) => c.r.head();

describe('folding events into a day', () => {
  it('adds catches, unlocks and rods', () => {
    const log = applyEvents(emptyLog(DAY, 100n), [caught('1'), { kind: 'unlock', locationId: 1 }, { kind: 'rod', rod: 2 }, caught('2', 5, 3000, 1)], 150n);
    expect(log.catches.map((c) => c.id)).toEqual(['1', '2']);
    expect(log.unlocked).toEqual([1]);
    expect(log.rods).toEqual([2]);
    expect(log.to).toBe('150');
    expect(log.from).toBe('100');
  });

  it('is idempotent: the same events read twice, or two overlapping reads, change nothing', () => {
    const events: DayEvent[] = [caught('1'), caught('2'), { kind: 'unlock', locationId: 1 }];
    const once = applyEvents(emptyLog(DAY, 100n), events, 150n);
    const twice = applyEvents(once, events, 150n);
    expect(twice).toEqual(once);
    const overlap = applyEvents(once, [caught('2'), caught('3'), { kind: 'unlock', locationId: 1 }], 170n);
    expect(overlap.catches.map((c) => c.id)).toEqual(['1', '2', '3']);
    expect(overlap.unlocked).toEqual([1]);
    // an older read arriving late does not move the mark back
    expect(applyEvents(overlap, [caught('1')], 120n).to).toBe('170');
  });

  it('an empty log has read nothing', () => {
    const log = emptyLog(DAY, 100n);
    expect(BigInt(log.to)).toBe(99n);
    expect(log.closed).toBe(false);
  });
});

describe('finding the day’s first block', () => {
  it('finds the first block at or after midnight, in a handful of reads', async () => {
    const c = chain(blockAt(DAY * DAY_SECONDS + 40_000));
    const first = await firstBlockAt(c.r, DAY * DAY_SECONDS, await headOf(c), 0n);
    expect(first).toBe(DAY_FIRST);
    expect(c.ts(first)).toBeGreaterThanOrEqual(DAY * DAY_SECONDS);
    expect(c.ts(first - 1n)).toBeLessThan(DAY * DAY_SECONDS);
    expect(c.asked.timestamps).toBeLessThanOrEqual(8);
  });

  it('still finds it when the chain stood still for an hour', async () => {
    // an hour without blocks, just before midnight: the block-time guess is an hour of blocks off
    const stall = { from: blockAt(DAY * DAY_SECONDS - 4_000), seconds: 3_600 };
    const c = chain(blockAt(DAY * DAY_SECONDS + 20_000), [], [stall]);
    const first = await firstBlockAt(c.r, DAY * DAY_SECONDS, await headOf(c), 0n);
    expect(c.ts(first)).toBeGreaterThanOrEqual(DAY * DAY_SECONDS);
    expect(c.ts(first - 1n)).toBeLessThan(DAY * DAY_SECONDS);
    expect(c.asked.timestamps).toBeLessThan(40);
  });

  it('a midnight that falls inside a gap belongs to the first block after it', async () => {
    const before = blockAt(DAY * DAY_SECONDS - 10);
    const c = chain(before + 500n, [], [{ from: before + 1n, seconds: 600 }]);
    const first = await firstBlockAt(c.r, DAY * DAY_SECONDS, await headOf(c), 0n);
    expect(first).toBe(before + 1n);
  });

  it('is after the head while the day has not begun on the chain', async () => {
    const c = chain(blockAt(DAY * DAY_SECONDS - 100));
    const head = await headOf(c);
    expect(await firstBlockAt(c.r, DAY * DAY_SECONDS, head, 0n)).toBe(head.number + 1n);
    expect(c.asked.timestamps).toBe(0);
  });

  it('never goes below the block the game was deployed at', async () => {
    const c = chain(blockAt(DAY * DAY_SECONDS + 1_000));
    const floor = blockAt(DAY * DAY_SECONDS + 300);
    expect(await firstBlockAt(c.r, DAY * DAY_SECONDS, await headOf(c), floor)).toBe(floor);
  });
});

describe('reading a day from the chain', () => {
  const at = (seconds: number): bigint => DAY_FIRST + BigInt(seconds);

  it('reads the day’s catches and leaves out everybody else’s days', async () => {
    const c = chain(at(3_000), [
      [DAY_FIRST - 1n, caught('yesterday')],
      [DAY_FIRST, caught('1')],
      [at(1_200), caught('2', 2, 500)],
      [at(2_999), caught('3')],
    ]);
    const head = await headOf(c);
    const { confirmed, live } = await readDay(c.r, emptyLog(DAY, DAY_FIRST), head.number, head.number, false);
    expect(live.catches.map((x) => x.id)).toEqual(['1', '2', '3']);
    // the newest blocks are on screen but not yet in what is kept
    expect(confirmed.catches.map((x) => x.id)).toEqual(['1', '2']);
    expect(BigInt(confirmed.to)).toBe(head.number - CONFIRMATIONS);
    expect(BigInt(live.to)).toBe(head.number);
  });

  it('goes on from where the last read stopped, and counts nothing twice', async () => {
    const c = chain(at(1_000), [[at(10), caught('1')], [at(999), caught('2')]]);
    let head = await headOf(c);
    let kept = (await readDay(c.r, emptyLog(DAY, DAY_FIRST), head.number, head.number, false)).confirmed;
    expect(kept.catches.map((x) => x.id)).toEqual(['1']);
    c.mine(50n, [[at(1_040), caught('3')]]);
    head = await headOf(c);
    c.asked.ranges.length = 0;
    const next = await readDay(c.r, kept, head.number, head.number, false);
    // only the blocks since: the first range starts right after the last one kept
    expect(c.asked.ranges[0][0]).toBe(BigInt(kept.to) + 1n);
    expect(next.live.catches.map((x) => x.id)).toEqual(['1', '2', '3']);
    kept = next.confirmed;
    // the same read again, with nothing new on the chain
    const again = await readDay(c.r, kept, head.number, head.number, false);
    expect(again.live.catches.map((x) => x.id)).toEqual(['1', '2', '3']);
    expect(again.confirmed.catches).toEqual(kept.catches);
  });

  it('a block that was shown but not kept is read again, so a reorganised catch disappears', async () => {
    const tip: [bigint, DayEvent][] = [[at(500), caught('gone')]];
    const c = chain(at(500), [[at(100), caught('1')], ...tip]);
    const head = await headOf(c);
    const first = await readDay(c.r, emptyLog(DAY, DAY_FIRST), head.number, head.number, false);
    expect(first.live.catches.map((x) => x.id)).toEqual(['1', 'gone']);
    expect(first.confirmed.catches.map((x) => x.id)).toEqual(['1']);
    // the tip block is replaced by one without that catch
    const c2 = chain(at(503), [[at(100), caught('1')]]);
    const head2 = await headOf(c2);
    const second = await readDay(c2.r, first.confirmed, head2.number, head2.number, false);
    expect(second.live.catches.map((x) => x.id)).toEqual(['1']);
  });

  it('asks in pieces the RPC accepts', async () => {
    const c = chain(at(80_000), [[at(100), caught('1')], [at(60_000), caught('2')]]);
    const head = await headOf(c);
    const { live } = await readDay(c.r, emptyLog(DAY, DAY_FIRST), head.number, head.number, false);
    expect(live.catches.map((x) => x.id)).toEqual(['1', '2']);
    for (const [from, to] of c.asked.ranges) expect(to - from + 1n).toBeLessThanOrEqual(CHUNK);
    expect(c.asked.ranges.length).toBeLessThanOrEqual(4);
  });

  it('a day that is over is read to its last block and closed: tomorrow’s catches are not in it', async () => {
    const next = at(DAY_SECONDS);
    const c = chain(next + 5_000n, [[at(100), caught('1')], [next - 1n, caught('last')], [next, caught('tomorrow')]]);
    const head = await headOf(c);
    const { confirmed, live } = await readDay(c.r, emptyLog(DAY, DAY_FIRST), next - 1n, head.number, true);
    expect(confirmed.closed).toBe(true);
    expect(confirmed.catches.map((x) => x.id)).toEqual(['1', 'last']);
    expect(live).toEqual(confirmed);
    // a closed day is never asked about again
    c.asked.ranges.length = 0;
    expect((await readDay(c.r, confirmed, next - 1n, head.number, true)).confirmed).toBe(confirmed);
    expect(c.asked.ranges).toEqual([]);
  });

  it('a log read as "today" is closed once the day is over, without a fish being lost or doubled', async () => {
    const next = at(DAY_SECONDS);
    const c = chain(at(80_000), [[at(100), caught('1')]]);
    let head = await headOf(c);
    const today = (await readDay(c.r, emptyLog(DAY, DAY_FIRST), head.number, head.number, false)).confirmed;
    c.mine(20_000n, [[at(86_000), caught('2')], [next + 10n, caught('tomorrow')]]);
    head = await headOf(c);
    const closed = (await readDay(c.r, today, next - 1n, head.number, true)).confirmed;
    expect(closed.closed).toBe(true);
    expect(closed.catches.map((x) => x.id)).toEqual(['1', '2']);
  });

  it('when the chain cannot be read the log is left as it was', async () => {
    const c = chain(at(1_000), [[at(10), caught('1')]]);
    const head = await headOf(c);
    const kept = (await readDay(c.r, emptyLog(DAY, DAY_FIRST), head.number, head.number, false)).confirmed;
    c.breakIt(true);
    await expect(readDay(c.r, kept, head.number + 100n, head.number + 100n, false)).rejects.toThrow('rpc down');
    expect(kept.catches.map((x) => x.id)).toEqual(['1']);
  });

  it('survives being stored: a reload reads on from the stored log', async () => {
    const c = chain(at(1_000), [[at(10), caught('1')], [at(1_500), caught('2')]]);
    let head = await headOf(c);
    const kept = (await readDay(c.r, emptyLog(DAY, DAY_FIRST), head.number, head.number, false)).confirmed;
    const stored = JSON.parse(JSON.stringify(kept)) as DayLog;
    expect(stored).toEqual(kept);
    c.mine(1_000n);
    head = await headOf(c);
    c.asked.ranges.length = 0;
    const after = await readDay(c.r, stored, head.number, head.number, false);
    expect(after.live.catches.map((x) => x.id)).toEqual(['1', '2']);
    expect(c.asked.ranges[0][0]).toBe(BigInt(stored.to) + 1n);
  });
});

describe('what the player had when the day began', () => {
  const now: Profile = { unlocked: [0, 1, 2], rods: ['willow', 'carbon', 'flyrod'] };

  it('is what they have now, less what the day brought', () => {
    const today = applyEvents(emptyLog(DAY, 1n), [{ kind: 'unlock', locationId: 2 }, { kind: 'rod', rod: 3 }], 10n);
    // rod 3 in the catalog is the Taiga Fly Rod
    expect(profileBefore(now, [today])).toEqual({ unlocked: [0, 1], rods: ['willow', 'carbon'] });
    expect(profileBefore(now, [emptyLog(DAY, 1n)])).toEqual(now);
  });

  it('so the set does not change when the day’s own catch opens a water, on this device or any other', () => {
    const start: Profile = { unlocked: [0, 1], rods: ['willow', 'carbon'] };
    const morning = emptyLog(DAY, 1n);
    const set = setOf(morning, ME, profileBefore(start, [morning]));
    // later the same day: a catch has unlocked Deep Lake and a rod was bought; another device sees only the result
    const evening = applyEvents(morning, [caught('1'), { kind: 'unlock', locationId: 2 }, { kind: 'rod', rod: 3 }], 50_000n);
    expect(setOf(evening, ME, profileBefore(now, [evening]))).toEqual(set);
    expect(set).toEqual(generateDaily(DAY, ME, start));
  });
});

describe('the streak, checked against the chain', () => {
  const profile: Profile = { unlocked: [0], rods: ['willow'] };
  /** A day in which every pond species was landed at its top weight four times: whatever the pond's set is, it is done. */
  function fullDay(day: number, closed = true): DayLog {
    const events: DayEvent[] = [];
    for (let round = 0; round < 4; round++) for (const [id] of LOCATIONS[0].pool) events.push(caught(`${day}-${round}-${id}`, id, SPECIES[id].maxWeight, 0));
    return applyEvents(emptyLog(day, BigInt(day) * 100n), events, BigInt(day) * 100n + 99n, closed);
  }
  const emptyDay = (day: number, closed = true): DayLog => ({ ...emptyLog(day, BigInt(day) * 100n), closed });

  it('a full day is complete by its own set', () => {
    const log = fullDay(DAY);
    expect(setProgress(setOf(log, ME, profile), log.catches).complete).toBe(true);
  });

  it('counts back while the days are complete, and stops at the first that is not', () => {
    expect(streakFrom(ME, profile, fullDay(DAY, false), [fullDay(DAY - 1), fullDay(DAY - 2), emptyDay(DAY - 3), fullDay(DAY - 4)])).toEqual({ count: 3, open: false });
  });

  it('an unfinished today does not break yesterday’s streak, it just does not add to it', () => {
    expect(streakFrom(ME, profile, emptyDay(DAY, false), [fullDay(DAY - 1), fullDay(DAY - 2), emptyDay(DAY - 3)])).toEqual({ count: 2, open: false });
    expect(streakFrom(ME, profile, emptyDay(DAY, false), [emptyDay(DAY - 1)])).toEqual({ count: 0, open: false });
  });

  it('says so when it ran out of days to look at', () => {
    expect(streakFrom(ME, profile, fullDay(DAY, false), [fullDay(DAY - 1)])).toEqual({ count: 2, open: true });
    expect(streakFrom(ME, profile, fullDay(DAY, false), [])).toEqual({ count: 1, open: true });
  });

  it('does not count across a gap in the logs, or a day that was not read to its end', () => {
    expect(streakFrom(ME, profile, fullDay(DAY, false), [fullDay(DAY - 2)])).toEqual({ count: 1, open: true });
    expect(streakFrom(ME, profile, fullDay(DAY, false), [fullDay(DAY - 1, false), fullDay(DAY - 2)])).toEqual({ count: 1, open: true });
  });

  it('judges each day by the set of that day: what was opened later is not asked of earlier days', () => {
    // two days ago the player had the pond only and did the pond's set; yesterday a catch opened Forest River
    const now: Profile = { unlocked: [0, 1], rods: ['willow'] };
    const yesterday = applyEvents(fullDay(DAY - 1, false), [{ kind: 'unlock', locationId: 1 }], BigInt(DAY - 1) * 100n + 99n, true);
    const s = streakFrom(ME, now, emptyDay(DAY, false), [yesterday, fullDay(DAY - 2)]);
    expect(s).toEqual({ count: 2, open: true });
    // had the river been asked of those days, pond fish alone would not always have been enough
    const riverDays = Array.from({ length: 60 }, (_, i) => DAY + i).filter((d) => generateDaily(d, ME, now).challenges[0].at === 1);
    expect(riverDays.length).toBeGreaterThan(0);
    const d = riverDays[0];
    expect(setProgress(generateDaily(d, ME, now), fullDay(d).catches).complete).toBe(false);
  });
});

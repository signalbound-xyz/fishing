import { describe, expect, it } from 'vitest';
import { landFish, sellFish, startCast } from './actions';
import {
  CAREER_VERSION,
  addEvents,
  careerKey,
  catchRate,
  completeness,
  emptyCareer,
  fmtRate,
  foldRange,
  lifetime,
  parseCareer,
  serializeCareer,
  syncCareer,
  totalsOf,
  waterStats,
  type CareerEvent,
  type CareerLog,
  type CareerReader,
} from './career';
import { LOCATIONS, SPECIES } from './content';
import { avgWeight, levelOf } from './economy';
import { freshSave, loadSave } from './save';
import type { Save } from './types';

const NOW = 1_700_000_000_000;
const START = 1_000n;

const cast = (locationId: number): CareerEvent => ({ kind: 'cast', locationId });
const fish = (locationId: number, speciesId: number): CareerEvent => ({ kind: 'catch', locationId, speciesId });
const miss = (locationId: number): CareerEvent => ({ kind: 'miss', locationId });

/**
 * A chain small enough to read: events by block, and the contract's two lifetime counters, which the real game
 * moves only together with its `Casted` and `Caught` events.
 */
class Chain implements CareerReader {
  blocks = new Map<bigint, CareerEvent[]>();
  tip = START;
  salt = 'a';
  /** Log queries made, as [from, to]. */
  queries: [bigint, bigint][] = [];
  /** A query that reaches this block fails. */
  failAt: bigint | null = null;
  totalsFail = false;
  /** Events the node has "lost": casts and catches the contract counted but the logs do not show. */
  hidden: CareerEvent[] = [];

  put(block: bigint, ...events: CareerEvent[]): this {
    this.blocks.set(block, [...(this.blocks.get(block) ?? []), ...events]);
    if (block > this.tip) this.tip = block;
    return this;
  }
  head = async (): Promise<bigint> => this.tip;
  hash = async (block: bigint): Promise<string> => `0x${this.salt}${block.toString(16)}`;
  events = async (from: bigint, to: bigint): Promise<CareerEvent[]> => {
    this.queries.push([from, to]);
    if (this.failAt !== null && from <= this.failAt && this.failAt <= to) throw new Error('rpc down');
    const out: CareerEvent[] = [];
    for (const [b, ev] of [...this.blocks].sort((x, y) => (x[0] < y[0] ? -1 : 1))) if (b >= from && b <= to) out.push(...ev);
    return out;
  };
  totals = async (block: bigint): Promise<{ casts: number; catches: number }> => {
    if (this.totalsFail) throw new Error('no archive');
    const all = [...[...this.blocks].filter(([b]) => b <= block).flatMap(([, ev]) => ev), ...this.hidden];
    return { casts: all.filter((e) => e.kind === 'cast').length, catches: all.filter((e) => e.kind === 'catch').length };
  };
}

const OPTS = { chunk: 100n, parallel: 2, confirmations: 0n };

describe('counts by water', () => {
  it('adds casts, catches and misses to the water each one names', () => {
    const w = addEvents({}, [cast(0), cast(0), fish(0, 1), miss(0), cast(3), fish(3, 7), fish(3, 7), fish(3, 2)]);
    expect(w[0]).toEqual({ casts: 2, catches: 1, misses: 1, species: { 1: 1 } });
    expect(w[3]).toEqual({ casts: 1, catches: 3, misses: 0, species: { 7: 2, 2: 1 } });
    expect(totalsOf(w)).toEqual({ casts: 3, catches: 4 });
  });

  it('does not change the counts it was given', () => {
    const before = addEvents({}, [cast(1), fish(1, 4)]);
    const copy = JSON.parse(JSON.stringify(before));
    const after = addEvents(before, [cast(1), fish(1, 4), cast(2)]);
    expect(before).toEqual(copy);
    expect(after[1]).toEqual({ casts: 2, catches: 2, misses: 0, species: { 4: 2 } });
    expect(addEvents(before, [])).toBe(before);
  });

  it('the catch rate is fish per cast, and nothing before the first cast', () => {
    expect(catchRate(0, 0)).toBeNull();
    expect(catchRate(5, 8)).toBe(0.625);
    expect(catchRate(0, 4)).toBe(0);
    expect(fmtRate(0.625)).toBe('62.5%');
    expect(fmtRate(1)).toBe('100%');
    expect(fmtRate(null)).toBe('—');
  });

  it('lists every location, the ones nobody fished included', () => {
    const stats = waterStats(addEvents({}, [cast(2), cast(2), fish(2, 5), fish(2, 5), fish(2, 3), cast(6), fish(6, 9)]));
    expect(stats.map((s) => s.locationId)).toEqual(LOCATIONS.map((l) => l.id));
    expect(stats).toHaveLength(8);
    const idle = stats[0];
    expect([idle.casts, idle.catches, idle.rate, idle.top, idle.share]).toEqual([0, 0, null, null, 0]);
    expect(stats[2].top).toEqual({ speciesId: 5, count: 2 });
    expect(stats[2].species).toEqual([
      { speciesId: 5, count: 2 },
      { speciesId: 3, count: 1 },
    ]);
    // the bar: the busiest water is full, the others are measured against it
    expect(stats[2].share).toBe(1);
    expect(stats[6].share).toBeCloseTo(1 / 3);
  });

  it('a tie for the most caught species goes to the lower id, every time', () => {
    const stats = waterStats(addEvents({}, [fish(1, 9), fish(1, 4), fish(1, 9), fish(1, 4)]));
    expect(stats[1].top).toEqual({ speciesId: 4, count: 2 });
  });

  it('the same species in two waters stays two counts', () => {
    const stats = waterStats(addEvents({}, [fish(0, 2), fish(1, 2), fish(1, 2)]));
    expect(stats[0].catches).toBe(1);
    expect(stats[1].catches).toBe(2);
  });
});

describe('folding ranges of blocks', () => {
  it('takes a range only right after the last one, so a repeated read counts nothing twice', () => {
    let log = emptyCareer(START);
    const first = { from: START, to: START + 9n, events: [cast(0), fish(0, 1)] };
    log = foldRange(log, first);
    expect(totalsOf(log.waters)).toEqual({ casts: 1, catches: 1 });
    // the same range again, one that overlaps, one that leaves a gap, an empty one turned around
    expect(foldRange(log, first)).toBe(log);
    expect(foldRange(log, { from: START + 5n, to: START + 20n, events: [cast(0)] })).toBe(log);
    expect(foldRange(log, { from: START + 11n, to: START + 20n, events: [cast(0)] })).toBe(log);
    expect(foldRange(log, { from: START + 10n, to: START + 9n, events: [cast(0)] })).toBe(log);
    const next = foldRange(log, { from: START + 10n, to: START + 20n, events: [cast(2)] });
    expect(next.to).toBe((START + 20n).toString());
    expect(totalsOf(next.waters)).toEqual({ casts: 2, catches: 1 });
  });

  it('a log that moved on has to be checked again', () => {
    const settled: CareerLog = { ...emptyCareer(START), to: (START + 9n).toString(), hash: '0xabc', check: { casts: 0, catches: 0 } };
    const next = foldRange(settled, { from: START + 10n, to: START + 12n, events: [] });
    expect([next.hash, next.check]).toEqual(['', null]);
  });
});

describe('reading a history', () => {
  it('reads from the first block in chunks and ends with totals that add up', async () => {
    const chain = new Chain().put(START, cast(0), fish(0, 1)).put(START + 150n, cast(3), miss(3)).put(START + 420n, cast(3), fish(3, 8), cast(0), fish(0, 1));
    const seen: number[] = [];
    const got = await syncCareer(chain, emptyCareer(START), { ...OPTS, onProgress: (_l, p) => seen.push(p) });
    expect(got.stopped).toBe(false);
    expect(got.reorged).toBe(false);
    expect(got.log.to).toBe((START + 420n).toString());
    expect(totalsOf(got.log.waters)).toEqual({ casts: 4, catches: 3 });
    expect(got.log.waters[3]).toEqual({ casts: 2, catches: 1, misses: 1, species: { 8: 1 } });
    expect(got.log.check).toEqual({ casts: 4, catches: 3 });
    expect(completeness(got.log)).toEqual({ state: 'complete' });
    // five chunks of a hundred blocks, none of them twice
    expect(chain.queries).toHaveLength(5);
    expect(new Set(chain.queries.map(([a]) => a)).size).toBe(5);
    expect(seen[seen.length - 1]).toBe(1);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('a second read asks only for the blocks since the first', async () => {
    const chain = new Chain().put(START, cast(0), fish(0, 1)).put(START + 250n, cast(1));
    const first = await syncCareer(chain, emptyCareer(START), OPTS);
    chain.queries = [];
    // nothing new: no log query at all
    const idle = await syncCareer(chain, first.log, OPTS);
    expect(chain.queries).toEqual([]);
    expect(idle.log).toEqual(first.log);
    // two new blocks
    chain.put(START + 251n, cast(1), fish(1, 2)).put(START + 252n, cast(1));
    const second = await syncCareer(chain, first.log, OPTS);
    expect(chain.queries).toEqual([[START + 251n, START + 252n]]);
    expect(totalsOf(second.log.waters)).toEqual({ casts: 4, catches: 2 });
    expect(completeness(second.log)).toEqual({ state: 'complete' });
  });

  it('reading the same history twice from the cache gives the same counts', async () => {
    const chain = new Chain().put(START + 3n, cast(0), fish(0, 1)).put(START + 90n, cast(0), fish(0, 1));
    const once = await syncCareer(chain, emptyCareer(START), OPTS);
    const cached = parseCareer(serializeCareer(once.log), START)!;
    const twice = await syncCareer(chain, cached, OPTS);
    const thrice = await syncCareer(chain, parseCareer(serializeCareer(twice.log), START)!, OPTS);
    expect(totalsOf(thrice.log.waters)).toEqual({ casts: 2, catches: 2 });
    expect(thrice.log).toEqual(once.log);
  });

  it('leaves the newest blocks for the next read', async () => {
    const chain = new Chain().put(START, cast(0)).put(START + 50n, cast(0), fish(0, 1));
    chain.tip = START + 52n;
    const got = await syncCareer(chain, emptyCareer(START), { ...OPTS, confirmations: 5n });
    expect(got.log.to).toBe((START + 47n).toString());
    expect(totalsOf(got.log.waters)).toEqual({ casts: 1, catches: 0 });
    // and what it has is whole as of that block
    expect(completeness(got.log)).toEqual({ state: 'complete' });
    chain.tip = START + 60n;
    const later = await syncCareer(chain, got.log, { ...OPTS, confirmations: 5n });
    expect(totalsOf(later.log.waters)).toEqual({ casts: 2, catches: 1 });
  });

  it('a failed query keeps what was read before it and the next read goes on from there', async () => {
    const chain = new Chain().put(START + 10n, cast(0), fish(0, 1)).put(START + 310n, cast(4), fish(4, 6)).put(START + 399n, cast(4));
    chain.failAt = START + 310n;
    let kept: CareerLog = emptyCareer(START);
    await expect(syncCareer(chain, kept, { ...OPTS, onProgress: (l) => (kept = l) })).rejects.toThrow('rpc down');
    // the first batch (two chunks) made it; the log is not at its end, so nothing calls it whole
    expect(kept.to).toBe((START + 199n).toString());
    expect(totalsOf(kept.waters)).toEqual({ casts: 1, catches: 1 });
    expect([kept.hash, kept.check]).toEqual(['', null]);
    expect(completeness(kept)).toEqual({ state: 'unverified' });
    // the node is back
    chain.failAt = null;
    chain.queries = [];
    const done = await syncCareer(chain, kept, OPTS);
    expect(chain.queries[0][0]).toBe(START + 200n);
    expect(totalsOf(done.log.waters)).toEqual({ casts: 3, catches: 2 });
    expect(completeness(done.log)).toEqual({ state: 'complete' });
  });

  it('a head that cannot be read is an error, not an empty history', async () => {
    const chain = new Chain();
    chain.head = async () => {
      throw new Error('offline');
    };
    await expect(syncCareer(chain, emptyCareer(START), OPTS)).rejects.toThrow('offline');
  });

  it('events the node does not return show up as a gap, with its size', async () => {
    const chain = new Chain().put(START + 5n, cast(0), fish(0, 1));
    chain.hidden = [cast(2), cast(2), fish(2, 3)];
    const got = await syncCareer(chain, emptyCareer(START), OPTS);
    expect(totalsOf(got.log.waters)).toEqual({ casts: 1, catches: 1 });
    expect(completeness(got.log)).toEqual({ state: 'mismatch', casts: 2, catches: 1 });
  });

  it('without the contract counters the history is not called whole', async () => {
    const chain = new Chain().put(START + 5n, cast(0), fish(0, 1));
    chain.totalsFail = true;
    const got = await syncCareer(chain, emptyCareer(START), OPTS);
    expect(got.log.check).toBeNull();
    expect(got.log.hash).not.toBe('');
    expect(completeness(got.log)).toEqual({ state: 'unverified' });
    // the next visit asks the contract again, without reading a single log twice
    chain.totalsFail = false;
    chain.queries = [];
    const again = await syncCareer(chain, got.log, OPTS);
    expect(chain.queries).toEqual([]);
    expect(completeness(again.log)).toEqual({ state: 'complete' });
  });

  it('a chain that changed under the cache is read again from the start', async () => {
    const chain = new Chain().put(START + 5n, cast(0), fish(0, 1)).put(START + 40n, cast(1), fish(1, 2));
    const first = await syncCareer(chain, emptyCareer(START), OPTS);
    expect(totalsOf(first.log.waters)).toEqual({ casts: 2, catches: 2 });
    // the same heights, another history: the second catch never happened
    chain.salt = 'b';
    chain.blocks.delete(START + 40n);
    chain.put(START + 40n, cast(1), miss(1));
    const again = await syncCareer(chain, first.log, OPTS);
    expect(again.reorged).toBe(true);
    expect(totalsOf(again.log.waters)).toEqual({ casts: 2, catches: 1 });
    expect(again.log.waters[1]).toEqual({ casts: 1, catches: 0, misses: 1, species: {} });
    expect(completeness(again.log)).toEqual({ state: 'complete' });
  });

  it('stops between batches when asked, and can be picked up later', async () => {
    const chain = new Chain().put(START + 10n, cast(0)).put(START + 450n, cast(5));
    let batches = 0;
    const part = await syncCareer(chain, emptyCareer(START), { ...OPTS, stop: () => batches++ >= 1 });
    expect(part.stopped).toBe(true);
    expect(part.log.to).toBe((START + 199n).toString());
    expect(part.log.hash).toBe('');
    const rest = await syncCareer(chain, part.log, OPTS);
    expect(totalsOf(rest.log.waters)).toEqual({ casts: 2, catches: 0 });
  });

  it('a fish that was sold or sent away is still counted: only the events are read', async () => {
    // the reader has no way to ask what is in the keepnet; the same chain with every fish gone gives the same counts
    const chain = new Chain().put(START + 1n, cast(0), fish(0, 1), cast(0), fish(0, 4)).put(START + 2n, cast(7), fish(7, 12));
    const got = await syncCareer(chain, emptyCareer(START), OPTS);
    expect(got.log.waters[0].catches).toBe(2);
    expect(got.log.waters[7].catches).toBe(1);
    expect(Object.keys(chain).some((k) => /keepnet|inventory|owner/i.test(k))).toBe(false);
  });
});

describe('the cache', () => {
  const log = (): CareerLog => ({ v: CAREER_VERSION, from: START.toString(), to: (START + 99n).toString(), hash: '0xfeed', waters: addEvents({}, [cast(0), fish(0, 1), miss(4)]), check: { casts: 1, catches: 1 } });

  it('comes back as it was stored', () => {
    expect(parseCareer(serializeCareer(log()), START)).toEqual(log());
    expect(parseCareer(serializeCareer(emptyCareer(START)), START)).toEqual(emptyCareer(START));
  });

  it('is thrown away when it is not a log of this game', () => {
    expect(parseCareer(null, START)).toBeNull();
    expect(parseCareer('', START)).toBeNull();
    expect(parseCareer('{', START)).toBeNull();
    expect(parseCareer('[]', START)).toBeNull();
    // another deployment (another first block), another version of the format
    expect(parseCareer(serializeCareer(log()), START + 1n)).toBeNull();
    expect(parseCareer(serializeCareer({ ...log(), v: CAREER_VERSION + 1 }), START)).toBeNull();
    // counts nobody could have: negative, fractional, text
    const broken = (w: unknown): string => JSON.stringify({ ...log(), waters: { 0: w } });
    expect(parseCareer(broken({ casts: -1, catches: 0, misses: 0, species: {} }), START)).toBeNull();
    expect(parseCareer(broken({ casts: 1.5, catches: 0, misses: 0, species: {} }), START)).toBeNull();
    expect(parseCareer(broken({ casts: 1, catches: 0, misses: 0, species: { 3: 'many' } }), START)).toBeNull();
    expect(parseCareer(JSON.stringify({ ...log(), to: 'latest' }), START)).toBeNull();
  });

  it('a check that is not two counts is forgotten, so the history is checked again', () => {
    const parsed = parseCareer(JSON.stringify({ ...log(), check: { casts: 'all', catches: 1 } }), START)!;
    expect(parsed.check).toBeNull();
    expect(completeness(parsed)).toEqual({ state: 'unverified' });
  });

  it('is kept apart by chain, by game contract and by account', () => {
    const game = '0x00000000000000000000000000000000000000Aa';
    const a = '0x00000000000000000000000000000000000000B1';
    const b = '0x00000000000000000000000000000000000000C2';
    const keys = new Set([careerKey(20994, game, a), careerKey(20994, game, b), careerKey(20993, game, a), careerKey(20994, b, a)]);
    expect(keys.size).toBe(4);
    // the same account, however its address is written
    expect(careerKey(20994, game, a)).toBe(careerKey(20994, game.toLowerCase(), a.toLowerCase()));
  });

  it('two accounts read from the same chain do not share a count', async () => {
    // each reader sees only its own player's events, as the node's topic filter gives them
    const alice = new Chain().put(START + 1n, cast(0), fish(0, 1), cast(0));
    const bob = new Chain().put(START + 1n, cast(5), fish(5, 9));
    const store = new Map<string, string>();
    for (const [who, chain] of [
      ['0xa', alice],
      ['0xb', bob],
    ] as const) {
      const got = await syncCareer(chain, parseCareer(store.get(careerKey(1, '0xgame', who)) ?? null, START) ?? emptyCareer(START), OPTS);
      store.set(careerKey(1, '0xgame', who), serializeCareer(got.log));
    }
    const a = parseCareer(store.get(careerKey(1, '0xgame', '0xa'))!, START)!;
    const b = parseCareer(store.get(careerKey(1, '0xgame', '0xb'))!, START)!;
    expect(totalsOf(a.waters)).toEqual({ casts: 2, catches: 1 });
    expect(totalsOf(b.waters)).toEqual({ casts: 1, catches: 1 });
    expect(a.waters[5]).toBeUndefined();
    expect(b.waters[0]).toBeUndefined();
  });
});

describe('the local game counts by water itself', () => {
  const land = (s: Save, speciesId: number): Save => {
    const { save, ticket } = startCast({ ...s, energy: 20 }, NOW);
    return landFish(save, ticket, { speciesId, weight: Math.round(avgWeight(SPECIES[speciesId])), isSpecial: false }, 'B', NOW).save;
  };
  const here = LOCATIONS[0].pool.map(([id]) => id).filter((id) => !SPECIES[id].special && !SPECIES[id].hidden);

  it('a new game starts with an empty book', () => {
    expect(freshSave(NOW).career).toEqual({ since: NOW, waters: {} });
  });

  it('a cast and a catch go to the water they were made in, next to the lifetime totals', () => {
    let s = freshSave(NOW);
    s = land(s, here[0]);
    s = land(s, here[0]);
    s = startCast({ ...s, energy: 20 }, NOW).save; // a cast that lands nothing
    expect(s.stats.casts).toBe(3);
    expect(s.stats.catches).toBe(2);
    expect(s.career.waters[0]).toEqual({ casts: 3, catches: 2, misses: 0, species: { [here[0]]: 2 } });
    expect(totalsOf(s.career.waters)).toEqual({ casts: s.stats.casts, catches: s.stats.catches });
  });

  it('selling a fish takes nothing back', () => {
    let s = land(freshSave(NOW), here[0]);
    s = sellFish(s, [s.fish[0].id], NOW).save;
    expect(s.fish).toHaveLength(0);
    expect(s.stats.catches).toBe(1);
    expect(s.career.waters[0].catches).toBe(1);
    expect(lifetime(s).catches).toBe(1);
    expect(lifetime(s).discovered).toBe(1);
  });

  it('a save from before the book loads with an empty one and keeps its lifetime totals', () => {
    const old = land(land(freshSave(NOW), here[0]), here[0]) as unknown as Record<string, unknown>;
    delete old.career;
    const LATER = NOW + 86_400_000;
    const { save, status } = loadSave(JSON.stringify(old), LATER);
    expect(status).toBe('ok');
    expect(save.stats).toMatchObject({ casts: 2, catches: 2 });
    // nothing is made up for the two catches of before: no water is named for them
    expect(save.career).toEqual({ since: LATER, waters: {} });
    expect(totalsOf(save.career.waters)).toEqual({ casts: 0, catches: 0 });
    // and from here on it counts
    const next = land(save, here[0]);
    expect(next.stats.catches).toBe(3);
    expect(totalsOf(next.career.waters)).toEqual({ casts: 1, catches: 1 });
  });

  it('the book survives a save and a load', () => {
    const s = land(freshSave(NOW), here[0]);
    const { save } = loadSave(JSON.stringify(s), NOW + 5_000);
    expect(save.career).toEqual(s.career);
  });

  it('a book that is not one is replaced, not believed', () => {
    const s = land(freshSave(NOW), here[0]);
    for (const career of [{ since: NOW, waters: { 0: { casts: -4, catches: 1, misses: 0, species: {} } } }, { since: 'yesterday', waters: {} }, { since: NOW, waters: { 0: { casts: 1 } } }, { since: NOW, waters: [1, 2] }]) {
      const { save } = loadSave(JSON.stringify({ ...s, career }), NOW + 1);
      expect(save.career).toEqual({ since: NOW + 1, waters: {} });
      expect(save.stats.catches).toBe(1);
    }
  });
});

describe('the lifetime numbers', () => {
  it('are read off the player state: totals, rate, encyclopedia, records, level', () => {
    const legendary = SPECIES.find((sp) => sp.rarity === 4)!;
    const common = SPECIES.find((sp) => sp.rarity === 0)!;
    const record = { speciesId: legendary.id, weight: 9_000, locationId: 3, at: NOW };
    const s: Save = {
      ...freshSave(NOW),
      xp: 1_234,
      stats: { casts: 40, catches: 25, escaped: 0, sold: 0, earned: 0 },
      dex: { [common.id]: { count: 22, best: 300, firstAt: NOW }, [legendary.id]: { count: 3, best: 9_000, firstAt: NOW } },
      records: { overall: record, byLocation: { 3: record } },
      fish: [], // an empty keepnet takes nothing away
    };
    const l = lifetime(s);
    expect([l.catches, l.casts, l.rate]).toEqual([25, 40, 0.625]);
    expect([l.discovered, l.species]).toEqual([2, SPECIES.length]);
    expect(l.biggest).toEqual(record);
    expect([l.legendary, l.mythic]).toEqual([3, 0]);
    expect(l.byRarity[0]).toMatchObject({ discovered: 1, caught: 22 });
    expect(l.byRarity[4]).toMatchObject({ discovered: 1, caught: 3 });
    expect(l.byRarity.reduce((n, r) => n + r.species, 0)).toBe(SPECIES.length);
    expect(l.waters).toBe(LOCATIONS.length);
    expect(l.unlocked).toBeGreaterThanOrEqual(1);
    expect(l.level).toBe(levelOf(1_234));
    expect(l.xp).toBe(1_234);
    expect(l.levelXp).toBeGreaterThanOrEqual(0);
    expect(l.levelXp).toBeLessThan(l.levelNeeds);
  });

  it('a new player has zeros and dashes, not errors', () => {
    const l = lifetime(freshSave(NOW));
    expect([l.catches, l.casts, l.rate, l.discovered, l.biggest, l.legendary, l.mythic]).toEqual([0, 0, null, 0, null, 0, 0]);
    expect(l.level).toBe(1);
  });
});

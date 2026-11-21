import { describe, expect, it } from 'vitest';
import type { EventBody } from './events';
import { IDLE_GAP_MS, Recorder, parseLog, type LogStore } from './recorder';
import { quantile, summarize } from './summary';

function memory(initial: string | null = null): LogStore & { value: string | null; writes: number } {
  return {
    value: initial,
    writes: 0,
    read() {
      return this.value;
    },
    write(v: string) {
      this.value = v;
      this.writes++;
    },
  };
}

const cast = (loc = 0, cost = 1, energy = 19): EventBody => ({ e: 'cast', loc, cost, rod: 'willow', lure: null, level: 1, energy });
const fight = (result: 'landed' | 'snapped' | 'slack', d = 0, attempt = 0): EventBody => ({ e: 'fight', result, seconds: 8, accuracy: 0.8, d, green: 0.25, attempt, replay: false });
const caught = (rarity = 0, price = 10): EventBody => ({ e: 'catch', loc: 0, species: 1, rarity, quality: 'B', weight: 100, price, score: 10, special: false, newSpecies: false });

describe('recorder', () => {
  it('opens a session with the first action and stamps every event with it', () => {
    let now = 1_000;
    const store = memory();
    const r = new Recorder(store, 'local', () => now);
    expect(r.log().events).toEqual([]);
    r.track(cast());
    now += 500;
    r.track({ e: 'bite', ok: true, loc: 0 });
    const ev = r.log().events;
    expect(ev.map((e) => e.e)).toEqual(['session_start', 'cast', 'bite']);
    expect(ev.every((e) => e.s === 1_000 && e.m === 'local')).toBe(true);
    expect(ev[2].t).toBe(1_500);
  });

  it('writes nothing until it is flushed, and then appends', () => {
    const store = memory();
    const r = new Recorder(store, 'local', () => 5);
    r.track(cast());
    expect(store.writes).toBe(0);
    r.flush();
    expect(parseLog(store.value).events).toHaveLength(2);
    r.track(cast());
    r.flush();
    expect(parseLog(store.value).events).toHaveLength(3);
    r.flush();
    expect(store.writes).toBe(2);
  });

  it('ends the session at its last action when the page goes away', () => {
    let now = 10_000;
    const store = memory();
    const r = new Recorder(store, 'local', () => now);
    r.track(cast());
    now += 60_000;
    r.track(cast());
    now += 3_600_000; // the tab sat open for an hour
    r.close();
    const end = parseLog(store.value).events.at(-1)!;
    expect(end).toMatchObject({ e: 'session_end', duration: 60_000, reason: 'closed', t: 70_000, s: 10_000 });
    // and the next action starts a new one
    r.track(cast());
    expect(r.log().events.at(-2)).toMatchObject({ e: 'session_start', s: now });
  });

  it('splits sessions on a long pause', () => {
    let now = 0;
    const r = new Recorder(memory(), 'local', () => now);
    r.track(cast());
    now += IDLE_GAP_MS; // exactly the gap is still the same session
    r.track(cast());
    now += IDLE_GAP_MS + 1;
    r.track(cast());
    const ev = r.log().events;
    expect(ev.map((e) => e.e)).toEqual(['session_start', 'cast', 'cast', 'session_end', 'session_start', 'cast']);
    expect(ev[3]).toMatchObject({ reason: 'idle', duration: IDLE_GAP_MS, t: IDLE_GAP_MS });
    expect(ev[5].s).toBe(now);
  });

  it('closes a session an earlier visit left open', () => {
    let now = 100;
    const store = memory();
    const first = new Recorder(store, 'chain', () => now);
    first.track(cast());
    now = 900;
    first.track(cast());
    first.flush(); // and then the tab is killed: no close()
    now = 50_000_000;
    const second = new Recorder(store, 'local', () => now);
    const ev = second.log().events;
    expect(ev.at(-1)).toMatchObject({ e: 'session_end', reason: 'lost', duration: 800, t: 900, s: 100, m: 'chain' });
    // a log that ends properly is left alone
    const third = new Recorder(store, 'local', () => now);
    expect(third.log().events).toHaveLength(ev.length);
  });

  it('keeps the newest events when the log is full and counts what it dropped', () => {
    let now = 0;
    const store = memory();
    const r = new Recorder(store, 'local', () => now, 5);
    for (let i = 0; i < 9; i++) {
      now += 1;
      r.track(cast(0, 1, i));
    }
    r.flush();
    const log = parseLog(store.value);
    expect(log.events).toHaveLength(5);
    expect(log.dropped).toBe(5); // 1 session_start + 9 casts − 5 kept
    expect((log.events.at(-1) as { energy: number }).energy).toBe(8);
  });

  it('merges with what another tab wrote instead of overwriting it', () => {
    const store = memory();
    const a = new Recorder(store, 'local', () => 1);
    const b = new Recorder(store, 'local', () => 2);
    a.track(cast());
    b.track(cast());
    a.flush();
    b.flush();
    expect(parseLog(store.value).events.filter((e) => e.e === 'cast')).toHaveLength(2);
  });

  it('survives storage that is broken, full or holds rubbish', () => {
    const broken: LogStore = {
      read: () => '{not json',
      write: () => {
        throw new Error('quota');
      },
    };
    const r = new Recorder(broken, 'local', () => 1);
    expect(() => {
      r.track(cast());
      r.flush();
      r.close();
      r.clear();
    }).not.toThrow();
    expect(parseLog('[]').events).toEqual([]);
    expect(parseLog(JSON.stringify({ version: 99, events: [1] })).events).toEqual([]);
  });

  it('clear forgets everything', () => {
    const store = memory();
    const r = new Recorder(store, 'local', () => 7);
    r.track(cast());
    r.flush();
    r.clear();
    expect(parseLog(store.value).events).toEqual([]);
    expect(r.log().events.map((e) => e.e)).toEqual(['session_start']);
  });
});

describe('summary', () => {
  function play(): Recorder {
    let now = 0;
    const r = new Recorder(memory(), 'local', () => now);
    const step = (ms: number, b: EventBody): void => {
      now += ms;
      r.track(b);
    };
    // session 1: three casts at the pond, the bar runs dry
    step(0, cast(0, 1, 2));
    step(3_000, { e: 'bite', ok: true, loc: 0 });
    step(400, { e: 'hook', ok: true, reaction: 0.4, window: 1.6, clean: true, d: 0 });
    step(8_000, fight('landed', 0));
    step(0, caught(0, 12));
    step(0, { e: 'level', level: 2 });
    step(2_000, cast(0, 1, 1));
    step(3_000, { e: 'bite', ok: false, loc: 0 });
    step(2_000, cast(0, 1, 0));
    step(0, { e: 'energy_out', loc: 0, cost: 1, left: 0 });
    step(3_000, { e: 'bite', ok: true, loc: 0 });
    step(1_600, { e: 'hook', ok: false, reaction: null, window: 1.6, clean: false, d: 0 });
    now += 60_000;
    r.close();
    // session 2, much later: the sea, a lost fight, a retry, a purchase
    now += 3_600_000;
    step(0, { e: 'purchase', kind: 'refill', id: 'energy', price: 100 });
    step(1_000, cast(3, 3, 17));
    step(4_000, { e: 'bite', ok: true, loc: 3 });
    step(900, { e: 'hook', ok: true, reaction: 0.9, window: 1.2, clean: false, d: 3 });
    step(5_000, fight('snapped', 3, 0));
    step(4_000, { e: 'hook', ok: true, reaction: 0.6, window: 1.2, clean: false, d: 3 });
    step(9_000, fight('landed', 3, 1));
    step(0, { ...caught(1, 80), loc: 3 } as EventBody);
    step(0, { e: 'unlock', loc: 2, how: 'progress' });
    step(1_000, { e: 'sale', fish: 2, earned: 110 });
    step(500, { e: 'purchase', kind: 'lure', id: 'spoon', price: 100 });
    return r;
  }

  it('counts the funnel, the fights and the sessions', () => {
    const s = summarize(play().log());
    expect(s.casts).toBe(4);
    expect(s.energy).toBe(6);
    expect(s.bites).toEqual({ yes: 3, no: 1 });
    expect(s.hooks).toMatchObject({ bites: 4, missed: 1, clean: 1, median: 0.6, p90: 0.9 });
    expect(s.hooksByDifficulty.map((h) => [h.d, h.bites, h.missed])).toEqual([
      [0, 2, 1],
      [3, 2, 0],
    ]);
    expect(s.fights).toMatchObject({ fights: 3, landed: 2, snapped: 1, slack: 0, seconds: 8, accuracy: 0.8 });
    expect(s.firstTries).toMatchObject({ fights: 2, landed: 1, snapped: 1 });
    expect(s.fightsByDifficulty.find((f) => f.d === 3)).toMatchObject({ fights: 2, landed: 1, snapped: 1 });
    expect(s.catches).toBe(2);
    expect(s.byRarity).toEqual([1, 1, 0, 0, 0, 0]);
    expect(s.byQuality.B).toBe(2);
    expect(s.locations).toEqual([
      { loc: 0, casts: 3, energy: 3, bites: 2, noBite: 1, caught: 1, pearl: 12 },
      { loc: 3, casts: 1, energy: 3, bites: 1, noBite: 0, caught: 1, pearl: 80 },
    ]);
    expect(s.pearlPerEnergy).toBeCloseTo(92 / 6);
    expect(s.energyOut).toBe(1);
    expect(s.pearlSpent).toBe(200);
    expect(s.purchases.map((p) => `${p.kind}:${p.id}`).sort()).toEqual(['lure:spoon', 'refill:energy']);
    expect(s.unlocks).toHaveLength(1);
    expect(s.levels).toEqual([{ level: 2, t: 11_400 }]);
    expect(s.sales).toEqual({ fish: 2, earned: 110 });
  });

  it('measures sessions by active play and knows which ran out of energy', () => {
    const s = summarize(play().log());
    expect(s.sessions).toHaveLength(2);
    expect(s.sessions[0]).toMatchObject({ casts: 3, caught: 1, outOfEnergy: true, reason: 'closed', duration: 23_000 });
    // the second is still open: it has run up to its last action
    expect(s.sessions[1]).toMatchObject({ casts: 1, outOfEnergy: false, reason: 'open', duration: 25_400 });
    expect(s.sessionStats).toMatchObject({ count: 2, outOfEnergy: 1, longestMs: 25_400, totalMs: 48_400 });
  });

  it('can look at one game mode alone', () => {
    const store = memory();
    let now = 0;
    const local = new Recorder(store, 'local', () => now);
    local.track(cast());
    local.close();
    now = 10_000_000;
    const chain = new Recorder(store, 'chain', () => now);
    chain.track(cast(4, 4, 16));
    chain.track(cast(4, 4, 12));
    const log = chain.log();
    expect(summarize(log).casts).toBe(3);
    expect(summarize(log, 'chain')).toMatchObject({ casts: 2, energy: 8 });
    expect(summarize(log, 'chain').sessions).toHaveLength(1);
    expect(summarize(log, 'local').casts).toBe(1);
  });

  it('an empty log is a summary of zeros', () => {
    const s = summarize({ version: 1, dropped: 0, events: [] });
    expect(s).toMatchObject({ events: 0, casts: 0, catches: 0, pearlPerEnergy: null, from: null });
    expect(s.hooks.median).toBeNull();
  });

  it('quantile is nearest rank', () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(quantile([1, 2, 3, 4], 0.9)).toBe(4);
    expect(quantile([5], 0.9)).toBe(5);
  });
});

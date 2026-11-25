import { describe, expect, it } from 'vitest';
import { drandRound, drandTime, huntHit } from '../game/hunt';
import { runKeeper, type BeaconFacts, type Keeper, type KeeperSeason, type RunOptions, type SeasonAttempt, type WaterCast } from './keeper';
import { createKeeperHandler, keeperFrom, type KeeperSetup } from './keeperHttp';

type Address = `0x${string}`;
type Hex = `0x${string}`;

const HUNT = '0x00000000000000000000000000000000000000aa' as Address;
const OPERATOR = '0x00000000000000000000000000000000000000ee' as Address;
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const word = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

/** A chain of one-second blocks: block n is at second T0 + n. */
const T0 = 1_800_000_000;
const DRAND = { chainHash: 'ab'.repeat(32), genesis: T0 - 1_000, period: 3, margin: 30 };

interface WorldOptions {
  scheme?: 'drand' | 'blockhash';
  head?: bigint;
  window?: bigint;
  /** Without a key nothing can be sent. */
  key?: boolean;
  counts?: boolean;
}

/** A chain the keeper can read and write, with everything it did written down. */
function world(o: WorldOptions = {}) {
  const st = {
    head: o.head ?? 100_000n,
    window: o.window ?? 8191n,
    seasons: [] as KeeperSeason[],
    attempts: [] as SeasonAttempt[],
    casts: new Map<string, WaterCast>(),
    casted: [] as { player: Address; targetBlock: bigint; block: bigint }[],
    /** randomness by group key: a drand round or a block */
    randomness: new Map<string, Hex>(),
    /** drand rounds whose signature the relays have */
    signed: new Set<number>(),
    paused: false,
    balance: 10n ** 17n,
    settled: [] as { season: number; seq: number; proof: Hex }[],
    reeled: [] as Address[],
    asked: { randomness: 0, outcome: 0, drand: 0, logs: [] as [bigint, bigint][] },
    /** what the contract answers when it disagrees with the arithmetic */
    outcomeOverride: null as null | 'miss' | 'wait',
    failSettle: null as null | (() => void),
    failReel: null as null | ((p: Address) => void),
    clock: 0, // seconds ahead of the chain's head
  };
  const scheme = o.scheme ?? 'drand';
  const beacon: BeaconFacts = scheme === 'drand' ? { scheme, drand: DRAND } : { scheme, drand: null };
  const groupOf = (a: SeasonAttempt): string => (beacon.drand ? `r${drandRound(beacon.drand, a.time)}` : `b${a.block}`);
  const rnd = (a: SeasonAttempt): Hex | undefined => st.randomness.get(groupOf(a));
  const isHit = (a: SeasonAttempt): boolean => {
    const r = rnd(a);
    return !!r && huntHit({ randomness: r, chainId: 20994, hunt: HUNT, season: a.season, seq: a.seq, player: a.player }, a.chance);
  };
  const k: Keeper = {
    chain: {
      chainId: 20994,
      startBlock: 1_000n,
      head: async () => ({ number: st.head, timestamp: T0 + Number(st.head) }),
      timestamp: async (b) => T0 + Number(b),
      reelWindow: async () => st.window,
      async casted(from, to) {
        if (to - from + 1n > 5_000n) throw new Error('query exceeds max block range');
        st.asked.logs.push([from, to]);
        return st.casted.filter((c) => c.block >= from && c.block <= to).map(({ player, targetBlock }) => ({ player, targetBlock }));
      },
      castOf: async (p) => st.casts.get(p.toLowerCase()) ?? { targetBlock: 0n, counted: false },
      async reelFor(p) {
        st.failReel?.(p);
        const c = st.casts.get(p.toLowerCase());
        if (!c || c.targetBlock === 0n) throw new Error('NoActiveCast');
        if (st.head <= c.targetBlock) throw new Error('TooEarly');
        st.casts.delete(p.toLowerCase());
        st.reeled.push(p);
      },
      water: async () => (o.counts === false ? null : { paused: st.paused, inWater: [...st.casts.values()].filter((c) => c.counted).length }),
      operator: async () => (o.key === false ? null : { address: OPERATOR, balanceWei: st.balance }),
      hunt: {
        address: HUNT,
        beacon: async () => beacon,
        seasons: async () => st.seasons.map((s) => ({ ...s })),
        season: async (id) => ({ ...st.seasons.find((s) => s.id === id)! }),
        async attempts(season, from, to) {
          if (to - from + 1n > 5_000n) throw new Error('query exceeds max block range');
          return st.attempts.filter((a) => a.season === season && a.block >= from && a.block <= to);
        },
        async randomness(a, proof) {
          st.asked.randomness++;
          if (beacon.drand && proof.length !== 130) throw new Error('BadProof');
          const r = rnd(a);
          return r ? { kind: 'value', value: r } : { kind: 'wait' };
        },
        async outcome(a) {
          st.asked.outcome++;
          if (st.outcomeOverride) return st.outcomeOverride;
          return rnd(a) ? (isHit(a) ? 'hit' : 'miss') : 'wait';
        },
        async settle(a, proof) {
          st.failSettle?.();
          const s = st.seasons.find((x) => x.id === a.season)!;
          if (s.hooked && a.seq >= s.winnerSeq) throw new Error('TargetAlreadyHooked');
          if (T0 + Number(st.head) > a.time + s.settleWindow) throw new Error('TooLate');
          if (!isHit(a)) throw new Error('NoCatch');
          Object.assign(s, { hooked: true, winnerSeq: a.seq });
          st.settled.push({ season: a.season, seq: a.seq, proof });
        },
      },
    },
    async drand(chainHash, round) {
      st.asked.drand++;
      expect(chainHash).toBe(DRAND.chainHash);
      return st.signed.has(round) ? (`0x${round.toString(16).padStart(128, '0')}` as Hex) : null;
    },
    now: () => (T0 + Number(st.head) + st.clock) * 1000,
    misses: new Set(),
  };

  const season = (over: Partial<KeeperSeason> = {}): KeeperSeason => {
    const now = T0 + Number(st.head);
    const s: KeeperSeason = { id: st.seasons.length, start: now - 86_400, end: now + 86_400, settleWindow: 3_600, funded: true, cancelled: false, hooked: false, winnerSeq: 0, ...over };
    st.seasons.push(s);
    return s;
  };
  /** A seasonal cast made `ago` blocks before the head. Its randomness is found so that it hits or misses. */
  const attempt = (s: KeeperSeason, ago: number, want: boolean | null, player = addr(1 + st.attempts.length)): SeasonAttempt => {
    const block = st.head - BigInt(ago);
    const a: SeasonAttempt = { season: s.id, seq: st.attempts.filter((x) => x.season === s.id).length, player, chance: 50_000_000, block, time: T0 + Number(block) };
    st.attempts.push(a);
    if (want === null) return a; // its randomness does not exist yet
    const key = groupOf(a);
    const mates = st.attempts.filter((x) => x !== a && groupOf(x) === key);
    if (mates.length && st.randomness.has(key)) throw new Error('give attempts that must differ their own rounds');
    for (let i = 0; ; i++) {
      st.randomness.set(key, word(1 + i * 7919 + a.seq * 104729));
      if (isHit(a) === want) break;
    }
    if (beacon.drand) st.signed.add(drandRound(beacon.drand, a.time));
    return a;
  };
  /** A cast in the water whose randomness block is `age` blocks under the head. */
  const cast = (player: Address, age: number, counted = true): void => {
    const targetBlock = st.head - BigInt(age);
    st.casts.set(player.toLowerCase(), { targetBlock, counted });
    st.casted.push({ player, targetBlock, block: targetBlock - 2n });
  };
  const run = (opts: RunOptions = {}) => runKeeper(k, opts);
  return { st, k, season, attempt, cast, run };
}

describe('the hits of a season hunt', () => {
  it('sends nothing for attempts that missed, and asks the beacon once per round, not per attempt', async () => {
    const w = world();
    const s = w.season();
    for (let i = 0; i < 6; i++) w.attempt(s, 600 - i * 60, false);
    const r = await w.run();
    expect(r.hunt).toMatchObject({ seasons: 1, attempts: 6, hits: 0, settled: 0, waiting: 0 });
    expect(w.st.settled).toEqual([]);
    expect(w.st.asked.randomness).toBe(6); // six rounds, one read each
    expect(w.st.asked.outcome).toBe(0);
    expect(r.failed).toBe(0);
  });

  it('records a hit, with the round’s signature as the proof, after the contract confirms it', async () => {
    const w = world();
    const s = w.season();
    w.attempt(s, 500, false);
    const hit = w.attempt(s, 400, true);
    w.attempt(s, 300, false);
    const r = await w.run();
    expect(r.hunt).toMatchObject({ attempts: 3, hits: 1, settled: 1 });
    expect(w.st.settled).toEqual([{ season: 0, seq: hit.seq, proof: `0x${drandRound(DRAND, hit.time).toString(16).padStart(128, '0')}` }]);
    expect(w.st.asked.outcome).toBe(1);
  });

  it('records the earliest of several hits, and only that one', async () => {
    const w = world();
    const s = w.season();
    w.attempt(s, 900, false);
    const first = w.attempt(s, 700, true);
    w.attempt(s, 500, true);
    w.attempt(s, 300, true);
    const r = await w.run();
    expect(r.hunt).toMatchObject({ hits: 3, settled: 1 });
    expect(w.st.settled.map((x) => x.seq)).toEqual([first.seq]);
    // the next pass has nothing left to do: every later attempt is past the recorded one, the earlier one is a known miss
    const again = await w.run();
    expect(again.hunt).toMatchObject({ attempts: 0, hits: 0, settled: 0 });
    expect(w.st.settled.length).toBe(1);
  });

  it('lets an earlier hit take the catch over from a later one already recorded', async () => {
    const w = world();
    const s = w.season();
    const early = w.attempt(s, 700, true);
    const late = w.attempt(s, 300, true);
    Object.assign(s, { hooked: true, winnerSeq: late.seq }); // somebody recorded the later hit first
    const r = await w.run();
    expect(r.hunt).toMatchObject({ attempts: 1, hits: 1, settled: 1 });
    expect(w.st.settled.map((x) => x.seq)).toEqual([early.seq]);
  });

  it('waits for randomness that is not there yet, and comes back for it', async () => {
    const w = world();
    const s = w.season();
    const fresh = w.attempt(s, 5, null); // cast five seconds ago: its round is half a minute away
    let r = await w.run();
    expect(r.hunt).toMatchObject({ attempts: 1, waiting: 1, hits: 0 });
    expect(w.st.asked.drand).toBe(0); // the round's time has not come: the relays are not even asked
    // the round's time comes, the relays do not have it yet
    w.st.head += 40n;
    r = await w.run();
    expect(r.hunt.waiting).toBe(1);
    expect(w.st.asked.drand).toBe(1);
    // and then they do
    w.st.signed.add(drandRound(DRAND, fresh.time));
    for (let i = 0; ; i++) {
      w.st.randomness.set(`r${drandRound(DRAND, fresh.time)}`, word(1 + i));
      if (huntHit({ randomness: word(1 + i), chainId: 20994, hunt: HUNT, season: 0, seq: 0, player: fresh.player }, fresh.chance)) break;
    }
    r = await w.run();
    expect(r.hunt).toMatchObject({ hits: 1, settled: 1, waiting: 0 });
  });

  it('goes by real time for a drand round, not by the chain’s clock', async () => {
    const w = world();
    const s = w.season();
    const a = w.attempt(s, 100, false);
    w.st.clock = -(100 + 60); // this machine's clock is behind the round's time
    expect(w.k.now() / 1000).toBeLessThan(drandTime(DRAND, drandRound(DRAND, a.time)));
    const r = await w.run();
    expect(r.hunt.waiting).toBe(1);
    expect(w.st.asked.drand).toBe(0);
  });

  it('reads attempts that share a round together', async () => {
    const w = world();
    const s = w.season();
    const a = w.attempt(s, 400, false, addr(7));
    // two more casts in the same second: the same round
    for (const p of [addr(8), addr(9)]) w.st.attempts.push({ ...a, seq: w.st.attempts.length, player: p });
    const r = await w.run();
    expect(r.hunt.attempts).toBe(3);
    expect(w.st.asked.randomness).toBe(1);
  });

  it('does not look twice at an attempt it knows to have missed', async () => {
    const w = world();
    const s = w.season();
    for (let i = 0; i < 4; i++) w.attempt(s, 600 - i * 60, false);
    await w.run();
    const r = await w.run();
    expect(r.hunt.attempts).toBe(0);
    expect(w.st.asked.randomness).toBe(4);
  });

  it('leaves alone seasons that cannot have a hit to record', async () => {
    const w = world();
    const now = T0 + Number(w.st.head);
    for (const over of [{ funded: false }, { cancelled: true }, { start: now + 60, end: now + 7_200 }, { start: now - 90_000, end: now - 3_700 }]) {
      const s = w.season(over);
      w.attempt(s, 200 + s.id * 10, true, addr(50 + s.id)); // each its own round
    }
    const r = await w.run();
    expect(r.hunt).toMatchObject({ seasons: 0, attempts: 0 });
    expect(w.st.settled).toEqual([]);
  });

  it('still records a hit while a finished season is closing', async () => {
    const w = world();
    const now = T0 + Number(w.st.head);
    const s = w.season({ start: now - 90_000, end: now - 600 });
    w.attempt(s, 900, true);
    const r = await w.run();
    expect(r.hunt).toMatchObject({ seasons: 1, settled: 1 });
  });

  it('does not send a hit whose window has closed, says so, and records a later one that is still in time', async () => {
    const w = world();
    const s = w.season({ settleWindow: 600 });
    const old = w.attempt(s, 590, true); // ten seconds left: it would not be mined in time
    const later = w.attempt(s, 200, true);
    const r = await w.run();
    expect(r.hunt).toMatchObject({ hits: 2, late: 1, settled: 1 });
    expect(w.st.settled.map((x) => x.seq)).toEqual([later.seq]);
    expect(r.notes.join(' ')).toContain(`attempt ${old.seq}`);
  });

  it('does not look at attempts older than the settle window', async () => {
    const w = world();
    const s = w.season({ settleWindow: 600 });
    w.attempt(s, 5_000, true);
    const r = await w.run();
    expect(r.hunt).toMatchObject({ attempts: 0, hits: 0 });
  });

  it('sends nothing when the contract disagrees with its arithmetic, and reports it', async () => {
    const w = world();
    const s = w.season();
    w.attempt(s, 400, true);
    w.st.outcomeOverride = 'miss';
    const r = await w.run();
    expect(r.hunt).toMatchObject({ hits: 1, mismatches: 1, settled: 0 });
    expect(w.st.settled).toEqual([]);
    expect(r.notes.join(' ')).toContain('nothing was sent');
  });

  it('counts a hit somebody else recorded first as beaten, not as a failure', async () => {
    const w = world();
    const s = w.season();
    const a = w.attempt(s, 400, true);
    w.st.failSettle = () => {
      Object.assign(s, { hooked: true, winnerSeq: a.seq }); // the player's own page was faster
      throw new Error('TargetAlreadyHooked');
    };
    const r = await w.run();
    expect(r.hunt).toMatchObject({ settled: 0, beaten: 1 });
    expect(r.failed).toBe(0);
  });

  it('counts a transaction that failed for another reason, and tries again on the next pass', async () => {
    const w = world();
    const s = w.season();
    w.attempt(s, 400, true);
    w.st.failSettle = () => {
      throw new Error('insufficient funds for gas');
    };
    let r = await w.run();
    expect(r.failed).toBe(1);
    expect(r.notes.join(' ')).toContain('insufficient funds');
    w.st.failSettle = null;
    r = await w.run();
    expect(r.hunt.settled).toBe(1);
  });

  it('works on the hash of a later block too: one read per cast block, no relay', async () => {
    const w = world({ scheme: 'blockhash' });
    const s = w.season();
    w.attempt(s, 500, false);
    const hit = w.attempt(s, 400, true);
    const r = await w.run();
    expect(r.hunt).toMatchObject({ attempts: 2, hits: 1, settled: 1 });
    expect(w.st.settled).toEqual([{ season: 0, seq: hit.seq, proof: '0x' }]);
    expect(w.st.asked.drand).toBe(0);
  });
});

describe('casts in the water', () => {
  it('reels in a cast that is about to expire and leaves the others to their players', async () => {
    const w = world();
    w.cast(addr(1), 7_500); // 691 blocks left: under the 900 it rescues at
    w.cast(addr(2), 7_000); // 1,191 left
    w.cast(addr(3), 30); // just made
    const r = await w.run();
    expect(w.st.reeled).toEqual([addr(1)]);
    expect(r.casts).toMatchObject({ seen: 1, reeled: 1, expired: 0, window: 8191 });
  });

  it('does not ask for more blocks in one log query than a node gives', async () => {
    const w = world();
    w.cast(addr(1), 8_100);
    await w.run({ drain: true });
    expect(w.st.asked.logs.length).toBeGreaterThan(1);
    for (const [from, to] of w.st.asked.logs) expect(to - from + 1n).toBeLessThanOrEqual(5_000n);
    expect(w.st.reeled).toEqual([addr(1)]);
  });

  it('on a chain with the 256-block window rescues earlier', async () => {
    const w = world({ window: 256n });
    w.cast(addr(1), 170); // 86 blocks left
    w.cast(addr(2), 120); // 136 left
    const r = await w.run();
    expect(w.st.reeled).toEqual([addr(1)]);
    expect(r.casts.window).toBe(256);
  });

  it('takes the rescue margin it is given', async () => {
    const w = world();
    w.cast(addr(1), 7_000);
    await w.run({ rescueBlocks: 2_000n });
    expect(w.st.reeled).toEqual([addr(1)]);
  });

  it('skips a cast that was reeled in or made again since the event', async () => {
    const w = world();
    w.cast(addr(1), 7_800);
    w.st.casts.delete(addr(1)); // reeled in by the player
    w.cast(addr(2), 7_800);
    w.st.casts.set(addr(2), { targetBlock: w.st.head - 10n, counted: true }); // a new cast since
    const r = await w.run();
    expect(w.st.reeled).toEqual([]);
    expect(r.casts.seen).toBe(0);
  });

  it('does not spend gas on an expired cast in an ordinary pass', async () => {
    const w = world();
    w.cast(addr(1), 8_200);
    const r = await w.run();
    expect(w.st.reeled).toEqual([]);
    expect(r.casts).toMatchObject({ reeled: 0, expired: 0, left: 0 });
  });

  it('drains: reels in every cast that can be, the fresh, the old and the expired that still count', async () => {
    const w = world();
    w.st.paused = true;
    w.cast(addr(1), 7_500);
    w.cast(addr(2), 40);
    w.cast(addr(3), 8_200); // expired, still in the count
    w.cast(addr(4), 8_230, false); // expired and from before the count: nothing to clear
    w.cast(addr(5), 0); // its randomness block is the head: not yet
    const r = await w.run({ drain: true });
    expect(w.st.reeled.sort()).toEqual([addr(1), addr(2), addr(3)]);
    expect(r.casts).toMatchObject({ seen: 5, reeled: 2, expired: 1, left: 2 });
    expect(r.water).toEqual({ paused: true, inWater: 1 });
    expect(r.notes.join(' ')).toContain('run the drain again');
    // two blocks later the last one can be reeled in, and the water is still
    w.st.head += 2n;
    const again = await w.run({ drain: true });
    expect(w.st.reeled).toContain(addr(5));
    expect(again.water).toEqual({ paused: true, inWater: 0 });
    expect(again.notes).toEqual([]);
  });

  it('says that a drain cannot finish while casting is not paused', async () => {
    const w = world();
    w.cast(addr(1), 0);
    const r = await w.run({ drain: true });
    expect(r.notes.join(' ')).toContain('pause first');
  });

  it('drains from a given block when casts are older than the window', async () => {
    const w = world();
    w.cast(addr(1), 20_000);
    let r = await w.run({ drain: true });
    expect(w.st.reeled).toEqual([]);
    expect(r.water?.inWater).toBe(1);
    r = await w.run({ drain: true, from: w.st.head - 21_000n });
    expect(w.st.reeled).toEqual([addr(1)]);
    expect(r.casts.expired).toBe(1);
  });

  it('counts a failed reel, unless the player got there first', async () => {
    const w = world();
    w.cast(addr(1), 7_800);
    w.cast(addr(2), 7_800);
    w.st.failReel = (p) => {
      if (p === addr(1)) w.st.casts.delete(addr(1)); // the player reeled in at the same moment
      throw new Error('execution reverted');
    };
    const r = await w.run();
    expect(r.failed).toBe(1);
    expect(r.notes.join(' ')).toContain(addr(2));
    expect(r.notes.join(' ')).not.toContain(addr(1));
  });
});

describe('a pass', () => {
  it('sends nothing on a dry run, and says what it would do', async () => {
    const w = world();
    const s = w.season();
    w.attempt(s, 400, true);
    w.cast(addr(1), 7_800);
    const r = await w.run({ dryRun: true });
    expect(w.st.settled).toEqual([]);
    expect(w.st.reeled).toEqual([]);
    expect(r).toMatchObject({ dryRun: true, hunt: { hits: 1, settled: 0 }, casts: { seen: 1, reeled: 0, left: 1 } });
    expect(r.notes.join(' ')).toContain('dry run');
  });

  it('refuses to run for real without a key, and runs dry without one', async () => {
    const w = world({ key: false });
    await expect(w.run()).rejects.toThrow('no keeper key');
    const r = await w.run({ dryRun: true });
    expect(r.operator).toBeNull();
  });

  it('stops when it is out of time and leaves the rest for the next pass', async () => {
    const w = world();
    for (let i = 1; i <= 5; i++) w.cast(addr(i), 7_800);
    let calls = 0;
    const r = await w.run({ shouldContinue: () => ++calls <= 2 });
    expect(w.st.reeled.length).toBe(2);
    expect(r.skipped).toBe(3);
    const next = await w.run();
    expect(w.st.reeled.length).toBe(5);
    expect(next.skipped).toBe(0);
  });

  it('reports the operator’s account, and a low balance', async () => {
    const w = world();
    let r = await w.run();
    expect(r.operator).toEqual({ address: OPERATOR, balance: '0.100000' });
    expect(r.notes).toEqual([]);
    w.st.balance = 10n ** 15n;
    r = await w.run();
    expect(r.notes.join(' ')).toContain('balance is low');
  });

  it('measures the chain’s clock against the beacon’s margin, and is quiet while it is on time', async () => {
    const w = world();
    w.season();
    w.st.clock = 2; // a block old, as a healthy chain is
    const r = await w.run();
    expect(r.clock).toEqual({ lagSeconds: 2, marginSeconds: 30 });
    expect(r.notes).toEqual([]);
  });

  it('says so when the clock is half the margin behind, and louder when a cast could be decided by a known round', async () => {
    const w = world();
    const s = w.season();
    w.st.clock = 15;
    let r = await w.run();
    expect(r.clock.lagSeconds).toBe(15);
    expect(r.notes.join(' ')).toMatch(/15 s behind real time and the beacon's margin is 30 s: .* with 15 s to spare/);
    expect(r.notes.join(' ')).not.toContain('DANGER');

    w.st.clock = 30;
    r = await w.run();
    expect(r.notes.join(' ')).toMatch(/DANGER: the chain's clock is 30 s behind real time .* already public/);

    // a season that is only waiting for late hits takes no casts: the lag is reported without the alarm
    s.end = T0 + Number(w.st.head) - 60;
    r = await w.run();
    expect(r.notes.join(' ')).toContain('no season is taking casts now');
    expect(r.notes.join(' ')).not.toContain('DANGER');
  });

  it('a clock that runs ahead, a hunt on block hashes and a hunt with nothing open raise no alarm', async () => {
    const ahead = world();
    ahead.season();
    ahead.st.clock = -40;
    expect((await ahead.run()).notes).toEqual([]);

    const hashes = world({ scheme: 'blockhash' });
    hashes.season();
    hashes.st.clock = 600;
    const r = await hashes.run();
    expect(r.clock).toEqual({ lagSeconds: 600, marginSeconds: null });
    expect(r.notes).toEqual([]);

    const idle = world();
    idle.st.clock = 600;
    expect((await idle.run()).clock).toEqual({ lagSeconds: 600, marginSeconds: null });
  });

  it('works with a game that does not count its casts, and with no hunt', async () => {
    const w = world({ counts: false });
    w.k.chain.hunt = null;
    w.cast(addr(1), 7_800);
    const r = await w.run();
    expect(r.water).toBeNull();
    expect(r.hunt.seasons).toBe(0);
    expect(w.st.reeled).toEqual([addr(1)]);
  });

  it('fails as a whole when the chain cannot be read: nothing is decided on half a picture', async () => {
    const w = world();
    const s = w.season();
    w.attempt(s, 400, true);
    w.k.chain.hunt!.attempts = async () => {
      throw new Error('rpc down');
    };
    await expect(w.run()).rejects.toThrow('rpc down');
    expect(w.st.settled).toEqual([]);
  });
});

describe('the endpoint', () => {
  const setup = (w: ReturnType<typeof world>, canSend = true): (() => KeeperSetup) => () => ({ keeper: w.k, canSend, rescueBlocks: undefined, budgetMs: 5_000 });
  const call = (handler: (r: Request) => Promise<Response>, query = '', token: string | null = 'secret', method = 'GET') =>
    handler(new Request(`https://example.test/api/keeper${query}`, { method, headers: token === null ? {} : { authorization: `Bearer ${token}` } }));

  it('runs a pass for the scheduler that knows the secret', async () => {
    const w = world();
    w.cast(addr(1), 7_800);
    const res = await call(createKeeperHandler(setup(w), 'secret'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.casts.reeled).toBe(1);
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('refuses everybody else, and is off without a secret', async () => {
    const w = world();
    w.cast(addr(1), 7_800);
    const handler = createKeeperHandler(setup(w), 'secret');
    expect((await call(handler, '', null)).status).toBe(401);
    expect((await call(handler, '', 'wrong')).status).toBe(401);
    expect((await call(handler, '', 'secret', 'DELETE')).status).toBe(405);
    expect((await call(createKeeperHandler(setup(w), undefined), '', 'secret')).status).toBe(503);
    expect((await call(createKeeperHandler(setup(w), ''), '', '')).status).toBe(503);
    expect((await call(createKeeperHandler(() => null, 'secret'))).status).toBe(503);
    expect(w.st.reeled).toEqual([]);
  });

  it('takes dry, drain and from', async () => {
    const w = world();
    w.cast(addr(1), 40);
    const handler = createKeeperHandler(setup(w), 'secret');
    let body = await (await call(handler, '?dry=1&drain=1')).json();
    expect(body).toMatchObject({ dryRun: true, drain: true });
    expect(w.st.reeled).toEqual([]);
    body = await (await call(handler, '?drain=1')).json();
    expect(w.st.reeled).toEqual([addr(1)]);
    expect((await call(handler, '?from=abc')).status).toBe(400);
    expect((await call(handler, `?drain=1&from=${w.st.head - 100n}`)).status).toBe(200);
  });

  it('runs dry when there is no key, and says so', async () => {
    const w = world({ key: false });
    w.cast(addr(1), 7_800);
    const body = await (await call(createKeeperHandler(setup(w, false), 'secret'))).json();
    expect(body.dryRun).toBe(true);
    expect(body.notes.join(' ')).toContain('no KEEPER_KEY');
    expect(w.st.reeled).toEqual([]);
  });

  it('answers 502 when the chain cannot be read, and runs one pass at a time', async () => {
    const w = world();
    const handler = createKeeperHandler(setup(w), 'secret');
    let release!: () => void;
    const original = w.k.chain.head;
    w.k.chain.head = () => new Promise((resolve) => (release = () => void original().then(resolve)));
    const first = call(handler);
    await new Promise((r) => setTimeout(r, 0));
    expect((await call(handler)).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    w.k.chain.head = async () => {
      throw new Error('rpc down');
    };
    const res = await call(handler);
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('chain_unavailable');
  });
});

describe('the configuration', () => {
  it('needs nothing but a key on Fluent Testnet, and runs dry without it', () => {
    const made = keeperFrom({});
    expect('missing' in made).toBe(false);
    if ('missing' in made) return;
    expect(made.canSend).toBe(false);
    expect(made.keeper.chain.chainId).toBe(20994);
    expect(made.keeper.chain.hunt).not.toBeNull();
    const withKey = keeperFrom({ KEEPER_KEY: `0x${'11'.repeat(32)}` });
    expect('missing' in withKey ? null : withKey.canSend).toBe(true);
  });

  it('says what is missing or wrong, without repeating a key', () => {
    expect(keeperFrom({ KEEPER_CHAIN_ID: '31337' })).toEqual({ missing: expect.stringContaining('KEEPER_GAME') });
    expect(keeperFrom({ KEEPER_CHAIN_ID: '31337', KEEPER_GAME: addr(1) })).toEqual({ missing: 'KEEPER_RPC_URL' });
    const bad = keeperFrom({ KEEPER_KEY: 'not-a-key' });
    expect(bad).toEqual({ missing: expect.stringContaining('KEEPER_KEY') });
    expect(JSON.stringify(bad)).not.toContain('not-a-key');
    expect(keeperFrom({ KEEPER_HUNT: 'nope' })).toEqual({ missing: expect.stringContaining('KEEPER_HUNT') });
    const local = keeperFrom({ KEEPER_CHAIN_ID: '31337', KEEPER_GAME: addr(1), KEEPER_RPC_URL: 'http://127.0.0.1:8545' });
    expect('missing' in local ? null : local.keeper.chain.hunt).toBeNull();
  });
});

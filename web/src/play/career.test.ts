import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type AbiEvent, type Address, type Hex } from 'viem';
import { fishingGameAbi } from '../abi';
import { CHAIN_ID, deployment } from '../config';
import { careerKey, parseCareer } from '../game/career';

/**
 * The browser side of the career, against a node that is a few lines of test: the real reader, the real cache
 * keys, the real view. What is faked is the transport and localStorage.
 */
const START = BigInt(deployment!.startBlock);
const GAME = deployment!.game;
const ALICE = '0x00000000000000000000000000000000000a11ce' as Address;
const BOB = '0x0000000000000000000000000000000000000b0b' as Address;

type Ev = { block: bigint; player: Address; name: 'Casted' | 'Caught' | 'Missed'; args: Record<string, unknown> };

const node = vi.hoisted(() => ({
  head: 0n,
  events: [] as unknown[],
  /** eth_getLogs calls, as [from, to, player topic]. */
  queries: [] as [bigint, bigint, string][],
  down: false,
  /** Set to hold every log query until released. */
  gate: null as Promise<void> | null,
}));

function encode(e: Ev): { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; logIndex: Hex; transactionHash: Hex; transactionIndex: Hex; blockHash: Hex; removed: boolean } {
  const item = fishingGameAbi.find((x) => x.type === 'event' && x.name === e.name) as AbiEvent;
  const plain = item.inputs.filter((i) => !i.indexed);
  return {
    address: GAME,
    // `Caught` indexes the fish id as well as the player
    topics: encodeEventTopics({ abi: fishingGameAbi, eventName: e.name, args: { player: e.player, ...(e.name === 'Caught' ? { fishId: e.args.fishId } : {}) } } as never) as Hex[],
    data: encodeAbiParameters(plain, plain.map((i) => e.args[i.name!] ?? (i.type === 'bool' ? false : 0n))),
    blockNumber: `0x${e.block.toString(16)}`,
    logIndex: '0x0',
    transactionHash: `0x${'11'.repeat(32)}`,
    transactionIndex: '0x0',
    blockHash: `0x${'22'.repeat(32)}`,
    removed: false,
  };
}

vi.mock('../clients', () => ({
  publicClient: {
    getBlockNumber: async () => {
      if (node.down) throw new Error('rpc down');
      return node.head;
    },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ hash: `0xb10c${blockNumber.toString(16)}` }),
    request: async ({ params }: { method: string; params: [{ fromBlock: Hex; toBlock: Hex; topics: [Hex[], Hex] }] }) => {
      const [q] = params;
      const from = BigInt(q.fromBlock);
      const to = BigInt(q.toBlock);
      node.queries.push([from, to, q.topics[1]]);
      if (node.gate) await node.gate;
      if (node.down) throw new Error('rpc down');
      return (node.events as Ev[]).filter((e) => e.block >= from && e.block <= to && q.topics[1].toLowerCase().endsWith(e.player.slice(2).toLowerCase())).map(encode);
    },
    readContract: async ({ args, blockNumber }: { args: [Address]; blockNumber: bigint }) => {
      const mine = (node.events as Ev[]).filter((e) => e.player.toLowerCase() === args[0].toLowerCase() && e.block <= blockNumber);
      return { casts: mine.filter((e) => e.name === 'Casted').length, catches: mine.filter((e) => e.name === 'Caught').length };
    },
  },
}));

const cast = (player: Address, block: bigint, locationId: number): Ev => ({ block, player, name: 'Casted', args: { locationId } });
const fish = (player: Address, block: bigint, locationId: number, speciesId: number): Ev => ({ block, player, name: 'Caught', args: { locationId, speciesId, fishId: block, weight: 100, quality: 1, score: 1 } });
const miss = (player: Address, block: bigint, locationId: number): Ev => ({ block, player, name: 'Missed', args: { locationId } });

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

// play/state.ts listens for another tab's save; there are no tabs here
vi.stubGlobal('window', { addEventListener: () => {} });

/** A fresh copy of the modules: the career keeps its state in the module, as the page does. */
async function boot() {
  vi.resetModules();
  const career = await import('./career');
  const { state } = await import('../store');
  const { replaceSave, getSave } = await import('./state');
  const signIn = (address: Address | null): void => {
    state.wallet = address ? ({ address } as never) : null;
  };
  const settled = (status = 'complete'): Promise<void> => vi.waitFor(() => expect(career.careerView().status).toBe(status));
  return { ...career, signIn, settled, replaceSave, getSave };
}
const catchesBy = (v: { waters: { locationId: number; catches: number }[] }): number[] => v.waters.map((w) => w.catches);

beforeEach(() => {
  store.clear();
  node.head = START + 1_000n;
  node.queries = [];
  node.down = false;
  node.gate = null;
  node.events = [
    cast(ALICE, START + 10n, 0),
    fish(ALICE, START + 12n, 0, 3),
    cast(ALICE, START + 20n, 2),
    miss(ALICE, START + 22n, 2),
    cast(ALICE, START + 30n, 2),
    fish(ALICE, START + 32n, 2, 7),
    cast(BOB, START + 40n, 5),
    fish(BOB, START + 42n, 5, 9),
  ];
});

describe('the career of the signed-in account', () => {
  it('is a guest view with nobody signed in, and nothing is read', async () => {
    const c = await boot();
    c.wantCareer(true);
    const v = c.careerView();
    expect(v.status).toBe('guest');
    expect(v.waters).toHaveLength(8);
    expect(v.counted).toEqual({ casts: 0, catches: 0 });
    expect(node.queries).toEqual([]);
  });

  it('reads nothing while the Stats page is closed', async () => {
    const c = await boot();
    c.signIn(ALICE);
    c.syncMyCareer();
    await new Promise((r) => setTimeout(r, 10));
    expect(node.queries).toEqual([]);
    expect(c.careerView().status).toBe('reading');
  });

  it('decodes the game events into counts by water and checks them against the contract', async () => {
    const c = await boot();
    c.signIn(ALICE);
    c.wantCareer(true);
    await c.settled();
    const v = c.careerView();
    expect(v.source).toBe('chain');
    expect(v.counted).toEqual({ casts: 3, catches: 2 });
    expect(catchesBy(v)).toEqual([1, 0, 1, 0, 0, 0, 0, 0]);
    expect(v.waters[2]).toMatchObject({ casts: 2, catches: 1, misses: 1, rate: 0.5, top: { speciesId: 7, count: 1 } });
    expect(v.gap).toEqual({ casts: 0, catches: 0 });
    // one query, for this player only
    expect(node.queries).toHaveLength(1);
    expect(node.queries[0][2].toLowerCase()).toContain(ALICE.slice(2).toLowerCase());
  });

  it('is not called complete while the history is still on its way', async () => {
    let open!: () => void;
    node.gate = new Promise((r) => (open = r));
    const c = await boot();
    c.signIn(ALICE);
    c.wantCareer(true);
    await vi.waitFor(() => expect(node.queries).toHaveLength(1));
    expect(c.careerView().status).toBe('reading');
    expect(c.careerView().counted).toEqual({ casts: 0, catches: 0 });
    open();
    await c.settled();
  });

  it('another wallet never sees the counts of the one before', async () => {
    const c = await boot();
    c.signIn(ALICE);
    c.wantCareer(true);
    await c.settled();
    expect(c.careerView().counted).toEqual({ casts: 3, catches: 2 });

    c.signIn(BOB);
    // at once, before anything of Bob's is read: not Alice's numbers
    const between = c.careerView();
    expect(between.status).toBe('reading');
    expect(between.counted).toEqual({ casts: 0, catches: 0 });
    c.syncMyCareer();
    await c.settled();
    expect(c.careerView().counted).toEqual({ casts: 1, catches: 1 });
    expect(catchesBy(c.careerView())).toEqual([0, 0, 0, 0, 0, 1, 0, 0]);

    // each has its own cache
    const a = parseCareer(store.get(careerKey(CHAIN_ID, GAME, ALICE)) ?? null, START)!;
    const b = parseCareer(store.get(careerKey(CHAIN_ID, GAME, BOB)) ?? null, START)!;
    expect(a.waters[0].catches).toBe(1);
    expect(a.waters[5]).toBeUndefined();
    expect(b.waters[5].catches).toBe(1);
    expect(b.waters[0]).toBeUndefined();

    // back to Alice: her cache, and no block read a second time
    node.queries = [];
    c.signIn(ALICE);
    c.syncMyCareer();
    await c.settled();
    expect(c.careerView().counted).toEqual({ casts: 3, catches: 2 });
    expect(node.queries).toEqual([]);
  });

  it('a reload reads only the blocks since the cache', async () => {
    const first = await boot();
    first.signIn(ALICE);
    first.wantCareer(true);
    await first.settled();
    const cursor = BigInt(parseCareer(store.get(careerKey(CHAIN_ID, GAME, ALICE)) ?? null, START)!.to);
    expect(cursor).toBe(node.head - 5n);

    // a new cast and catch, a new page
    (node.events as Ev[]).push(cast(ALICE, node.head + 1n, 0), fish(ALICE, node.head + 2n, 0, 3));
    node.head += 20n;
    node.queries = [];
    const second = await boot();
    second.signIn(ALICE);
    // before the read: the cached counts are on screen, not zeros
    second.wantCareer(true);
    expect(second.careerView().counted).toEqual({ casts: 3, catches: 2 });
    await vi.waitFor(() => expect(second.careerView().counted).toEqual({ casts: 4, catches: 3 }));
    expect(second.careerView().status).toBe('complete');
    expect(node.queries).toHaveLength(1);
    expect(node.queries[0][0]).toBe(cursor + 1n);
    expect(second.careerView().waters[0].species).toEqual([{ speciesId: 3, count: 2 }]);
  });

  it('a node that does not answer is an error, not a history of zeros', async () => {
    node.down = true;
    const c = await boot();
    c.signIn(ALICE);
    c.wantCareer(true);
    await c.settled('error');
    expect(c.careerView().counted).toEqual({ casts: 0, catches: 0 });
    expect(store.size).toBe(0);
    // the node is back: the next refresh reads it
    node.down = false;
    c.syncMyCareer();
    await c.settled();
    expect(c.careerView().counted).toEqual({ casts: 3, catches: 2 });
    expect(c.careerView().stale).toBe(false);
  });

  it('keeps the last whole copy on screen, marked stale, when a later read fails', async () => {
    const c = await boot();
    c.signIn(ALICE);
    c.wantCareer(true);
    await c.settled();
    node.down = true;
    c.syncMyCareer();
    await vi.waitFor(() => expect(c.careerView().stale).toBe(true));
    expect(c.careerView().status).toBe('complete');
    expect(c.careerView().counted).toEqual({ casts: 3, catches: 2 });
  });

  it('says how much of the lifetime totals the events do not account for', async () => {
    // the contract counted a cast and a catch whose logs the node does not return
    const lost = [cast(ALICE, START + 50n, 6), fish(ALICE, START + 52n, 6, 1)];
    (node.events as Ev[]).push(...lost);
    const c = await boot();
    const { publicClient } = await import('../clients');
    const real = publicClient.request as unknown as (a: unknown) => Promise<{ blockNumber: Hex }[]>;
    (publicClient as { request: unknown }).request = async (a: unknown) => (await real(a)).filter((l) => BigInt(l.blockNumber) < START + 50n || BigInt(l.blockNumber) > START + 52n);
    c.signIn(ALICE);
    c.wantCareer(true);
    await c.settled('partial');
    const v = c.careerView();
    expect(v.counted).toEqual({ casts: 3, catches: 2 });
    expect(v.gap).toEqual({ casts: 1, catches: 1 });
  });

  it('a cast the state already has and the history does not yet is shown as pending, not lost', async () => {
    const c = await boot();
    c.signIn(ALICE);
    c.replaceSave({ ...c.getSave(), stats: { ...c.getSave().stats, casts: 4, catches: 3 } });
    c.wantCareer(true);
    await c.settled();
    expect(c.careerView().pending).toEqual({ casts: 1, catches: 1 });
    expect(c.careerView().gap).toEqual({ casts: 0, catches: 0 });
    c.wantCareer(false);
  });
});

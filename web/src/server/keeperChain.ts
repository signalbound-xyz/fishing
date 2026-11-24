/** The chain and the drand relays, as the keeper uses them (server/keeper.ts): JSON-RPC through viem, and fetch. */
import { BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, defineChain, http, pad, parseAbi, parseEventLogs, toEventSelector, toFunctionSelector, toHex, zeroAddress, type AbiEvent, type Account } from 'viem';
import { fishingGameAbi, seasonHuntAbi } from '../abi';
import { isRelease004, reelWindowOf } from '../game/release';
import type { BeaconFacts, HuntChain, KeeperChain, KeeperSeason, Randomness, SeasonAttempt } from './keeper';

type Address = `0x${string}`;
type Hex = `0x${string}`;

const beaconAbi = parseAbi([
  'function scheme() view returns (string)',
  'function chainHash() view returns (bytes32)',
  'function genesis() view returns (uint256)',
  'function period() view returns (uint256)',
  'function margin() view returns (uint256)',
  'function randomnessFor(uint256 blockNumber, uint256 timestamp, bytes proof) view returns (bytes32)',
  'error NotYet()',
  'error BadProof()',
]);

/** EIP-2935: the chain's record of its last 8,191 block hashes (FishingGame._hashOf asks it). */
const BLOCK_HISTORY = '0x0000F90827F1C53a10cb7A02335B175320002935' as const;
const ZERO = '0x0000000000000000000000000000000000000000';
const CASTED = toEventSelector(fishingGameAbi.find((x) => x.type === 'event' && x.name === 'Casted') as AbiEvent);
const SEASON_CAST = toEventSelector(seasonHuntAbi.find((x) => x.type === 'event' && x.name === 'SeasonCast') as AbiEvent);
const CAST_OF = toFunctionSelector('castOf(address)');

/** The name of the custom error a call reverted with, if it did. */
function revertName(e: unknown): string | null {
  if (!(e instanceof BaseError)) return null;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return r instanceof ContractFunctionRevertedError ? (r.data?.errorName ?? r.reason ?? 'revert') : null;
}

export interface KeeperChainOptions {
  chainId: number;
  rpcUrl: string;
  game: Address;
  hunt?: Address;
  startBlock: bigint;
  /** The account that pays for the transactions. Without one nothing can be sent: a dry run. */
  account?: Account;
  timeoutMs?: number;
  /** How long to wait for a transaction to be mined, ms. */
  receiptMs?: number;
}

export function keeperChain(o: KeeperChainOptions): KeeperChain {
  const chain = defineChain({ id: o.chainId, name: `chain ${o.chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [o.rpcUrl] } } });
  const transport = http(o.rpcUrl, { timeout: o.timeoutMs ?? 8_000, retryCount: 1 });
  const client = createPublicClient({ chain, transport });
  const wallet = o.account ? createWalletClient({ account: o.account, chain, transport }) : null;
  const game = { address: o.game, abi: fishingGameAbi } as const;
  const times = new Map<bigint, number>();

  const timestamp = async (block: bigint): Promise<number> => {
    let t = times.get(block);
    if (t === undefined) {
      t = Number((await client.getBlock({ blockNumber: block })).timestamp);
      if (times.size > 20_000) times.clear();
      times.set(block, t);
    }
    return t;
  };

  /** Sends one call of a function anyone may call, and waits until it is mined. */
  const send = async (request: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }): Promise<void> => {
    if (!wallet) throw new Error('no keeper key');
    const hash = await wallet.writeContract(request as never);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: o.receiptMs ?? 20_000, pollingInterval: 500 });
    if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`);
  };

  const logsOf = (address: Address, topics: (Hex | null)[], from: bigint, to: bigint): Promise<unknown> =>
    client.request({ method: 'eth_getLogs', params: [{ address, fromBlock: toHex(from), toBlock: toHex(to), topics: topics as never }] });

  let reelWindowPromise: Promise<bigint> | null = null;

  /** Whether the game is release 004 or later: it counts its casts, can pause them, and lands them for 8,191 blocks. */
  let release004 = false;
  const isCounting = async (): Promise<boolean> => {
    // an upgrade goes one way, so a yes is kept; a no is asked again
    if (!release004) release004 = isRelease004((await client.call({ to: o.game, data: (CAST_OF + pad(zeroAddress).slice(2)) as Hex })).data);
    return release004;
  };

  const hunt = o.hunt ? huntChain(o.hunt) : null;

  function huntChain(address: Address): HuntChain {
    const h = { address, abi: seasonHuntAbi } as const;
    let beaconPromise: Promise<{ address: Address; facts: BeaconFacts }> | null = null;
    const beacon = (): Promise<{ address: Address; facts: BeaconFacts }> => {
      beaconPromise ??= (async () => {
        const at = await client.readContract({ ...h, functionName: 'beacon' });
        const b = { address: at, abi: beaconAbi } as const;
        const scheme = await client.readContract({ ...b, functionName: 'scheme' });
        if (scheme !== 'drand') return { address: at, facts: { scheme, drand: null } };
        const [chainHash, genesis, period, margin] = await Promise.all([
          client.readContract({ ...b, functionName: 'chainHash' }),
          client.readContract({ ...b, functionName: 'genesis' }),
          client.readContract({ ...b, functionName: 'period' }),
          client.readContract({ ...b, functionName: 'margin' }),
        ]);
        return { address: at, facts: { scheme, drand: { chainHash: chainHash.slice(2), genesis: Number(genesis), period: Number(period), margin: Number(margin) } } };
      })().catch((e) => {
        beaconPromise = null;
        throw e;
      });
      return beaconPromise;
    };
    const facts = (id: number, s: { rules: { start: number; end: number; settleWindow: number }; sponsor: string; cancelled: boolean; hooked: boolean; winnerSeq: bigint }): KeeperSeason => ({
      id,
      start: s.rules.start,
      end: s.rules.end,
      settleWindow: s.rules.settleWindow,
      funded: s.sponsor !== ZERO,
      cancelled: s.cancelled,
      hooked: s.hooked,
      winnerSeq: Number(s.winnerSeq),
    });
    const args = (a: SeasonAttempt, proof: Hex) => [BigInt(a.season), BigInt(a.seq), proof] as const;
    return {
      address,
      beacon: async () => (await beacon()).facts,
      async seasons() {
        // newest first; a season older than these has long been over
        const [views] = await client.readContract({ ...h, functionName: 'list', args: [ZERO, 0n, 20n] });
        return views.map((v) => facts(Number(v.id), v.season));
      },
      async season(id) {
        return facts(id, await client.readContract({ ...h, functionName: 'season', args: [BigInt(id)] }));
      },
      async attempts(season, from, to) {
        const logs = await logsOf(address, [SEASON_CAST, pad(toHex(season))], from, to);
        const out: SeasonAttempt[] = [];
        for (const l of parseEventLogs({ abi: seasonHuntAbi, logs: logs as never, eventName: 'SeasonCast' })) {
          // the log as the node sent it: numbers are still hex text here
          const raw = l as unknown as { address: string; blockNumber: Hex | bigint | null; blockTimestamp?: Hex; removed?: boolean };
          if (raw.address.toLowerCase() !== address.toLowerCase() || raw.blockNumber === null || raw.removed) continue;
          const block = BigInt(raw.blockNumber);
          // the attempt's time is its block's time (SeasonHunt.cast); a node that puts it in the log saves a read
          let time: number;
          if (raw.blockTimestamp) {
            time = Number(BigInt(raw.blockTimestamp));
            times.set(block, time);
          } else time = await timestamp(block);
          out.push({ season, seq: Number(l.args.seq), player: l.args.player, chance: Number(l.args.chance), block, time });
        }
        return out;
      },
      async randomness(a, proof): Promise<Randomness> {
        const b = await beacon();
        try {
          const value = await client.readContract({ address: b.address, abi: beaconAbi, functionName: 'randomnessFor', args: [a.block, BigInt(a.time), proof] });
          return /^0x0+$/.test(value) ? { kind: 'lost' } : { kind: 'value', value };
        } catch (e) {
          // not there yet, or a relay handed out something the beacon does not accept: the next run asks again
          if (revertName(e)) return { kind: 'wait' };
          throw e;
        }
      },
      async outcome(a, proof) {
        try {
          return (await client.readContract({ ...h, functionName: 'outcome', args: args(a, proof) })) ? 'hit' : 'miss';
        } catch (e) {
          const name = revertName(e);
          if (name === 'RandomnessLost' || name === 'UnknownAttempt' || name === 'UnknownSeason') return 'lost';
          if (name) return 'wait';
          throw e;
        }
      },
      settle: (a, proof) => send({ ...h, functionName: 'settle', args: args(a, proof) }),
    };
  }

  return {
    chainId: o.chainId,
    startBlock: o.startBlock,
    async head() {
      const b = await client.getBlock({ blockTag: 'latest' });
      times.set(b.number, Number(b.timestamp));
      return { number: b.number, timestamp: Number(b.timestamp) };
    },
    timestamp,
    reelWindow(head) {
      reelWindowPromise ??= (async () => {
        // the game asks the history only from release 004 on: before it a cast is gone after 256 blocks, history or not
        const counting = await isCounting();
        // a block the EVM has forgotten, where there is one: the history must answer for it
        const probe = head > 306n ? head - 306n : head > 1n ? head - 1n : 0n;
        let history = false;
        try {
          const { data } = await client.call({ to: BLOCK_HISTORY, data: pad(toHex(probe)) });
          history = !!data && data.length === 66 && !/^0x0+$/.test(data);
        } catch (e) {
          if (!revertName(e) && !(e instanceof BaseError)) throw e;
        }
        const window = reelWindowOf(counting, history);
        // the short answer is not kept: an upgrade to release 004 lengthens it under a running keeper
        if (window === 256n) reelWindowPromise = null;
        return window;
      })().catch((e) => {
        reelWindowPromise = null;
        throw e;
      });
      return reelWindowPromise;
    },
    async casted(from, to) {
      const logs = await logsOf(o.game, [CASTED], from, to);
      const out: { player: Address; targetBlock: bigint }[] = [];
      for (const l of parseEventLogs({ abi: fishingGameAbi, logs: logs as never, eventName: 'Casted' })) {
        if (l.address.toLowerCase() !== o.game.toLowerCase() || l.blockNumber === null || l.removed) continue;
        out.push({ player: l.args.player, targetBlock: BigInt(l.args.targetBlock) });
      }
      return out;
    },
    async castOf(player) {
      // read as words: a release up to 003 answers with six of them, later ones add `counted`
      const { data } = await client.call({ to: o.game, data: (CAST_OF + pad(player).slice(2)) as Hex });
      if (!data || data.length < 2 + 64 * 6) throw new Error('castOf answered with nothing');
      const word = (i: number): bigint => BigInt('0x' + data.slice(2 + 64 * i, 2 + 64 * (i + 1)));
      return { targetBlock: word(0), counted: data.length >= 2 + 64 * 7 && word(6) !== 0n };
    },
    reelFor: (player) => send({ ...game, functionName: 'reelFor', args: [player] }),
    async water() {
      if (!(await isCounting())) return null; // release 003 and earlier do not count their casts
      const [inWater, paused] = await Promise.all([client.readContract({ ...game, functionName: 'castsInWater' }), client.readContract({ ...game, functionName: 'castingPaused' })]);
      return { paused, inWater: Number(inWater) };
    },
    async operator() {
      if (!o.account) return null;
      return { address: o.account.address, balanceWei: await client.getBalance({ address: o.account.address }) };
    },
    hunt,
  };
}

const DRAND_HOSTS = ['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh'];

/** The signature of a drand round from the public relays, or null while it is not there. Only the round is sent. */
export async function drandSignature(chainHash: string, round: number, hosts: string[] = DRAND_HOSTS): Promise<Hex | null> {
  for (const host of hosts) {
    try {
      const res = await fetch(`${host}/${chainHash}/public/${round}`, { signal: AbortSignal.timeout(4_000) });
      if (!res.ok) continue;
      const body = (await res.json()) as { round?: number; signature?: string };
      if (body.round === round && typeof body.signature === 'string' && /^[0-9a-f]{128}$/i.test(body.signature)) return `0x${body.signature}`;
    } catch {
      /* this relay is out of reach: the next one */
    }
  }
  return null;
}

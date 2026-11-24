/** The chain, as the reward verifier reads it (server/dailyReward.ts): plain JSON-RPC reads through viem. */
import { createPublicClient, http, pad, parseEventLogs, toEventSelector, type AbiEvent } from 'viem';
import { dailyRewardsAbi, fishingGameAbi } from '../abi';
import type { ChainFacts, PlayerEvent } from './dailyReward';

type Address = `0x${string}`;

const EVENTS = ['Caught', 'LocationUnlocked', 'RodBought'] as const;
const TOPICS = fishingGameAbi.filter((x) => x.type === 'event' && (EVENTS as readonly string[]).includes(x.name)).map((e) => toEventSelector(e as AbiEvent));

export function chainFacts(opts: { rpcUrl: string; game: Address; rewards: Address; timeoutMs?: number }): ChainFacts {
  const client = createPublicClient({ transport: http(opts.rpcUrl, { timeout: opts.timeoutMs ?? 8_000, retryCount: 1 }) });
  const game = { address: opts.game, abi: fishingGameAbi } as const;
  const rewards = { address: opts.rewards, abi: dailyRewardsAbi } as const;
  return {
    async head() {
      const b = await client.getBlock({ blockTag: 'latest' });
      return { number: b.number, timestamp: Number(b.timestamp) };
    },
    async timestamp(block) {
      return Number((await client.getBlock({ blockNumber: block })).timestamp);
    },
    async events(player, from, to) {
      // one query for the three events: the player is the first indexed argument of each
      const logs = await client.request({
        method: 'eth_getLogs',
        params: [{ address: opts.game, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [TOPICS, pad(player)] }],
      });
      const out: PlayerEvent[] = [];
      for (const l of parseEventLogs({ abi: fishingGameAbi, logs: logs as never })) {
        // only the game's own logs, only this player's, only ones that are in a block
        if (l.address.toLowerCase() !== opts.game.toLowerCase() || l.blockNumber === null) continue;
        if (!('player' in l.args) || (l.args.player as string).toLowerCase() !== player.toLowerCase()) continue;
        const at = { block: l.blockNumber, removed: !!l.removed };
        if (l.eventName === 'Caught') out.push({ ...at, kind: 'catch', fish: { id: l.args.fishId.toString(), speciesId: l.args.speciesId, weight: l.args.weight, locationId: l.args.locationId } });
        else if (l.eventName === 'LocationUnlocked') out.push({ ...at, kind: 'unlock', locationId: l.args.locationId });
        else if (l.eventName === 'RodBought') out.push({ ...at, kind: 'rod', rod: l.args.rod });
      }
      return out;
    },
    async player(player, block) {
      const p = await client.readContract({ ...game, functionName: 'playerOf', args: [player], blockNumber: block });
      return { unlocks: p.unlocks, rods: p.rods };
    },
    async rewards(player, day, signer) {
      const [firstDay, claimed, signerAccepted] = await Promise.all([
        client.readContract({ ...rewards, functionName: 'firstDay' }),
        client.readContract({ ...rewards, functionName: 'claimed', args: [player, BigInt(day)] }),
        client.readContract({ ...rewards, functionName: 'signers', args: [signer] }),
      ]);
      return { firstDay: Number(firstDay), claimed, signerAccepted };
    },
  };
}

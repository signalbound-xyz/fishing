/**
 * What the game and the keeper assume about the live network, asked of the network itself. Reads only: no key, no
 * transaction, no gas.
 *
 *   - The game lands a cast for 8,191 blocks by asking the chain's block-hash history (EIP-2935) once the EVM's own
 *     `blockhash` is gone (FishingGame._hashOf). That holds only if the history has the hash of every block, not
 *     of most of them: a slot that was skipped would still hold the hash of a block 8,191 blocks earlier.
 *   - The page reads the game through the lens, in the shape of the release the network runs (game/release.ts).
 *     The lens ships with the game's release: this is the check to run before and right after an upgrade.
 *   - The keeper decides off the chain which seasonal casts hooked the season's fish (game/hunt.ts). Whatever the
 *     live hunt holds right now is put to the contract's own `outcome` as well.
 *
 * Run: pnpm live:read   (LIVE_RPC and LIVE_CHAIN_ID choose another network; the default is Fluent Testnet)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, encodeFunctionData, http, pad, toHex, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { gameLensAbi } from '../src/abi';
import { huntHit } from '../src/game/hunt';
import { CAST_OF_SELECTOR, decodePlayerView, isRelease004 } from '../src/game/release';
import { runKeeper } from '../src/server/keeper';
import { drandSignature, keeperChain } from '../src/server/keeperChain';

const chainId = Number(process.env.LIVE_CHAIN_ID ?? 20994);
const rpcUrl = process.env.LIVE_RPC ?? 'https://rpc.testnet.fluent.xyz';
const dep = JSON.parse(readFileSync(fileURLToPath(new URL(`../../deployments/${chainId}.json`, import.meta.url)), 'utf8')) as Record<string, Hex> & { startBlock: number };
const pub = createPublicClient({ transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }) });

const HISTORY = '0x0000F90827F1C53a10cb7A02335B175320002935' as const;
const WINDOW = 8191n;

/** The history's answer for `block`, as seen from the state of `at`; null when it reverts. */
async function history(block: bigint, at: bigint): Promise<Hex | null> {
  try {
    const { data } = await pub.call({ to: HISTORY, data: pad(toHex(block)), blockNumber: at });
    return data ?? null;
  } catch {
    return null;
  }
}

describe('the chain’s block-hash history', () => {
  it('has the hash of every block of its window, and of no other', async () => {
    const head = (await pub.getBlockNumber()) - 3n; // a few blocks down: every node has them
    // the newest, the edge of what the EVM itself serves, the middle, and the oldest
    const starts = [head - 40n, head - 276n, head - 2_500n, head - 5_000n, head - WINDOW];
    let compared = 0;
    for (const start of starts) {
      const blocks = Array.from({ length: 40 }, (_, i) => start + BigInt(i)).filter((b) => b < head);
      const [answers, real] = await Promise.all([Promise.all(blocks.map((b) => history(b, head))), Promise.all(blocks.map((b) => pub.getBlock({ blockNumber: b })))]);
      for (const [i, b] of blocks.entries()) {
        expect(answers[i], `the history's answer for block ${b} (${head - b} under the head)`).toBe(real[i].hash);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(190);
    // outside the window it answers nothing: the game then calls the cast expired
    expect(await history(head - WINDOW - 1n, head)).toBeNull();
    expect(await history(head, head)).toBeNull();
    expect(await history(head + 5n, head)).toBeNull();
  });

  it('answers a contract’s own call the same way', async () => {
    const head = (await pub.getBlockNumber()) - 3n;
    for (const [depth, expected] of [
      [300n, true],
      [5_000n, true],
      [8_100n, true],
      [9_000n, false],
    ] as const) {
      const block = head - depth;
      // a contract that calls the history exactly as the game does and returns [the word at 0][whether the call succeeded]
      const code = `0x7f${pad(toHex(block)).slice(2)}5f5260205f60205f73${HISTORY.slice(2)}5afa60205260405ff3` as Hex;
      const { data } = await pub.call({ data: code, blockNumber: head });
      const ok = BigInt(`0x${data!.slice(66)}`) === 1n;
      expect(ok, `block ${depth} under the head`).toBe(expected);
      if (expected) expect(`0x${data!.slice(2, 66)}`).toBe((await pub.getBlock({ blockNumber: block })).hash);
    }
  });
});

describe('the deployed lens', () => {
  const lens = { address: dep.lens, abi: gameLensAbi } as const;

  it('answers the page’s reads in the shape this build decodes, on the release the network runs', async () => {
    // the page asks the game which release it is, and reads the lens in that release's shape (game/release.ts)
    const castOf = await pub.call({ to: dep.game, data: `${CAST_OF_SELECTOR}${pad('0x00', { size: 32 }).slice(2)}` });
    const is004 = isRelease004(castOf.data);
    const catalog = await pub.readContract({ ...lens, functionName: 'catalog' });
    expect(catalog.locations.length).toBeGreaterThan(0);
    expect(catalog.species.length).toBeGreaterThan(0);
    // any address will do: a wallet that never played is read the same way
    const answer = await pub.call({ to: dep.lens, data: encodeFunctionData({ abi: gameLensAbi, functionName: 'playerView', args: ['0x000000000000000000000000000000000000dEaD'] }) });
    const view = decodePlayerView(answer.data!, is004);
    expect(view.energyNow).toBeGreaterThan(0n);
    expect(Number(view.blockNumber)).toBeGreaterThan(0);
    expect(view.bestByLocation).toHaveLength(catalog.locations.length);
    expect(view.dex).toHaveLength(catalog.species.length);
    if (!is004) expect(view.castingPaused).toBe(false);
    console.log(`[live] the game is release ${is004 ? '004 or later' : '003 or earlier'}; lens ${dep.lens}: ${catalog.locations.length} water(s), ${catalog.species.length} species`);
  });
});

describe('the keeper on the live network', () => {
  const chain = keeperChain({ chainId, rpcUrl, game: dep.game, hunt: dep.seasonHunt, startBlock: BigInt(dep.startBlock), timeoutMs: 20_000 });

  it('reads it without a key and would send nothing', async () => {
    const report = await runKeeper({ chain, drand: drandSignature, now: () => Date.now() }, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.hunt.settled + report.casts.reeled + report.casts.expired + report.failed).toBe(0);
    expect([256, 8191]).toContain(report.casts.window);
    // the long window belongs to release 004: a game that does not count its casts does not ask the history either
    if (report.water === null) expect(report.casts.window).toBe(256);
    console.log('[live] keeper dry run:', JSON.stringify(report));
  });

  it('decides the hunt’s recent attempts as the contract does', async () => {
    const hunt = chain.hunt;
    if (!hunt) return console.log('[live] no hunt is deployed here: nothing to compare');
    const head = await chain.head();
    const beacon = await hunt.beacon();
    let compared = 0;
    let hits = 0;
    for (const season of await hunt.seasons()) {
      if (!season.funded || season.cancelled) continue;
      // the last five thousand blocks of the season, wherever it is in its life
      const attempts = await hunt.attempts(season.id, head.number > 5_000n ? head.number - 5_000n : 0n, head.number);
      for (const a of attempts.slice(-25)) {
        let proof: Hex = '0x';
        if (beacon.drand) {
          const { drandRound } = await import('../src/game/hunt');
          const signature = await drandSignature(beacon.drand.chainHash, drandRound(beacon.drand, a.time));
          if (!signature) continue;
          proof = signature;
        }
        const rnd = await hunt.randomness(a, proof);
        if (rnd.kind !== 'value') continue;
        const mine = huntHit({ randomness: rnd.value, chainId, hunt: hunt.address, season: a.season, seq: a.seq, player: a.player }, a.chance);
        const theirs = await hunt.outcome(a, proof);
        expect(mine ? 'hit' : 'miss', `season ${a.season} attempt ${a.seq}`).toBe(theirs);
        compared++;
        if (mine) hits++;
      }
    }
    console.log(`[live] attempts compared with the contract: ${compared} (${hits} hit(s))`);
  });
});

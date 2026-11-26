/**
 * What the game and the keeper assume about the live network, asked of the network itself. Reads only: no key, no
 * transaction, no gas.
 *
 *   - The game lands a cast for 8,191 blocks by asking the chain's block-hash history (EIP-2935) once the EVM's own
 *     `blockhash` is gone (FishingGame._hashOf). That holds only if the history has the hash of every block, not
 *     of most of them: a slot that was skipped would still hold the hash of a block 8,191 blocks earlier.
 *   - The page reads the game through the lens, in the shape of the release the network runs (game/release.ts).
 *     The lens ships with the game's release: this is the check to run before and right after an upgrade.
 *   - A fish on the line is landed by a recording of its fight, which the page plays on its own copy of the fight
 *     (game/fight.ts) and the deployed judge replays (ReelJudge, FightVerifier). The two must agree on which fight
 *     a cast gets and on what every recording comes to, on this network's own execution, or players lose fish
 *     they landed. Checked for the judge in the deployments file, attached or not.
 *   - The keeper decides off the chain which seasonal casts hooked the season's fish (game/hunt.ts). Whatever the
 *     live hunt holds right now is put to the contract's own `outcome` as well.
 *
 * Run: pnpm live:read   (LIVE_RPC and LIVE_CHAIN_ID choose another network; the default is Fluent Testnet)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, encodeFunctionData, http, pad, toHex, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { gameLensAbi, reelJudgeAbi } from '../src/abi';
import { castFight } from '../src/game/chainOutcome';
import { LOCATIONS } from '../src/game/content';
import { MAX_TICKS, botInputs, packInputs, replayFight } from '../src/game/fight';
import { huntHit } from '../src/game/hunt';
import { CAST_OF_SELECTOR, decodePlayerView, releaseOf, type GameRelease } from '../src/game/release';
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
    const release = releaseOf(castOf.data);
    const catalog = await pub.readContract({ ...lens, functionName: 'catalog' });
    expect(catalog.locations.length).toBeGreaterThan(0);
    expect(catalog.species.length).toBeGreaterThan(0);
    // the lens is read in the shape of the release it was built for: one that knows fights says how long one may take
    const lensRelease: GameRelease = await pub.readContract({ ...lens, functionName: 'fightBlocks' }).then(
      () => 5 as const,
      () => (release >= 4 ? 4 : 3),
    );
    // any address will do: a wallet that never played is read the same way
    const answer = await pub.call({ to: dep.lens, data: encodeFunctionData({ abi: gameLensAbi, functionName: 'playerView', args: ['0x000000000000000000000000000000000000dEaD'] }) });
    const view = decodePlayerView(answer.data!, lensRelease);
    expect(view.energyNow).toBeGreaterThan(0n);
    expect(Number(view.blockNumber)).toBeGreaterThan(0);
    expect(view.bestByLocation).toHaveLength(catalog.locations.length);
    expect(view.dex).toHaveLength(catalog.species.length);
    if (release < 4) expect(view.castingPaused).toBe(false);
    if (lensRelease < 5) expect(view.cast.fight).toBe(false);
    console.log(`[live] the game is release ${release === 3 ? '003 or earlier' : release === 4 ? '004' : '005 or later'}, its lens ${dep.lens} is built for ${lensRelease}: ${catalog.locations.length} water(s), ${catalog.species.length} species`);
  });
});

describe.skipIf(!dep.reelJudge)('the deployed reel judge', () => {
  const judge = { address: dep.reelJudge, abi: reelJudgeAbi } as const;
  const lens = { address: dep.lens, abi: gameLensAbi } as const;

  it('gives a cast the fight the page plays, and makes of a recording what the page makes of it', async () => {
    const catalog = await pub.readContract({ ...lens, functionName: 'catalog' });
    const attached = await pub.readContract({ ...lens, functionName: 'reelJudge' });
    const rods = [-8, 0, 6, 12, 40];
    let fights = 0;
    let recordings = 0;
    let landedOnes = 0;
    let longest = { ticks: 0, gas: 0n };
    // every water with a fish of every rarity it can be asked about, under rods from the worst to past the cap
    const cases = LOCATIONS.flatMap((loc, locationId) =>
      [0, 5, 11, 17, 23, catalog.species.length - 1].map((speciesId, k) => ({ loc, locationId, speciesId, rodCatch: rods[(locationId + k) % rods.length], seed: BigInt(locationId * 1_000 + k * 37 + 1) })),
    );
    for (const c of cases) {
      const mine = castFight(c.seed, catalog.species[c.speciesId].rarity, c.loc.tier, c.rodCatch);
      const [seed, difficulty, green] = await pub.readContract({ ...judge, functionName: 'fightOf', args: [c.seed, BigInt(c.speciesId), BigInt(c.locationId), BigInt(c.rodCatch)] });
      expect({ seed, difficulty: Number(difficulty), green: Number(green) }, `the fight of species ${c.speciesId} at ${c.loc.name}, rod catch ${c.rodCatch}`).toEqual(mine);
      fights++;

      // a recording that lands it (when the stand-in player manages), the same cut short, the same with every
      // tick turned over, an untouched reel, and a reel held from the first tick to the last
      const played = botInputs(mine.seed, mine.difficulty, mine.green);
      const tries = [played, played.slice(0, played.length >> 1), played.map((b) => !b), [], Array.from({ length: MAX_TICKS }, () => true)];
      for (const bits of tries) {
        const inputs = packInputs(bits);
        const page = replayFight(mine.seed, mine.difficulty, mine.green, inputs);
        const args = [c.seed, BigInt(c.speciesId), BigInt(c.locationId), BigInt(c.rodCatch), inputs] as const;
        const chain = await pub.readContract({ ...judge, functionName: 'landed', args });
        expect(chain, `species ${c.speciesId} at ${c.loc.name}, rod catch ${c.rodCatch}, a recording of ${bits.length} tick(s)`).toBe(page.landed);
        recordings++;
        if (chain) landedOnes++;
        if (page.ticks > longest.ticks) longest = { ticks: page.ticks, gas: await pub.estimateContractGas({ ...judge, functionName: 'landed', args }) };
      }
    }
    expect(landedOnes).toBeGreaterThan(cases.length / 4); // the comparison saw fish landed, not only fish lost
    // the longest fight here is replayed well inside what a transaction may spend
    expect(longest.gas).toBeLessThan(2_000_000n);
    console.log(
      `[live] the reel judge ${dep.reelJudge} (${attached === dep.reelJudge ? 'attached' : attached === '0x0000000000000000000000000000000000000000' ? 'not attached' : `NOT the one the game asks: ${attached}`}): ` +
        `${fights} fight(s) and ${recordings} recording(s) agree with the page, ${landedOnes} landed; the longest replay, ${longest.ticks} tick(s), costs ${longest.gas} gas as a call of its own`,
    );
  }, 180_000);
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

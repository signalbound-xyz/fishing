/**
 * End to end on a local chain: the reel fight between the page's own code and the contracts.
 *
 * A fresh deployment (contracts/script/Deploy.s.sol) has the judge of the reel fight attached. Against it this
 * casts, works out what bit and which fight it has to be landed in with the code the page uses
 * (game/chainOutcome.ts), plays the fight on the page's machine (game/fight.ts) and sends the recording. The
 * contract must then do exactly what the page's own replay says: mint the predicted fish for a recording that
 * lands it, and let it go for any other. It also tries every other way to get the fish: somebody else's
 * settlement, the keeper's drain, a new cast over it, a second recording, a recording that comes too late.
 *
 * Only ever a local chain: it refuses any chain id but 31337, and takes its key from LIVE_KEY (one of the
 * well-known accounts anvil starts with). See web/README.md, "The reel fight end to end".
 *
 * Run: LIVE_KEY=0x… pnpm live:reel   (anvil on 127.0.0.1:8545 with a fresh deployment in deployments/31337.json)
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BaseError, ContractFunctionRevertedError, createPublicClient, createTestClient, createWalletClient, encodeFunctionData, http, parseEventLogs, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { fishingGameAbi, fishNftAbi, gameLensAbi, reelJudgeAbi } from '../src/abi';
import { resolveCast, type CastOutcome, type ChainCatalog } from '../src/game/chainOutcome';
import { LOCATIONS } from '../src/game/content';
import { MAX_TICKS, botInputs, packInputs, replayFight } from '../src/game/fight';
import { castNeedsFight, decodePlayerView } from '../src/game/release';
import { runKeeper } from '../src/server/keeper';
import { keeperChain } from '../src/server/keeperChain';

const file = fileURLToPath(new URL('../../deployments/31337.json', import.meta.url));
const key = process.env.LIVE_KEY as Hex | undefined;
const ready = existsSync(file) && !!key;
const dep = ready ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, Hex>) : ({} as Record<string, Hex>);
const rpc = process.env.LIVE_RPC ?? 'http://127.0.0.1:8545';
const chain = { id: 31337, name: 'anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } as const;
const transport = http(rpc);
const pub = createPublicClient({ chain, transport });
const test = createTestClient({ chain, transport, mode: 'anvil' });
const game = { address: dep.game, abi: fishingGameAbi } as const;
const lens = { address: dep.lens, abi: gameLensAbi } as const;
const fish = { address: dep.fish, abi: fishNftAbi } as const;

/**
 * EIP-2935, the chain's record of its last 8,191 block hashes, as the EIP gives it. Fluent has it; a bare anvil
 * does not, and there a cast is simply expired after 256 blocks, before the time for a fight is over. For the one
 * case that outlives 256 blocks the contract is put in place and told the hash of the cast's block, as the chain
 * itself would have.
 */
const HISTORY = '0x0000F90827F1C53a10cb7A02335B175320002935' as const;
const HISTORY_CODE = '0x3373fffffffffffffffffffffffffffffffffffffffe14604657602036036042575f35600143038111604257611fff81430311604257611fff9006545f5260205ff35b5f5ffd5b5f35611fff60014303065500' as const;

const revertOf = (e: unknown): string | null => {
  if (!(e instanceof BaseError)) return null;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return r instanceof ContractFunctionRevertedError ? (r.data?.errorName ?? 'revert') : null;
};

describe.skipIf(!ready)('the reel fight on a local chain', () => {
  const account = ready ? privateKeyToAccount(key!) : null!;
  const me = account?.address;
  const wallet = ready ? createWalletClient({ account, chain, transport }) : null!;
  const send = async (hash: Hex) => {
    const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 200 });
    expect(r.status).toBe('success');
    return parseEventLogs({ abi: fishingGameAbi, logs: r.logs });
  };
  const refuses = async (functionName: 'reelFor' | 'cast' | 'reel', args: readonly unknown[], from = me): Promise<string | null> => {
    try {
      await pub.simulateContract({ ...game, functionName, args, account: from } as never);
      return null;
    } catch (e) {
      return revertOf(e) ?? 'error';
    }
  };

  let catalog: ChainCatalog;
  const readCatalog = async (): Promise<ChainCatalog> => {
    const [c, cfg] = await Promise.all([pub.readContract({ ...lens, functionName: 'catalog' }), pub.readContract({ ...game, functionName: 'config' })]);
    return {
      config: { qualityPerCatch: cfg[11], qualityPerRarity: cfg[12], blendChancePpm: cfg[14], blendMaxWins: cfg[15] },
      locations: c.locations.map((l) => ({ special: l.special, speciesIds: [...l.speciesIds], weights: [...l.weights] })),
      species: c.species.map((s, i) => ({ rarity: s.rarity, minWeight: s.minWeight, maxWeight: s.maxWeight, hidden: c.hidden[i] })),
      specials: c.specials.map((s) => ({ speciesId: s.speciesId, chancePpm: s.chancePpm, pity: s.pity })),
      tiers: LOCATIONS.map((l) => l.tier),
    };
  };

  /** Casts, waits for the randomness block and says what the page would show for it. */
  const castAndLook = async (): Promise<{ out: CastOutcome; target: bigint }> => {
    await send(await wallet.writeContract({ ...game, functionName: 'cast', args: [0] }));
    const own = await pub.call({ to: dep.game, data: encodeFunctionData({ abi: fishingGameAbi, functionName: 'castOf', args: [me] }) });
    expect(castNeedsFight(own.data), 'a cast made with the judge attached has to be reeled in').toBe(true);
    const v = decodePlayerView((await pub.call({ to: dep.lens, data: encodeFunctionData({ abi: gameLensAbi, functionName: 'playerView', args: [me] }) })).data!, 5);
    const target = v.cast.targetBlock;
    while ((await pub.getBlockNumber({ cacheTime: 0 })) <= target) await new Promise((r) => setTimeout(r, 200));
    const lo = await pub.readContract({ ...game, functionName: 'loadout', args: [BigInt(v.cast.rod), BigInt(v.cast.lure), BigInt(v.cast.special), BigInt(v.cast.locationId)] });
    const out = resolveCast(catalog, {
      blockHash: (await pub.getBlock({ blockNumber: target })).hash,
      player: me,
      game: dep.game,
      nonce: v.cast.nonce,
      locationId: v.cast.locationId,
      loadout: { rodCatch: Number(lo[0]), biteBps: Number(lo[1]), rarity: Number(lo[2]), weight: Number(lo[3]), hiddenMult: Number(lo[4]) },
      bottleOpen: false,
      bottleAmount: 0,
      specialsFound: v.p.specialsFound,
      dry: [...v.dry],
    });
    return { out, target };
  };

  const progress = async () => {
    const p = await pub.readContract({ ...game, functionName: 'playerOf', args: [me] });
    return { xp: p.xp, catches: p.catches, dexCount: p.dexCount, fish: await pub.readContract({ ...fish, functionName: 'balanceOf', args: [me] }), supply: await pub.readContract({ ...fish, functionName: 'totalSupply' }) };
  };

  it('runs a fresh deployment with the judge attached, set as the page sets a fight', async () => {
    expect(await pub.getChainId(), 'this test only ever runs on a local chain').toBe(31337);
    catalog = await readCatalog();
    const judge = await pub.readContract({ ...lens, functionName: 'reelJudge' });
    expect(judge).not.toBe('0x0000000000000000000000000000000000000000');
    expect(judge.toLowerCase()).toBe(dep.reelJudge.toLowerCase());
    expect(await pub.readContract({ ...lens, functionName: 'fightBlocks' })).toBe(600n);
    const tiers = await pub.readContract({ address: judge, abi: reelJudgeAbi, functionName: 'tiers' });
    LOCATIONS.forEach((l, i) => expect(Number((tiers >> BigInt(4 * i)) & 15n), l.name).toBe(l.tier));
  });

  it('mints the predicted fish for a landing, lets it go for anything else, and offers no way around', async () => {
    const done = { landed: 0, lost: 0, snapped: 0, empty: 0, late: 0, missed: 0 };
    let keeperTried = false;
    const wants: ('land' | 'snap' | 'empty' | 'late')[] = ['land', 'snap', 'land', 'empty', 'late', 'land'];
    for (let casts = 0; wants.length > 0 && casts < 19; casts++) {
      const { out, target } = await castAndLook();
      if (out.kind !== 'caught') {
        // nothing to fight for: anyone takes the cast out of the water
        expect(out.kind).toBe('missed');
        const logs = await send(await wallet.writeContract({ ...game, functionName: 'reelFor', args: [me] }));
        expect(logs.some((l) => l.eventName === 'Missed')).toBe(true);
        done.missed++;
        continue;
      }
      const before = await progress();
      // a fish is on the line: nobody settles it without a fight, and a new cast does not throw it away
      expect(await refuses('reelFor', [me], '0x000000000000000000000000000000000000bEEF')).toBe('FishOn');
      expect(await refuses('reelFor', [me])).toBe('FishOn');
      expect(await refuses('cast', [0])).toBe('FishOn');
      if (!keeperTried) {
        // the keeper's drain meets the same refusal, sends nothing and calls it a fight, not a failure
        keeperTried = true;
        const k = keeperChain({ chainId: 31337, rpcUrl: rpc, game: dep.game, startBlock: 0n, account });
        const nonce = await pub.getTransactionCount({ address: me });
        expect(await k.reelFor(me)).toBe('fishOn');
        const report = await runKeeper({ chain: k, drand: async () => null, now: () => Date.now() }, { drain: true });
        expect(report.casts).toMatchObject({ seen: 1, reeled: 0, fighting: 1, left: 1 });
        expect(report.failed).toBe(0);
        expect(await pub.getTransactionCount({ address: me }), 'the keeper sent a transaction that could only revert').toBe(nonce);
        expect(await progress()).toEqual(before);
      }

      const want = wants.shift()!;
      const f = out.fight;
      if (want === 'late') {
        const good = packInputs(botInputs(f.seed, f.difficulty, f.green));
        await test.setCode({ address: HISTORY, bytecode: HISTORY_CODE });
        await test.setStorageAt({ address: HISTORY, index: toHex(target % 8191n, { size: 32 }), value: (await pub.getBlock({ blockNumber: target })).hash });
        await test.mine({ blocks: 600 });
        // the time is up: the same recording lands nothing, and now anyone may close the cast
        expect(await refuses('reelFor', [me], '0x000000000000000000000000000000000000bEEF')).toBeNull();
        const logs = await send(await wallet.writeContract({ ...game, functionName: 'reel', args: [good] }));
        expect(logs.find((l) => l.eventName === 'Escaped')?.args).toMatchObject({ speciesId: out.speciesId });
        expect(await progress()).toEqual(before);
        done.late++;
        continue;
      }
      const recording = want === 'land' ? packInputs(botInputs(f.seed, f.difficulty, f.green)) : want === 'snap' ? packInputs(new Array<boolean>(MAX_TICKS).fill(true)) : '0x';
      // the page's own replay of the recording is the verdict the contract must reach
      const mine = replayFight(f.seed, f.difficulty, f.green, recording);
      if (want !== 'land') expect(mine.landed).toBe(false);
      const logs = await send(await wallet.writeContract({ ...game, functionName: 'reel', args: [recording] }));
      const caught = logs.find((l) => l.eventName === 'Caught');
      const escaped = logs.find((l) => l.eventName === 'Escaped');
      expect(!!caught, `the contract ${caught ? 'landed' : 'lost'} a fight the page ${mine.landed ? 'landed' : 'lost'}`).toBe(mine.landed);
      expect(!!escaped).toBe(!mine.landed);
      const after = await progress();
      if (caught) {
        expect(caught.args).toMatchObject({ speciesId: out.speciesId, weight: out.weight, quality: out.quality, special: out.special });
        expect(after.fish).toBe(before.fish + 1n);
        expect(after.catches).toBe(before.catches + 1);
        expect(after.xp).toBeGreaterThan(before.xp);
        done.landed++;
      } else {
        expect(escaped!.args).toMatchObject({ speciesId: out.speciesId });
        expect(after, 'a lost fish moved the player’s progress').toEqual(before);
        if (want === 'land') {
          wants.push('land'); // the stand-in player lost this one: an honest loss, and another fish to land
          done.lost++;
        } else done[want === 'snap' ? 'snapped' : 'empty']++;
      }
      // the cast is closed either way: there is no second try at the same fish
      expect(await refuses('reel', [packInputs(botInputs(f.seed, f.difficulty, f.green))])).toBe('NoActiveCast');
      expect(await refuses('reelFor', [me])).toBe('NoActiveCast');
    }
    console.log('[reel] on a local chain:', done);
    expect(wants, 'not every way to end a fight was reached: run again on a fresh deployment').toEqual([]);
    expect(done.landed).toBeGreaterThanOrEqual(3);
    expect(done.snapped + done.empty + done.late).toBe(3);
  });
});

/**
 * The contract backend of the game. Reads the player's whole state through GameLens and maps it onto the same
 * `Save` shape the local game uses, so the UI does not care where the state lives; writes go out as transactions.
 * Here the chain is the source of truth: nothing in localStorage decides a catch, a balance or an unlock.
 */
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, encodeFunctionData, erc20Abi, formatEther, pad, parseAbi, parseEther, parseEventLogs, toHex, type Abi, type Address, type Hex, type TransactionReceipt } from 'viem';
import { bottlePoolAbi, fishingGameAbi, gameLensAbi, pearlExchangeAbi, reelJudgeAbi } from '../abi';
import { publicClient } from '../clients';
import { CHAIN_ID, LOCAL_GAME, deployment } from '../config';
import { greenOf, resolveCast, type CastOutcome, type ChainCatalog } from '../game/chainOutcome';
import { CAST_OF_SELECTOR, castNeedsFight, decodePlayerView, releaseOf, reelWindowOf, type GameRelease, type PlayerView } from '../game/release';
import { LOCATIONS, QUALITIES, SPECIALS, SPECIES, TUNING, BLEND_PRIZE } from '../game/content';
import { achievements } from '../game/progress';
import { freshSave } from '../game/save';
import { reconcile, type Prefs } from '../game/favorites';
import { tournamentScore } from '../game/tournament';
import type { FishInstance, Rarity, Save } from '../game/types';
import { state } from '../store';
import { LURES, RODS } from '../tackle/catalog';
import { fluentSend } from '../fluent';
import { friendlyError } from '../errors';
import { sendTx, TxError } from '../tx';
import { toast } from '../ui/toast';
import { loadPrefs, storePrefs, type PrefsScope } from './prefs';

const zero = '0x0000000000000000000000000000000000000000' as Address;
const game = { address: deployment?.game ?? zero, abi: fishingGameAbi } as const;
const lens = { address: deployment?.lens ?? zero, abi: gameLensAbi } as const;

const num = (wei: bigint): number => Number(formatEther(wei));

export interface Standing {
  address: Address;
  total: number;
}

/** Chain facts that do not fit the Save shape. */
export interface World {
  /**
   * The player's unresolved cast, if any. `fight`: a fish on it has to be reeled in, in one try, and is lost
   * otherwise (the game had a judge of the reel fight attached when the cast was made).
   */
  cast: { targetBlock: bigint; nonce: bigint; locationId: number; rod: number; lure: number; special: number; fight: boolean } | null;
  /** What the pending cast's outcome depends on besides the block hash (see game/chainOutcome.ts). */
  rolls: { blendWins: number; xp: bigint; specialsFound: number; dry: number[] };
  week: number;
  standings: Standing[];
  /** The player's past weeks, newest first. */
  history: { week: number; total: number }[];
  loaded: boolean;
  /** The BLEND → PEARL exchange, when one is deployed. Balances are of the BLEND token in the player's wallet. */
  blend: { balance: number; allowance: bigint; pearlPerBlend: number; paused: boolean } | null;
  /** The bottle as the contracts have it now: the prize, who may hook it, and how many are left to find. */
  bottle: { amount: number; chancePpm: number; minLevel: number; maxWins: number; dailyMax: number; today: number; left: number } | null;
  /** The owner has stopped new casts for a while (before a change of rules or of the game's code). Reeling in still works. */
  castingPaused: boolean;
  /**
   * The reel fight as the contracts have it. `on`: a judge is attached, so a fish hooked by a cast made now has to
   * be reeled in. `blocks`: how many blocks after its randomness block such a fish can still be landed.
   */
  fights: { on: boolean; blocks: number };
}

/** FishingGame.FIGHT_BLOCKS, until the lens has said it (checked against the contracts in `catalogMismatches`). */
export const FIGHT_BLOCKS = 600;

export const world: World = {
  cast: null,
  rolls: { blendWins: 0, xp: 0n, specialsFound: 0, dry: [] },
  week: 0,
  standings: [],
  history: [],
  loaded: false,
  blend: null,
  bottle: null,
  castingPaused: false,
  fights: { on: false, blocks: FIGHT_BLOCKS },
};

// ------------------------------------------------------------------ client-side preferences (not game state)

// Saved fish (the Trophy Room): this browser's, per chain, fish collection and account (play/prefs.ts). They
// guard the game's own Sell buttons; the contracts know nothing of them.
const scopeOf = (a: Address): PrefsScope => ({ chainId: CHAIN_ID, collection: deployment?.fish ?? zero, address: a });
/** Preferences the browser would not store (private mode, quota): kept for as long as the page is open. */
let unsaved: { address: string; prefs: Prefs } | null = null;
const prefsOf = (a: Address): Prefs => (unsaved?.address === a.toLowerCase() ? unsaved.prefs : loadPrefs(scopeOf(a)));
function keepPrefs(a: Address, prefs: Prefs): void {
  unsaved = storePrefs(scopeOf(a), prefs) ? null : { address: a.toLowerCase(), prefs };
}
/** The account whose keepnet the current save was read from. Preferences are only changed against a real read. */
let inventoryOf: string | null = null;
export const inventoryReadFor = (a: Address): boolean => inventoryOf === a.toLowerCase();
/** The view was emptied (signed out): what is on screen is no longer anybody's keepnet. */
export const forgetInventory = (): void => void (inventoryOf = null);

/**
 * Writes down the stars of `save`, which is the account's own view after a real read. Saved fish the view does
 * not hold are left as they were: that is for the next read to decide.
 */
export function rememberCollection(a: Address, save: Save): void {
  const here = new Set(save.fish.map((f) => f.id));
  const elsewhere = prefsOf(a).saved.filter((id) => !here.has(id));
  keepPrefs(a, { saved: [...elsewhere, ...save.fish.filter((f) => f.isFavorite).map((f) => f.id)] });
}
const LOC_KEY = 'onchain-fishing:location';
export function rememberLocation(id: number): void {
  try {
    localStorage.setItem(LOC_KEY, String(id));
  } catch {
    /* a convenience only */
  }
}
function recalledLocation(): number {
  try {
    return Number(localStorage.getItem(LOC_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------ reads

/**
 * The release of the game (game/release.ts), by its own answer about a cast. An upgrade goes one way, so the
 * latest one seen is kept for the life of the page; it is asked again with every read of the player, which is how
 * an open page notices an upgrade.
 */
let gameRelease: GameRelease = 3;
const castOfCall = (who: Address): { to: Address; data: Hex } => ({ to: game.address, data: `${CAST_OF_SELECTOR}${pad(who).slice(2)}` });
async function gameIsRelease004(): Promise<boolean> {
  if (gameRelease < 4) gameRelease = releaseOf((await publicClient.call(castOfCall(zero))).data);
  return gameRelease >= 4;
}

/** A call that the contract itself turned down (it has no such function, or it reverted): an answer, not an outage. */
const refused = (e: unknown): boolean => e instanceof BaseError && !!e.walk((x) => x instanceof ContractFunctionRevertedError || x instanceof ContractFunctionZeroDataError);

let lensReleasePromise: Promise<GameRelease> | null = null;
/**
 * The release the lens of this build was made for, which is the shape it answers in. A lens never changes, so the
 * answer is kept. Asked of the lens itself: one that knows fights says how long a fight may take. (Between an
 * upgrade of the game and the publishing of the page built for it, the page reads the new game through the old
 * lens: the game's release is then one ahead of the lens's.)
 */
function lensRelease(): Promise<GameRelease> {
  lensReleasePromise ??= publicClient
    .readContract({ ...lens, functionName: 'fightBlocks' })
    .then(
      (blocks): GameRelease => {
        world.fights.blocks = Number(blocks);
        return 5;
      },
      async (e): Promise<GameRelease> => {
        if (!refused(e)) throw e;
        return (await gameIsRelease004()) ? 4 : 3;
      },
    )
    .catch((e) => {
      lensReleasePromise = null;
      throw e;
    });
  return lensReleasePromise;
}

/** Whether a judge of the reel fight is attached to the game now. Only a lens that knows fights can say. */
async function fightsOn(): Promise<boolean> {
  if ((await lensRelease()) < 5) return false;
  return (await publicClient.readContract({ ...lens, functionName: 'reelJudge' })) !== zero;
}

/**
 * The lens's view of a player, read in the shape of the lens's release, and what the game itself says about the
 * player's cast: its release, and whether the cast has to be reeled in. That last word is not taken from the lens:
 * an older lens leaves it out, and settling such a cast the old way would lose the fish.
 */
async function readPlayerView(who: Address): Promise<{ v: PlayerView; fight: boolean }> {
  const [shape, own, answer] = await Promise.all([lensRelease(), publicClient.call(castOfCall(who)), publicClient.call({ to: lens.address, data: encodeFunctionData({ abi: gameLensAbi, functionName: 'playerView', args: [who] }) })]);
  if (!answer.data) throw new Error('the lens answered with nothing');
  const release = releaseOf(own.data);
  if (release > gameRelease) gameRelease = release;
  return { v: decodePlayerView(answer.data, shape), fight: castNeedsFight(own.data) };
}

/** Loads the connected player's state from the chain as a Save. Returns null when no wallet is connected. */
export async function loadChainSave(): Promise<Save | null> {
  const me = state.wallet?.address;
  if (!me) return null;
  const [view, keep, blend, bottle, judged] = await Promise.all([
    readPlayerView(me),
    publicClient.readContract({ ...lens, functionName: 'keepnet', args: [me] }),
    loadBlend(me),
    loadBottle(),
    // for the wording before a cast only: what a cast in the water needs is the cast's own word, read above
    fightsOn().catch(() => world.fights.on),
  ]);
  const v = view.v;
  world.blend = blend;
  world.bottle = bottle;
  world.fights.on = judged;
  const now = Date.now();
  const skew = now - Number(v.timestamp) * 1000;
  const p = v.p;
  const [ids, list, values] = keep;
  // The keepnet was read, so the stars can be held against it: a fish that was sold or transferred is no longer
  // saved and leaves the Trophy Room. A failed read never gets here, and so never empties the room.
  const kept = reconcile(prefsOf(me), ids.map((id) => id.toString()));
  if (kept.changed) keepPrefs(me, kept.prefs);
  if (kept.dropped.length) {
    const n = kept.dropped.length;
    toast(`${n === 1 ? 'A fish you saved is' : `${n} fish you saved are`} no longer in your keepnet, and left your Trophy Room`, 'info');
  }
  const favs = new Set(kept.prefs.saved);

  const fish: FishInstance[] = ids
    .map((id, i) => {
      const f = list[i];
      const sp = SPECIES[f.speciesId];
      const quality = QUALITIES[f.quality] ?? 'B';
      return {
        id: id.toString(),
        speciesId: f.speciesId,
        rarity: (sp?.rarity ?? 0) as Rarity,
        weight: f.weight,
        quality,
        locationId: f.spotId,
        caughtAt: Number(f.caughtAt) * 1000 + skew,
        sellPrice: num(values[i]),
        tournamentScore: sp ? tournamentScore(sp, f.weight, quality) : 0,
        isFavorite: favs.has(id.toString()),
        isSpecial: !!sp?.special,
      };
    })
    .sort((a, b) => b.caughtAt - a.caughtAt);

  const s = freshSave(now);
  s.pearl = num(v.pearl);
  s.blend = num(v.blendWon);
  s.blendWins = p.blendWins;
  s.xp = Number(p.xp);
  if (p.energyUpdatedAt === 0) {
    s.energy = TUNING.maxEnergy;
    s.energyAt = now;
  } else {
    s.energy = p.energy;
    s.energyAt = p.energyUpdatedAt * 1000 + skew;
  }
  // the header derives the next refill price from the number of refills today
  const refills = Math.max(0, Math.round(Math.log2(num(v.refillPrice) / TUNING.refillPrice)));
  s.refills = { day: Math.floor(now / 86_400_000), count: refills };
  s.rods = {};
  RODS.forEach((r, i) => {
    if (i === 0 || (p.rods >> i) & 1) s.rods[r.id] = { durability: v.rodDurability[i] ?? 0 };
  });
  s.lures = {};
  LURES.forEach((l, i) => {
    if ((v.lureCasts[i] ?? 0) > 0) s.lures[l.id] = { casts: v.lureCasts[i] };
  });
  s.equipped = { rod: RODS[p.rod]?.id ?? 'willow', lure: p.lure === 0 ? null : (LURES[p.lure - 1]?.id ?? null) };
  if (s.equipped.lure && !s.lures[s.equipped.lure]) s.equipped.lure = null;
  s.fish = fish;
  s.dex = {};
  v.dex.forEach((d, i) => {
    if (d.count > 0) s.dex[i] = { count: d.count, best: d.best, firstAt: 0 };
  });
  s.permanentUnlocks = LOCATIONS.filter((l) => l.unlock.type === 'start' || (p.unlocks >> l.id) & 1).map((l) => l.id);
  s.specialsFound = SPECIALS.filter((_, i) => (p.specialsFound >> i) & 1).map((x) => x.id);
  SPECIALS.forEach((x, i) => (s.dry[x.id] = v.dry[i] ?? 0));
  s.activeSpecial = p.activeSpecial === 0 ? null : (SPECIALS[p.activeSpecial - 1]?.id ?? null);
  const byLocation: Save['records']['byLocation'] = {};
  v.bestByLocation.forEach((r, i) => {
    if (r.weight > 0) byLocation[i] = { speciesId: r.speciesId, weight: r.weight, locationId: i, at: r.at * 1000 + skew };
  });
  const where = Object.values(byLocation).find((r) => r.weight === v.best.weight && r.speciesId === v.best.speciesId);
  s.records = {
    overall: v.best.weight > 0 ? { speciesId: v.best.speciesId, weight: v.best.weight, locationId: where?.locationId ?? 0, at: v.best.at * 1000 + skew } : null,
    byLocation,
  };
  const week = Number(v.week);
  s.weeks = {
    [week]: v.weekEntries.map((e) => ({ score: e.score, speciesId: e.speciesId, weight: e.weight, quality: QUALITIES[e.quality] ?? 'B', at: e.at * 1000 + skew })),
  };
  s.stats = { casts: p.casts, catches: p.catches, escaped: 0, sold: 0, earned: 0 };
  // claimed achievements: the contract's indices follow the order of achievements()
  const order = achievements(s).map((a) => a.id);
  s.claimed = order.filter((_, i) => (p.claimed >> i) & 1);
  const wanted = recalledLocation();
  s.location = s.permanentUnlocks.includes(wanted) ? wanted : 0;

  world.cast = v.cast.targetBlock === 0n ? null : { targetBlock: v.cast.targetBlock, nonce: v.cast.nonce, locationId: v.cast.locationId, rod: v.cast.rod, lure: v.cast.lure, special: v.cast.special, fight: view.fight };
  world.rolls = { blendWins: p.blendWins, xp: p.xp, specialsFound: p.specialsFound, dry: [...v.dry] };
  world.week = week;
  world.castingPaused = v.castingPaused;
  world.loaded = true;
  inventoryOf = me.toLowerCase();
  return s;
}

const bottles = deployment?.bottles ? ({ address: deployment.bottles, abi: bottlePoolAbi } as const) : null;

/** Reads the bottle pool: its rules, today's count and what is left. For the UI only: null when it cannot be read. */
async function loadBottle(): Promise<World['bottle']> {
  if (!bottles) return null;
  try {
    const head = await publicClient.getBlock();
    const [cfg, amount, minLevel, dailyMax, left, today] = await Promise.all([
      publicClient.readContract({ ...game, functionName: 'config' }),
      publicClient.readContract({ ...bottles, functionName: 'amount' }),
      publicClient.readContract({ ...bottles, functionName: 'minLevel' }),
      publicClient.readContract({ ...bottles, functionName: 'dailyMax' }),
      publicClient.readContract({ ...bottles, functionName: 'left' }),
      publicClient.readContract({ ...bottles, functionName: 'foundOnDay', args: [head.timestamp / 86_400n] }),
    ]);
    return { amount: num(amount), chancePpm: cfg[14], maxWins: cfg[15], minLevel, dailyMax, today: Number(today), left: Number(left) };
  } catch {
    return null;
  }
}

/**
 * Whether a bottle can bite at all: the game's chance on the contracts, the local rule otherwise. At zero the bottle
 * is switched off and the client says nothing about it.
 */
export const bottleOn = (): boolean => (LOCAL_GAME ? BLEND_PRIZE.chance > 0 : (world.bottle?.chancePpm ?? 0) > 0);

const exchange = deployment?.exchange && deployment.blend ? { address: deployment.exchange, token: deployment.blend } : null;
export const EXCHANGE_DEPLOYED = exchange !== null;

async function loadBlend(me: Address): Promise<World['blend']> {
  if (!exchange) return null;
  const token = { address: exchange.token, abi: erc20Abi } as const;
  const ex = { address: exchange.address, abi: pearlExchangeAbi } as const;
  const [balance, allowance, rate, paused] = await Promise.all([
    publicClient.readContract({ ...token, functionName: 'balanceOf', args: [me] }),
    publicClient.readContract({ ...token, functionName: 'allowance', args: [me, exchange.address] }),
    publicClient.readContract({ ...ex, functionName: 'pearlPerBlendUnit' }),
    publicClient.readContract({ ...ex, functionName: 'paused' }),
  ]);
  // both tokens have 18 decimals, so the unit rate is also "PEARL per BLEND"
  return { balance: num(balance), allowance, pearlPerBlend: Number(rate), paused };
}

/**
 * Buys PEARL for `blendAmount` BLEND: an approval for exactly that amount (when the current one is too small)
 * and the purchase, as one batch. Returns true when it went through.
 */
export async function buyPearlOnChain(blendAmount: string): Promise<boolean> {
  const w = state.wallet;
  if (!w || !exchange) return false;
  let amount: bigint;
  try {
    amount = parseEther(blendAmount.replace(',', '.').trim());
  } catch {
    toast('Enter an amount of BLEND', 'err');
    return false;
  }
  if (amount <= 0n) {
    toast('Enter an amount of BLEND', 'err');
    return false;
  }
  const label = 'Buy PEARL';
  try {
    const calls = [];
    if ((world.blend?.allowance ?? 0n) < amount) calls.push({ to: exchange.token, abi: erc20Abi, method: 'approve', args: [exchange.address, amount] });
    calls.push({ to: exchange.address, abi: pearlExchangeAbi, method: 'buyPearl', args: [amount] });
    const hash = await fluentSend(calls, label);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 300 });
    if (receipt.status !== 'success') throw new Error('Transaction reverted');
    toast(`${label}: done`, 'ok');
    return true;
  } catch (e) {
    console.warn('[tx] buy pearl failed', e);
    toast(`${label}: ${friendlyError(e)}`, 'err');
    return false;
  }
}

/** This week's table of real anglers and the player's own past weeks. */
export async function loadStandings(): Promise<void> {
  const week = BigInt(Math.floor(Date.now() / (7 * 86_400_000)));
  const me = state.wallet?.address;
  const [table, history] = await Promise.all([
    publicClient.readContract({ ...lens, functionName: 'weekStandings', args: [week, 0n, 200n] }),
    me ? publicClient.readContract({ ...lens, functionName: 'weekHistory', args: [me, 8n] }) : Promise.resolve(null),
  ]);
  world.standings = table[0].map((address, i) => ({ address, total: table[1][i] })).sort((a, b) => b.total - a.total);
  world.history = history ? history[0].map((w, i) => ({ week: Number(w), total: history[1][i] })).filter((h) => h.total > 0) : [];
}

/** Resolves once the chain head is past `target` (the cast's randomness block exists). */
export async function waitPastBlock(target: bigint, alive: () => boolean): Promise<void> {
  while (alive()) {
    try {
      if ((await publicClient.getBlockNumber({ cacheTime: 0 })) > target) return;
    } catch {
      /* a flaky RPC read: try again */
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}

// ------------------------------------------------------------------ predicting the pending cast

let catalogPromise: Promise<ChainCatalog> | null = null;
/** The contracts' own catalog and config, read once: the prediction must use exactly what the contract uses. */
function chainCatalog(): Promise<ChainCatalog> {
  catalogPromise ??= (async () => {
    const [c, cfg] = await Promise.all([publicClient.readContract({ ...lens, functionName: 'catalog' }), publicClient.readContract({ ...game, functionName: 'config' })]);
    return {
      config: { qualityPerCatch: cfg[11], qualityPerRarity: cfg[12], blendChancePpm: cfg[14], blendMaxWins: cfg[15] },
      locations: c.locations.map((l) => ({ special: l.special, speciesIds: [...l.speciesIds], weights: [...l.weights] })),
      species: c.species.map((s, i) => ({ rarity: s.rarity, minWeight: s.minWeight, maxWeight: s.maxWeight, hidden: c.hidden[i] })),
      specials: c.specials.map((s) => ({ speciesId: s.speciesId, chancePpm: s.chancePpm, pity: s.pity })),
      // the judge of the reel fight has its own copy of these; `catalogMismatches` holds the two together
      tiers: LOCATIONS.map((l) => l.tier),
    };
  })().catch((e) => {
    catalogPromise = null;
    throw e;
  });
  return catalogPromise;
}

/** The EVM itself serves the hashes of the 256 most recent blocks. */
const BLOCKHASH_WINDOW = 256n;
/**
 * EIP-2935: the chain's own record of its last 8,191 block hashes, at the same address on every chain that has it.
 * The game asks it once the EVM's answer is gone (FishingGame._hashOf), which is what gives a player more than two
 * hours to reel a cast in on Fluent instead of a few minutes.
 */
const BLOCK_HISTORY = '0x0000F90827F1C53a10cb7A02335B175320002935' as const;
/** The settlement lands in a later block than the one this page saw, so a hash is called readable with a margin. */
const WINDOW_MARGIN = 2n;

/** The history contract's answer for a block: its hash, or null when it has none (too old, or no such contract). */
async function historyHash(block: bigint): Promise<Hex | null> {
  try {
    const { data } = await publicClient.call({ to: BLOCK_HISTORY, data: pad(toHex(block)) });
    return data && data.length === 66 && !/^0x0+$/.test(data) ? data : null;
  } catch {
    return null; // it reverts for a block outside its window
  }
}

let reelWindowPromise: Promise<bigint> | null = null;
/**
 * How many blocks after its randomness block a cast can still be reeled in here: 8,191 when the game asks the
 * chain's history (release 004 on) and the chain has one, 256 otherwise.
 */
function reelWindow(head: bigint): Promise<bigint> {
  reelWindowPromise ??= (async () => {
    // a block the EVM has already forgotten, where there is one; the history must answer for it
    const probe = head > BLOCKHASH_WINDOW + 50n ? head - BLOCKHASH_WINDOW - 50n : head > 1n ? head - 1n : 0n;
    const [is004, hash] = await Promise.all([gameIsRelease004(), historyHash(probe)]);
    const window = reelWindowOf(is004, hash !== null);
    // the short answer is not kept: the upgrade to release 004 lengthens it under an open page
    if (window === BLOCKHASH_WINDOW) reelWindowPromise = null;
    return window;
  })().catch(() => {
    reelWindowPromise = null;
    return BLOCKHASH_WINDOW;
  });
  return reelWindowPromise;
}

/** The hash the contract will read for `target` when a reel sent now is mined, or null when it will find none. */
async function readableHash(target: bigint, head: bigint): Promise<Hex | null> {
  const age = head - target;
  if (age < BLOCKHASH_WINDOW - WINDOW_MARGIN) return (await publicClient.getBlock({ blockNumber: target })).hash;
  // past the EVM's own reach only a game that asks the history finds a hash
  if (age >= (await reelWindow(head)) - WINDOW_MARGIN) return null;
  // asked of the history itself, not of the node's block index: the contract will read exactly this
  return historyHash(target);
}

/**
 * A fish that was on the line and no longer is: the cast had to be reeled in (`fight`) and the time for it is
 * over. Nothing can land it now; whoever settles the cast next only takes it out of the water.
 */
export type Preview = CastOutcome | { kind: 'escaped'; speciesId: number };

/** Blocks left in which a fish on the player's line can still be landed: the reel has to be mined by then. */
export async function fightBlocksLeft(): Promise<number> {
  if (!world.cast) return 0;
  const head = await publicClient.getBlockNumber({ cacheTime: 0 });
  return Number(world.cast.targetBlock + BigInt(world.fights.blocks) - head);
}

/**
 * What the player's pending cast will be when it is settled, or null if its block is not there yet.
 * Presentation only: the settlement transaction computes the real result (see game/chainOutcome.ts).
 * Throws on RPC trouble; the caller then falls back to settling first and showing the result after, or, for a
 * cast that has to be reeled in, asks again: such a cast is never settled blind.
 */
export async function previewCast(): Promise<Preview | null> {
  const me = state.wallet?.address;
  const c = world.cast;
  if (!me || !c) return null;
  const head = await publicClient.getBlockNumber({ cacheTime: 0 });
  if (head <= c.targetBlock) return null;
  const [catalog, blockHash, lo, poolOpen, bottleAmount] = await Promise.all([
    chainCatalog(),
    readableHash(c.targetBlock, head),
    publicClient.readContract({ ...game, functionName: 'loadout', args: [BigInt(c.rod), BigInt(c.lure), BigInt(c.special), BigInt(c.locationId)] }),
    // asked now, as the settlement will ask: the player's XP cannot change while a cast is out, the pool can
    bottles ? publicClient.readContract({ ...bottles, functionName: 'open', args: [world.rolls.xp] }) : Promise.resolve(false),
    bottles ? publicClient.readContract({ ...bottles, functionName: 'amount' }) : Promise.resolve(0n),
  ]);
  const out = resolveCast(catalog, {
    blockHash,
    player: me,
    game: game.address,
    nonce: c.nonce,
    locationId: c.locationId,
    loadout: { rodCatch: Number(lo[0]), biteBps: Number(lo[1]), rarity: Number(lo[2]), weight: Number(lo[3]), hiddenMult: Number(lo[4]) },
    bottleOpen: poolOpen && world.rolls.blendWins < catalog.config.blendMaxWins,
    bottleAmount: num(bottleAmount),
    specialsFound: world.rolls.specialsFound,
    dry: world.rolls.dry,
  });
  if (c.fight && out.kind === 'caught' && head > c.targetBlock + BigInt(world.fights.blocks)) return { kind: 'escaped', speciesId: out.speciesId };
  return out;
}

/** Blocks left before the pending cast's randomness is out of the contract's reach. */
export async function blocksUntilExpiry(): Promise<number> {
  if (!world.cast) return 0;
  const head = await publicClient.getBlockNumber({ cacheTime: 0 });
  return Number(world.cast.targetBlock + (await reelWindow(head)) - head);
}

// ------------------------------------------------------------------ writes

/** A write to the game contract. Argument types are checked by the simulation before anything is sent. */
export interface GameCall {
  functionName: string;
  args: readonly unknown[];
  /** For a function the current ABI no longer has (`reel()` of the releases before fights were checked). */
  abi?: Abi;
}

/** The game's ABI as releases up to 004 have it where it differs: `reel` takes nothing. Errors and events as now. */
const releasedReelAbi = [...parseAbi(['function reel()']), ...fishingGameAbi.filter((x) => !(x.type === 'function' && x.name === 'reel'))] as Abi;

/**
 * The player's own settlement of their cast, on whichever release the chain runs. `recording` is the reel fight
 * (game/fight.ts, `packInputs`): a cast that has to be reeled in lands its fish for a recording that lands it and
 * loses it for any other, the empty one included. A cast that needs no fight ignores it.
 */
export function reelCall(recording: Hex = '0x'): GameCall {
  return gameRelease >= 5 ? { functionName: 'reel', args: [recording] } : { abi: releasedReelAbi, functionName: 'reel', args: [] };
}

/**
 * Settles the player's cast the way anyone may: with no recording. It takes a bottle or an empty hook out of the
 * water; with a fish still fighting on the line the game refuses (`FishOn`) and nothing is lost.
 */
export const haulCall = (me: Address): GameCall => ({ functionName: 'reelFor', args: [me] });

/** Sends one game transaction. Returns the receipt, or undefined when it failed (the error is already toasted). */
export async function tx(label: string, request: GameCall, quiet = false): Promise<TransactionReceipt | undefined> {
  const w = state.wallet;
  if (!w) {
    toast('Connect with Fluent to play', 'info');
    return undefined;
  }
  try {
    return await sendTx(w, label, { ...game, ...request } as never, { quiet });
  } catch (e) {
    if (!(e instanceof TxError)) throw e;
    if (quiet) toast(`${label}: ${e.message}`, 'err');
    return undefined;
  }
}

export type ReelOutcome =
  | { kind: 'missed' }
  | { kind: 'expired' }
  /** A fish was on the line and got away: the fight was lost, never played, or took too long. Nothing was minted. */
  | { kind: 'escaped'; speciesId: number; locationId: number }
  | { kind: 'bottle'; amount: number }
  | { kind: 'caught'; fishId: string; speciesId: number; weight: number; quality: number; locationId: number; score: number; special: boolean; unlocked: number[]; counted: boolean };

/** What a receipt says happened to the player's cast, if it resolved one. */
export function outcomeOf(receipt: TransactionReceipt, me: Address): ReelOutcome | null {
  const logs = parseEventLogs({ abi: fishingGameAbi, logs: receipt.logs }).filter((l) => 'player' in l.args && (l.args.player as string).toLowerCase() === me.toLowerCase());
  const unlocked: number[] = [];
  let counted = false;
  let out: ReelOutcome | null = null;
  for (const l of logs) {
    if (l.eventName === 'LocationUnlocked') unlocked.push(l.args.locationId);
    else if (l.eventName === 'WeekScore') counted = true;
    else if (l.eventName === 'Missed') out = { kind: 'missed' };
    else if (l.eventName === 'CastExpired') out = { kind: 'expired' };
    else if (l.eventName === 'Escaped') out = { kind: 'escaped', speciesId: l.args.speciesId, locationId: l.args.locationId };
    else if (l.eventName === 'BottleFound') out = { kind: 'bottle', amount: num(l.args.amount) };
    else if (l.eventName === 'Caught') {
      const a = l.args;
      out = { kind: 'caught', fishId: a.fishId.toString(), speciesId: a.speciesId, weight: a.weight, quality: a.quality, locationId: a.locationId, score: a.score, special: a.special, unlocked, counted };
    }
  }
  if (out?.kind === 'caught') out.counted = counted;
  return out;
}

// ------------------------------------------------------------------ catalog check

/**
 * The client shows names, art and numbers from its own catalog, and the contract plays by its own copy.
 * This compares the two and returns what differs, so a drifted number is noticed instead of quietly lying.
 */
export async function catalogMismatches(): Promise<string[]> {
  const c = await publicClient.readContract({ ...lens, functionName: 'catalog' });
  const out: string[] = [];
  const check = (what: string, chain: number | bigint | boolean, local: number | boolean): void => {
    if (Number(chain) !== Number(local)) out.push(`${what}: chain ${chain}, client ${local}`);
  };
  check('rods', c.rods.length, RODS.length);
  check('lures', c.lures.length, LURES.length);
  check('locations', c.locations.length, LOCATIONS.length);
  check('species', c.species.length, SPECIES.length);
  check('specials', c.specials.length, SPECIALS.length);
  [...RODS.map((r, i) => [r, c.rods[i]] as const), ...LURES.map((l, i) => [l, c.lures[i]] as const)].forEach(([item, on]) => {
    if (!on) return;
    check(`${item.name} price`, num(on.price), item.price);
    check(`${item.name} wear`, on.wear, item.wear);
    check(`${item.name} repair`, on.repair, item.repair ?? 0);
    check(`${item.name} catch`, on.catchPts, item.base.catch ?? 0);
    check(`${item.name} rarity`, on.rarity, item.base.rarity ?? 0);
    check(`${item.name} weight`, on.weight, item.base.weight ?? 0);
    const mask = (item.spot?.spots ?? []).reduce((m, i) => m | (1 << i), 0);
    check(`${item.name} bonus locations`, on.a.mask, mask);
    check(`${item.name} bonus catch`, on.a.catchPts, item.spot?.catch ?? 0);
    check(`${item.name} bonus rarity`, on.a.rarity, item.spot?.rarity ?? 0);
    check(`${item.name} bonus weight`, on.a.weight, item.spot?.weight ?? 0);
  });
  SPECIES.forEach((sp, i) => {
    const on = c.species[i];
    if (!on) return;
    if (on.name !== sp.name) out.push(`species ${i}: chain ${on.name}, client ${sp.name}`);
    check(`${sp.name} rarity`, on.rarity, sp.rarity);
    check(`${sp.name} min weight`, on.minWeight, sp.minWeight);
    check(`${sp.name} max weight`, on.maxWeight, sp.maxWeight);
    check(`${sp.name} price`, num(on.basePrice), sp.basePrice);
    check(`${sp.name} hidden`, c.hidden[i], !!sp.hidden);
  });
  LOCATIONS.forEach((loc, i) => {
    const on = c.locations[i];
    if (!on) return;
    check(`${loc.name} energy`, on.energyCost, loc.energyCost);
    check(`${loc.name} pool size`, on.speciesIds.length, loc.pool.length);
    loc.pool.forEach(([id, w], k) => {
      check(`${loc.name} pool[${k}] species`, on.speciesIds[k] ?? -1, id);
      check(`${loc.name} pool[${k}] weight`, on.weights[k] ?? -1, w);
    });
    const special = loc.special ? SPECIALS.findIndex((x) => x.id === loc.special) + 1 : 0;
    check(`${loc.name} special`, on.special, special);
  });
  SPECIALS.forEach((sp, i) => {
    const on = c.specials[i];
    if (!on) return;
    check(`${sp.name} species`, on.speciesId, sp.speciesId);
    check(`${sp.name} chance`, on.chancePpm, Math.round(sp.chance * 1_000_000));
    check(`${sp.name} pity`, on.pity, sp.pity);
  });
  const cfg = await publicClient.readContract({ ...game, functionName: 'config' });
  // [maxEnergy, energyRegenSeconds, revealDelay, baseBiteBps, maxBiteBps, …, blendAmount (unused), blendChancePpm, blendMaxWins]
  check('max energy', cfg[0], TUNING.maxEnergy);
  check('energy regen seconds', cfg[1], TUNING.energyRegenSeconds);
  check('base bite', cfg[3], TUNING.baseBite * 100);
  check('refill price', num(cfg[8]), TUNING.refillPrice);
  check('BLEND chance', cfg[14], Math.round(BLEND_PRIZE.chance * 1_000_000));
  check('BLEND bottles per player', cfg[15], BLEND_PRIZE.maxWins);
  if (bottles) {
    check('BLEND amount', num(await publicClient.readContract({ ...bottles, functionName: 'amount' })), BLEND_PRIZE.amount);
    check('BLEND level', await publicClient.readContract({ ...bottles, functionName: 'minLevel' }), BLEND_PRIZE.minLevel);
  }
  // the reel fight: the page plays the fight the judge will replay, so the two must set it the same way
  if ((await lensRelease()) >= 5) {
    check('blocks for a fight', await publicClient.readContract({ ...lens, functionName: 'fightBlocks' }), FIGHT_BLOCKS);
    const judge = await publicClient.readContract({ ...lens, functionName: 'reelJudge' });
    if (judge !== zero) {
      const j = { address: judge, abi: reelJudgeAbi } as const;
      const tiers = await publicClient.readContract({ ...j, functionName: 'tiers' });
      LOCATIONS.forEach((loc, i) => check(`${loc.name} fight tier`, (tiers >> BigInt(i * 4)) & 15n, loc.tier));
      for (const rodCatch of [-8n, 0n, 6n, 40n]) {
        const [, , green] = await publicClient.readContract({ ...j, functionName: 'fightOf', args: [1n, 0n, 0n, rodCatch] });
        check(`green band at rod catch ${rodCatch}`, green, greenOf(Number(rodCatch)));
      }
    }
  }
  return out;
}

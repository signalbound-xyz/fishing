/**
 * The season hunt contract (contracts/src/SeasonHunt.sol), as the client sees it: the seasons, the player's
 * seasonal casts and what became of them, and the transactions (a seasonal cast, recording a hit, claiming).
 *
 * Nothing here decides anything. A seasonal cast is one transaction to the hunt, which makes an ordinary cast in
 * the game for the player. Whether that cast hooked the season's fish is asked of the contract (`outcome`, a
 * read) once the cast's randomness exists; only a hit needs a second transaction (`settle`), and anybody may
 * send it. The order of the casts on the chain, not the order of these transactions, decides who wins.
 */
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, erc20Abi, formatEther, parseAbi, parseEventLogs, toEventSelector, pad, type AbiEvent, type Address, type Hex, type TransactionReceipt } from 'viem';
import { seasonHuntAbi } from '../abi';
import { publicClient } from '../clients';
import { CHAIN_ID, deployment } from '../config';
import { friendlyError, revertName } from '../errors';
import { fluentSend } from '../fluent';
import { SPECIES } from '../game/content';
import { HUNT_STATUS, chanceOf, drandRound, drandTime, idsOf, levelOfXp, logRanges, type DrandNet, type HuntAttempt, type HuntSeason, type HuntStatus } from '../game/hunt';
import { currentWeek, finalAt, groupWeeks, statusAt, type WeekEntry, type WeekView } from '../game/week';
import { weeks as weekRegistry } from '../generated/weeks';
import type { Save } from '../game/types';
import { emit, state } from '../store';
import { LURES, RODS } from '../tackle/catalog';
import { sendTx, TxError } from '../tx';
import { toast } from '../ui/toast';

const zero = '0x0000000000000000000000000000000000000000' as Address;
export const HUNT_DEPLOYED = !!deployment?.seasonHunt;
const hunt = { address: deployment?.seasonHunt ?? zero, abi: seasonHuntAbi } as const;
export type { HuntAttempt, HuntSeason };

/**
 * A preview of the page with made-up seasons, on a development server only: `?huntDemo=monday` (or `upcoming`,
 * `early`, `midweek`, `friday`, `finalizing`, `over`). Nothing is read from the hunt contract and nothing is sent
 * to it. The production build has no such switch.
 */
const DEMO: string | null = import.meta.env.DEV && typeof location !== 'undefined' ? new URLSearchParams(location.search).get('huntDemo') : null;
export const HUNT_DEMO = !!DEMO;

const beaconAbi = parseAbi([
  'function scheme() view returns (string)',
  'function unbiasable() view returns (bool)',
  'function chainHash() view returns (bytes32)',
  'function genesis() view returns (uint256)',
  'function period() view returns (uint256)',
  'function margin() view returns (uint256)',
]);

/** Where the hunt takes its randomness from. */
export interface Beacon {
  scheme: 'blockhash' | 'drand' | string;
  /** False: whoever builds the blocks could choose it. Such a hunt is a prototype. */
  unbiasable: boolean;
  drand: (DrandNet & { chainHash: string }) | null;
}

/** A seasonal cast of this player whose result is not known or not recorded yet. Kept across reloads. */
export interface PendingAttempt {
  season: number;
  seq: number;
  player: Address;
  /** The cast's block, as a decimal string (it is stored as JSON). */
  block: string;
  time: number;
  /** Unix seconds after which a hit can no longer be recorded. */
  deadline: number;
  /** 'waiting': the randomness is not there yet. 'hit': it hooked the target and is not recorded yet. */
  state: 'waiting' | 'hit';
  proof?: Hex;
}

export type AttemptResult = 'miss' | 'recorded' | 'beaten' | 'lost' | 'late';
/** What became of the player's latest seasonal cast, for the line under the Cast button. */
export interface LastAttempt {
  season: number;
  seq: number;
  result: AttemptResult;
  /** Whose cast it was: another account signed in on this page is not told about it. */
  player: Address;
}

export const hunts = {
  list: [] as HuntSeason[],
  /** Seasons the contract holds; `list` has the newest of them. */
  total: 0,
  /** The weekly seasons of this network: which seasons are the three hunts of each (src/generated/weeks.ts). */
  entries: (weekRegistry[String(CHAIN_ID)] ?? []) as readonly WeekEntry[],
  loaded: false,
  failed: false,
  /** Chain time minus this device's time, in seconds. */
  skew: 0,
  beacon: null as Beacon | null,
  /** The player wants their casts to count for the season. */
  armed: false,
  pending: [] as PendingAttempt[],
  last: null as LastAttempt | null,
  /** A hunt transaction is on its way: 'claim', 'record', 'trophy', 'reclaim' or 'ticket'. */
  busy: null as string | null,
  /** Bumped on every change, for render signatures. */
  rev: 0,
};

// a week is three seasons: a page holds the weeks of several months
const PAGE = 60;
let shown = PAGE;

/** The chain's clock, unix seconds. */
export const huntNow = (): number => Date.now() / 1000 + hunts.skew;

function changed(): void {
  hunts.rev++;
  emit();
}

// ------------------------------------------------------------------ what is kept in the browser

const ARMED_KEY = 'onchain-fishing:hunt-armed';
const pendingKey = (): string => `onchain-fishing:hunt-attempts:${hunt.address.toLowerCase()}`;

function recall(): void {
  try {
    hunts.armed = localStorage.getItem(ARMED_KEY) === '1';
    const raw: unknown = JSON.parse(localStorage.getItem(pendingKey()) ?? '[]');
    if (!Array.isArray(raw)) return;
    hunts.pending = raw.filter(
      (p): p is PendingAttempt => !!p && typeof p === 'object' && typeof p.season === 'number' && typeof p.seq === 'number' && typeof p.player === 'string' && typeof p.block === 'string' && typeof p.time === 'number' && typeof p.deadline === 'number' && (p.state === 'waiting' || p.state === 'hit'),
    );
  } catch {
    /* nothing remembered: attempts are found again on the chain (recoverAttempts) */
  }
}

function remember(): void {
  try {
    localStorage.setItem(pendingKey(), JSON.stringify(hunts.pending.slice(-60)));
  } catch {
    /* storage is blocked: the attempts of this visit are still watched */
  }
}

export function armHunt(on: boolean): void {
  hunts.armed = on;
  try {
    localStorage.setItem(ARMED_KEY, on ? '1' : '0');
  } catch {
    /* a remembered switch is a convenience only */
  }
  changed();
}

// ------------------------------------------------------------------ reading

/** A season's state at this moment: the contract's status, moved on by the clock between reads. */
export const statusNow = (s: HuntSeason, now = huntNow()): HuntStatus => statusAt(s, now);

/** Nothing can change who won any more. */
export const isFinal = (s: HuntSeason, now = huntNow()): boolean => finalAt(s, now);

/** The seasons as the page shows them: grouped into weekly seasons, newest first (game/week.ts). */
export const weeksNow = (now = huntNow()): WeekView<HuntSeason>[] => groupWeeks(hunts.entries, hunts.list, now);

/** The weekly season the page opens on. */
export const weekNow = (now = huntNow()): WeekView<HuntSeason> | null => currentWeek(weeksNow(now), now);

let beaconRead: Promise<void> | null = null;
function readBeacon(): Promise<void> {
  beaconRead ??= (async () => {
    const address = await publicClient.readContract({ ...hunt, functionName: 'beacon' });
    const b = { address, abi: beaconAbi } as const;
    const [scheme, unbiasable] = await Promise.all([publicClient.readContract({ ...b, functionName: 'scheme' }), publicClient.readContract({ ...b, functionName: 'unbiasable' })]);
    let drand: Beacon['drand'] = null;
    if (scheme === 'drand') {
      const [chainHash, genesis, period, margin] = await Promise.all([
        publicClient.readContract({ ...b, functionName: 'chainHash' }),
        publicClient.readContract({ ...b, functionName: 'genesis' }),
        publicClient.readContract({ ...b, functionName: 'period' }),
        publicClient.readContract({ ...b, functionName: 'margin' }),
      ]);
      drand = { chainHash: chainHash.slice(2), genesis: Number(genesis), period: Number(period), margin: Number(margin) };
    }
    hunts.beacon = { scheme, unbiasable, drand };
  })().catch((e) => {
    beaconRead = null;
    throw e;
  });
  return beaconRead;
}

const lureOf = (recorded: number): number | null => (recorded === 0 ? null : recorded - 1);

/**
 * False once the hunt has answered that it has no tickets: the first release of the contract, where every season
 * is free. Null until it was asked.
 */
let sellsTickets: boolean | null = null;

/**
 * The ticket of each season in `ids` for `me`: its price and whether `me` holds it. A hunt without tickets is
 * asked once and then left alone. A read that fails for another reason leaves the seasons as they were read last
 * (free, the first time): a cast without a ticket is refused by the contract, in words, and costs nothing.
 */
async function readTickets(me: Address, ids: number[]): Promise<Map<number, { wei: bigint; held: boolean }> | null> {
  if (sellsTickets === false || ids.length === 0) return null;
  try {
    const [prices, held] = await publicClient.readContract({ ...hunt, functionName: 'tickets', args: [me, ids.map((id) => BigInt(id))] });
    sellsTickets = true;
    return new Map(ids.map((id, i) => [id, { wei: prices[i], held: held[i] }]));
  } catch (e) {
    const refused = e instanceof BaseError && !!e.walk((x) => x instanceof ContractFunctionRevertedError || x instanceof ContractFunctionZeroDataError);
    if (refused && sellsTickets === null) sellsTickets = false;
    else console.warn('[hunt] could not read the season tickets', e);
    return null;
  }
}

export async function loadHunts(): Promise<void> {
  if (!HUNT_DEPLOYED) return;
  const me = state.wallet?.address ?? zero;
  if (DEMO) {
    const demo = (await import('../game/fixtures/weekDemo')).demoWeeks(DEMO, Date.now() / 1000, state.wallet?.address ?? null);
    Object.assign(hunts, { list: demo.seasons, entries: demo.entries, total: demo.seasons.length, loaded: true, failed: false, skew: 0, beacon: { scheme: 'drand', unbiasable: true, drand: null } });
    return changed();
  }
  try {
    const [[views, total, time]] = await Promise.all([publicClient.readContract({ ...hunt, functionName: 'list', args: [me, 0n, BigInt(shown)] }), readBeacon()]);
    const tickets = await readTickets(
      me,
      views.map((v) => Number(v.id)),
    );
    const before = new Map(hunts.list.map((s) => [s.id, s]));
    hunts.skew = Number(time) - Date.now() / 1000;
    hunts.total = Number(total);
    hunts.list = views.map((v) => {
      const s = v.season;
      const r = s.rules;
      const funded = s.sponsor !== zero;
      const was = before.get(Number(v.id));
      const ticket = tickets?.get(Number(v.id)) ?? (tickets || !was ? { wei: 0n, held: false } : { wei: was.ticketWei, held: was.hasTicket });
      return {
        id: Number(v.id),
        name: r.name,
        description: r.description,
        start: r.start,
        end: r.end,
        speciesId: r.speciesId,
        waters: idsOf(r.waters),
        rods: idsOf(r.rods),
        minLevel: r.minLevel,
        dailyAttempts: r.dailyAttempts,
        settleWindow: r.settleWindow,
        odds: { baseChance: r.baseChance, maxBonus: r.maxBonus, rodBonus: [...r.rodBonus], lureBonus: [...r.lureBonus], waterBonus: [...r.waterBonus] },
        prize: Number(formatEther(r.prize)),
        sponsor: funded ? s.sponsor : null,
        status: HUNT_STATUS[v.status] ?? 'cancelled',
        finalAt: Number(v.finalAt),
        attempts: Number(s.attempts),
        winner: s.hooked ? { player: v.winner.player, seq: Number(s.winnerSeq), blockNumber: BigInt(v.winner.blockNumber), time: v.winner.time, rod: v.winner.rod, lure: lureOf(v.winner.lure), water: v.winner.water } : null,
        paid: s.paid,
        returned: s.returned,
        trophyId: s.trophyId,
        attemptsLeft: Number(v.attemptsLeft),
        ticket: Number(formatEther(ticket.wei)),
        ticketWei: ticket.wei,
        hasTicket: ticket.held,
      };
    });
    hunts.loaded = true;
    hunts.failed = false;
  } catch (e) {
    console.warn('[hunt] could not read the seasons', e);
    hunts.failed = true;
  }
  changed();
}

/** Older seasons: the next page of the history. */
export function showMoreHunts(): Promise<void> {
  shown += PAGE;
  return loadHunts();
}

/**
 * The fish that are season trophies, by id, as far as the page has read the seasons. The game does not buy a
 * trophy (`TrophyNotForSale`): the Sell buttons leave these out, so that one trophy does not fail a whole sale.
 */
export const trophyIds = (): Set<string> => new Set(hunts.list.filter((s) => s.trophyId > 0n).map((s) => s.trophyId.toString()));

/** The season that takes casts right now, if any. */
export const activeHunt = (): HuntSeason | null => hunts.list.find((s) => statusNow(s) === 'active') ?? null;

// ------------------------------------------------------------------ the player's tackle in a season

/** The rod and the lure on the player's line, as the contracts number them. */
export function tackleOf(save: Save): { rod: number; lure: number | null } {
  const rod = Math.max(0, RODS.findIndex((r) => r.id === save.equipped.rod));
  const lure = save.equipped.lure ? LURES.findIndex((l) => l.id === save.equipped.lure) : -1;
  return { rod, lure: lure < 0 ? null : lure };
}

/** The chance of the player's next cast at `water` in season `s`, in billionths. */
export function myChance(s: HuntSeason, save: Save, water = save.location): number {
  const t = tackleOf(save);
  return chanceOf(s.odds, t.rod, t.lure, water);
}

/** Why a cast at `water` cannot count for season `s` right now, or null when it can. */
export function huntBlocker(s: HuntSeason, save: Save, water = save.location): string | null {
  const fish = SPECIES[s.speciesId]?.name ?? 'season’s fish';
  const st = statusNow(s);
  if (st === 'upcoming') return 'The season has not started yet';
  if (st !== 'active') return 'The season is not taking casts any more';
  if (!s.waters.includes(water)) return `The ${fish} is not hunted in this water`;
  if (s.rods.length > 0 && !s.rods.includes(tackleOf(save).rod)) return `This season is fished with: ${s.rods.map((r) => RODS[r]?.name ?? `rod ${r}`).join(', ')}`;
  if (s.minLevel > 1 && levelOfXp(save.xp) < s.minLevel) return `This season starts at level ${s.minLevel}`;
  if (needsTicket(s)) return `This season is fished with a ticket: ${ticketText(s)}, once`;
  if (s.attemptsLeft <= 0) return 'No seasonal casts left today: they return at midnight UTC';
  return null;
}

/** The season asks for a ticket and the connected player does not hold it. */
export const needsTicket = (s: HuntSeason): boolean => s.ticket > 0 && !s.hasTicket;

/** `250 PEARL`. */
export const ticketText = (s: HuntSeason): string => `${s.ticket.toLocaleString('en-US', { maximumFractionDigits: 2 })} PEARL`;

/**
 * Why the connected player cannot buy the ticket of `s` right now, or null when they can. The contract sells a
 * ticket only to a wallet that could cast: the season is running and the wallet has its level.
 */
export function ticketBlocker(s: HuntSeason, save: Save): string | null {
  if (!needsTicket(s)) return 'There is no ticket to buy';
  const st = statusNow(s);
  if (st === 'upcoming') return 'Tickets are sold once the season has started';
  if (st !== 'active') return 'The season is not taking casts any more';
  if (s.minLevel > 1 && levelOfXp(save.xp) < s.minLevel) return `This season starts at level ${s.minLevel}`;
  if (save.pearl < s.ticket) return `Not enough PEARL: the ticket is ${ticketText(s)}`;
  return null;
}

/** The season the next cast at the player's water counts for: the player armed the hunt and nothing is in the way. */
export function huntCastFor(save: Save): HuntSeason | null {
  if (!HUNT_DEPLOYED || DEMO || !hunts.armed || !state.wallet) return null;
  const s = activeHunt();
  return s && huntBlocker(s, save) === null ? s : null;
}

// ------------------------------------------------------------------ writes

async function write(label: string, functionName: 'cast' | 'settle' | 'claim' | 'mintTrophy' | 'reclaim', args: readonly unknown[]): Promise<TransactionReceipt | undefined> {
  const w = state.wallet;
  if (!w) {
    toast('Connect with Fluent to play', 'info');
    return undefined;
  }
  if (DEMO) {
    toast('This is a preview of the page: nothing is sent to the contract.', 'info');
    return undefined;
  }
  try {
    return await sendTx(w, label, { ...hunt, functionName, args } as never, { quiet: true });
  } catch (e) {
    if (!(e instanceof TxError)) throw e;
    toast(`${label}: ${e.message}`, 'err');
    return undefined;
  }
}

/**
 * A seasonal cast: the hunt makes an ordinary cast in the game for the player (the receipt carries the game's
 * own events, so the pond goes on exactly as after `game.cast`) and numbers it as an attempt at the target.
 */
export async function castForHunt(s: HuntSeason, water: number): Promise<TransactionReceipt | undefined> {
  const me = state.wallet?.address;
  const receipt = await write(`Season cast · ${s.name}`, 'cast', [BigInt(s.id), water]);
  if (!receipt || !me) return receipt;
  try {
    const [ev] = parseEventLogs({ abi: seasonHuntAbi, logs: receipt.logs, eventName: 'SeasonCast' });
    if (ev) {
      const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
      const time = Number(block.timestamp);
      track({ season: s.id, seq: Number(ev.args.seq), player: me, block: receipt.blockNumber.toString(), time, deadline: time + s.settleWindow, state: 'waiting' });
      s.attemptsLeft = Math.max(0, s.attemptsLeft - 1);
      s.attempts++;
      changed();
    }
  } catch (e) {
    // the cast is made either way; the attempt is found again on the chain
    console.warn('[hunt] could not read the attempt from the receipt', e);
    void recoverAttempts();
  }
  return receipt;
}

/**
 * Buys the season's ticket: an approval of PEARL for exactly its price (when the current one is too small) and the
 * purchase, signed together. The PEARL is burned by the hunt: nobody receives it, and it is not returned.
 */
async function buyTicket(s: HuntSeason): Promise<TransactionReceipt | undefined> {
  const w = state.wallet;
  if (!w || !deployment) {
    toast('Connect with Fluent to play', 'info');
    return undefined;
  }
  if (DEMO) {
    toast('This is a preview of the page: nothing is sent to the contract.', 'info');
    return undefined;
  }
  const label = `Season ticket · ${s.name}`;
  try {
    const pearl = { address: deployment.pearl, abi: erc20Abi } as const;
    // asked of the contract now: the price that is burned is the contract's, whatever the page last read
    const [price, allowance] = await Promise.all([publicClient.readContract({ ...hunt, functionName: 'ticketPrice', args: [BigInt(s.id)] }), publicClient.readContract({ ...pearl, functionName: 'allowance', args: [w.address, hunt.address] })]);
    if (price !== s.ticketWei) throw new Error('The ticket price on the page is out of date. Reload and look again.');
    const calls = [];
    if (allowance < price) calls.push({ to: pearl.address, abi: erc20Abi, method: 'approve', args: [hunt.address, price] });
    calls.push({ to: hunt.address, abi: seasonHuntAbi, method: 'buyTicket', args: [BigInt(s.id)] });
    const hash = await fluentSend(calls, label);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 300 });
    if (receipt.status !== 'success') throw new Error('Transaction reverted');
    s.hasTicket = true;
    toast(`${label}: ${ticketText(s)} burned. Your casts in this season count now.`, 'ok', 8000);
    return receipt;
  } catch (e) {
    console.warn('[hunt] buying the ticket failed', e);
    toast(`${label}: ${friendlyError(e)}`, 'err');
    return undefined;
  }
}

async function act(busy: string, f: () => Promise<TransactionReceipt | undefined>): Promise<boolean> {
  if (hunts.busy) return false;
  hunts.busy = busy;
  changed();
  try {
    return !!(await f());
  } finally {
    hunts.busy = null;
    await loadHunts();
  }
}

export const huntOps = {
  /** The winner takes the prize; the trophy fish comes with it. */
  claim: (s: HuntSeason) => act('claim', () => write('Claim the prize', 'claim', [BigInt(s.id)])),
  /** The trophy alone, when the prize was paid without it. */
  trophy: (s: HuntSeason) => act('trophy', () => write('Land the trophy', 'mintTrophy', [BigInt(s.id)])),
  /** The sponsor takes back the prize of a season nobody won, or one that was called off. */
  reclaim: (s: HuntSeason) => act('reclaim', () => write('Take the prize back', 'reclaim', [BigInt(s.id)])),
  /** Buys the connected player's ticket for a season that asks for one. */
  ticket: (s: HuntSeason) => act('ticket', () => buyTicket(s)),
  /** Sends the proof of a hit again, after a refused or failed first try. */
  record: (p: PendingAttempt) => act('record', () => recordHit(p).then(() => undefined)),
};

// ------------------------------------------------------------------ what became of a cast

const keyOf = (p: { season: number; seq: number }): string => `${p.season}:${p.seq}`;
const watching = new Set<string>();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function track(p: PendingAttempt): void {
  if (hunts.pending.some((x) => keyOf(x) === keyOf(p))) return;
  hunts.pending.push(p);
  remember();
  void watch(p);
}

function drop(p: PendingAttempt, result: AttemptResult | null): void {
  hunts.pending = hunts.pending.filter((x) => keyOf(x) !== keyOf(p));
  remember();
  if (result && p.player.toLowerCase() === state.wallet?.address.toLowerCase()) hunts.last = { season: p.season, seq: p.seq, result, player: p.player };
  changed();
}

const DRAND_HOSTS = ['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh'];

/** The signature of a drand round, or null while the network has not made it. Only the round number is sent. */
async function drandSignature(chainHash: string, round: number): Promise<Hex | null> {
  for (const host of DRAND_HOSTS) {
    try {
      const res = await fetch(`${host}/${chainHash}/public/${round}`);
      if (!res.ok) continue;
      const body = (await res.json()) as { round?: number; signature?: string };
      if (body.round === round && typeof body.signature === 'string' && /^[0-9a-f]{128}$/i.test(body.signature)) return `0x${body.signature}`;
    } catch {
      /* this relay is out of reach: the next one */
    }
  }
  return null;
}

/** What the beacon needs to show the randomness of `p`, or null while that randomness does not exist. */
async function proofFor(p: PendingAttempt): Promise<Hex | null> {
  const b = hunts.beacon;
  if (!b) return null;
  if (b.drand) {
    const round = drandRound(b.drand, p.time);
    // by this device's clock, not the chain's: drand runs on real time
    if (Date.now() / 1000 < drandTime(b.drand, round)) return null;
    return drandSignature(b.drand.chainHash, round);
  }
  return '0x';
}

/** Asks the contract whether `p` hooked the target. 'wait': its randomness is not there yet. */
async function outcomeOf(p: PendingAttempt): Promise<{ kind: 'wait' | 'miss' | 'lost' } | { kind: 'hit'; proof: Hex }> {
  const proof = await proofFor(p);
  if (proof === null) return { kind: 'wait' };
  try {
    const hit = await publicClient.readContract({ ...hunt, functionName: 'outcome', args: [BigInt(p.season), BigInt(p.seq), proof] });
    return hit ? { kind: 'hit', proof } : { kind: 'miss' };
  } catch (e) {
    const name = revertName(e);
    if (name === 'NotYet') return { kind: 'wait' };
    if (name === 'RandomnessLost' || name === 'UnknownAttempt' || name === 'UnknownSeason') return { kind: 'lost' };
    throw e;
  }
}

/** Follows one seasonal cast until its result is known, and records a hit. */
async function watch(p: PendingAttempt): Promise<void> {
  const key = keyOf(p);
  if (watching.has(key)) return;
  watching.add(key);
  try {
    if (!hunts.beacon) await readBeacon();
    let errors = 0;
    while (hunts.pending.some((x) => keyOf(x) === key)) {
      if (huntNow() > p.deadline) return drop(p, p.state === 'hit' ? 'late' : 'lost');
      if (p.state === 'hit') return;
      try {
        const out = await outcomeOf(p);
        if (out.kind === 'miss') return drop(p, 'miss');
        if (out.kind === 'lost') return drop(p, 'lost');
        if (out.kind === 'hit') {
          p.state = 'hit';
          p.proof = out.proof;
          remember();
          changed();
          // straight to the contract: the sooner it is recorded, the sooner nobody can cast past it
          await recordHit(p);
          return;
        }
        errors = 0;
      } catch (e) {
        // a flaky read: keep trying while the window is open, less eagerly
        if (++errors === 1) console.warn('[hunt] could not check a seasonal cast yet', e);
      }
      await sleep(errors > 3 ? 6000 : 1500);
    }
  } finally {
    watching.delete(key);
  }
}

/**
 * Sends the proof that `p` hooked the target. The contract takes it unless an earlier cast already holds the
 * catch. Returns whether the catch is (now) recorded for this cast.
 */
async function recordHit(p: PendingAttempt): Promise<boolean> {
  if (!p.proof) return false;
  const fish = SPECIES[hunts.list.find((s) => s.id === p.season)?.speciesId ?? -1]?.name ?? 'season’s fish';
  try {
    const s = await publicClient.readContract({ ...hunt, functionName: 'season', args: [BigInt(p.season)] });
    if (s.hooked && Number(s.winnerSeq) === p.seq) {
      drop(p, 'recorded'); // somebody sent it already: anyone may
      void loadHunts();
      return true;
    }
    if (s.hooked && Number(s.winnerSeq) < p.seq) {
      drop(p, 'beaten');
      toast(`Your cast hooked the ${fish}, but an earlier cast had hooked it first.`, 'info', 10_000);
      void loadHunts();
      return false;
    }
  } catch (e) {
    console.warn('[hunt] could not read the season before recording', e);
  }
  toast(`You hooked the ${fish}! Confirm the transaction to record the catch.`, 'ok', 12_000);
  const receipt = await write(`Record the catch · ${fish}`, 'settle', [BigInt(p.season), BigInt(p.seq), p.proof]);
  if (!receipt) {
    // refused or failed: the hit stays on the page with a button, until its window closes
    changed();
    return false;
  }
  drop(p, 'recorded');
  void loadHunts();
  return true;
}

const SEASON_CAST = toEventSelector(seasonHuntAbi.find((x) => x.type === 'event' && x.name === 'SeasonCast') as AbiEvent);

/**
 * Finds the player's seasonal casts whose result may still matter and that this browser does not know of (they
 * were made on another device, or the page was closed before the receipt came): the hunt's own log, read back as
 * far as a hit can still be recorded.
 */
export async function recoverAttempts(): Promise<void> {
  const me = state.wallet?.address;
  if (!HUNT_DEPLOYED || DEMO || !me) return;
  const now = huntNow();
  const open = hunts.list.filter((s) => s.sponsor && now >= s.start && now <= s.end + s.settleWindow && !(s.winner && now > s.finalAt));
  for (const s of open) {
    try {
      const head = await publicClient.getBlockNumber({ cacheTime: 0 });
      // about a block a second on Fluent: twice the window in blocks reaches every cast whose hit can still be
      // recorded, in queries small enough for a public node. The newest blocks come first.
      const logs: unknown[] = [];
      for (const [from, to] of logRanges(head, s.settleWindow * 2 + 120)) {
        const part = await publicClient.request({
          method: 'eth_getLogs',
          params: [{ address: hunt.address, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [SEASON_CAST, pad(`0x${s.id.toString(16)}`), pad(me)] }],
        });
        logs.push(...(part as unknown[]));
      }
      for (const l of parseEventLogs({ abi: seasonHuntAbi, logs: logs as never, eventName: 'SeasonCast' })) {
        const seq = Number(l.args.seq);
        if (hunts.pending.some((p) => p.season === s.id && p.seq === seq)) continue;
        if (s.winner && s.winner.seq <= seq) continue; // it cannot win any more
        const a = await publicClient.readContract({ ...hunt, functionName: 'attemptOf', args: [BigInt(s.id), BigInt(seq)] });
        if (a.time + s.settleWindow < now) continue;
        track({ season: s.id, seq, player: me, block: BigInt(a.blockNumber).toString(), time: a.time, deadline: a.time + s.settleWindow, state: 'waiting' });
      }
    } catch (e) {
      console.warn('[hunt] could not look for earlier seasonal casts', e);
    }
  }
}

/** The connected player's casts that hooked the target and are not recorded yet. */
export function myHits(): PendingAttempt[] {
  const me = state.wallet?.address.toLowerCase();
  return me ? hunts.pending.filter((p) => p.state === 'hit' && p.player.toLowerCase() === me) : [];
}

/** The connected player's casts whose result is still on its way. */
export function myWaiting(): PendingAttempt[] {
  const me = state.wallet?.address.toLowerCase();
  return me ? hunts.pending.filter((p) => p.state === 'waiting' && p.player.toLowerCase() === me) : [];
}

let started: string | null = null;
/**
 * Called on every render: once per connected account it reads the seasons, picks the remembered casts of that
 * account up again and looks on the chain for ones it does not know.
 */
export function syncHunt(): void {
  if (!HUNT_DEPLOYED) return;
  const me = state.wallet?.address.toLowerCase() ?? '';
  if (started === me) return;
  started = me;
  if (!hunts.loaded && hunts.pending.length === 0) recall();
  void loadHunts().then(() => {
    if (!me) return;
    for (const p of hunts.pending) if (p.player.toLowerCase() === me) void watch(p);
    void recoverAttempts();
  });
}

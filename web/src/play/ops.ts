/**
 * Everything the UI can ask the game to do, with one implementation per backend: the local save (pure reducers
 * from game/actions.ts) or the contracts (a transaction, then a fresh read). Every operation resolves to whether
 * it happened; failures are already reported to the player.
 */
import { LOCAL_GAME } from '../config';
import * as A from '../game/actions';
import { LOCATIONS, SPECIALS } from '../game/content';
import { profileOf } from '../game/daily';
import { achievements } from '../game/progress';
import type { Save } from '../game/types';
import { emit, state } from '../store';
import { LURES, RODS } from '../tackle/catalog';
import { buyPearlOnChain, inventoryReadFor, loadChainSave, loadStandings, rememberCollection, rememberLocation, tx, type GameCall } from './chain';
import { toast } from '../ui/toast';
import { syncDaily } from './daily';
import { claimRewardOnChain, syncReward } from './dailyReward';
import { act, apply, getSave, replaceSave } from './state';
import { track } from './telemetry';

export const CHAIN = !LOCAL_GAME;

let refreshing: Promise<void> | null = null;
/** The account whose state has been read at least once (or whose first read has failed): the UI stops waiting for it. */
let readFor: string | null = null;
/** False between the sign-in and the first read of that account's state: what is on screen is still an empty save. */
export const playerRead = (): boolean => !CHAIN || !state.wallet || readFor === state.wallet.address;

/** Re-reads the player's state from the contracts (chain mode only). Concurrent calls share one read. */
export function refresh(): Promise<void> {
  if (!CHAIN) return Promise.resolve();
  refreshing ??= (async () => {
    const who = state.wallet?.address ?? null;
    try {
      const s = await loadChainSave();
      readFor = who;
      if (s) replaceSave(s);
      // the day's challenges are read from the chain's events, after the state they are compared with
      if (s && who) void syncDaily(who, profileOf(s));
      if (s && who) void syncReward(who);
    } catch (e) {
      console.warn('refresh failed', e);
      // the next refresh tries again; meanwhile the page shows what it has instead of waiting forever
      readFor = who;
      emit();
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function refreshStandings(): Promise<void> {
  if (!CHAIN) return;
  try {
    await loadStandings();
    emit();
  } catch (e) {
    console.warn('standings failed', e);
  }
}

/** A transaction followed by a fresh read. */
async function send(label: string, request: GameCall): Promise<boolean> {
  const ok = !!(await tx(label, request));
  if (ok) await refresh();
  return ok;
}

const rodIndex = (id: string): number => RODS.findIndex((r) => r.id === id);
const lureIndex = (id: string): number => LURES.findIndex((l) => l.id === id);
const local = (fn: (s: Save) => Save): Promise<boolean> => Promise.resolve(apply(fn));

/**
 * A change to what the player saved. The same rules in both modes (game/actions.ts); what differs is
 * where the result is kept: the local save, or this browser's preferences for the signed-in account. Nothing is
 * sent to the chain. A refusal becomes a toast and changes nothing.
 */
function collect(fn: (s: Save) => Save): Save | undefined {
  if (!CHAIN) return act(fn, (s) => s);
  const me = state.wallet?.address;
  // only against the account's own keepnet, as it was last read
  if (!me || !inventoryReadFor(me)) return undefined;
  try {
    const next = fn(getSave());
    rememberCollection(me, next);
    replaceSave(next);
    return next;
  } catch (e) {
    if (e instanceof A.GameError) toast(e.message, 'err');
    else throw e;
    return undefined;
  }
}

type Bought = 'rod' | 'lure' | 'repair' | 'refill' | 'location' | 'pearl';
/** Telemetry: a purchase that went through, at the price shown when it was asked for. */
const bought = (done: Promise<boolean>, kind: Bought, id: string, price: number): Promise<boolean> =>
  done.then((ok) => {
    if (ok) track({ e: 'purchase', kind, id, price });
    return ok;
  });

export const ops = {
  buyRod: (id: string): Promise<boolean> =>
    bought(CHAIN ? send('Buy rod', { functionName: 'buyRod', args: [rodIndex(id)] }) : local((s) => A.buyRod(s, id)), 'rod', id, RODS[rodIndex(id)]?.price ?? 0),

  /** Buys the lure; an empty lure slot takes it. */
  buyLure: (id: string): Promise<boolean> =>
    bought(
      CHAIN ? send('Buy lure', { functionName: 'buyLure', args: [lureIndex(id)] }) : local((s) => (s.lures[id] ? A.buyLure(s, id) : A.equipLure(A.buyLure(s, id), id))),
      'lure',
      id,
      LURES[lureIndex(id)]?.price ?? 0,
    ),

  equipRod: (id: string): Promise<boolean> => (CHAIN ? send('Equip rod', { functionName: 'equipRod', args: [rodIndex(id)] }) : local((s) => A.equipRod(s, id))),

  equipLure: (id: string | null): Promise<boolean> =>
    CHAIN ? send(id ? 'Equip lure' : 'Take the lure off', { functionName: 'equipLure', args: [id ? lureIndex(id) + 1 : 0] }) : local((s) => A.equipLure(s, id)),

  repairRod(id: string): Promise<boolean> {
    const price = A.rodRepairPrice(getSave(), id);
    return bought(CHAIN ? send('Repair rod', { functionName: 'repairRod', args: [rodIndex(id)] }) : local((s) => A.repairRod(s, id)), 'repair', id, price);
  },

  /** Buys PEARL for BLEND. `blendAmount` is what the player typed. */
  async buyPearl(blendAmount: string): Promise<boolean> {
    const blend = Number(blendAmount.replace(',', '.'));
    // for this one purchase the price is the BLEND paid, not PEARL
    if (!CHAIN) return bought(Promise.resolve(apply((s) => A.buyPearl(s, blend).save)), 'pearl', 'blend', blend);
    if (!state.wallet) {
      toast('Connect with Fluent to play', 'info');
      return false;
    }
    const ok = await buyPearlOnChain(blendAmount);
    if (ok) await refresh();
    return bought(Promise.resolve(ok), 'pearl', 'blend', blend);
  },

  refillEnergy(): Promise<boolean> {
    const price = A.refillPrice(getSave(), Date.now());
    return bought(CHAIN ? send('Refill energy', { functionName: 'refillEnergy', args: [] }) : local((s) => A.refillEnergy(s, Date.now())), 'refill', 'energy', price);
  },

  /** Resolves to the PEARL earned, or undefined if nothing was sold. */
  async sellFish(ids: string[]): Promise<number | undefined> {
    if (!CHAIN) {
      const earned = act(
        (s) => A.sellFish(s, ids, Date.now()),
        (r) => r.save,
      )?.earned;
      if (earned !== undefined) track({ e: 'sale', fish: ids.length, earned });
      return earned;
    }
    const s = getSave();
    const sold = s.fish.filter((f) => ids.includes(f.id));
    const now = Date.now();
    // the same protections the local rules enforce; the contract itself only checks ownership
    try {
      A.sellFish(s, ids, now);
    } catch (e) {
      if (e instanceof A.GameError) {
        toast(e.message, 'err');
        return undefined;
      }
      throw e;
    }
    const ok = await send(`Sell ${ids.length} fish`, { functionName: 'sellFish', args: [ids.map((id) => BigInt(id))] });
    if (!ok) return undefined;
    const earned = sold.reduce((a, f) => a + A.saleValue(f, now), 0);
    track({ e: 'sale', fish: ids.length, earned });
    return earned;
  },

  /**
   * The star: saves a fish into the Trophy Room, or takes it out. A client-side convenience in both modes: it only
   * guards the game's Sell buttons.
   */
  toggleFavorite: (id: string): boolean => collect((s) => A.toggleFavorite(s, id)) !== undefined,

  setActiveSpecial: (id: string | null): Promise<boolean> =>
    CHAIN
      ? send(id ? 'Use bonus' : 'Turn bonus off', { functionName: 'setActiveSpecial', args: [id ? SPECIALS.findIndex((x) => x.id === id) + 1 : 0] })
      : local((s) => A.setActiveSpecial(s, id)),

  /** Resolves to the PEARL reward, or undefined. */
  async claimAchievement(id: string): Promise<number | undefined> {
    if (!CHAIN) {
      return act(
        (s) => A.claimAchievement(s, id),
        (r) => r.save,
      )?.reward;
    }
    const list = achievements(getSave());
    const index = list.findIndex((a) => a.id === id);
    if (index < 0) return undefined;
    const ok = await send('Claim reward', { functionName: 'claimAchievement', args: [BigInt(index)] });
    return ok ? list[index].reward : undefined;
  },

  /**
   * The reward for a full day of challenges: +4 energy, once. Local game: an action on the save. On the contracts:
   * the verifier's authorization and one transaction, then the state is read again, so the energy on screen is the
   * chain's. Resolves to whether it was granted.
   */
  async claimDailyReward(day: number): Promise<boolean> {
    if (!CHAIN) return apply((s) => A.claimDailyReward(s, day, Date.now()));
    const me = state.wallet?.address;
    const ok = await claimRewardOnChain(day);
    if (ok && me) {
      await refresh();
      await syncReward(me);
    }
    return ok;
  },

  /**
   * Permanent access to a secret water for PEARL. Local game only: the contracts have no such purchase yet, so on
   * chain nothing is sent and nothing changes.
   */
  buyLocation(id: number): Promise<boolean> {
    if (!CHAIN) {
      const price = LOCATIONS[id]?.purchase?.price ?? 0;
      return bought(local((s) => A.buyLocation(s, id)), 'location', String(id), price).then((ok) => {
        if (ok) track({ e: 'unlock', loc: id, how: 'purchase' });
        return ok;
      });
    }
    toast('Buying access is not available on the contracts yet', 'info');
    return Promise.resolve(false);
  },

  /** Picking a location is free: on the contracts it is only sent with the cast. */
  setLocation(id: number): boolean {
    if (!CHAIN) return apply((s) => A.setLocation(s, id));
    try {
      replaceSave(A.setLocation(getSave(), id));
      rememberLocation(id);
      return true;
    } catch {
      return false;
    }
  },
};

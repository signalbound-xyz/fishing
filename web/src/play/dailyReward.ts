/**
 * The reward for a full day of challenges, in the browser: what the interface shows about it and how a claim is
 * made. The rules are in game/dailyReward.ts.
 *
 * Local game: the save keeps the day and the reward book; the claim is a game action (game/actions.ts). It is this
 * browser's reward and has nothing to do with the chain's.
 *
 * On the contracts the page decides nothing. It reads what the DailyRewards contract says (first day, claimed
 * days), asks the verifier for an authorization with nothing but the account and the day, and sends that to the
 * contract. The page's own idea of the day (play/daily.ts) only decides whether the button is offered: a page that
 * lies to itself gets a refusal from the verifier, and one that forges an authorization gets one from the contract.
 */
import { dailyRewardsAbi } from '../abi';
import { publicClient } from '../clients';
import { CHAIN_ID, LOCAL_GAME, deployment } from '../config';
import { revertName } from '../errors';
import { dailyRewardCheck, energyNow } from '../game/actions';
import { TUNING } from '../game/content';
import { DAILY_REWARD, utcDay } from '../game/daily';
import { REWARD_ENERGY, askVerifier, claimEndMs, rewardStatus, type RewardStatus } from '../game/dailyReward';
import { emit, state } from '../store';
import { TxError, sendTx } from '../tx';
import { toast } from '../ui/toast';
import { dailyView, yesterdayComplete, type DailyView } from './daily';
import { createPending, pendingKey } from './pending';
import { getSave } from './state';

const CHAIN = !LOCAL_GAME;
const contract = deployment?.dailyRewards;
/** Where the verifier answers. The game's own origin unless the build says otherwise. */
const API: string = import.meta.env.VITE_DAILY_REWARD_API ?? '/api/daily-reward';

// ------------------------------------------------------------------ what the contract says (contracts only)

interface OnChain {
  address: string;
  /** Today, as the chain counts it. */
  day: number;
  firstDay: number;
  claimedToday: boolean;
  claimedYesterday: boolean;
}
let onChain: OnChain | null = null;
/** The last read failed and there is nothing to show for this account. */
let unread = false;

/** Reads the reward's state for the account. Called after every read of the player's state. */
export async function syncReward(address: string): Promise<void> {
  if (!CHAIN || !contract) return;
  const me = address.toLowerCase();
  try {
    const [day, first, claimedToday, claimedYesterday] = await publicClient.readContract({ address: contract, abi: dailyRewardsAbi, functionName: 'rewardState', args: [address as `0x${string}`] });
    onChain = { address: me, day: Number(day), firstDay: Number(first), claimedToday, claimedYesterday };
    unread = false;
  } catch (e) {
    console.warn('[daily] could not read the reward state', e);
    // what was read before stays on screen for the same account; a claim is checked by the contract anyway
    unread = onChain?.address !== me;
  }
  emit();
}

// ------------------------------------------------------------------ the view

export interface RewardPanel {
  day: number;
  when: 'today' | 'yesterday';
  status: RewardStatus;
  /** Energy to spend before the claim fits. */
  spend: number;
  /** Seconds until this reward can no longer be claimed. */
  endsIn: number;
  /** A claim of it is on its way. */
  pending: boolean;
}

export interface RewardView {
  /** There is a reward to earn here: the preview and the panels are shown. False: nothing is promised. */
  on: boolean;
  /** On the contracts: rewards are deployed and begin on this UTC day, which is still ahead. */
  startsOn: number | null;
  /** On the contracts: the reward's state could not be read, so no claim is offered. */
  unread: boolean;
  /** The local game: a reward of this browser, not an on-chain one. */
  local: boolean;
  amount: number;
  energy: number;
  max: number;
  today: RewardPanel | null;
  /** Yesterday's reward, while it is still there to claim. */
  yesterday: RewardPanel | null;
}

const claims = createPending(emit);
const keyOf = (day: number): string => pendingKey(CHAIN_ID, state.wallet?.address, `daily:${day}`);
export const rewardClaims = { run: <T>(day: number, task: () => Promise<T>): Promise<T | undefined> => claims.run(keyOf(day), task), keys: (): string[] => claims.keys() };

export function rewardView(v: DailyView = dailyView(), now = Date.now()): RewardView {
  const s = getSave();
  const energy = energyNow(s, now);
  const max = TUNING.maxEnergy;
  const none: RewardView = { on: false, startsOn: null, unread: false, local: !CHAIN, amount: REWARD_ENERGY, energy, max, today: null, yesterday: null };
  if (v.status !== 'ready' || !v.progress) return none;
  const today = utcDay(now);
  const panel = (day: number, when: RewardPanel['when'], check: { status: RewardStatus; spend: number }): RewardPanel => ({ day, when, ...check, endsIn: Math.max(0, Math.ceil((claimEndMs(day) - now) / 1000)), pending: claims.has(keyOf(day)) });
  const open = (p: RewardPanel): RewardPanel | null => (p.status === 'ready' || p.status === 'full' || p.pending ? p : null);

  if (!CHAIN) {
    if (today < DAILY_REWARD.localFirstDay) return none;
    return { ...none, on: true, today: panel(today, 'today', dailyRewardCheck(s, today, now)), yesterday: open(panel(today - 1, 'yesterday', dailyRewardCheck(s, today - 1, now))) };
  }

  const me = state.wallet?.address.toLowerCase();
  if (!contract || !me) return none;
  const c = onChain?.address === me ? onChain : null;
  if (!c) return { ...none, unread };
  if (c.firstDay <= 0) return none;
  if (c.firstDay > today) return { ...none, startsOn: c.firstDay };
  // the chain's day and this device's agree except for moments around midnight; the chain's flags are the chain's days
  const claimed = (day: number): boolean => (day === c.day ? c.claimedToday : day === c.day - 1 ? c.claimedYesterday : false);
  const facts = (day: number, complete: boolean) => rewardStatus({ day, today, firstDay: c.firstDay, complete, claimed: claimed(day), energy, max });
  return {
    ...none,
    on: true,
    today: panel(today, 'today', facts(today, v.progress.complete)),
    yesterday: open(panel(today - 1, 'yesterday', facts(today - 1, yesterdayComplete(today) === true))),
  };
}

// ------------------------------------------------------------------ the claim (contracts)

/**
 * Claims the reward of `day` on the contracts: the verifier's authorization, then one transaction. Resolves to
 * whether the chain confirmed it; every failure has already been told to the player.
 */
export async function claimRewardOnChain(day: number): Promise<boolean> {
  const w = state.wallet;
  if (!w) {
    toast('Connect with Fluent to play', 'info');
    return false;
  }
  if (!contract) {
    toast('Energy rewards are not available yet', 'info');
    return false;
  }
  const answer = await askVerifier((url, init) => fetch(url, init), API, { chainId: CHAIN_ID, contract, player: w.address, day });
  if (!answer.ok) {
    toast(`Daily reward: ${answer.message}`, answer.code === 'incomplete' ? 'info' : 'err', 6000);
    // the verifier knows something this page did not: read the chain again
    if (answer.code === 'already_claimed' || answer.code === 'not_active' || answer.code === 'day_expired') void syncReward(w.address);
    return false;
  }
  const a = answer.authorization;
  try {
    await sendTx(
      w,
      'Claim daily reward',
      { address: contract, abi: dailyRewardsAbi, functionName: 'claimDailyReward', args: [BigInt(day), { rules: BigInt(a.rules), amount: BigInt(a.amount), deadline: BigInt(a.deadline), signature: a.signature }] },
      { quiet: true },
    );
    return true;
  } catch (e) {
    if (!(e instanceof TxError)) throw e;
    const name = revertName(e.original);
    // the game's "energy is full" means here: no room for all four
    toast(`Daily reward: ${name === 'EnergyFull' ? `Spend energy to claim your +${REWARD_ENERGY} reward.` : e.message}`, 'err', 6000);
    if (name === 'AlreadyClaimed' || name === 'NotActive' || name === 'DayExpired') void syncReward(w.address);
    return false;
  }
}

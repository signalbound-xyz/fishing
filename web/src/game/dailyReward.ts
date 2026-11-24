/**
 * The reward for a full day of daily challenges: +4 energy, once per player and UTC day, claimed by hand.
 *
 * This module is the part every side agrees on, as pure data and pure functions: how much, for how long a
 * completed day stays claimable, what stands between a player and the claim right now (`rewardStatus`), and the
 * EIP-712 message a verifier signs for the contract (`rewardTypedData`, contracts/src/DailyRewards.sol).
 *
 * Who decides that a day was completed is not here, and it is never the page:
 *   - on the contracts, a verifier reads the day's `Caught` events itself (src/server/dailyReward.ts) and signs;
 *     the contract checks the signature and adds the energy;
 *   - in the local game, the save's own day (game/daily.ts, `claimLocalReward`). A local save proves nothing to
 *     anybody else, and nothing in it is ever sent to the verifier.
 */
import { DAILY_REWARD, DAY_MS } from './daily';

/** Energy for all three challenges of a day. The contract has the same number (`ENERGY`) and accepts no other. */
export const REWARD_ENERGY: number = DAILY_REWARD.fullSet.amount;

/** A completed day can be claimed while it runs and on the UTC day after it. */
export const CLAIM_DAYS = 2;
/** The moment a day's reward can no longer be claimed, ms. */
export const claimEndMs = (day: number): number => (day + CLAIM_DAYS) * DAY_MS;

export type RewardStatus =
  /** No rewards here (not switched on), or the day is before the first one that pays. */
  | 'off'
  /** The day has not been completed (yet). */
  | 'incomplete'
  /** Completed, unclaimed, and the bar has room for all of it. */
  | 'ready'
  /** Completed and unclaimed, but the bar has less than the whole reward of room: nothing is given in part. */
  | 'full'
  | 'claimed'
  /** The day after the day is over. */
  | 'expired';

export interface RewardCheck {
  status: RewardStatus;
  /** Energy to spend before the claim fits; 0 unless `status` is 'full'. */
  spend: number;
}

export interface RewardFacts {
  day: number;
  today: number;
  /** The first day that pays; 0 when rewards are off. */
  firstDay: number;
  complete: boolean;
  claimed: boolean;
  /** Energy now, regeneration included. */
  energy: number;
  max: number;
}

/** What stands between a player and the reward of `day`. The order is the order the contract checks in. */
export function rewardStatus(f: RewardFacts, amount: number = REWARD_ENERGY): RewardCheck {
  const no = (status: RewardStatus): RewardCheck => ({ status, spend: 0 });
  if (f.firstDay <= 0 || f.day < f.firstDay) return no('off');
  if (f.today > f.day + CLAIM_DAYS - 1) return no('expired');
  if (f.claimed) return no('claimed');
  if (f.day > f.today || !f.complete) return no('incomplete');
  const spend = Math.max(0, f.energy + amount - f.max);
  return spend > 0 ? { status: 'full', spend } : no('ready');
}

// ------------------------------------------------------------------ the signed authorization (contracts only)

/** The EIP-712 domain of DailyRewards, less the chain and the contract address. */
export const REWARD_DOMAIN = { name: 'Onchain Fishing Daily Rewards', version: '1' } as const;

export const REWARD_TYPES = {
  DailyReward: [
    { name: 'player', type: 'address' },
    { name: 'day', type: 'uint256' },
    { name: 'rules', type: 'uint256' },
    { name: 'amount', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

type Address = `0x${string}`;

/** What a verifier vouches for: this player completed this day under these rules, and may take this much until then. */
export interface RewardTerms {
  player: Address;
  day: number;
  /** Version of the challenge rules the day was checked against (`DAILY.version`). */
  rules: number;
  amount: number;
  /** Unix seconds. */
  deadline: number;
}

/** The typed data to sign or hash, as viem takes it. Bound to one chain and one contract: it is worth nothing elsewhere. */
export function rewardTypedData(chainId: number, contract: Address, t: RewardTerms) {
  return {
    domain: { ...REWARD_DOMAIN, chainId, verifyingContract: contract },
    types: REWARD_TYPES,
    primaryType: 'DailyReward' as const,
    message: { player: t.player, day: BigInt(t.day), rules: BigInt(t.rules), amount: BigInt(t.amount), deadline: BigInt(t.deadline) },
  };
}

/** A verifier's answer: the terms, its signature over them, and where they are good. */
export interface RewardAuthorization extends RewardTerms {
  chainId: number;
  contract: Address;
  signer: Address;
  signature: `0x${string}`;
}

/** Is `a` an authorization for exactly this claim? A page checks it before asking the wallet to send anything. */
export function authorizationFits(a: RewardAuthorization, want: { chainId: number; contract: string; player: string; day: number }, nowSeconds: number): boolean {
  return (
    a.chainId === want.chainId &&
    a.contract.toLowerCase() === want.contract.toLowerCase() &&
    a.player.toLowerCase() === want.player.toLowerCase() &&
    a.day === want.day &&
    a.amount === REWARD_ENERGY &&
    Number.isInteger(a.deadline) &&
    a.deadline > nowSeconds &&
    /^0x[0-9a-fA-F]{130}$/.test(a.signature)
  );
}

// ------------------------------------------------------------------ asking the verifier (the page's side)

/** What the verifier said: an authorization for exactly the claim asked about, or why there is none. */
export type VerifierAnswer = { ok: true; authorization: RewardAuthorization } | { ok: false; code: string; message: string };

/**
 * Asks the verifier for the authorization of one day. The question is the account and the day, nothing else: what
 * a page believes about the day's catches is not sent, because it would not be believed. The answer is not
 * believed either until it is seen to be for this very claim: an authorization for another player, day, amount,
 * chain or contract is refused here, before any wallet is asked to send it.
 */
export async function askVerifier(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  want: { chainId: number; contract: string; player: string; day: number },
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): Promise<VerifierAnswer> {
  let res: Response;
  try {
    res = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ player: want.player, day: want.day }), signal: AbortSignal.timeout(25_000) });
  } catch {
    return { ok: false, code: 'service', message: 'The reward service could not be reached. Try again in a moment.' };
  }
  type Body = { authorization?: RewardAuthorization; error?: { code?: unknown; message?: unknown } };
  let body = null as Body | null;
  try {
    body = (await res.json()) as Body | null;
  } catch {
    /* not JSON: not the verifier (a page served in its place, a gateway error) */
  }
  if (res.ok && body && typeof body === 'object' && body.authorization) {
    let fits = false;
    try {
      fits = authorizationFits(body.authorization, want, nowSeconds());
    } catch {
      /* not the shape of an authorization at all */
    }
    return fits ? { ok: true, authorization: body.authorization } : { ok: false, code: 'service', message: 'The reward service answered for a different claim. Nothing was sent.' };
  }
  const e = body && typeof body === 'object' ? body.error : undefined;
  if (e && typeof e.code === 'string' && typeof e.message === 'string') return { ok: false, code: e.code, message: e.message };
  return { ok: false, code: 'service', message: res.status === 429 ? 'Too many requests. Wait a minute and try again.' : 'The reward service is not available right now. Try again in a moment.' };
}

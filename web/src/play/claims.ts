/**
 * Claiming an achievement's reward, and knowing that a claim is on its way. On the contracts a claim is a
 * transaction: until it is confirmed (or refused) and the player's state is read again, the reward's button waits
 * and a second click sends nothing. In the local game the claim is over at once and nothing has to wait.
 */
import { CHAIN_ID } from '../config';
import { emit, state } from '../store';
import { ops } from './ops';
import { rewardClaims } from './dailyReward';
import { createPending, pendingKey } from './pending';

const claims = createPending(emit);
const keyOf = (id: string): string => pendingKey(CHAIN_ID, state.wallet?.address, id);

/** Is this achievement's reward being claimed right now, by the account that is signed in? */
export const claiming = (id: string): boolean => claims.has(keyOf(id));

/** Part of the render signature of everything that draws a claim button. */
export const claimsSig = (): string[] => claims.keys();

/** Resolves to the PEARL reward, or undefined when nothing was claimed (refused, failed, or already on its way). */
export const claim = (id: string): Promise<number | undefined> => claims.run(keyOf(id), () => ops.claimAchievement(id));

/**
 * Claims the daily reward of `day`; a second click while one is on its way does nothing. Resolves to whether it was
 * granted (false too when it was already on its way).
 */
export const claimDailyReward = (day: number): Promise<boolean> => rewardClaims.run(day, () => ops.claimDailyReward(day)).then((ok) => ok === true);

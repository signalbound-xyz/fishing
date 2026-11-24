/**
 * The reward verifier as a Vercel Function. `pnpm build:api` bundles this file into web/api/daily-reward.js, which
 * is what Vercel serves at /api/daily-reward; the bundle is committed, and a test fails when it is stale.
 */
import { createHandler, verifierFrom } from './http';
import type { Verifier } from './dailyReward';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

// built on the first request and kept for the life of the instance; a host that is not configured says so on every request
let verifier: Verifier | null | undefined;
function get(): Verifier | null {
  if (verifier === undefined) {
    const made = verifierFrom(env);
    if ('missing' in made) console.warn(`[daily-reward] not configured: ${made.missing}`);
    verifier = 'missing' in made ? null : made.verifier;
  }
  return verifier;
}

const handler = createHandler(get, { allowOrigin: env.DAILY_REWARD_ALLOW_ORIGIN });

export default { fetch: handler };

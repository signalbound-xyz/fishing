/**
 * The keeper as a Vercel Function. `pnpm build:api` bundles this file into web/api/keeper.js, which is what Vercel
 * serves at /api/keeper; the bundle is committed, and a test fails when it is stale.
 */
import { createKeeperHandler, keeperFrom, type KeeperSetup } from './keeperHttp';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

// built on the first request and kept for the life of the instance
let setup: KeeperSetup | null | undefined;
function get(): KeeperSetup | null {
  if (setup === undefined) {
    const made = keeperFrom(env);
    if ('missing' in made) console.warn(`[keeper] not configured: ${made.missing}`);
    setup = 'missing' in made ? null : made;
  }
  return setup;
}

const handler = createKeeperHandler(get, env.CRON_SECRET);

export default { fetch: handler };

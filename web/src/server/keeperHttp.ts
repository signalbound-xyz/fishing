/**
 * The keeper as an HTTP endpoint: a scheduler calls it every minute, each call is one pass (server/keeper.ts).
 * A web-standard handler, so it runs on Vercel (web/api/keeper.js), on Node and anywhere else that speaks fetch.
 *
 *   GET /api/keeper              one pass: record the season hunt's hits, reel in casts about to expire
 *   GET /api/keeper?dry=1        look and report, send nothing
 *   GET /api/keeper?drain=1      reel in every cast in the water (before a change of rules or of the game's code)
 *
 * Every call must carry `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends it by itself once the variable
 * is set). What the keeper sends is open to anyone and changes no result, but each transaction costs its gas,
 * so strangers do not get to decide when it runs.
 *
 * Configuration is the host's environment, read once (web/KEEPER.md lists it). The key is used here and nowhere
 * else: it is not logged, not returned, and not part of any bundle.
 */
import { privateKeyToAccount } from 'viem/accounts';
import { deployments } from '../generated/deployments';
import { runKeeper, type Keeper, type KeeperReport } from './keeper';
import { drandSignature, keeperChain } from './keeperChain';

type Env = Record<string, string | undefined>;
type Address = `0x${string}`;

const RPC: Record<number, string> = { 20994: 'https://rpc.testnet.fluent.xyz', 25363: 'https://rpc.fluent.xyz' };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const isAddress = (x: string | undefined): x is Address => !!x && /^0x[0-9a-fA-F]{40}$/.test(x);

const int = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export interface KeeperSetup {
  keeper: Keeper;
  /** Whether there is a key: without one only a dry run is possible. */
  canSend: boolean;
  rescueBlocks: bigint | undefined;
  budgetMs: number;
}

/** The keeper this environment describes, or why there is none. */
export function keeperFrom(env: Env): KeeperSetup | { missing: string } {
  const chainId = int(env.KEEPER_CHAIN_ID, 20994, 1, 2 ** 31);
  const d = deployments[String(chainId)];
  const game = env.KEEPER_GAME ?? d?.game;
  if (!isAddress(game)) return { missing: `the game's address (deployments for chain ${chainId}, or KEEPER_GAME)` };
  const hunt = env.KEEPER_HUNT ?? d?.seasonHunt;
  if (hunt !== undefined && !isAddress(hunt)) return { missing: 'a valid KEEPER_HUNT' };
  const rpcUrl = env.KEEPER_RPC_URL ?? RPC[chainId];
  if (!rpcUrl) return { missing: 'KEEPER_RPC_URL' };
  const key = env.KEEPER_KEY?.trim();
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) return { missing: 'a valid KEEPER_KEY (0x and 64 hex digits)' };
  const rescue = int(env.KEEPER_RESCUE_BLOCKS, 0, 1, 8_000);
  return {
    keeper: {
      chain: keeperChain({
        chainId,
        rpcUrl,
        game,
        hunt,
        startBlock: BigInt(int(env.KEEPER_START_BLOCK, d?.startBlock ?? 0, 0, Number.MAX_SAFE_INTEGER)),
        account: key ? privateKeyToAccount(key as `0x${string}`) : undefined,
      }),
      drand: (chainHash, round) => drandSignature(chainHash, round),
      now: () => Date.now(),
      misses: new Set(),
    },
    canSend: !!key,
    rescueBlocks: rescue ? BigInt(rescue) : undefined,
    // a function on Vercel has ten seconds unless it is given more; what does not fit is done by the next run
    budgetMs: int(env.KEEPER_BUDGET_MS, 7_000, 1_000, 280_000),
  };
}

/** `setup` is a function so that a host that is not configured still answers, with a clear refusal. */
export function createKeeperHandler(setup: () => KeeperSetup | null, secret: string | undefined, now: () => number = Date.now): (request: Request) => Promise<Response> {
  // one pass at a time on an instance: two would send the same transactions twice
  let running: Promise<KeeperReport> | null = null;
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'POST') return json(405, { error: { code: 'bad_request', message: 'GET or POST.' } });
    if (!secret) return json(503, { error: { code: 'not_configured', message: 'The keeper is not switched on: CRON_SECRET is not set.' } });
    if (request.headers.get('authorization') !== `Bearer ${secret}`) return json(401, { error: { code: 'unauthorized', message: 'A bearer token is required.' } });
    const s = setup();
    if (!s) return json(503, { error: { code: 'not_configured', message: 'The keeper is not configured.' } });

    const q = new URL(request.url).searchParams;
    const dryRun = q.get('dry') === '1' || !s.canSend;
    const from = q.get('from');
    if (from !== null && !/^\d{1,12}$/.test(from)) return json(400, { error: { code: 'bad_request', message: '`from` is a block number.' } });
    if (running) return json(409, { error: { code: 'busy', message: 'A pass is already running.' } });
    const started = now();
    running = runKeeper(s.keeper, {
      drain: q.get('drain') === '1',
      dryRun,
      from: from === null ? undefined : BigInt(from),
      rescueBlocks: s.rescueBlocks,
      shouldContinue: () => now() - started < s.budgetMs,
    });
    try {
      const report = await running;
      if (!s.canSend) report.notes.push('no KEEPER_KEY is set: this was a dry run');
      console.info(JSON.stringify({ event: 'keeper_run', ms: now() - started, ...report }));
      return json(200, report);
    } catch (e) {
      // a read failed: nothing is known, nothing was decided. The next run starts over.
      const message = String((e as Error)?.message ?? e).slice(0, 300);
      console.error(JSON.stringify({ event: 'keeper_failed', message }));
      return json(502, { error: { code: 'chain_unavailable', message } });
    } finally {
      running = null;
    }
  };
}

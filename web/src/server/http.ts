/**
 * The reward verifier as an HTTP endpoint: `POST { "player": "0x…", "day": 20781 }` answers with a signed
 * authorization, or with a reason there is none. A web-standard handler (Request in, Response out), so it runs on
 * Vercel (web/api/daily-reward.js), on Node and anywhere else that speaks fetch.
 *
 * Configuration is the host's environment, read once (web/DAILY_REWARDS.md lists it). The signing key is used here
 * and nowhere else: it is not logged, not returned, and not part of any bundle.
 */
import { privateKeyToAccount } from 'viem/accounts';
import { deployments } from '../generated/deployments';
import { chainFacts } from './chain';
import { authorize, isAddress, parseRequest, rateLimiter, type Refusal, type Verdict, type Verifier } from './dailyReward';

type Env = Record<string, string | undefined>;

const RPC: Record<number, string> = { 20994: 'https://rpc.testnet.fluent.xyz', 25363: 'https://rpc.fluent.xyz' };

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

const failure = (r: Pick<Refusal, 'code' | 'message' | 'status' | 'progress'> | { code: string; message: string; status: number }, headers: Record<string, string> = {}): Response =>
  json(r.status, { error: { code: r.code, message: r.message, ...('progress' in r && r.progress ? { progress: r.progress } : {}) } }, headers);

const int = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

/** The verifier this environment describes, or why there is none. */
export function verifierFrom(env: Env): { verifier: Verifier } | { missing: string } {
  const chainId = int(env.DAILY_REWARD_CHAIN_ID, 20994, 1, 2 ** 31);
  const d = deployments[String(chainId)];
  if (!d) return { missing: `no deployment for chain ${chainId}` };
  const contract = env.DAILY_REWARD_CONTRACT ?? d.dailyRewards;
  if (!isAddress(contract)) return { missing: 'the DailyRewards address (deployments, or DAILY_REWARD_CONTRACT)' };
  const key = env.DAILY_REWARD_SIGNER_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return { missing: 'DAILY_REWARD_SIGNER_KEY' };
  const rpcUrl = env.DAILY_REWARD_RPC_URL ?? RPC[chainId];
  if (!rpcUrl) return { missing: 'DAILY_REWARD_RPC_URL' };
  const account = privateKeyToAccount(key as `0x${string}`);
  return {
    verifier: {
      config: {
        chainId,
        contract,
        signer: account.address,
        confirmations: BigInt(int(env.DAILY_REWARD_CONFIRMATIONS, 5, 0, 10_000)),
        ttlSeconds: int(env.DAILY_REWARD_TTL_SECONDS, 600, 30, 3_600),
        startBlock: BigInt(d.startBlock),
        maxClockSkew: 120,
      },
      chain: chainFacts({ rpcUrl, game: d.game, rewards: contract }),
      sign: (data) => account.signTypedData(data),
      now: () => Date.now(),
      dayBlocks: new Map(),
    },
  };
}

export interface HandlerOptions {
  /** Origins allowed to call from a browser, besides the endpoint's own. `*` allows any. */
  allowOrigin?: string;
  now?: () => number;
  /** Requests per minute. */
  perClient?: number;
  perPlayer?: number;
  /** How long an answer is repeated without asking the chain again, ms. */
  cacheMs?: number;
}

/** `verifier` is a function so that a host that is not configured still answers, with a clear refusal. */
export function createHandler(verifier: () => Verifier | null, opts: HandlerOptions = {}): (request: Request) => Promise<Response> {
  const now = opts.now ?? Date.now;
  const clientOk = rateLimiter(opts.perClient ?? 30, 60_000, now);
  const playerOk = rateLimiter(opts.perPlayer ?? 10, 60_000, now);
  const cacheMs = opts.cacheMs ?? 4_000;
  const cache = new Map<string, { at: number; verdict: Verdict }>();
  const inFlight = new Map<string, Promise<Verdict>>();

  const cors = (request: Request): Record<string, string> => {
    const origin = request.headers.get('origin');
    if (!origin || !opts.allowOrigin) return {};
    const allowed = opts.allowOrigin === '*' || opts.allowOrigin.split(',').some((o) => o.trim() === origin);
    return allowed ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'origin' } : {};
  };

  return async (request) => {
    const headers = cors(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return failure({ code: 'bad_request', status: 405, message: 'POST a player address and a UTC day number.' }, { ...headers, allow: 'POST, OPTIONS' });

    const client = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
    if (!clientOk(`ip:${client}`)) return failure({ code: 'rate_limited', status: 429, message: 'Too many requests. Wait a minute and try again.' }, { ...headers, 'retry-after': '60' });

    let body: unknown;
    try {
      const text = await request.text();
      if (text.length > 1_000) throw new Error('too long');
      body = JSON.parse(text);
    } catch {
      return failure({ code: 'bad_request', status: 400, message: 'Send JSON: a player address and a UTC day number.' }, headers);
    }
    const req = parseRequest(body);
    if (!req) return failure({ code: 'bad_request', status: 400, message: 'Send a player address and a UTC day number.' }, headers);
    // only what was parsed goes on: whatever else the body carried (catches, progress, a "completed" flag) is dropped here
    const key = `${req.player}:${req.day}`;

    const v = verifier();
    if (!v) return failure({ code: 'not_configured', status: 503, message: 'Energy rewards are not switched on.' }, headers);

    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheMs) return respond(hit.verdict, headers);
    if (!playerOk(`player:${req.player}`)) return failure({ code: 'rate_limited', status: 429, message: 'Too many requests for this account. Wait a minute and try again.' }, { ...headers, 'retry-after': '60' });

    // one verification per player and day at a time: a burst of clicks is one read of the chain
    let pending = inFlight.get(key);
    if (!pending) {
      pending = authorize(v, req).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    const verdict = await pending;
    // an answer that came from a failed read is not worth repeating
    if (verdict.ok || verdict.code !== 'chain_unavailable') {
      cache.set(key, { at: now(), verdict });
      if (cache.size > 5_000) cache.delete(cache.keys().next().value as string);
    }
    return respond(verdict, headers);
  };
}

function respond(verdict: Verdict, headers: Record<string, string>): Response {
  return verdict.ok ? json(200, { authorization: verdict.authorization }, headers) : failure(verdict, headers);
}

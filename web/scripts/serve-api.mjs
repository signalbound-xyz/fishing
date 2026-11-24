#!/usr/bin/env node
// Runs the reward verifier (api/daily-reward.js, the same file Vercel serves) on this machine, for development
// and for rehearsals against a fork. It reads the same environment as the deployed function (DAILY_REWARDS.md):
//
//   DAILY_REWARD_SIGNER_KEY=0x… DAILY_REWARD_RPC_URL=http://127.0.0.1:8545 DAILY_REWARD_CONTRACT=0x… pnpm api:dev
//
// and the game's dev server reaches it with DAILY_REWARD_PROXY=http://127.0.0.1:8787 pnpm exec vite.
// The key is a verifier key made for this, never a wallet that holds anything.
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 8787);
const { default: fn } = await import('../api/daily-reward.js');

createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const out = await fn.fetch(new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined }));
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (e) {
    console.error('[api]', e);
    res.writeHead(500).end();
  }
}).listen(port, '127.0.0.1', () => console.log(`[api] daily reward verifier on http://127.0.0.1:${port}/api/daily-reward`));

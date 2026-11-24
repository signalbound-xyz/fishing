#!/usr/bin/env node
// Runs the operator's keeper (api/keeper.js, the same file Vercel serves) from this machine: one pass, a loop, or
// a drain before a change of rules. It reads the same environment as the deployed function (KEEPER.md):
//
//   pnpm keeper --dry-run              look and report: needs no key, sends nothing
//   pnpm keeper                        one pass: record the season hunt's hits, reel in casts about to expire
//   pnpm keeper --watch [seconds]      a pass every minute (or every `seconds`), until stopped
//   pnpm keeper --drain [--from N]     reel in every cast in the water, pass after pass, until it is still
//
// The key comes from the environment and from nowhere else, for example from a git-ignored file:
//   set -a && . ./.env.keeper.local && set +a && pnpm keeper --watch
// It is a gas wallet made for this, never a wallet that owns anything.
import { randomBytes } from 'node:crypto';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const after = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

const dry = has('--dry-run');
const drain = has('--drain');
const from = after('--from');
const every = has('--watch') ? Math.max(5, Number(after('--watch')) || 60) : 0;
if (from !== undefined && !/^\d+$/.test(from)) {
  console.error('--from takes a block number');
  process.exit(2);
}
if (!dry && !process.env.KEEPER_KEY) {
  console.error('KEEPER_KEY is not set: run with --dry-run to look only, or put the keeper\'s key in the environment');
  process.exit(2);
}

// the handler wants a bearer token; this process is both the scheduler and the function, so it makes its own
process.env.CRON_SECRET ??= randomBytes(24).toString('hex');
// from a terminal there is no ten-second limit to fit in
process.env.KEEPER_BUDGET_MS ??= drain ? '240000' : '50000';
const { default: fn } = await import('../api/keeper.js');

const query = new URLSearchParams();
if (dry) query.set('dry', '1');
if (drain) query.set('drain', '1');
if (from) query.set('from', from);

async function pass() {
  const res = await fn.fetch(new Request(`http://localhost/api/keeper?${query}`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
  const body = await res.json();
  if (!res.ok) {
    console.error(`[keeper] ${res.status}: ${body?.error?.message ?? 'failed'}`);
    return null;
  }
  const { hunt, casts, water } = body;
  console.log(
    `[keeper] block ${body.head}${body.dryRun ? ' (dry run)' : ''} · hunt: ${hunt.attempts} attempt(s) in ${hunt.seasons} season(s), ${hunt.hits} hit(s), ${hunt.settled} recorded, ${hunt.waiting} waiting` +
      ` · casts: ${casts.seen} in the water seen, ${casts.reeled} reeled in, ${casts.expired} expired, ${casts.left} left` +
      (water ? ` · water: ${water.inWater} cast(s)${water.paused ? ', casting paused' : ''}` : '') +
      (body.failed ? ` · ${body.failed} FAILED` : '') +
      (body.skipped ? ` · ${body.skipped} left for the next pass` : ''),
  );
  for (const note of body.notes) console.log(`         ${note}`);
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (drain && !dry) {
  // pass after pass: a cast made a moment ago can be reeled in two blocks later
  let failed = false;
  for (let i = 0; i < 20; i++) {
    const r = await pass();
    if (!r) {
      failed = true;
      break;
    }
    if (!r.water) {
      console.log('[keeper] this game does not count its casts: the pass above reeled in what it found');
      break;
    }
    if (r.water.inWater === 0) {
      console.log(r.water.paused ? '[keeper] the water is still' : '[keeper] no cast is in the water right now, but casting is not paused');
      break;
    }
    if (r.casts.reeled + r.casts.expired === 0 && r.casts.left === 0) {
      console.log('[keeper] casts remain that this pass could not find: they are older than the range it looked at, try --from <block>');
      failed = true;
      break;
    }
    await sleep(3_000);
  }
  process.exit(failed ? 1 : 0);
} else if (every) {
  console.log(`[keeper] a pass every ${every} s; Ctrl-C stops it`);
  for (;;) {
    await pass().catch((e) => console.error('[keeper]', e?.message ?? e));
    await sleep(every * 1000);
  }
} else {
  const r = await pass();
  process.exit(r && !r.failed ? 0 : 1);
}

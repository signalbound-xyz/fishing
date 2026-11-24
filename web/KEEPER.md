# The keeper

A small service of the operator that sends, for the players, the two transactions that are lost when nobody sends
them in time. It is built and rehearsed on a local chain; **it runs nowhere yet**: it has no key and no schedule
until the operator gives it both ("Switching it on").

| | What is lost without it | What the keeper sends |
|---|---|---|
| Season Hunt | A seasonal cast that hooked the season's fish counts only once `SeasonHunt.settle` has recorded it, within the season's settle window (an hour in season 0). The player's page does that; a closed tab does not. | `settle(season, attempt, proof)` for every attempt that hit and can still take the catch |
| Ordinary casts | A cast is landed by `reel` for as long as the game can read the hash of its randomness block: 8,191 blocks on Fluent from release 004, 256 before it. After that the fish is gone. | `reelFor(player)` for every cast with fewer than `KEEPER_RESCUE_BLOCKS` left |
| Still water | Rules that decide a catch may only change while no cast is in the water (`contracts/UPGRADES.md`, "Still water"). | with `--drain`: `reelFor` for every cast in the water |

Code: `src/server/keeper.ts` (the logic, no I/O of its own), `keeperChain.ts` (the chain and the drand relays),
`keeperHttp.ts` (the endpoint), `keeperEntry.ts` → `api/keeper.js` (the bundle Vercel serves, committed like
`api/daily-reward.js`; `pnpm test` fails when it is stale), `scripts/keeper.mjs` (`pnpm keeper`).

## What the key can do

Both calls are open to anyone on the contracts and neither can change a result. The randomness of an attempt and
of a cast is fixed when they are made; a hit is recorded for the player who cast it, and a fish goes to the player
who cast for it. So the keeper's key is a **gas wallet** and nothing else:

- it owns nothing in the game and has no role on any contract;
- it cannot choose who wins: an earlier hit always takes the catch over, whoever records what first;
- a stolen key is worth the gas in its wallet. Nothing needs revoking on the chain: move the rest of the gas out
  and make a new key.

What the keeper decides is only *when* to pay gas. That is why the endpoint is closed to strangers (below).

## How a pass works

One call is one pass. A pass reads the chain, sends what is due and returns a report; it keeps nothing between
passes except, on a warm instance, the list of attempts already known to have missed.

**The hunt.** For every funded season whose hits can still be recorded, the pass reads the seasonal casts from the
hunt's log and decides off the chain which of them hit, with the contract's own arithmetic
(`keccak256(randomness, chain, hunt, season, attempt, player) % 1e9 < chance`, `src/game/hunt.ts`). The beacon is
read once per drand round, not once per attempt. A hit found that way is put to the contract's own `outcome`
before anything is sent; a disagreement is reported in the pass's notes and never acted on. Hits are recorded
lowest attempt first, and an attempt later than the recorded catch is skipped: it could not win.

**Casts.** The pass reads `Casted` events of the last reel window (5,000 blocks per query), asks the game which of
those casts are still in the water, and reels in the ones with fewer than `KEEPER_RESCUE_BLOCKS` blocks left. The
window is asked of the chain: 8,191 where the game is release 004 or later and the block-hash history contract
(EIP-2935) answers, 256 otherwise. On release 003, which Fluent Testnet runs today, it is 256 although the
history is there: that game does not ask it. The keeper notices the upgrade by itself.

**Out of time.** A pass stops sending when `KEEPER_BUDGET_MS` is used up and reports what it left; the next pass
does it. Two passes at once on one instance are refused (409).

**Draining.** `?drain=1` (or `pnpm keeper --drain`) reels in every cast that can be reeled, not only the old
ones. `pnpm keeper --drain` repeats the pass until the game's own count, `castsInWater`, is zero. An expired
cast is reeled in too (it lands nothing, and leaves the count). `--from <block>` looks further back than one
reel window, for casts older than that.

## The endpoint

```
GET /api/keeper              one pass
GET /api/keeper?dry=1        look and report, send nothing
GET /api/keeper?drain=1      reel in every cast in the water
```

Every call must carry `Authorization: Bearer <CRON_SECRET>`.

| Status | Meaning |
|---|---|
| 200 | the pass's report: `hunt` (seasons, attempts, hits, settled, waiting, late, mismatches), `casts` (seen, reeled, expired, left, window), `water`, `operator` (address and balance), `failed`, `skipped`, `notes` |
| 401 | no bearer token, or a wrong one |
| 409 | a pass is already running on this instance |
| 502 | a read of the chain failed: nothing was decided, the next pass starts over |
| 503 | `CRON_SECRET` is not set: the keeper is switched off. This is its state on any deployment where the variable was never set |

Without `KEEPER_KEY` every pass is a dry run, and its notes say so. The report warns when the operator's balance
falls under 0.002 ETH.

## Environment

Read by the function at run time. None of them is a `VITE_` variable, so none of them reaches the page's bundle.

| Variable | Required | Default | |
|---|---|---|---|
| `CRON_SECRET` | yes | | the bearer token of the endpoint. Secret. Vercel Cron sends it by itself once it is set |
| `KEEPER_KEY` | to send | | the gas wallet's private key (`0x` and 64 hex digits). Secret |
| `KEEPER_CHAIN_ID` | | `20994` | a chain in `deployments/`, unless the addresses are given below |
| `KEEPER_RPC_URL` | | the network's public RPC | |
| `KEEPER_GAME` | | `game` of `deployments/<chainId>.json` | |
| `KEEPER_HUNT` | | `seasonHunt` of `deployments/<chainId>.json` | |
| `KEEPER_START_BLOCK` | | `startBlock` of the deployment | nothing is looked for below it |
| `KEEPER_RESCUE_BLOCKS` | | 900 with the 8,191 window, 96 with 256 | a cast is reeled in once fewer blocks than this are left |
| `KEEPER_BUDGET_MS` | | `7000` | how long a pass may keep sending; a Vercel function has ten seconds unless it is given more |

### The key

- Make a new key for this and nothing else, a different one per network.

  ```bash
  cast wallet new
  ```

- Send its **address** a little gas. On Fluent Testnet a `settle` with a drand proof is about 210,000 gas and a
  `reelFor` about 250,000.
- Its **private key** goes into the host's environment (Vercel: Project Settings → Environment Variables,
  Production only, marked Sensitive) or, for `pnpm keeper` on a machine, into a git-ignored file such as
  `web/.env.keeper.local`. Nowhere else: not into `.env.local`, not into `contracts/.env`, not into a chat or a
  commit.
- It must not be the owner's key, the daily reward verifier's key or a wallet that holds anything.

## Switching it on

None of this is done. Each step is the operator's decision.

1. Make the key and fund its address (above).
2. Set `CRON_SECRET` (any long random string) and `KEEPER_KEY` in the host's environment and redeploy.
3. Check by hand that it answers and refuses:

   ```bash
   curl -s https://<site>/api/keeper?dry=1
   ```

   Expected: 401. With `-H "Authorization: Bearer <CRON_SECRET>"`: the report of a dry run.
4. Give it a schedule. One of:

   - **Vercel Cron**, in `web/vercel.json`. A pass every minute needs a plan that allows it; on the Hobby plan a
     cron may run once a day, and a deployment with a more frequent one is refused, which is why the file is not
     in the repository.

     ```json
     { "crons": [{ "path": "/api/keeper", "schedule": "* * * * *" }] }
     ```

   - **Any scheduler that can send a header** (a hosted cron service, a CI schedule, a server's crontab): `GET
     https://<site>/api/keeper` with the bearer token, every one to five minutes.
   - **A process on a machine that stays on**, with no Vercel function at all:

     ```bash
     set -a && . ./.env.keeper.local && set +a && pnpm keeper --watch
     ```

**How often.** A hit must be recorded within the season's settle window after its cast, and a cast must be reeled
in before its window ends. With an hour to settle and 900 blocks of rescue margin (about a quarter of an hour on
Fluent), a pass every five minutes is enough and every minute is comfortable. A scheduler that can be half an hour
late needs a larger `KEEPER_RESCUE_BLOCKS`.

**Switching it off:** remove the schedule, or unset `CRON_SECRET`. Players lose nothing they had before the
keeper existed: their own pages still settle and reel.

## From a terminal

```bash
pnpm keeper --dry-run              # look and report: needs no key, sends nothing
pnpm keeper                        # one pass
pnpm keeper --watch [seconds]      # a pass every minute (or every `seconds`), until stopped
pnpm keeper --drain [--from N]     # reel in every cast in the water, pass after pass, until it is still
```

It runs the same `api/keeper.js` and reads the same environment.

## Tests and rehearsals

- `src/server/keeper.test.ts`, 39 tests against a fake chain: hits recorded lowest first, an earlier hit taking a
  recorded catch over, attempts whose round does not exist yet, late ones, a disagreement with the contract, a
  hit recorded by someone else between the read and the send, casts rescued and drained, expired and uncounted
  casts, the time budget, the endpoint's refusals, the configuration.
- `src/game/release.test.ts`: the release is told from a real answer of the testnet's game, and the reel window
  is the long one only for a release that asks the history.
- `src/game/hunt.test.ts` replays `src/game/fixtures/hunt.json`: 45 attempts (19 of them hits) decided by the
  contract in `contracts/test/SeasonHunt.t.sol` (`WRITE_VECTORS=true` rewrites the file). The keeper's arithmetic
  must give the same answer for each.
- `pnpm live:read` (`live/chain.live.ts`) asks a live network, reading only: the keeper's dry run, and the hunt's
  recent attempts decided by the keeper and by the contract's `outcome`.
- **A local chain (anvil), 24 November 2026**, with the repository's deployment scripts and the keeper running as
  `pnpm keeper --watch 5` on its own key. Eight wallets made seasonal casts in a season with the blockhash
  beacon; the contract named attempt 9 of the first 16 the only hit, and the keeper had recorded exactly that one
  (the `settle` came from the keeper's address) within ten blocks of the cast. Eight ordinary casts left in the
  water were reeled in by the keeper when their margin was reached. Then the still-water procedure: with five
  casts in the water a change of rules was refused (`WaterNotStill`), casting was paused, a new cast was refused
  (`CastingPaused`), `pnpm keeper --drain` reeled in the five, the change went through, casting was resumed and
  a cast went through. **Not exercised:** drand proofs sent by the keeper to a live network (the arithmetic and
  the proofs are tested separately, above), the Vercel function behind a real schedule, and the 8,191-block
  window on a local chain (anvil has no history contract; the window there is 256).

## Open risks

- **It is one process on one schedule.** A missed hour is a missed hit. Monitoring (the `keeper_run` log line,
  the `failed` and `mismatches` counters, the balance warning) is the operator's to set up.
- **The public RPC.** The keeper reads logs and state through one RPC; when it fails the pass fails whole (502)
  and nothing is decided on partial data.
- **The clock.** A drand round is chosen from the block's timestamp, as the contract does it, and the margin the
  contract adds covers the timestamp lag measured so far (`SEASON_HUNT.md`, "Randomness"). An attempt with fewer
  than twenty seconds of its settle window left is counted as late and not sent: the transaction would not be
  mined in time.
- **Tournament casts** are not the game's casts and the keeper does not reel them.

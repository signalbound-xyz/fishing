# Daily reward: +4 energy for a full day

A player who completes all three daily challenges of a UTC day can claim **+4 energy**, once for that day. This
file is how that is checked and paid on the contracts, what has to be deployed, and how it is switched on and off.
The challenges themselves are in [DAILY_CHALLENGES.md](DAILY_CHALLENGES.md).

**State of this release: implemented and tested in the repository, deployed nowhere.** No contract on any network
was touched. Until the steps under "Deployment" are done, the game on the contracts shows the challenges as before
and offers no claim.

## The rules

| | |
|---|---|
| Reward | 4 energy for all three challenges of a day. Nothing for one or two. No PEARL, no XP. |
| How often | once per player and UTC day |
| How | by hand: `Claim +4 Energy` in the Daily tab. Completing the day claims nothing. |
| Until when | the day itself and the UTC day after it; then it is gone |
| Full bar | the reward is added whole or not at all. With more than 16 of 20 energy the claim is refused and stays claimable: "Spend 2 energy to claim your full +4 reward." Regenerated energy counts. |
| Unchanged | the bar (20), regeneration speed, the regeneration period that is running, cast costs, the streak, mastery |
| The past | no day before the first day set at activation pays, ever |

## Who decides what

The three challenges of a day are not stored on the chain: they are a function of the player, the day and what the
player had when the day began, and progress is the player's `Caught` events of that day. A contract cannot read
past events, so somebody has to read them for it.

```
 browser                     verifier (serverless)                 chain
 ───────                     ─────────────────────                 ─────
 POST { player, day } ─────▶ reads firstDay / claimed / signers ◀── DailyRewards
                             reads the player's events of the day ◀─ FishingGame logs
                             reads the player as of the day's start ◀ FishingGame.playerOf @ block
                             rebuilds the set, counts progress
              ◀───────────── signs DailyReward(player, day, rules, amount, deadline)   (EIP-712)
 claimDailyReward(day, authorization) ───────────────────────────▶ DailyRewards: checks, records the day
                                                                    └▶ FishingGame.grantEnergy(player, 4)
```

- **The browser** asks with an account and a day number and nothing else. What it believes about the catches is
  not sent, because it would not be believed. Local saves, the telemetry log and the local game are never inputs.
  Before the wallet is asked to send anything, the page checks that the answer is for exactly this player, day,
  amount, chain and contract (`askVerifier`, `authorizationFits` in `src/game/dailyReward.ts`).
- **The verifier** (`src/server/`) decides whether the day is complete. It uses the game's own code for it
  (`generateDaily`, `setProgress` from `src/game/daily.ts`), so it cannot drift from what the Daily tab shows.
- **The contract** (`contracts/src/DailyRewards.sol`) trusts the verifier's signature for one thing only: "this
  player completed this day". Everything else it enforces itself, whatever was signed.
- **The game** (`FishingGame.grantEnergy`) keeps the energy. It settles regeneration first, adds the amount whole
  or reverts, and leaves the regeneration timer where it was. Only the address in `energyGranter` may call it.

### What the contract enforces by itself

`claimDailyReward(uint256 day, Authorization a)`, in this order:

| Check | Error |
|---|---|
| rewards are on and `day` is not before `firstDay` | `NotActive` |
| the day has begun | `DayNotStarted` |
| today is that day or the next | `DayExpired` |
| the authorization's deadline has not passed | `AuthorizationExpired` |
| the amount is exactly `ENERGY` (4) | `WrongAmount` |
| this player has not claimed this day | `AlreadyClaimed` |
| the signature is over this caller, this day, these terms, this contract, this chain | recovers another address, so `UnknownSigner` |
| the signer is on the list right now | `UnknownSigner` |
| the bar has room for all 4 (in the game, after regeneration is settled) | `EnergyFull` |

Then the day is recorded (one bit per day in `_claimed[player]`), the game adds the energy, and
`DailyRewardClaimed(player, day, amount, rules, signer)` is emitted. A revert at any point leaves nothing behind,
so a claim refused for a full bar can be sent again later with the same authorization or a new one.

What follows from the signed struct and the EIP-712 domain (name `Onchain Fishing Daily Rewards`, version `1`,
chain id, this contract's address): an authorization cannot be used by another wallet, for another day, for another
amount, on another chain or on another deployment, and after its use the day's bit stops it for good. Two claims
in one block: the second reverts.

### What the verifier checks

`authorize` in `src/server/dailyReward.ts`. It never throws; every refusal has a code.

1. The request is `{ "player": "0x…", "day": <integer> }`. Any other field is ignored.
2. The chain's head is read; if its time and the server's differ by more than two minutes, it refuses.
3. The day must be the chain's today or yesterday.
4. `DailyRewards` is asked: is the day on or after `firstDay`, is it unclaimed, is this verifier's key accepted.
5. Only blocks at least `DAILY_REWARD_CONFIRMATIONS` (5) under the head count.
6. The player's `Caught`, `LocationUnlocked` and `RodBought` events from the first block of the day to its last
   (or to the safe head) are read with `eth_getLogs`, filtered by the game's address and the player's topic. A log
   marked removed, outside the range, of another address or another player is dropped; a fish id counts once.
7. The player's open waters and rods **as of the start of the day** are the player's state at the safe block minus
   that day's unlock and purchase events. The set is drawn from that, as the client draws it.
8. Progress is counted. All three done: it signs, with a deadline `DAILY_REWARD_TTL_SECONDS` (10 minutes) ahead,
   never later than the end of the claim window.

| HTTP | `error.code` | Meaning |
|---|---|---|
| 200 | | `{ "authorization": { player, day, rules, amount, deadline, chainId, contract, signer, signature } }` |
| 400 | `bad_request`, `day_not_started` | not an address and a day; a day that has not begun |
| 409 | `not_active`, `already_claimed` | before the first day or switched off; claimed already |
| 410 | `day_expired` | older than yesterday |
| 422 | `incomplete` | not all three; `error.progress` is `{ done, of }` |
| 429 | `rate_limited` | too many requests |
| 503 | `chain_unavailable`, `signer_not_accepted`, `not_configured` | RPC failed or disagreed; the key is not on the contract's list; no key in the environment |

An RPC error, a timeout or an answer that does not add up is a refusal, never a guess. A reorg deeper than the
confirmations could make the verifier sign for a day whose catches then disappear; on Fluent, with one sequencer,
that is not expected, and the damage is bounded as described under "What the key can do".

The endpoint (`src/server/http.ts`) accepts `POST` with JSON of at most 1,000 characters, limits requests per
client address (30 a minute) and per player (10 a minute), answers a burst of identical requests with one chain
read, repeats a verdict for 4 seconds, sends `cache-control: no-store`, and sends CORS headers only for an origin
named in `DAILY_REWARD_ALLOW_ORIGIN`. The limits live in the memory of one function instance; see "Open risks".

## What the key can do

The verifier's key can make `DailyRewards` add energy without the day being complete. Within these limits, which
the contract enforces and the key cannot change:

- 4 energy per player per day, for today and yesterday only, never over the bar of 20;
- nothing before `firstDay`, nothing while rewards are off;
- no PEARL, no fish, no XP, no other state.

So a stolen key is worth free casts: at most 8 energy per account at the moment of theft and 4 a day after, until
it is revoked. It cannot be used to take anything from a player. The owner's key is a different matter (it owns
the game); `activate` refuses to make the owner's address a signer.

## Environment

Read by the function at run time. None of them is a `VITE_` variable, so none of them reaches the page's bundle.

| Variable | Required | Default | |
|---|---|---|---|
| `DAILY_REWARD_SIGNER_KEY` | yes | | the verifier's private key (`0x` and 64 hex digits). Secret. |
| `DAILY_REWARD_CHAIN_ID` | | `20994` | must be a chain in `deployments/` |
| `DAILY_REWARD_RPC_URL` | | the network's public RPC | an RPC with logs and historical state (`eth_call` at a past block) |
| `DAILY_REWARD_CONTRACT` | | `dailyRewards` of `deployments/<chainId>.json` | the `DailyRewards` address |
| `DAILY_REWARD_CONFIRMATIONS` | | `5` | blocks under the head that count |
| `DAILY_REWARD_TTL_SECONDS` | | `600` | life of an authorization, 30 to 3600 |
| `DAILY_REWARD_ALLOW_ORIGIN` | | none | one more origin allowed from a browser, or `*` |

For the page: `VITE_DAILY_REWARD_API` (build time, optional) is the verifier's URL when it is not
`/api/daily-reward` on the page's own origin. For local development: `DAILY_REWARD_PROXY` makes the Vite dev server
forward `/api` to a verifier started with `pnpm api:dev`.

Without `DAILY_REWARD_SIGNER_KEY` the function answers 503 `not_configured` and signs nothing. That is its state
on any deployment where the variable was never set.

### The key

- Make a new key for this and nothing else. It never holds funds and never sends a transaction.

  ```bash
  cast wallet new
  ```

- Its **address** goes to the contract (`SIGNER=` in `activate`). Its **private key** goes into the host's
  environment (Vercel: Project Settings → Environment Variables, Production only, marked Sensitive) and nowhere
  else: not into `.env.local`, not into `contracts/.env`, not into a chat or a commit. `.env.example` lists the
  names with no values.
- A different key per network.
- **Rotation**: add the new address (`setSigner(new, true)`), change the environment variable and redeploy, then
  remove the old address (`revoke`). In between both are accepted.
- **Revocation** is immediate: an authorization the old key already signed stops working at the next block.

## Deployment

Nothing here was run against a live network. Each step that sends a transaction needs the owner's key and is the
owner's decision; steps 4 and 6 are the ones that make rewards real.

1. **Preflight** (`contracts/UPGRADES.md`): `cd contracts && ./preflight.sh fluent_testnet`.
2. **Upgrade the game** to the version with `grantEnergy`. The hook does nothing until step 6: `energyGranter` is
   zero after the upgrade.

   ```bash
   TARGET=game forge script script/Upgrade.s.sol --rpc-url fluent_testnet --broadcast --private-key <owner key>
   ```

   Then record the release as usual (`./release.sh record fluent_testnet`, `./release.sh verify fluent_testnet --source`).
3. **Deploy `DailyRewards`**, switched off (no signer, no first day, the game does not listen to it). The script
   writes its address into `deployments/<chainId>.json`.

   ```bash
   forge script script/DailyRewards.s.sol --sig "deploy()" --rpc-url fluent_testnet --broadcast --private-key <owner key>
   ```

4. **The verifier.** Regenerate what embeds the address, and commit it together with `deployments/`:

   ```bash
   cd web && pnpm sync && pnpm build:api
   ```

   On Vercel the project's Root Directory must be `web`, so that `web/api/daily-reward.js` is its `api/` directory;
   Vercel then serves it at `/api/daily-reward` on the Node.js runtime and installs `viem` from `package.json`.
   The file is a bundle generated from `src/server/entry.ts` and committed, because Vercel does not bundle a
   function's relative imports; `pnpm test` fails when it is stale. Set `DAILY_REWARD_SIGNER_KEY` and deploy.
   Check that it answers and refuses:

   ```bash
   curl -s -X POST https://<site>/api/daily-reward -H 'content-type: application/json' -d '{"player":"0x0000000000000000000000000000000000000001","day":1}'
   ```

   Expected now: `signer_not_accepted` or `not_active` (503 or 409). `not_configured` means the key is not set.
5. **Decide the first day.** A UTC day number, unix time / 86400: today or later, at most 30 days ahead. Days
   before it never pay, so choosing tomorrow means nobody is paid for a day that was half over at activation.

   ```bash
   echo $(( $(date -u +%s) / 86400 + 1 ))
   ```

6. **Activate.** One run: the signer is accepted, the first day is set, and last the game starts listening.

   ```bash
   SIGNER=<verifier address> FIRST_DAY=<day> forge script script/DailyRewards.s.sol --sig "activate()" --rpc-url fluent_testnet --broadcast --private-key <owner key>
   ```

   `--sig "status()"` prints what is set and sends nothing.
7. **The page** needs no switch. It reads `firstDay` from the contract: before that day it says when rewards
   begin, from that day it shows the preview and the claim.

### Switching it off

From the fastest and mildest to the hardest. Each is undone by doing step 6 again or setting the variable back.

| What | How | Effect |
|---|---|---|
| Stop issuing | remove `DAILY_REWARD_SIGNER_KEY` on the host and redeploy | no new authorization. Ones already issued live for at most 10 minutes. No key needed, no transaction. |
| Revoke the verifier | `SIGNER=<address> … --sig "revoke()"` | that key's authorizations stop at once, issued ones included |
| Stop all claims | `… --sig "stop()"` (`setFirstDay(0)`) | every claim reverts with `NotActive`; the page stops offering one |
| Detach the game | `… --sig "detach()"` (`setEnergyGranter(0)`) | the game adds no energy for anyone, whatever is signed or deployed |

Energy that was already claimed stays with the player; there is nothing to roll back. A reward that could not be
claimed while rewards were off is claimable again if they come back within its window, and lost otherwise.

## The local game

`VITE_GAME_MODE=local` has the same rule with the save as its book: `claimDailyReward` in `src/game/actions.ts`.
Today's completion is read off the day itself; when the day turns, a completed day is written into
`save.daily.rewards.earned`, so yesterday's reward is still there today; claimed days are in
`save.daily.rewards.claimed`. A save from before this release loads unchanged and gains an empty book. The first
paying day is `DAILY_REWARD.localFirstDay` (20781, 24 November 2026). The panel says "Local game reward: kept in
this browser, not on chain", and nothing of the local game is ever sent to the verifier.

## Tests and rehearsals

| | |
|---|---|
| `contracts/test/DailyRewards.t.sol` | 36 tests: exactly four, never over the bar (fuzz), a full bar refuses and keeps the claim, once per day, two claims in one block, each day once, yesterday until its last second, before the first day, expired authorization, another wallet, another day, another chain, another contract, an unknown key, changed terms, malformed and high-s signatures, revoked and rotated signers, owner-only setters, only the granter adds energy, the regeneration timer |
| `contracts/test/Upgrade.t.sol` | the world played on the released bytecode, upgraded, and a claim made: only energy moves |
| `contracts/test/UpgradeFork.t.sol` | a fork of Fluent Testnet upgraded by the real script, the rewards deployed and activated by theirs; a newcomer and known players claim |
| `src/game/dailyReward.test.ts` | the status rules, the local game's reward, the typed data against vectors written by the Solidity tests (same digest, same signature), the page's request to the verifier |
| `src/server/dailyReward.test.ts` | the verifier: forged request fields, other players' and other days' catches, duplicates, removed logs, confirmations, the profile at the day's start, every refusal, RPC failures, the endpoint and its limits |

End to end, on a local fork of Fluent Testnet (anvil; nothing was sent to the network): the game upgraded with
`script/Upgrade.s.sol`, `DailyRewards` deployed and activated with `script/DailyRewards.s.sol`, the committed
`api/daily-reward.js` run against the fork with a throwaway key. A new account was refused with no catches and with
a request that claimed completion, fished at the pond, was authorized after 12 casts, was refused at 18/20
(`EnergyFull`), spent two energy and claimed: 16 → 20, nothing else of the player changed, 77,808 gas. The same
authorization from another wallet, for another day and for another amount was refused by the contract; a second
use reverted with `AlreadyClaimed`, and the verifier answered `already_claimed`.

Not tested, because it needs a deployment: the function on Vercel itself, and a claim through Fluent Connect in a
browser.

## Open risks

- **The verifier is trusted** for "the day is complete", within the limits above. It is one key on one host.
- **The owner is one key.** It can upgrade the game, change signers and point `energyGranter` anywhere; whoever
  holds it can grant energy without any of this. A timelock or a multisig is not part of this release.
- **Rate limits are per function instance** and in memory: several instances each count for themselves, and a new
  instance starts from zero. They keep one client from hammering the RPC; they are not an abuse barrier. Every
  request costs RPC reads, so a determined flood costs RPC quota and nothing else, since a refusal signs nothing.
  A shared store (Vercel KV, Upstash) or the host's firewall rules would be the next step.
- **The RPC is trusted** by the verifier. A lying RPC could show catches that are not there. Use an endpoint you
  trust; the public one is the default.
- **The client's rules and the verifier's are one file**, but two builds: a page cached from before a rules change
  could show a set the verifier no longer agrees with. `rules` (the version of the challenge rules) is in the
  signed struct and in the event, so such a period can be found afterwards.
- **A player who changes rods or opens a water outside the events the verifier reads** (an owner grant without
  `LocationUnlocked` / `RodBought`) could get a different set from the verifier than from another device. The
  same limit as in DAILY_CHALLENGES.md.
- **`FishingGame` has 888 bytes left** under the size limit after this change. See `contracts/UPGRADES.md`.
- **Not audited.**

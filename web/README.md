# Onchain Fishing — web client

Browser frontend for the contracts in `../contracts` (FishingGame, Tournaments, FishNFT, PearlToken, PearlExchange, Marketplace).
Stack: Vite + TypeScript + viem, no UI framework (plain DOM + canvas).

## Two modes, one set of rules

- **On the contracts.** With a deployment in `../deployments/<chainId>.json` the game plays on Fluent: every
  action is a transaction, and the player's state is read from the chain through `GameLens` and shown with the
  same UI. Sign-in is Fluent Connect.
- **Local.** Without a deployment (or with `VITE_GAME_MODE=local`) the same rules run in the browser on a
  `localStorage` save: no transactions, no RPC. Useful for trying the game and for balance work.

`src/play/ops.ts` is the seam: each operation has a local implementation (a pure reducer) and a contract one
(a transaction, then a fresh read). `src/play/chain.ts` maps chain state onto the local `Save` shape and, at
start-up, compares the client's catalog with the contracts' and warns if a number has drifted.

One difference is deliberate. Locally the hook and the reel fight decide whether the fish is landed and how good
it is. On the contracts the fish, its weight and its quality are rolled by the contract (a client-reported result
could be forged). The client works the pending outcome out as soon as its block exists
(`src/game/chainOutcome.ts`, checked against vectors produced by the contract), plays a real bite, hook and fight
on it, and settles afterwards; a lost fight there is a retry, not a lost fish. The reasoning, the trust model and
the randomness review are in [../ARCHITECTURE.md](../ARCHITECTURE.md).

```sh
pnpm install
pnpm dev          # http://localhost:5180
pnpm test         # unit tests of the game rules (vitest)
pnpm sim          # balance simulation, rewrites BALANCE.md
pnpm sim:audit    # balance audit and experiments, rewrites BALANCE_AUDIT.md
pnpm sim:daily    # what a day's three challenges cost, rewrites the table in DAILY_CHALLENGES.md
```

## Local game

Loop: pick a location → equip a rod and a lure → cast → wait for the float → **Hook!** → hold to keep the fish
inside the zone → the fish lands with a species, weight and quality grade (D–S) → keep it or sell it for PEARL →
buy tackle → rarer fish, new waters.

- **Rods** widen the reel zone (catch), **lures** raise the bite chance (catch); both add rarity and weight.
  Rarity is a relative weighting of rarer species, not percentage points. Location bonuses apply only at their
  locations. All of it is summed in `game/equipment.ts`.
- **Price** = base price × weight factor × quality. **Tournament score** = rarity points × weight factor (0.7–1.5)
  × quality, fixed when the fish lands; selling keeps the points.
- **Special fish** (Golden Koi, Ancient Catfish, Ghost Fish) are very rare, open a new water for good and carry a
  passive bonus (one active slot, needs a specimen in hand). They are local collectibles, not NFTs.
- **Buying access** (local game only): the three secret waters can also be opened for PEARL once the player has
  the level: Golden Lake 2,500 from level 5, Ancient Swamp 5,000 from level 8, Phantom Waters 10,000 from
  level 12 (`purchase` on the location in `game/content.ts`, `buyLocation` in `game/actions.ts`). The level alone
  opens nothing, the special fish still opens its water for free at any level, and buying grants neither the fish
  nor its bonus. The contracts have no such purchase yet, so on the contracts the offer is not shown.
- **Weekly cup**: the ten best catches of the week. Weeks roll over Thursday 00:00 UTC, the same as the
  contract's `currentWeek()`. Opponents are generated and labelled DEMO; no rank rewards are paid.
- **Saved fish and the Trophy Room**: one action, the star on a fish (☆ Save / ★ Saved), on a keepnet card and on
  the card of a fresh catch. A saved fish is kept out of every sale until the star is removed, and every saved fish
  hangs in **My Trophy Room** at the top of the Trophies tab: no slots, no limit, no second list. The room is a
  view of the keepnet (`trophyFish`, `pageOf` in `game/favorites.ts`): sorted (newest, rarest, heaviest, most
  valuable), filtered by rarity and location, and drawn twelve at a time with Load more, so a large room is never in
  the page whole. Each frame has one button, ★ Remove from favorites; the fish stays in the keepnet. The star means
  saved; a personal record wears a medal. Special fish can be saved like any other, which changes nothing about
  their bonus or unlock; their own section follows the room. The rules are in `game/actions.ts` (`toggleFavorite`,
  `sellFish`). In the local game the star lives in the save. On the contracts it is a preference of this browser,
  per chain, fish collection and account (`play/prefs.ts`): it guards the game's own Sell buttons and nothing else.
  The fish is an NFT, the contracts know nothing of the star, and it does not stop a transfer or a trade outside the
  game. After every successful read of the keepnet a fish that is gone loses its star and leaves the room; a failed
  read changes nothing. The room used to be six frames filled by hand: what hung in one is a saved fish now, read
  from the old `showcase` field of the save and of the stored preferences wherever it is still found.
- **Location mastery**: three tiers per water (Explorer, Experienced Angler, Master), read from the encyclopedia
  and shown in the Collection tab. **Daily challenges**: three a day (easy, medium, hard), the same all day, new
  at 00:00 UTC, in the Daily tab and as a strip under the cast button. Mastery is a badge only. A full day of
  challenges earns +4 energy, claimed by hand in the Daily tab, once per UTC day, never over the bar and never
  PEARL. Rules, where progress comes from in each mode, what a day costs and the limits:
  [DAILY_CHALLENGES.md](DAILY_CHALLENGES.md). How the reward is verified and paid on the contracts, its verifier
  (a serverless function), its environment and how to switch it on and off: [DAILY_REWARDS.md](DAILY_REWARDS.md).
- Numbers and the reasoning behind them: [BALANCE.md](BALANCE.md). The audit of the current balance, the
  experiments with other numbers and the endgame proposal: [BALANCE_REVIEW.md](BALANCE_REVIEW.md), on top of the
  generated tables in [BALANCE_AUDIT.md](BALANCE_AUDIT.md).

### Trust

The local save is a JSON blob the player can edit: fine for a local game, worthless as evidence. On the contracts
nothing in the browser decides a catch, a balance or an unlock; the only client-side state there is cosmetic
(favourite stars, the last location picked).

## Wallets

- **Fluent Connect** ([`@fluent.xyz/connect`](https://www.npmjs.com/package/@fluent.xyz/connect)) — the
  "Connect with Fluent" button. The widget signs players in with a Fluent ID (a smart account, gas can be
  sponsored) or connects an External wallet through its own picker. Every game action is sent as a widget Batch
  operation (`src/fluent.tsx`, `src/tx.ts`). It needs, from the Fluent Dashboard:
  - `VITE_FLUENT_APP_ID` (`app_…`) and `VITE_FLUENT_PRIVY_CLIENT_ID` (`client-…`) in `web/.env.local`
    (see `.env.example`);
  - every page origin (e.g. `http://localhost:5180`) allow-listed for Direct login;
  - for sponsored gas: the app enabled for Sponsorship and Auth tokens.

  Players connect only through Fluent Connect; there is no other wallet option. On the contracts the connected account is the player; in the local game signing in is optional.

## Scripts

| Command          | What it does                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `pnpm sync`      | Copies ABIs from `../contracts/out/<Name>.sol/<Name>.json` and addresses from `../deployments/*.json` into `src/generated/` |
| `pnpm dev`       | `sync` + Vite dev server on port 5180                                                         |
| `pnpm build`     | `sync` + type check (`tsc`) + production build into `dist/`                                   |
| `pnpm typecheck` | type check only                                                                               |
| `pnpm test`      | unit tests of the game rules                                                                  |
| `pnpm sim`       | balance simulation (100k casts per loadout), writes `BALANCE.md`                              |
| `pnpm sim:audit` | balance audit and experiments (about two minutes), writes `BALANCE_AUDIT.md` and `sim/out/loadouts.csv` |
| `pnpm build:api` | bundles the reward verifier (`src/server`) into `api/daily-reward.js`; `pnpm test` fails when that file is stale |
| `pnpm api:dev` | runs the verifier on this machine (port 8787) with the environment of [DAILY_REWARDS.md](DAILY_REWARDS.md) |
| `pnpm sim:daily` | plays the daily challenge sets with a model player, writes the cost table in `DAILY_CHALLENGES.md` |

After changing the contracts: `forge build` (and redeploy if needed), then `pnpm sync`.
If `contracts/out` is missing, `sync` keeps the already generated files.

## Settings (Vite environment variables)

- `VITE_GAME_MODE` — `local` forces the local game even when a deployment exists.
- `VITE_CHAIN_ID` — chainId (default `20994`, Fluent Testnet; `25363` is Fluent mainnet); addresses are taken from `deployments/<chainId>.json`.
- `VITE_RPC_URL` — node RPC (default: the network's public RPC).
- `VITE_TELEMETRY` — `off` stops the gameplay telemetry from recording (it is on by default and stays in the browser).

## Gameplay telemetry

Balance work needs to know how people actually play, and a bot cannot say. The game records what happens at the
water and shows it on the **Play stats** page (`#/stats`, linked in the footer), where the log can be exported as
JSON or cleared.

- **What**: sessions (start, end, active length), casts (location, cost, tackle, energy left), bites and empty
  hooks, the hook (reaction time, window, missed or clean), every reel fight (landed, line snapped or slack; its
  length, the share of it in the green, the difficulty, which try it was), catches by rarity and quality, the bar
  running out of energy, purchases (rod, lure, repair, refill, access to a water, PEARL for BLEND), unlocks,
  level-ups and sales.
- **Where**: in this browser's `localStorage` only (`onchain-fishing:telemetry`, the newest 5,000 events). Nothing
  is sent to any server or third party, and no event holds a wallet address or any account data. Sharing the log is
  the player's own act: Export, then send the file.
- **Both modes**: every event is tagged `local` or `chain`, because the hook and the fight are the same in both and
  the contracts are where players are. The page can show either alone.
- **Apart from the rules**: nothing in `src/game` knows about it and nothing reads it back. The format and the
  summary are pure functions in `src/telemetry` (tested); `src/play/telemetry.ts` is the browser side; the UI calls
  it from `play/ui/pond.ts` and `play/ops.ts`.
- In the console: `fishingTelemetry.summary()`, `.log()`, `.export()`, `.clear()`.

What the page shows is measured from the person at the keyboard. What `pnpm sim` and `pnpm sim:audit` print is a
simulation with model players. The two are kept apart on purpose; see BALANCE_REVIEW.md for what to compare.

## Balance lab

`sim/lab.ts` plays whole careers and single sittings with the real rules: three model players (beginner, average,
experienced), either rule set (the contracts, where a lost fight is a retry, or the local game, where it is a lost
fish), a play pattern (from every other day to a check-in every four hours with refills) and a start (a new
player or one who owns everything). `sim/scenarios.ts` holds what the audit runs: alternative energy rules (cast
prices, bar size, refill price, payouts), reel difficulty curves, cups and mastery tiers. Edit it and run
`pnpm sim:audit`; nothing there changes the game or the contracts. `sim/lab.test.ts` (part of `pnpm test`) checks
the lab's bookkeeping against the rules: PEARL is conserved, energy never exceeds what the clock and the refills
give, the contract's quality roll is reproduced exactly.

## Structure

```
src/game/              the rules, pure TypeScript, no DOM and no storage
  content.ts           species, locations, special fish, tuning numbers
  equipment.ts         rod + lure + location + special bonuses, capped
  generate.ts          species odds (normalised), weight roll, special roll
  economy.ts           prices, XP, levels, repair and refill costs
  minigame.ts          hook window, bite delay and the reel fight as pure functions; model players
  chainOutcome.ts      what a pending cast will be, computed as the contract computes it
  tournament.ts        score, week boundaries, top ten, demo standings
  progress.ts          unlocks (permanent vs ownership), encyclopedia, achievements
  mastery.ts           location mastery: three tiers per water as a pure function of the encyclopedia
  daily.ts             daily challenges: the rules, the day's set (deterministic), progress, the local day
  dailyLog.ts          a player's day read from the game's events: folding, the day's first block, the streak
  dailyReward.ts       the reward for a full day: its rules, the claim window, the signed authorization (EIP-712)
  favorites.ts         saved fish and the Trophy Room as data: the room as a sorted, paged view; the stored preferences; reconciling
  actions.ts           every state change as (save, input) → new save
  save.ts              save shape, versioned migrations
  game.test.ts         unit tests
src/tackle/            rod and lure catalog, sprites, the shop page
src/play/              the local game's shell
  ops.ts               every operation, local or contract
  chain.ts             contract backend: reads via GameLens, transactions, catalog check
  state.ts             the current Save (localStorage in local mode, a view of chain state otherwise)
  fishSprite.ts        pixel fish drawn from shape parameters
  telemetry.ts         gameplay telemetry in the browser: the recorder over localStorage, what the UI reports
  daily.ts             daily challenges in the browser: the chain reader, its cache, what the UI shows
  dailyReward.ts       the reward in the browser: what the contract says, the claim (verifier, then one transaction)
  pending.ts, claims.ts  actions on their way (a claim is sent once, its button waits)
  prefs.ts             on the contracts: where the saved fish (the Trophy Room) are kept (per chain and account)
  ui/*.ts              pond, keepnet, daily, collection (with mastery), trophies (with trophyRoom), ranks, header, prize (the bottle reveal), stats
src/telemetry/         telemetry format, recorder and summary: pure, no DOM
src/server/            the daily reward verifier: the check (dailyReward.ts), the chain reads (chain.ts), HTTP (http.ts)
api/daily-reward.js    the verifier as one file for Vercel, generated by `pnpm build:api` and committed
sim/balance.sim.ts     balance simulation (BALANCE.md)
sim/lab.ts             the balance lab: model players, rule sets, careers day by day
sim/scenarios.ts       what the audit tries: energy rules, reel curves, cups, mastery tiers
sim/audit.sim.ts       the audit (BALANCE_AUDIT.md, sim/out/loadouts.csv)
sim/daily.ts           a model player fishing a day's three challenges; sim/daily.sim.ts writes the table
src/ui/tooltip.ts      hints that appear at once (data-tip), in place of the browser's slow title tooltip
src/tx.ts, errors.ts   simulate → send through Fluent Connect → receipt, readable revert messages
src/scene.ts           canvas water animation (both modes)
src/fluent.tsx         Fluent Connect widget (React island)
scripts/sync-abi.mjs   generates src/generated/* from ../contracts/out and ../deployments
```

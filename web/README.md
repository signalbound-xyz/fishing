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
on it, and settles afterwards. What a lost fight costs there depends on the game the network runs:

- **Up to release 004**, and on release 005 with no reel judge attached (Fluent Testnet today): a lost fight is a
  retry, each easier, and the third is hauled in. The fight is the floating-point one in `src/game/minigame.ts`
  and decides nothing.
- **Release 005 with a reel judge attached**: one fight per fish, in the integer machine the contract replays
  (`src/game/fight.ts`, the twin of `contracts/src/FightVerifier.sol`). The page records it and sends the
  recording with the settlement; a lost fight is sent too and the fish is gone, with nothing given for it. The
  page shows the rule before the cast, counts down before the fight starts, and plays no fish twice: the fight of
  a cast is remembered in this browser (`src/play/fightLog.ts`), so a reload in the middle of a fight comes back
  to a lost fish, not to a new try.

The page tells which rule a cast is under from the game's own answer for that cast (`castNeedsFight` in
`src/game/release.ts`), not from its build. The local game follows the stricter rule with the same machine: one
fight, and a lost one is a lost fish. The reasoning, the trust model, what the check does not prove (a script can
compute a recording that lands the fish) and the randomness review are in
[../ARCHITECTURE.md](../ARCHITECTURE.md).

```sh
pnpm install
pnpm dev          # http://localhost:5180
pnpm test         # unit tests of the game rules (vitest)
pnpm sim          # balance simulation, rewrites BALANCE.md
pnpm sim:audit    # balance audit and experiments, rewrites BALANCE_AUDIT.md
pnpm sim:daily    # what a day's three challenges cost, rewrites the table in DAILY_CHALLENGES.md
pnpm sim:reel     # what losing a fish for good does to landing rates, PEARL, XP and progress, rewrites REEL_BALANCE.md
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
| `pnpm build:api` | bundles the reward verifier and the keeper (`src/server`) into `api/daily-reward.js` and `api/keeper.js`; `pnpm test` fails when either is stale |
| `pnpm api:dev` | runs the verifier on this machine (port 8787) with the environment of [DAILY_REWARDS.md](DAILY_REWARDS.md) |
| `pnpm sim:daily` | plays the daily challenge sets with a model player, writes the cost table in `DAILY_CHALLENGES.md` |
| `pnpm sim:hunt` | plays Season Hunt seasons for crowds of 10 to 10,000 model anglers, writes the tables in `SEASON_HUNT_BALANCE.md` |
| `pnpm sim:reel` | compares the contracts before and after the reel judge (a lost fight is a retry / a lost fish) for three model players, writes `REEL_BALANCE.md` (about a minute) |
| `pnpm sim:week` | works out and plays the three hunts of the repository's week file for the same crowds, writes the weekly tables in `SEASON_HUNT_BALANCE.md` |
| `pnpm keeper` | the operator's keeper from a terminal: `--dry-run` looks and sends nothing, `--watch` repeats, `--drain` reels in every cast in the water ([KEEPER.md](KEEPER.md)) |
| `pnpm live:read` | asks the live network, reading only: the block-hash history the long reel window relies on, the deployed lens in the shape this build decodes, the keeper's dry run |
| `pnpm live:reel` | the reel fight end to end on a local chain (anvil): the page's own code against a fresh deployment; see "The reel fight end to end" below |
| `pnpm live` | the tournament rehearsal on a live network; sends transactions with the deployer's key (see the header of `live/cup.live.ts`) |

After changing the contracts: `forge build` (and redeploy if needed), then `pnpm sync`. From release 004 the
deployed `GameLens` belongs to one build of the game (it reads the game's storage by slot). The client asks the
game which release it is and reads either: release 003 (the player's view without the two fields 004 added, a
256-block reel window), 004, or 005 (`reel(bytes)`, one more word per cast, a lens that knows the reel judge;
`src/game/release.ts`; `pnpm live:read` says which the network runs). What it cannot do is read a new game
through an old lens: after an upgrade the lens address in `deployments/` changes,
and the client must be published again.
If `contracts/out` is missing, `sync` keeps the already generated files.

## Settings (Vite environment variables)

- `VITE_GAME_MODE` — `local` forces the local game even when a deployment exists.
- `VITE_CHAIN_ID` — chainId (default `20994`, Fluent Testnet; `25363` is Fluent mainnet); addresses are taken from `deployments/<chainId>.json`.
- `VITE_RPC_URL` — node RPC (default: the network's public RPC).
- `VITE_TELEMETRY` — `off` stops the gameplay telemetry from recording (it is on by default and stays in the browser).

## Season Hunt (`#/hunt`)

The competition in the navigation (Pond, Season Hunt, Tackle, Stats); the design is in
[../SEASON_HUNT.md](../SEASON_HUNT.md) and the odds in [SEASON_HUNT_BALANCE.md](SEASON_HUNT_BALANCE.md). It exists
in contract mode only and only where the deployment names a `seasonHunt`; otherwise the page says the hunt is not
deployed on this network.

- **A weekly season is three hunts**, each a season of the contract. Which seasons belong together comes from
  `src/generated/weeks.ts`, which `pnpm sync` builds from `../deployments/weeks/<chainId>/*.json` (written by the
  script that creates a week) and the week files in `../contracts/script/seasons/weeks/`. The grouping, every
  status and the countdown are pure functions in `src/game/week.ts`. Dates, prizes, winners and claims are read
  from `SeasonHunt.list` and never from the registry; a season no week claims is shown as a week of one hunt.
- The page shows the week (name, dates, pool, hunts concluded, a countdown to the next event), three hunt cards
  (target, difficulty, prize, days, status: Upcoming, Active, Pending finalization, Winner found, No winner), and
  for the selected hunt its rules, the odds of one cast with the tackle in hand and with every other rod, lure and
  water of its table, the catch while it is being decided, the winner and the claim. Completed weeks are in the
  archive below; a prize won and not yet claimed is offered at the top whichever week it is from.
- A cast is offered only for a hunt the contract reports as running and funded. The pond strip names the hunt
  and its place in the week ("hunt 2/3") and disappears between hunts.
- `?huntDemo=upcoming|monday|early|midweek|friday|finalizing|over` on a development server shows a made-up week
  in that state (`src/game/fixtures/weekDemo.ts`). It reads and sends nothing and is not in the production build.
- **Tournaments** are no longer in the navigation. The page is still routed at `#/cup` as "Legacy tournaments"
  and linked from the Season Hunt page, so results can be read and outstanding prizes claimed. The weekly
  leaderboard is "My week" under Stats, a personal record.
- Fishing happens at the pond. The gold strip under the Cast button switches the hunt on and off; with it on the
  button reads **Hunt cast** and the cast is sent to `SeasonHunt.cast` instead of `FishingGame.cast`. The rest of
  the cast is the ordinary flow.
- An attempt's result is the contract's (`outcome`), asked once the attempt's drand round exists; its signature
  is fetched from a public drand relay, and only the round number is sent there. A hit is recorded with one more
  transaction (`settle`), automatically, with a **Record the catch** button as the fallback. Attempts waiting for
  their result are kept in `localStorage` and found again from the contract's events after a reload.
- Odds are "1 in N" for a cast, computed with the contract's arithmetic (`src/game/hunt.ts`). The page does not
  show a chance of winning the season.

## My Stats (`#/profile`)

The player's fishing career: lifetime numbers, fishing by location, personal records, progress. The header shows
what is spent at the water (level, PEARL, energy); the lifetime numbers live here, behind the **Stats** link.

Every number has one of three sources, and the page does not mix them:

| What | On the contracts | Local game |
| --- | --- | --- |
| Fish caught, casts, catch rate, level and XP, waters unlocked | the player's state in `FishingGame` (`GameLens.playerView`) | the save (`stats`, `xp`, the unlocked locations) |
| Species discovered, fish caught per rarity (Legendary, Mythic), best weight per species | the encyclopedia in the same state: a count and a best per species | the save (`dex`) |
| Biggest fish overall and by location | the records in the same state | the save (`records`) |
| Mastery, collection achievements | computed from the encyclopedia (`game/mastery.ts`, `game/progress.ts`) | the same |
| Casts, catches, no-bite casts and species **by location** | the game's `Casted`, `Caught` and `Missed` events of the account | counters in the save (`career`), kept since they were added |
| Daily streak | the daily-challenge reader (`play/daily.ts`), as the Daily tab shows it | the save |
| Saved trophies | the keepnet as it is now, and this browser's stars | the save |

Nothing is taken from the keepnet for a lifetime number (a fish that was sold or sent away still counts), nothing
by location is guessed from the encyclopedia (a species lives in more than one water), and the telemetry log plays
no part.

**The history by location on the contracts** (`game/career.ts`, `play/career.ts`). The state does not keep where a
fish was caught, the events do. They are read from the game's first block (`startBlock` of the deployment) with
`eth_getLogs`, filtered by the player's topic, 90,000 blocks a query (the Fluent RPC refuses more than 100,000),
three queries at a time. The folded counts are cached in localStorage under
`onchain-fishing:career:<chainId>:<game>:<account>`, with the last block read and its hash, so the history is read
once per device and afterwards only the blocks since; another account, network or game contract has its own cache.
The read stops five blocks under the head, and only while the Stats page is open.

What makes the counts more than a hope: `casts` and `catches` in the contract move only together with `Casted` and
`Caught`, so after every read the sums are held against `playerOf(account)` **at the same block**. They are equal,
or the page says how many casts and catches no water could be named for. While a first read is on its way the page
shows its progress and calls nothing complete; a read that fails keeps what it had and resumes there; a cached end
block whose hash has changed (a reorg) throws the cache away and reads again; if the counters cannot be read the
counts are marked unchecked. A partial result is never shown as a lifetime total: the lifetime tiles come from the
state, not from the events.

**No indexer.** A player's whole history on Fluent Testnet is a handful of log queries (about two seconds for the
first visit at today's chain length, then one small query a visit), so a backend would add a service to run and
trust for nothing a browser cannot do. If the chain grows past what a first visit can read comfortably, the place
for it is behind `CareerReader` (four methods), without touching the page.

**Local game.** The save counts casts and catches by location from the day the counters were added
(`Save.career`, filled by `startCast` and `landFish`). An older save loads with an empty book: what was fished
before is in the lifetime totals and is shown as "not counted by water", never spread over the waters.

**Not shown, because nothing trustworthy records it:** time played and session length, fish that escaped on the
contracts (a lost fight is a cast without a catch there), where local catches made before the counters were
caught, and the past of the keepnet (how many fish were sold or sent away).

## Gameplay telemetry

Balance work needs to know how people actually play, and a bot cannot say. The game records what happens at the
water and shows it on the **Debug telemetry** page (`#/stats`, linked in the footer), where the log can be
exported as JSON or cleared. It is a debugging log of one browser, not the player's record: the player's own
numbers are on [My Stats](#my-stats-profile), which reads nothing from it.

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

## The reel fight end to end

`pnpm live:reel` (`live/reel.live.ts`) runs the fight between the page's own code and the contracts on a local
chain. It refuses any chain but 31337 and takes its key from `LIVE_KEY`, one of the well-known accounts anvil
starts with: never a key that holds anything.

```sh
anvil --block-time 1                                    # in one terminal
cd ../contracts
forge create test/Base.t.sol:MockBlend --rpc-url http://127.0.0.1:8545 --private-key <anvil key> --broadcast
BLEND_TOKEN=<the address it printed> forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --slow --private-key <anvil key>
cd ../web && LIVE_KEY=<anvil key> pnpm live:reel
rm ../deployments/31337.json                            # the local deployment is not part of the repository
```

A fresh deployment has the judge attached. The test casts, works out what bit and which fight it has to be landed
in with the code the page uses (`chainOutcome.ts`), plays the fight on the page's machine (`fight.ts`) and sends
the recording. The contract must do exactly what the page's replay says: mint the predicted fish for a recording
that lands it, and let it go for a snapped line, an empty recording and a recording that comes after the 600
blocks. In between it tries the ways around: somebody else's `reelFor`, the keeper's drain (which must send
nothing and report a fight), a new cast over the fish, a second recording for the same fish.

**What it does not cover:** the page itself in a browser against a game with a judge. Sign-in is Fluent Connect,
which has no wallet on a local chain, so the strict flow of `play/ui/pond.ts` (the countdown, the one fight, the
settlement of a lost fight, coming back after a reload) has been driven in the browser in local mode only, where
it shares the fight code and the screens but not the transactions. It needs a pass by hand on Fluent Testnet once
a judge is attached there.

## Balance lab

`sim/lab.ts` plays whole careers and single sittings with the real rules: three model players (beginner, average,
experienced), a rule set (the contracts up to release 004, where a lost fight is a retry; the contracts with the
reel judge, where the one fight the contract replays decides whether there is a fish; or the local game), a play
pattern (from every other day to a check-in every four hours with refills) and a start (a new
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
  minigame.ts          hook window, bite delay and the floating-point reel fight (the flow up to release 004); model players
  fight.ts             the fight the contracts replay, in integers: the twin of FightVerifier.sol (tournaments, and every fish under the reel judge)
  chainOutcome.ts      what a pending cast will be, computed as the contract computes it, and the fight the judge gives it
  tournament.ts        score, week boundaries, top ten, demo standings
  hunt.ts              Season Hunt: the chance of a seasonal cast as the contract computes it, odds as text, statuses, the drand round of a cast
  week.ts              weekly seasons: the week file and its validation, grouping the contract's seasons into weeks, card and week statuses, the countdown, the archive
  release.ts           which release of the game answered, and the player's view and the reel window of each
  progress.ts          unlocks (permanent vs ownership), encyclopedia, achievements
  mastery.ts           location mastery: three tiers per water as a pure function of the encyclopedia
  daily.ts             daily challenges: the rules, the day's set (deterministic), progress, the local day
  dailyLog.ts          a player's day read from the game's events: folding, the day's first block, the streak
  dailyReward.ts       the reward for a full day: its rules, the claim window, the signed authorization (EIP-712)
  favorites.ts         saved fish and the Trophy Room as data: the room as a sorted, paged view; the stored preferences; reconciling
  career.ts            My Stats: the lifetime numbers; counts by location folded from events; the cached log and its check against the contract
  actions.ts           every state change as (save, input) → new save
  save.ts              save shape, versioned migrations
  game.test.ts         unit tests
src/tackle/            rod and lure catalog, sprites, the shop page
src/play/              the local game's shell
  ops.ts               every operation, local or contract
  chain.ts             contract backend: reads via GameLens, transactions, catalog check
  state.ts             the current Save (localStorage in local mode, a view of chain state otherwise)
  fishSprite.ts        pixel fish drawn from shape parameters
  fightLog.ts          the one fight of a cast, remembered in this browser: started, ended, its recording
  telemetry.ts         gameplay telemetry in the browser: the recorder over localStorage, what the UI reports
  daily.ts             daily challenges in the browser: the chain reader, its cache, what the UI shows
  dailyReward.ts       the reward in the browser: what the contract says, the claim (verifier, then one transaction)
  career.ts            My Stats in the browser: the event reader, the per-account cache, the one view the page reads
  hunt.ts              Season Hunt in the browser: seasons, the seasonal cast, attempts waiting for their drand round, recording a hit, claiming
  pending.ts, claims.ts  actions on their way (a claim is sent once, its button waits)
  prefs.ts             on the contracts: where the saved fish (the Trophy Room) are kept (per chain and account)
  ui/*.ts              pond, keepnet, daily, collection (with mastery), trophies (with trophyRoom), ranks, header, prize (the bottle reveal), profile (My Stats), hunt (the Season Hunt page and the pond strip), stats (debug telemetry)
src/telemetry/         telemetry format, recorder and summary: pure, no DOM
src/server/            the daily reward verifier: the check (dailyReward.ts), the chain reads (chain.ts), HTTP (http.ts)
                       the keeper: the pass (keeper.ts), the chain and drand (keeperChain.ts), HTTP (keeperHttp.ts)
api/daily-reward.js    the verifier as one file for Vercel, generated by `pnpm build:api` and committed
api/keeper.js          the keeper, the same way; switched off until CRON_SECRET is set (KEEPER.md)
scripts/keeper.mjs     `pnpm keeper`
live/chain.live.ts     `pnpm live:read`
live/reel.live.ts      `pnpm live:reel`: the reel fight on a local chain
sim/reel.sim.ts        the reel fight with the fish at stake (REEL_BALANCE.md)
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

# Onchain Fishing 🎣

A fishing game that runs in smart contracts: casting, fair randomness, rods and lures, catches as NFTs with onchain art, the PEARL currency, a species collection, special fish that unlock new waters, and Season Hunt, the game's competition: weekly seasons of three prize fish, each won by the first angler to hook it. (Tournaments are kept on the chain as a legacy mode.)

Hypothesis results for the first version are in **[REPORT.md](REPORT.md)**; the current balance is in [web/BALANCE.md](web/BALANCE.md).

## Layout

| Folder | Contents |
|---|---|
| `contracts/` | Foundry project: `FishingGame` and `Tournaments` (both behind upgradeable proxies), `FightVerifier`, `BottlePool`, `GameLens`, `FishNFT`, `PearlToken`, `PearlExchange`, `Marketplace`, `DailyRewards`, `SeasonHunt` with its randomness beacons + 290 tests (7 of them on a fork of the live network), upgrade tooling ([UPGRADES.md](contracts/UPGRADES.md)) |
| `contracts/script/Water.s.sol` | pausing and resuming casts before a change of rules ("Still water" in UPGRADES.md) |
| `contracts/script/SeasonHunt.s.sol`, `contracts/script/seasons/` | deploying the hunt, announcing and funding a season or a weekly season of three hunts; a season is a JSON file, a week is one in `seasons/weeks/` |
| `contracts/script/GameSetup.sol` | catalog: species, locations, rods, lures, special fish, achievements, config |
| `sim/` | model of the first version's formulas and an agent-based economy simulation (Python) |
| `web/` | browser client (Vite + TypeScript + viem), see [web/README.md](web/README.md); the daily reward verifier and the operator's keeper ([web/KEEPER.md](web/KEEPER.md)) as serverless functions |
| `deployments/` | contract addresses per chainId (written by the deploy script); `deployments/weeks/<chainId>/` records which on-chain seasons each weekly season is |

## Quick start

You need Node 20+ and pnpm (and [Foundry](https://getfoundry.sh) for the contracts).

```bash
cd web && pnpm install && pnpm dev
```

Open http://localhost:5180. With a deployment in `deployments/20994.json` the client plays on the contracts on **Fluent Testnet** (sign in with **Connect with Fluent**). Without one it runs the same rules locally in the browser.

## Tests and simulation

```bash
cd contracts && forge test
```

```bash
python3 sim/sim.py && python3 sim/report.py
```

```bash
cd web && pnpm test && pnpm sim:reel
```

## Deploying to Fluent Testnet

| | |
|---|---|
| Network | Fluent Testnet |
| chainId | 20994 |
| RPC | https://rpc.testnet.fluent.xyz |
| Explorer | https://testnet.fluentscan.xyz |
| Faucet | https://portal.fluent.xyz/builder/faucet |

Blocks come about once per second and gas is ~0.001 gwei. The full deployment (~25M gas) costs about 0.00003 ETH. One attempt (cast + reel) is about 0.5M gas, roughly 5·10⁻⁷ ETH.

1. `contracts/.env` already holds a dedicated **testnet-only** deployer key (the file is git-ignored). Fund its address from the faucet:

```bash
grep DEPLOYER_ADDRESS contracts/.env
```

2. Deploy and verify the sources on fluentscan:

```bash
contracts/deploy-fluent.sh
```

This is a complete, fresh deployment: tokens, market, lens, the BLEND → PEARL exchange, the game, the bottle pool and the tournaments. `BLEND_TOKEN` picks the BLEND token (default: the testnet Mock Blend).

To deploy from your own wallet (a key in the Foundry keystore) instead:

```bash
contracts/deploy-fluent.sh --account <key-name>
```

3. Client (players connect with Fluent Connect — set the widget ids in `web/.env.local`, see `web/.env.example`):

```bash
cd web && pnpm dev
```

> ⚠️ Randomness comes from `blockhash`. It works on Fluent (verified on testnet: the value matches the real block hash), but blocks are produced by a sequencer, which could in theory influence outcomes. Anything with real value needs VRF (see REPORT.md). The code is not audited.

## Upgrading without losing progress

`FishingGame` and `Tournaments` sit behind transparent proxies (OpenZeppelin). Their addresses and all player state are permanent; a new version is new code behind the same address:

```bash
cd contracts && ./preflight.sh fluent_testnet
```

```bash
TARGET=game forge script script/Upgrade.s.sol --rpc-url fluent_testnet --broadcast --private-key <owner key>
```

```bash
./release.sh record fluent_testnet
```

`TARGET=tournaments` upgrades the tournaments. The procedure, what each check protects against and the contract size limit are in [contracts/UPGRADES.md](contracts/UPGRADES.md). In short:

- `preflight.sh` compares the storage layout of the new code with the code that is released (inside every struct too), runs OpenZeppelin's upgrade validation against the build of the released source, runs the tests (they start from the bytecode recorded from the chain, not from the current source) and, given a network, rehearses the upgrade on a fork of it. CI runs it on every change to `contracts/`.
- `Upgrade.s.sol` changes the code and nothing else: no price, config or catalog entry. It refuses to run unless the proxy runs the recorded release, the token addresses match and the new implementation is this build. The economy is its own step (`script/Economy.s.sol`).
- **Release 004 is on Fluent Testnet** since 25 November 2026. It gives a cast 8,191 blocks to be landed instead of 256 (the chain's block-hash history, EIP-2935), makes the game refuse a change of its rules while a cast is in the water (the owner pauses casting, the keeper reels the casts in, then the change), and moves five views from the game into `GameLens` to make the room. From this release the lens ships with the game, and the client must be published right after the upgrade: UPGRADES.md, "Release 004".
- **Release 005 is on Fluent Testnet** since 25 November 2026, and **the reel fight counts there since 26 November 2026**: the owner attached the reel judge `0x34F8D1a3372abb06F119daf8f6eca35590a2b12F`. Besides not buying trophies and four more views in the lens, the release settles a cast by `reel(recording)`: with a judge attached a fish is minted only for a recording of the one fight that lands it, and a lost fight loses the fish for good. The owner can take the judge off again over still water. UPGRADES.md, "Release 005".
- `release.sh record` snapshots what the proxies run into `contracts/releases/` (addresses, code hash, bytecode, storage layout, ABI, compiler settings, source commit); `release.sh verify --source` rebuilds every release from its commit and compares it with the chain.

`PearlToken`, `FishNFT`, the market and the exchange are plain contracts and are never replaced. Whoever owns the proxies can change the rules, so on a mainnet the owner should be a multisig with a delay.

## Season Hunt

The main competition: a season names one target fish and holds one BLEND prize, and the first angler to hook the fish takes all of it. A season runs for a set time (seven days in the first one), entry is free, and a wallet gets a set number of seasonal casts per UTC day (20). The prize is in the contract before the season can start.

A seasonal cast is an ordinary cast made through the hunt (`SeasonHunt.cast`): the game charges the same energy, wears the same rod, uses the same lure and lands the same ordinary catch. On top of it the hunt makes one separate draw for the target. Its chance is the season's base chance plus the bonuses of the rod, the lure and the water, added and capped (three times the base at most in the first season), so better tackle helps and nothing guarantees the fish. Ordinary fishing odds are not touched.

The winner is the earliest cast that hooked the target, by the order in which casts were executed on the chain, not whoever reports first: anyone can record a hit for anyone, an earlier hit recorded later takes the catch over, and a hit is final when its recording window has passed. The winner claims the prize and a trophy fish of the target species, a real `FishNFT`. If nobody hooks it, the sponsor takes the prize back or rolls it into the next season.

A hit counts once it is recorded on the chain within its window. The player's page does that; so that a closed tab does not lose a hit, the operator's keeper ([web/KEEPER.md](web/KEEPER.md)) records hits for everyone. It is built and not yet running: it needs a gas wallet and a schedule.

The draw uses the [drand](https://drand.love) randomness beacon, whose signatures the contract verifies on the chain, because no VRF provider serves Fluent today and a block hash is the sequencer's to choose. The hunt is a contract of its own behind a small hook in `FishingGame` (`castFor`, `landFor`).

**It is live on Fluent Testnet since 24 November 2026** (the first season, "The Stray Taimen", runs to 1 December for 1,000 test BLEND). A free season is open to anybody who runs many wallets, so until that is solved it is for testnet prizes only. The design, the security assessment, the deployment steps and what a public launch needs are in [SEASON_HUNT.md](SEASON_HUNT.md); the simulated odds are in [web/SEASON_HUNT_BALANCE.md](web/SEASON_HUNT_BALANCE.md) (`cd web && pnpm sim:hunt`).

### Weekly seasons

Seasons are run as weeks of three hunts, one after another: an easy one (suggested Monday and Tuesday, 20% of the pool), a medium one (Wednesday and Thursday, 30%) and a hard one (Friday to Sunday, 50%). Each hunt is an ordinary season of the same `SeasonHunt` contract, with its own fish, waters, rules, escrowed prize, winner and claim; the contract was not changed and knows nothing of weeks. A hunt starts at its own time even when the one before it was won in its first hour, and a prize nobody won goes nowhere without its sponsor.

A week is one file, `contracts/script/seasons/weeks/<id>.json`: the title, the start, and the three hunts with all their rules, so nothing of the schedule is in the code. The same script checks it against the chain, creates the three hunts, funds them and writes down which on-chain seasons they became (`deployments/weeks/<chainId>/<id>.json`); the client groups the seasons by that record. Harder hunts are not only rarer fish: they admit fewer anglers (level, waters), give fewer casts a day, are set for fewer expected hits, and let tackle count for more.

```bash
cd contracts
WEEK=2026-w50 forge script script/SeasonHunt.s.sol --sig "checkWeek()" --rpc-url fluent_testnet     # reads only
WEEK=2026-w50 forge script script/SeasonHunt.s.sol --sig "createWeek()" --rpc-url fluent_testnet --broadcast --private-key <owner key>
WEEK=2026-w50 forge script script/SeasonHunt.s.sol --sig "fundWeek()" --rpc-url fluent_testnet --broadcast --private-key <sponsor key>
cd ../web && pnpm sync    # then commit the record and the registry, and publish
```

Running a command again after a failure is safe: a hunt that exists with exactly the file's rules is never created or funded twice. The whole procedure is under "Weekly seasons" in [SEASON_HUNT.md](SEASON_HUNT.md), and what each hunt of the example week does for crowds of 10 to 10,000 is in [web/SEASON_HUNT_BALANCE.md](web/SEASON_HUNT_BALANCE.md) (`cd web && pnpm sim:week`). **No weekly season has been created on a network yet**; `2026-w50.json` is the example, written for the testnet's handful of players.

## Tournaments (legacy)

Season Hunt replaced tournaments as the game's competition. The `Tournaments` contract, its state, its results and its prizes are untouched and stay on the chain; the page is still in the client at `#/cup` ("Legacy tournaments", linked from the Season Hunt page), where a running tournament can be fished, past results read and an outstanding prize claimed. The link is gone from the navigation, and no new tournaments are meant to be opened; nothing ever opened them automatically. The rest of this section describes the mode as it is on the chain.

Short events with a BLEND prize pool where the fight decides the score. Each tournament is fished with one rod and only players who own that rod in the game may enter (everyone owns the first one), so everyone fishes the same water with the same tackle and the same number of casts; every cast hooks a fish (which one is the block-hash draw); the player gets one fight at it. The browser records the fight as one bit per 50 ms tick, and `Tournaments.reel(id, inputs)` replays the recording in `FightVerifier` and scores the catch: half the fish's points for landing it, up to all of them by the share of the fight spent in the green. The score of a tournament is the sum of the best `counted` catches; ties go to whoever got there first; the top three share the prize pool 50 / 30 / 20 and claim it themselves.

A tournament may ask an **entry fee** in BLEND (`enter` takes it; the client signs the approval and the entry as one batch). Its prize pool is the larger of two numbers: the guarantee the organiser put up when opening it, and the fees less the organiser's share (the rake). A small field plays for the guarantee, a large one for its own fees, and `reclaim` sends the organiser whatever the contract holds above the pool once the tournament is over.

| Entries at 5 BLEND, guarantee 300, rake 15% | Prize pool | Organiser |
|---|---|---|
| 10 | 300 | −250 |
| 60 | 300 | 0 |
| 71 | 301.75 | +53.25 |
| 200 | 850 | +150 |

So the organiser breaks even at guarantee ÷ fee entries and earns the rake from guarantee ÷ (fee × (1 − rake)) on; below that the guarantee is the cost of a prize worth entering for.

**Paid tournaments are opened without a guarantee** (prize 0): the pool is the fees less the rake, the organiser earns the rake from the first entry and can never lose, and a program that plays a perfect fight can only win what other anglers paid in, not money put up by the organiser. The price is a small prize in a small field (20 entries at 5 BLEND make a pool of 85). Free tournaments (fee 0) keep a small guarantee and are where a new player's first BLEND comes from.

```bash
contracts/new-tournament.sh "Pond Cup" 0 0 0 0 25000 60 10080 30 10 0 5 15
```

(the arguments are documented in the script; the last three are the guarantee, the fee and the rake in percent). `FightVerifier` is behind an interface, so the replay can be swapped for another implementation, for example a Rust contract on Fluent, with `Tournaments.setVerifier`.

> ⚠️ The fight seed is public once its block exists, so a program can compute a perfect recording, and a person can replay a fight by reloading within the two-minute deadline. The replay proves the input produces the score, not that a human produced the input. Fine for a testnet; an open event with real money needs an allow-list or a server that streams the fish live.

## The BLEND bottle

> The bottle is **switched off for now** (`blendChancePpm` is 0 in `GameSetup.defaultConfig()` and on the testnet game, `BLEND_PRIZE.chance` is 0 in the client, which then does not mention it). A prize paid out of a reserve earns nothing and is the first thing a script farms; it comes back as a jackpot fed by what players spend. The contracts, the pool and the reveal stay. What follows is how it works when the chance is above zero.

Now and then a bite is not a fish but a sealed bottle with BLEND in it, paid to the player's wallet in the same transaction that settles the cast. The game rolls for it (a share of the bites, one bottle per player ever); `BottlePool` holds the money and says whether there is a bottle to give:

| Rule | Value | Where |
|---|---|---|
| Prize | 1,000 BLEND | `BottlePool.amount` |
| Player level | 5 or higher (1,000 XP, about 140 casts at the pond) | `BottlePool.minLevel` |
| Found per UTC day, all players together | 2 | `BottlePool.dailyMax` |
| Chance per bite / bottles per player | 0 (off; it was 0.3%) / 1 | `FishingGame.config` |

The pool is the BLEND balance of the `bottles` address in `deployments/<chainId>.json`: send BLEND there to fund it, and the bottles can never cost more than was sent. With less than one whole bottle in the pool, a "bottle" roll lands a fish as usual. The owner changes the rules with `BottlePool.setRules(amount, minLevel, dailyMax)` and takes unspent BLEND back with `withdraw`.

> ⚠️ Free play has no skill onchain, so a script can level up many wallets and fish for the bottle. The level and the daily limit only slow that down; the pool size is the real cap on what it can take.

## Economy

Two currencies. **PEARL** is earned by selling fish and by achievements, and burned on rods, lures, repairs and energy refills; it never leaves the game. **BLEND** is the outside token: it comes in when a player pays a tournament entry fee or buys PEARL at the exchange (100 PEARL per BLEND, one way, to the treasury), and goes out as tournament prizes and bottles.

| Rod | PEARL | Bought on day (one energy bar a day … never a full bar) | Full repair, PEARL | Upkeep per cast |
|---|---|---|---|---|
| Willow Rod | free | 1 | never wears out | |
| Carbon Spinner | 1,500 | 5 … 2 | 120 | 1.5 |
| Ironwood Rod | 4,000 | | 640 | 4 |
| Taiga Fly Rod | 12,000 | 21 … 9 | 210 | 3 |
| Deep Troller | 30,000 | 61 … 26 | 400 | 8 |
| Pearl Master | 150,000 | 170 … 71 | 1,200 | 10 |

Lures are 100 to 900 PEARL for 40 to 80 casts (Abyss Spoon 3,000 for 25). Every rod has its own repair price, paid in PEARL for the share of the durability that is gone. It is not a share of what the rod cost (prices differ a hundredfold, what a rod adds to a cast about tenfold) but about a third of what the rod adds over the starter in the weakest of its home waters, so upkeep is felt on every rod and no rod loses money. The days are from the balance simulation ([web/BALANCE.md](web/BALANCE.md), "Progression in days") for a player who lands nearly every fish and buys no energy; a beginner gets there about three times later. Energy is the limit: a point every 30 minutes, 48 a day at most, so a script that never sleeps is only 2.4 times ahead of somebody who plays one bar a day. A refill (100 PEARL, doubling with each further one that day) is the way to go faster, and the first two or three a day earn more than they cost. A rod opens the tournaments fished with it (equal tackle inside each), so better rods mean richer leagues, not better odds.

The prices and repairs live in `GameSetup.rodPrices()` / `lurePrices()` / `rodRepairs()` and in `web/src/tackle/catalog.ts`, the energy rate in `GameSetup.defaultConfig()` and `TUNING.energyRegenSeconds`, the bottle chance in `GameSetup.defaultConfig()` and `BLEND_PRIZE.chance` (the client warns when the two sides differ). To change them on a deployed game, edit both and run:

```bash
forge script script/Economy.s.sol --rpc-url fluent_testnet --broadcast --private-key <owner key>
```

Rods already bought stay bought. Upgrading the game (`TARGET=game`, above) runs the same sync in the same broadcast.

## Planned

Decided on, not built yet:

- **Diving, as a location of its own.** A push-your-luck dive instead of a cast: a ticket buys a fixed number of moves on a hidden board, corals pay, whirlpools cost a life, and the diver chooses when to surface with what they have. What a ticket costs and what the corals pay is open. It would be a contract of its own beside the game (`FishingGame` is 283 bytes under the 24,576-byte limit).
- **Lures for one fish.** A lure that raises the pool weight of a single species (today's lures lift every rarer species at once): the tool for filling the collection and for chasing one prize fish. It changes how a cast is drawn, so it needs room in `FishingGame` first.
- **Aquarium.** Fish given to a personal collection instead of sold, shown the way the trophies are now, with a level per species. A fish given away is PEARL that is never minted, which slows progression without raising a price.

Looked at and dropped: a recipe of the day (handing in the fish named that day).

## Game loop (contracts)

1. `cast(locationId)` spends energy, one point of rod durability and one lure cast, and commits to target block `N+2`. The equipped rod, lure and active special-fish bonus are fixed at this moment.
2. `reel()` after the target block: the outcome comes from that block's `blockhash`. Does anything bite, is it the special fish of the location, which species, what weight, what quality (D–S). The catch is minted as an NFT. Anyone may call `reelFor(player)`. (From release 005: `reel(recording)`. With a reel judge attached the fish is minted only if the recording of the fight lands it, nobody but the player can settle a fish for 600 blocks, and after that it is gone.)
3. `sellFish(ids)` burns the fish for PEARL: base price × weight factor × quality. Fish can also be kept or listed on the marketplace.
4. PEARL can also be bought for BLEND through `PearlExchange.buyPearl(blendAmount)` at a fixed rate (100 PEARL per BLEND on testnet); the BLEND goes to the treasury.
5. PEARL is burned on rods (`buyRod`), lures (`buyLure`), repairs and energy refills (each further refill on the same day costs ×2).
6. Progress is onchain: XP and level, the species encyclopedia, permanent location unlocks, personal records, the ten best catches of each week, and achievements that pay PEARL once.

Location mastery (three tiers per water) and the three daily challenges are computed by the client from this state and from the game's `Caught` events; the game contract stores nothing for them. Mastery is a badge. A full day of challenges earns +4 energy, once per player and UTC day: an off-chain verifier reads the same events and signs an authorization, and the `DailyRewards` contract checks it and has the game add the energy (never over the bar, never PEARL). It is live on Fluent Testnet since 24 November 2026. See [web/DAILY_CHALLENGES.md](web/DAILY_CHALLENGES.md) and [web/DAILY_REWARDS.md](web/DAILY_REWARDS.md).

What the contract decides, the client cannot. Once a cast's block exists its outcome is fixed and public, so the client computes it, plays the bite, the hook and the fight on it, and settles afterwards: skill there changes how soon you land the fish, never which fish it is. See [ARCHITECTURE.md](ARCHITECTURE.md).

**Losing a fish for real (release 005; switched on on Fluent Testnet on 26 November 2026).** With a reel judge attached the fight is the one the contract replays, it is played once, and a lost one is a lost fish: no NFT, no XP, no collection entry, and the energy, rod wear and lure use of the cast are not returned. Which fish it would have been is still the contract's roll. The contract checks that the recording lands the fish; it cannot check that a person played it, so a script loses nothing. What the rule does to landing rates, PEARL and progress for three model players is in [web/REEL_BALANCE.md](web/REEL_BALANCE.md) (`cd web && pnpm sim:reel`); the design and its limits are in [ARCHITECTURE.md](ARCHITECTURE.md), "The reel fight"; the rollout is in [contracts/UPGRADES.md](contracts/UPGRADES.md). Season Hunt's own fish is not fought for yet: [SEASON_HUNT.md](SEASON_HUNT.md), "The reel fight and the hunt".

Energy: max 20, regenerates 1 every 30 minutes on the contracts (`GameSetup.defaultConfig`, set on a deployed game by `script/Economy.s.sol`) and 1 every minute in the local game, which has nothing at stake. If a cast is not reeled in within 256 blocks, the fish gets away.

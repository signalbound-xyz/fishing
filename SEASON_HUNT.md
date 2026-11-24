# Season Hunt

One target fish, one BLEND prize, and the first angler to hook the fish takes all of it. Rods, lures and waters
change the chance; nothing guarantees it. Tournaments stay as they are, as the second competitive mode.

This file is the design, the security assessment, the deployment instructions and the list of what must change
before a public launch. The balance numbers are in [web/SEASON_HUNT_BALANCE.md](web/SEASON_HUNT_BALANCE.md); the
upgrade-safety report is the "season hunt" section of [contracts/UPGRADES.md](contracts/UPGRADES.md).

**Status: live on Fluent Testnet since 24 November 2026, with a prize of test tokens only.** The game runs
release 003 (the hook), `SeasonHunt` is at `0xb09eA27cA0B980f4A1031FD19084F8EdA4dbe5E0` on the drand beacon
`0x444fb6D173EF8FcEE21BD6D73FF7844C3D66E91a`, and the first season, "The Stray Taimen", runs from 24 November
15:26 UTC to 1 December with 1,000 Mock BLEND in escrow. It is not ready for a prize of value: see
[Before a public launch](#before-a-public-launch).

| Piece | Where |
|---|---|
| The hunt: seasons, attempts, the winner, the escrow | `contracts/src/SeasonHunt.sol` (15,455 bytes, a plain contract) |
| Randomness | `contracts/src/HuntBeacon.sol` (the interface and the block-hash prototype), `contracts/src/DrandBeacon.sol` (drand, verified on chain) |
| The game's hook | `FishingGame.castFor`, `landFor`, `seasonHunt`, `setSeasonHunt` (+605 bytes) |
| Scripts | `contracts/script/SeasonHunt.s.sol`, `contracts/script/DrandProbe.sol`, `contracts/script/seasons/*.json` |
| Tests | `contracts/test/SeasonHunt.t.sol`, `SeasonHunt.invariant.t.sol`, `DrandBeacon.t.sol`, and the hunt cases of `Upgrade.t.sol` |
| Client | `web/src/game/hunt.ts` (rules), `web/src/play/hunt.ts` (chain), `web/src/play/ui/hunt.ts` (page and pond strip) |
| Simulation | `web/sim/hunt.ts`, `web/sim/hunt.sim.ts` (`pnpm sim:hunt`) |

## How a season runs

1. **Announced.** The owner creates a season: name, target species, waters, dates, daily cap, base chance, bonus
   table, prize. The rules are stored once and can never be changed.
2. **Funded.** Anyone (the sponsor) deposits the whole prize before the start. An unfunded season never opens.
3. **Active.** A player casts through the hunt (`hunt.cast(seasonId, water)`). The hunt asks the game to make an
   ordinary cast for that player: the game charges the energy, wears the rod, uses the lure and later lands the
   ordinary catch exactly as for `game.cast`. The hunt numbers the cast as an attempt (`seq`) and remembers who
   made it, when, with which rod and lure, in which water.
4. **The draw.** Once the attempt's randomness exists, anyone can ask the contract whether the attempt hooked the
   target (`outcome`, a read). A miss needs no transaction. A hit is recorded with `settle(seasonId, seq, proof)`,
   which anyone may send for anyone.
5. **Winner found.** The lowest-numbered recorded hit holds the catch. Once its settle window is over it is final.
6. **Claim.** The winner calls `claim`: the whole prize, and a trophy fish of the target species minted into the
   game's own `FishNFT`.
7. **Expired.** If nobody hooked it by `end + settleWindow`, the sponsor takes the prize back (`reclaim`) or moves
   it into a later season (`rollOver`).

Statuses in the contract and on the page: Upcoming, Active, Closing (casting is over, late hits can still be
recorded), Winner found, Expired, Cancelled (called off before the start, or never funded).

MVP parameters, all of them per-season data and none hardcoded: 7 days, free entry, 20 attempts per wallet and UTC
day, one winner takes 100%, prize in escrow before the start. A season can also require a minimum level
(`minLevel`) and restrict the rods that may be used (`rods`), which are the Sybil levers discussed below.

## Architecture

Three ways to build it were compared.

| | A. No change to the game | **B. A separate hunt behind a thin hook (built)** | C. Inside `FishingGame` |
|---|---|---|---|
| How a seasonal cast is made | The player casts in the game, then registers that cast with the hunt in a second transaction | One transaction to the hunt, which calls `game.castFor(player, water)` | One transaction to the game |
| Change to `FishingGame` | None | +605 bytes: two functions, one setter, one storage slot appended | Several kilobytes |
| Fits the 24,576-byte limit | Yes | Yes, 283 bytes left | **No**: the game had 888 bytes free |
| Energy, rod wear, lures | Charged by the game | Charged by the game, same code path as `cast` | Charged by the game |
| Player transactions per attempt | 2 (+1 for a hit) | 1 (+1 for a hit) | 1 (+1 for a hit) |
| Weak point | The registration must land before the cast's randomness block, 2 blocks later, or it could be made only for casts already known to be worth registering; a slow wallet review loses the attempt | The game trusts one address to cast for players and to mint a fish | Every hunt bug is a bug in the contract that holds all player progress |
| Trophy | Its own NFT, not a game fish | A real `FishNFT` fish | A real `FishNFT` fish |
| Trust added | None | The game's owner chooses the hunt; the hunt's code is immutable | None, but the upgrade surface grows |
| If the hunt has a bug | The game is untouched | The owner detaches it with one transaction; player progress cannot be affected | Needs a game upgrade |

**B is recommended and built.** It is the only one that both fits and keeps the rule "one cast is one
transaction". The hunt is a plain contract, not a proxy: nobody can change the code that holds a prize. It can be
replaced by deploying another and pointing `seasonHunt` at it; seasons already funded in the old one stay
claimable there.

### The hook

```solidity
address public seasonHunt;                                         // appended after energyGranter
function setSeasonHunt(address hunt) external onlyOwner;
function castFor(address player, uint8 locationId) external;       // only seasonHunt
function landFor(address player, FishNFT.Fish calldata f) external; // only seasonHunt
```

`cast` became a one-line wrapper around an internal `_cast(player, locationId)`, and `castFor` calls the same
function, so a seasonal cast and an ordinary cast cannot drift apart: same energy, same wear, same lure, same
pending cast, same randomness block, same `reel`. `landFor` forwards one `fishNft.mint`.

What the hook lets the hunt do, and nothing more:

- make a cast for an address. `SeasonHunt` only ever passes `msg.sender`, so a player's energy and tackle are
  spent only by that player's own transaction;
- mint a fish. `SeasonHunt` mints one per won season, of the season's species, to the winner. It cannot burn,
  transfer, mint PEARL or touch any other state of the game.

With `seasonHunt` zero, which is its value after the upgrade, nobody can call either function.

**What was deliberately not done:** nothing in `_reel`, the catalog, the config, energy or pricing changed. The
target is a separate draw in a separate contract, so the rarity and special-fish odds of ordinary fishing are
exactly what they were. `test_the_ordinary_catch_is_the_same_through_the_hunt` proves that the same cast lands the
same fish, XP and state whether it is made directly or through the hunt.

**The trophy is a real fish with less bookkeeping.** It is minted by the game's fish contract and can be kept,
shown, listed or sold like any fish. It is not entered into the collection (dex), gives no XP and emits no
`Caught` event: routing it through the game's own landing code cost 2,078 bytes and did not fit. Selling it pays
the ordinary PEARL price of that fish, so each won season can mint the PEARL value of one fish of the target
species; that is the only way the hunt touches the PEARL supply, and it is bounded at one fish per season.

## Who wins

> The winner is the lowest-numbered attempt that hooked the target and was recorded within its settle window.

- **Numbering.** `seq` is assigned inside `hunt.cast`, so it is the order in which the casts were executed on the
  chain: by block, and by position inside a block. Two attempts never share a number, so **there are no ties** and
  no tie-break is needed.
- **Settling is not racing.** `settle` proves a hit from the attempt's own randomness. Who sends it, with how
  much gas, and in which order compared with other settlements changes nothing about which attempt it is. A later
  hit that is recorded first simply holds the catch until an earlier one is recorded (`TargetHooked` is emitted
  again) and can never take it back.
- **The grace period is bounded and per attempt.** An attempt can be settled for `settleWindow` seconds after its
  cast and never later.
- **Finality needs no waiting on anyone.** Attempts with a lower number were cast no later, so their windows
  close no later than the window of the recorded hit. When that window is over, no earlier attempt can be settled
  any more and the result is final. The season never loops over attempts and never waits for an attempt that is
  not coming. `testFuzz_earlier_attempts_never_outlast_later_ones` and the invariant suite check exactly this.
- **Once a hit is recorded, new casts are refused** (`TargetAlreadyHooked`): they would all be later than the hit
  and could not win.

The cases the specification lists:

| Case | What happens |
|---|---|
| A casts first, B settles first, both hit | B holds the catch until A settles; then A holds it for good. Tested in `test_the_earlier_cast_wins_even_when_it_is_settled_later` |
| Casts in nearby blocks | The lower block has the lower numbers |
| Two hits in the same block | The one executed first in the block wins, whoever settles first (`test_two_hits_in_one_block_go_to_the_one_cast_first`) |
| A hit that is never settled | It runs out with its window. A later recorded hit becomes final when its own window ends (`test_an_earlier_hit_that_is_never_settled_runs_out`) |
| Randomness no longer readable (block-hash beacon, after 256 blocks) | `settle` reverts with `RandomnessLost`; the attempt is gone. A drand signature never expires |
| The season ends with casts pending | The status is Closing. Casts made before the end can still be settled inside their own windows; the season is Expired only after `end + settleWindow` |
| Several hits | The lowest number among those recorded in time |
| Sequencer ordering | The sequencer decides the order of transactions and so the numbers. With the drand beacon it cannot know which attempt will hit when it orders them, so ordering buys nothing. With the block-hash beacon it could; see below |

## Randomness

### What Fluent offers today

Checked on 24 November 2026 against each provider's published network list and, where possible, the chain itself:

| Source | On Fluent Testnet (20994) / Fluent (25363) |
|---|---|
| Pyth Entropy, Chainlink VRF v2.5, Supra dVRF, API3 QRNG, Witnet, Randamu / dcipher, Band VRF, Switchboard | Not listed for either network |
| Gelato VRF, Orochi | Could not be confirmed either way |
| `PREVRANDAO` | The sequencer's own `mixHash`: chosen by the block producer |
| `blockhash` | Works, 256 blocks; chosen by the block producer |
| EIP-2935 history contract | Active (8,191 blocks); still block hashes |
| BN254 pairing, `ecAdd`, `ecMul`, `modexp` precompiles | Present and correct (probed with read-only calls) |

There is one operator building blocks and no forced inclusion, so anything derived from a block is the
sequencer's to choose. No VRF provider could be verified as available. What does work is checking a public
randomness beacon's signature on the chain, which needs no provider at all.

### The drand beacon (`DrandBeacon`)

[drand](https://drand.love) (the League of Entropy) publishes a threshold BLS signature every few seconds. Round
`r` is the signature of the number `r`, so its value is fixed before anyone can know it and is the same wherever
it is read. The `evmnet` network signs on BN254, the curve the EVM has precompiles for.

- An attempt cast at block time `t` is bound to the first round made at `t + margin` or later (`margin` = 30 s as
  deployed by the script). The round does not exist when the cast is made.
- The proof of an attempt is that round's 64-byte signature, fetched by anyone from any drand relay. The contract
  hashes the round number to the curve (RFC 9380, keccak-256, the Shallue–van de Woestijne map) and checks the
  pairing against the network's public key. No oracle, no keeper, no trust in whoever brings the signature.
- The attempt's draw is `keccak256(randomness, chainId, hunt, seasonId, seq, player) mod 10⁹ < chance`, so no
  attempt, season, contract or chain shares a draw with another, and nothing can be replayed.
- Verification costs about 135,000 gas; a `settle` with a drand proof about 207,000 in total. A hit is known about
  35 seconds after its cast: the margin, and the round that follows it.

**Verified, not assumed.** `test/DrandBeacon.t.sol` checks four rounds the live drand network made and refuses
wrong rounds, altered signatures and malformed points. `script/DrandProbe.sol` asks a live node to do the same
inside one read-only call (it deploys the beacon and verifies a real round in a simulated creation; nothing is
sent). Run against Fluent Testnet on 24 November 2026 it returned the expected randomness
`0xa5a3bdc9…58c1845`. The whole path with rounds fetched live from a public relay was run on a local chain; see
"Rehearsals" at the end.

Residual risks of the drand beacon:

- **Block timestamps.** If blocks carry timestamps more than `margin` behind real time (a sequencer catching up
  after a halt, or one that lies), a round is public before the cast it decides is in a block, and a player could
  submit only casts that win. Fluent Testnet's timestamps were measured about 1 s behind real time. `margin` is the
  knob; a possible hardening is to mix a later block hash into the draw (EIP-2935 makes that readable for 8,191
  blocks), which would need both the sequencer and a stale clock to cheat.
- **drand itself.** A threshold of League of Entropy members colluding could know rounds early. An outage of
  drand longer than a settle window would make the hits cast in that time unrecordable.
- **The verifier is not audited.** It is about 190 lines, mostly field arithmetic, checked against live rounds.

### The prototype beacon (`BlockhashBeacon`)

The hash of the block two after the cast, as the game itself uses. One sequencer builds every block, so it could
grind a block until its own attempt wins or drop a block in which somebody else's does. The beacon says so
(`unbiasable() == false`), and **`SeasonHunt.fund` then refuses to take a prize on any chain but Fluent Testnet
(20994) and a local chain (31337)** with `PrototypeRandomness`. A hunt on this beacon cannot hold a prize on a
network with value. It exists for local development and as the fallback if drand verification were ever
unavailable.

## The chance of an attempt

```
chance = baseChance × (100 + min(rodBonus + lureBonus + waterBonus, maxBonus)) / 100      (in billionths)
```

- Free tackle is never zero: the Willow Rod with a bare hook has exactly `baseChance`.
- Bonuses are percentages of the base chance, **added**, never multiplied, and their sum is capped by `maxBonus`,
  so stacking is bounded by construction.
- `create` refuses a season whose best possible chance is above 10% per cast (`MAX_CHANCE`), so no tackle
  guarantees anything. All arithmetic is on `uint256` with inputs of at most 32 bits: nothing can overflow.
- The table is public and immutable per season. `chance(seasonId, rod, lure, water)` returns the exact number the
  draw uses, and every `SeasonCast` event carries the chance of that attempt. The client shows it as "1 in N"
  from the same arithmetic (`web/src/game/hunt.ts`, tested against the contract's own numbers).

The recommended table gives the best tackle three times the chance of the free rod (2.45× for mid-range gear);
see the balance report for why, and for the base chance by expected crowd.

## The prize

- `create` (owner) → `fund` (anyone, once, the whole amount, before the start). `fund` measures the balance before
  and after and refuses a token that delivers less (`BadToken`).
- The prize leaves the contract in exactly one of two ways: to the winner (`claim`), or back to the sponsor
  (`reclaim`, or `rollOver` into a later season) when the season was called off before its start or ended with no
  winner. Never while a season runs, never when there is a winner, never twice.
- `rollOver(id, nextId)` moves the unwon prize into a season that is announced, unfunded and not yet started, and
  returns what the later season does not need.
- `cancel` (owner) works only before the start. Nothing can stop a season that has started, and its rules cannot
  be edited.
- `rescue` (owner) sends out tokens that arrived by mistake; of BLEND only what is above `escrowed`, the sum of
  all prizes owed.
- Pull payments only, `SafeERC20`, `nonReentrant` on every function that moves tokens, state written before the
  transfer. The hunt mints no PEARL and holds no other asset. Total BLEND paid out can never exceed total BLEND
  deposited: there is no emission.
- Events: `SeasonCreated`, `SeasonFunded`, `SeasonCancelled`, `SeasonCast`, `TargetHooked`, `SeasonFinalized`,
  `PrizeClaimed`, `TrophyLanded`, `PrizeReturned`, `PrizeRolledOver`.
- If the game refuses the trophy mint (the hunt was detached), the prize is paid all the same and the fish can be
  minted later with `mintTrophy`, by anyone, to the winner.

## Security assessment

| Threat | Assessment |
|---|---|
| **Sybil: many wallets in one hand** | **Open in a free season.** A per-wallet cap does not limit a person. Energy is free and refills, so a wallet costs gas only. See the numbers below. Levers that exist: `minLevel` (each wallet must be played up first), `rods` (each wallet must own a paid rod). Not built: an entry fee, identity attestation |
| Bots | A cast needs no skill, so a script is just a player who never misses a day. Bounded per wallet by the cap and energy; many wallets is the Sybil row |
| Sequencer picks the randomness | Possible with the block-hash beacon (testnet only, enforced). Not possible with drand unless block timestamps lag by more than the margin |
| Front-running a settlement | Gains nothing: the prize goes to the attempt's caster, whoever sends the proof |
| Front-running a cast | With drand nobody knows which cast will hit, so position is worth nothing in expectation |
| Selective settlement | A player cannot hide another player's hit; anyone can settle it. Holding back one's own hit only risks losing it |
| Delaying one's own hit | A hit can sit unrecorded for up to `settleWindow`, during which others keep casting attempts that will lose to it. They still land their ordinary catches, so they lose only the hope. A keeper that settles every hit as it appears removes this; none is run yet |
| Censoring a settlement | The sequencer could ignore a `settle` for the whole window. Same trust as every transaction on the chain; a longer window makes it harder to do unnoticed |
| Replay | The draw is bound to chain, contract, season, attempt number and player; the proof to one drand round by the cast's own timestamp |
| Draining the escrow | One exit per prize, checked by unit, reentrancy and invariant tests (`balance == escrowed == sum of prizes owed`) |
| Reentrancy | `nonReentrant` and checks-effects-interactions; tested with a token that calls back |
| Griefing by filling a season | No loop runs over attempts; storage is paid by the caster; there is no global cap to exhaust |
| Denial of service on finalization | Finality is a time comparison; nothing an attacker does can keep a season open |
| A free cast that skips costs | Not possible: the hunt has no path that records an attempt without `game.castFor` succeeding, and that is the game's own cast |
| Owner powers over a running season | None over its rules, its escrow or its winner. The game's owner can detach the hunt; casting then stops, recorded hits and prizes are unaffected, and an unwon prize returns to the sponsor after the end |
| One key | The same testnet deployer key owns the game, the proxies and would own the hunt. A network with value needs a multisig behind a timelock (see `contracts/UPGRADES.md`, "Secrets") |

### Sybil, in numbers

From `pnpm sim:hunt`, recommended table: the chance that the winner is one of the extra wallets when someone adds
free-tackle wallets that each make all 20 casts every day.

| Honest anglers | 10 wallets | 100 wallets | 1,000 wallets |
|---|---|---|---|
| 100 | 10% | 52% | 92% |
| 1,000 | 1% | 10% | 52% |
| 10,000 | 0% | 1% | 10% |

A hundred scripted wallets take half of a season fished by a hundred real players. **The MVP season is therefore
fit for a testnet and for prizes nobody would script for, and for nothing else.** What raises the price of a
wallet today: `minLevel` 5 costs about 139 ordinary casts (2.9 days of a wallet's energy) before it may hunt, and a
required paid rod costs 1,500 PEARL per wallet. What a launch with real value needs is in the checklist below.

## Deployment

These steps were run on Fluent Testnet on 24 November 2026, in this order (see "Rehearsals" at the end). Every
step that changes a network needs the owner's explicit go-ahead.

Before anything: `cd contracts && ./preflight.sh fluent_testnet` (layout, OpenZeppelin validation, sizes, tests,
releases against the chain, the upgrade rehearsed on a fork).

1. **Upgrade the game** so that it has the hook (the standard procedure of `contracts/UPGRADES.md`). After it the
   hook exists and is closed: `seasonHunt` is zero.
   ```bash
   TARGET=game forge script script/Upgrade.s.sol --rpc-url fluent_testnet --broadcast --private-key <owner key>
   ```
   Then record the release: `./release.sh record fluent_testnet`.
2. **Ask the node whether it can verify drand** (read-only, sends nothing). The answer must be
   `0xa5a3bdc9c0bffab8d41349329a6a97d206b4c8ebd119e18b934f2272d58c1845`.
   ```bash
   cast call --rpc-url fluent_testnet --create $(forge inspect DrandProbe bytecode)
   ```
3. **Deploy the hunt and its beacon.** The game does not listen to it yet. Writes `seasonHunt` into
   `deployments/20994.json`.
   ```bash
   BEACON=drand forge script script/SeasonHunt.s.sol --sig "deploy()" --rpc-url fluent_testnet --broadcast --private-key <owner key>
   ```
4. **Attach it.** From here on seasonal casts are possible in a funded, running season.
   ```bash
   forge script script/SeasonHunt.s.sol --sig "attach()" --rpc-url fluent_testnet --broadcast --private-key <owner key>
   ```
5. **Announce a season** from a file in `contracts/script/seasons/`, starting at a unix time at least ten minutes
   away. Its rules are final once this is mined.
   ```bash
   SEASON=stray-taimen START=<unix seconds> forge script script/SeasonHunt.s.sol --sig "create()" --rpc-url fluent_testnet --broadcast --private-key <owner key>
   ```
6. **Fund it**, before the start. This moves BLEND from the sender into escrow.
   ```bash
   SEASON_ID=0 forge script script/SeasonHunt.s.sol --sig "fund()" --rpc-url fluent_testnet --broadcast --private-key <sponsor key>
   ```
7. **Ship the client**: commit `deployments/20994.json` and deploy the web build; it picks the hunt up from there.

`--sig "status()"` prints the hunt and its seasons at any time and sends nothing. For an incident:
`--sig "detach()"` stops all seasonal casting at once (prizes already won stay claimable), and `--sig "cancel()"`
with `SEASON_ID` calls off a season that has not started.

**Rolling back.** Detach the hunt first. Pointing the game's proxy back at release 002 is then safe: the old code
never reads the new slot. With the hunt still attached to old code, `hunt.cast` reverts as a whole (the game has no
`castFor`), so nothing is charged and no attempt is recorded.

`contracts/script/seasons/stray-taimen.json` is a season for the testnet's present crowd of a handful of players:
base chance 1 in 125, best tackle 1 in 42, 1,000 BLEND. For another crowd take the base chance from the balance
report, and change the prize to what the sponsor actually holds.

## The client

- **Season Hunt** is its own page (`#/hunt`) and the first competition in the navigation; **Tournaments**
  (`#/cup`) stay where they were, one link over.
- Fishing for the season happens at the pond. A gold strip under the Cast button is the switch: with the hunt on,
  the button reads "Hunt cast" and turns gold, and the cast goes to `hunt.cast` instead of `game.cast`. Everything
  after it (the bite, the reel, the catch card) is the ordinary flow, because it is an ordinary cast.
- The result of an attempt is the contract's answer. The client waits for the attempt's drand round, fetches its
  signature from a public relay (only the round number is sent), asks `outcome`, and sends `settle` only for a
  hit. A refused or failed `settle` leaves a "Record the catch" button on the page until the window closes.
- Because the answer comes about 35 seconds after the cast, a player who keeps casting can make several more
  attempts before learning that an earlier one already hooked the fish. Those casts are ordinary casts with their
  ordinary catches; as attempts they are spent.
- Attempts are remembered in the browser and also found again from the hunt's event log, so a hit made on another
  device or just before a reload is not lost while its window is open.
- Odds are shown as "1 in N" and as a multiple of the base chance, from the season's own table. The page never
  shows a chance of winning the season: that depends on everybody else and cannot be known.
- History is read from the contract a page at a time (`list(player, offset, limit)`); nothing is duplicated off
  the chain.

## Before a public launch

A hunt with a prize of real value needs all of these; none is done.

1. **Sybil resistance.** Free entry with free tackle cannot carry a real prize. Pick at least one: an entry fee
   that funds the prize (the tournaments' model, so a farm only wins what others paid), a meaningful `minLevel`
   plus a paid rod, or an identity attestation signed by a verifier (the daily reward's pattern).
2. **An audit** of `SeasonHunt`, `DrandBeacon` and the hook.
3. **The clock.** Measure the network's block-timestamp lag over time and under load, set `margin` from it, and
   decide on mixing in a later block hash.
4. **A keeper** that settles every hit the moment its round exists, so that no hit depends on its owner's browser
   and nobody can sit on one.
5. **Ownership.** The game, the proxies and the hunt behind a multisig with a delay.
6. **A drand outage plan**: a settle window comfortably longer than any outage drand has had, and monitoring.
7. **The trophy's bookkeeping** (dex entry, XP, `Caught` event), if it should count as a catch; it needs room in
   `FishingGame` first.

## Tests

`cd contracts && forge test` runs all of it; `./preflight.sh` adds the layout and upgrade validation.

- `SeasonHunt.t.sol`: creation and refused rules, funding and escrow, the prototype-randomness guard, start and
  end, waters, rods, levels, the bounds of the chance (fuzz), the share of hits against the chance, daily caps and
  the UTC reset, energy, rod wear and lure accounting, that a cast through the hunt lands the same ordinary catch,
  hits and misses, concurrent hits, settlement order, unsettled and expired attempts, finality, claiming, the
  trophy, double claims, refunds, roll-over, unauthorized withdrawals, history paging, tournaments running beside
  a season, the season file, reentrancy with a hostile token, and a hunt on the drand beacon with a real round.
- `SeasonHunt.invariant.t.sol`: random sequences of every action anyone can take. The escrow always equals the
  prizes owed and the tokens held; every BLEND that went in is still there, went to a winner or went back to its
  sponsor; a prize leaves once; a final result never changes; the catch is always held by the lowest hit settled;
  no PEARL is minted.
- `DrandBeacon.t.sol`: real rounds, wrong rounds, altered and malformed proofs.
- `Upgrade.t.sol`: the hunt attached on top of the released state after an upgrade; a player from the released
  world casts, wins and claims, and every other player, fish and tournament is as before.
- `UpgradeFork.t.sol` (`FORK_RPC=fluent_testnet`, part of `./preflight.sh fluent_testnet`): the upgrade, the
  hunt's deployment by its script, a season from the season file funded with the network's own BLEND, a cast, a
  real drand round, the prize and the trophy, on a fork of the live network.
- `web`: `src/game/hunt.test.ts` (the chance arithmetic against the contract's numbers, the drand round of a cast).

### Rehearsals

Run on 24 November 2026, before the deployment; none of them sent anything to a live network.

- **Fluent Testnet, read-only.** `./preflight.sh fluent_testnet` passed: storage layout and OpenZeppelin
  validation against release 002, 235 tests, the releases rebuilt and compared with the chain, and the six fork
  tests, the hunt's among them (the five players the chain can name were compared before and after). The drand
  probe returned the expected randomness from a live node.
- **A local chain (anvil), with the repository's scripts and live drand rounds.** `deploy`, `attach`, `create`
  and `fund` as in "Deployment". Twenty addresses made 400 seasonal casts at the base chance of 1 in 125; asked
  with signatures fetched from api.drand.sh, the contract named four of them hits. A miss could not be settled.
  The later hit (attempt 70) was recorded first, by a stranger; the earlier one (attempt 47) then took the catch
  over; a still later hit and new casts were refused. Inside the window nobody could claim; after it the other
  hitter and the sponsor were refused, the winner received the 1,000 mock BLEND and a Taimen (`fishValue` 1,136
  PEARL), the escrow was zero and a second claim was refused. Gas there: `settle` 209,631 and 187,530, the first
  `claim` with the trophy 351,352.
- **The client against that chain.** The Season Hunt page was looked at in every state (upcoming, active, target
  hooked and its takeover, winner found, claimed), on a desktop and a phone-sized viewport. With a second,
  high-chance season, a seasonal cast was made with the page's own button, its outcome came back from drand in
  the browser, further casts went through the client's cast function, the client recorded the hit by itself, and
  the prize was claimed with the page's button. **What this did not exercise:** signing through Fluent Connect.
  There is no wallet for a local chain, so for this rehearsal transactions were handed to the local node by a
  temporary shim in place of the sign-in module (not in the repository). The first cast on Fluent Testnet through
  the real wallet is still to be made.

### The deployment on Fluent Testnet

24 November 2026, with the owner's go-ahead, by the steps of "Deployment":

- the game upgraded to release 003 (implementation `0x294a9a59B29055C13b8bfba934c9b886d1C24a4b`, 24,293 bytes);
  the release was recorded and rebuilt from its commit; after the upgrade `seasonHunt` was zero, the daily reward
  contract was still attached and the cast counter was unchanged;
- the drand probe answered with the expected randomness, and the deployed beacon verifies the same real round;
- `SeasonHunt` deployed and attached; season 0 announced from `stray-taimen.json` and funded by the owner's
  address with 1,000 Mock BLEND (the testnet's BLEND is a mock that anyone can mint; the prize was minted for
  this).

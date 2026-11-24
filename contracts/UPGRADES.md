# Upgrading the contracts

`FishingGame` and `Tournaments` run behind OpenZeppelin transparent proxies. Their addresses and everything players
own or have done are permanent; an upgrade is new code behind the same address. The other contracts (`PearlToken`,
`FishNFT`, `BottlePool`, `PearlExchange`, `Marketplace`, `FightVerifier`, `GameLens`, `DailyRewards`, `SeasonHunt`
and its beacon) are plain contracts and are never replaced in place.

This file is the procedure and the tooling around it. Nothing here needs a private key until the upgrade
transaction itself.

## What an upgrade must keep

Strict guarantees, checked by the tests on every change: XP, PEARL balances, owned rods and their durability, lures,
unlocked locations, special fish found, the encyclopedia and records, claimed achievements, who holds which fish and
the fish's attributes and metadata, weekly scores, tournament entries, standings and prizes, a cast that is in the
water.

Not guaranteed, because it is game balance and changes on purpose: prices, energy, bite chance, pools, rewards. A
code upgrade never touches any of it (see "The upgrade script"); balance is changed by its own, explicit transaction
(`script/Economy.s.sol`).

## The tools

| Command | What it does | Needs |
|---|---|---|
| `./preflight.sh` | everything below that works offline, in order; this is what CI runs | forge, python3, node |
| `./preflight.sh fluent_testnet` | the same, then the releases against the chain and the upgrade rehearsed on a fork | + RPC |
| `./check-layout.sh` | storage layout of the current code against the released code | forge, python3 |
| `./check-layout.sh --selftest` | proves the layout rules reject each kind of incompatible change | python3 |
| `./validate-upgrade.sh` | OpenZeppelin's upgrade validation against the build of the released source | forge, node, git history |
| `./release.sh record <rpc>` | snapshots what the proxies run now into `releases/` | RPC |
| `./release.sh verify <rpc> [--source]` | checks the snapshots against the chain; `--source` rebuilds them from their commits | RPC |
| `./release.sh check-impl <Contract> <address> <rpc>` | is a deployed implementation this build, with the proxy's dependencies? | RPC |
| `forge script script/Upgrade.s.sol --sig "check()"` | prints what a proxy runs; sends nothing | RPC |

### Release snapshots (`releases/`)

`releases/<chainId>/<Contract>/<NNN>/` is what runs behind a proxy, recorded from the chain:

| File | Content |
|---|---|
| `release.json` | network, chain id, proxy, proxy admin, implementation, runtime code hash and size, the addresses fixed in the bytecode and where they sit in it, compiler settings, the source commit |
| `abi.json` | the implementation's ABI |
| `storage-layout.json` | its storage layout without build-specific ids |
| `runtime.hex` | the runtime bytecode as it is on the chain |

`releases/<chainId>/index.json` names the latest release of each contract.

A release is only recorded when a commit rebuilds the on-chain bytecode byte for byte (the immutables aside): the
tool tries the working tree, then walks back through the commits of `contracts/src`. That commit goes into
`release.json`, and `./release.sh verify <rpc> --source` repeats the proof at any time: it checks out the commit,
builds it and compares. There are no timestamps in a release, so recording the same chain state at the same commit
gives the same files. `release.json` also carries a SHA-256 of the other three files.

A release holds public chain data and build output only. The tools never read `.env` or a key.

The first releases were recorded from Fluent Testnet: `FishingGame` 001 (implementation `0xDF73…dC1`, commit
`00ae715`) and `Tournaments` 001 (implementation `0x795E…171`, commit `b252c37`). `FishingGame` 002
(implementation `0xB253…063d`, commit `b74feaa`) followed on 24 November 2026: the size optimizations and the
daily reward hook.

### Storage layout check (`check-layout.sh`, `tools/layout.py`)

Compares the layout of the current build with `storage-layout.json` of the latest release of every chain. Unlike the
first version of this script, it looks inside every struct, wherever it is stored:

- state variables: the released list must be an exact prefix of the new one;
- every struct: its released fields must be an exact prefix of its new fields;
- a struct stored inline (a state variable such as `config`, an array element such as `Item`, `Location`,
  `Tournament`, a field of another struct) must keep its size. Only a struct that is a mapping value (`Player`,
  `Cast`, `Entry`, `Terms`) may grow at its end;
- every other stored type keeps its size, key, value and base type.

What a layout cannot show and no tool here checks: a change of meaning of a field that keeps its type (a unit, a bit
mask), new members of an enum, immutables, and ERC-7201 namespaces. Those are for review.

### OpenZeppelin validation (`validate-upgrade.sh`)

Runs `@openzeppelin/upgrades-core validate` (pinned version) with `--requireReference`: each contract is compared
with the build of its release's source commit, checked out into a throwaway worktree and cached under `cache/`. It
covers the storage layout again, independently of our own check, plus `delegatecall`, `selfdestruct`, initializer
problems and the validator's other rules.

Two findings are allowed by name in the script, and the validator still prints a warning for each on every run:

| Finding | Why it is allowed |
|---|---|
| `constructor` | The constructors fix the token addresses in the bytecode and lock the bare implementation (`initialize` reverts on it). Proxy state is set by `initialize`. OpenZeppelin's non-upgradeable `Ownable` has a constructor too; it writes the implementation's own owner, never the proxy's. |
| `state-variable-immutable` | The token addresses are immutables. A new implementation must be built with the same ones; the upgrade script and `release.sh check-impl` verify that. |

Nothing else is allowed, and the storage check is never skipped. A new finding fails the script; do not add it to
the list without a written reason here.

### Tests

`test/Upgrade.t.sol` does not upgrade the current source to itself. The proxies are created on `runtime.hex` of the
latest release (the token addresses in it swapped for the test's own tokens), and the whole world is played on that
code: players of different levels, PEARL balances, a bought and worn rod, lures, the Golden Koi and the Golden Lake
it opens, claimed achievements, a fish listed on the marketplace, catches in several weeks, a finished paid
tournament with one prize claimed, a running one with a fish on the line, an upcoming one, and a cast in the water.
Then the proxies are pointed at the current source and the tests compare:

- every storage slot the world wrote, in the game, the tournaments, PEARL and the fish (all but the implementation slot);
- everything about every player, every fish (owner, attributes, `tokenURI`, sale value) and every tournament,
  through the public functions;
- gameplay: the same stretch of play (landing the pending cast and fight, new casts, selling, buying, repairing, a
  prize) on the released code and on the new code must emit the same events and leave the same state. When a release
  changes a rule on purpose, this is the test that says so, and it is updated with the reason.

`test/UpgradeFork.t.sol` is the rehearsal on the real thing: a fork of a live network, upgraded by the real
`script/Upgrade.s.sol` with all its checks, as the proxy admin's owner. Every player the chain can name (holders and
catchers of fish, weekly boards, tournament leaders, the owner), every fish and every tournament must read the same
after it, and the game is played on. It is skipped unless `FORK_RPC` is set:

```bash
FORK_RPC=fluent_testnet forge test --match-contract UpgradeForkTest -vv
```

### The upgrade script (`script/Upgrade.s.sol`)

It changes the code and nothing else. The earlier version also re-applied prices, repairs, energy and the bottle
chance from `GameSetup` after every upgrade; that is gone, so an upgrade cannot reset the balance. Before it sends
anything it reverts unless:

- the proxy runs exactly the implementation the latest release records;
- the token addresses read from the proxy are the ones in `deployments/<chainId>.json`, and the new implementation
  is built with them;
- the new implementation's bytecode is this build (`out/`), and it is within the 24,576-byte limit;
- the sender owns the proxy's `ProxyAdmin`;
- after the upgrade the proxy runs the new code, and its owner, config and counters read as before.

It prints the proxy, the old and new implementation, the code size and hash, and what to do next.

## The procedure

1. **Freeze the code.** Commit; the build inputs (`src`, `lib`, `foundry.toml`) must be clean.
2. **Preflight, with the network.** It must end with `preflight passed`.

   ```bash
   cd contracts && ./preflight.sh fluent_testnet
   ```

3. **Mind what is in flight.** A cast is settled with the rules in force when it is reeled, and it lives at most 256
   blocks; a tournament reads the game's catalog for as long as it runs. Until the contracts enforce it (planned,
   see "Remaining risks"), do not change the code of `_reel`, the config, pools or species while it matters: upgrade
   when no rule changes, or settle open casts first (`reelFor` is open to anyone) and wait for running tournaments.
4. **Upgrade.** One contract per run.

   ```bash
   TARGET=game forge script script/Upgrade.s.sol --rpc-url fluent_testnet --broadcast --private-key <owner key>
   ```

   To look at the implementation on the chain before anything depends on it, do it in two steps: `--sig
   "deployOnly()"`, then `./release.sh check-impl FishingGame <address> fluent_testnet`, then `IMPL=<address>` with
   `--sig "switchTo()"`.
5. **Record and verify the release**, and commit `contracts/releases`.

   ```bash
   ./release.sh record fluent_testnet
   ```

   ```bash
   ./release.sh verify fluent_testnet --source
   ```

6. **Balance, if the release needs it**, as its own step: `forge script script/Economy.s.sol …`.
7. **Client.** If the ABI changed: deploy a new `GameLens`, put its address in `deployments/`, and publish the web
   client together with the upgrade (`pnpm build` syncs the ABI). The client warns when its catalog differs from
   the chain's.

### Rollback

Rolling back is an upgrade to the previous implementation, whose address is in its release. It is safe only while
the new code has not written anything the old code cannot read (a new `unlockType`, a rod id beyond the old count, a
new bit). So new features ship switched off and are switched on by a separate transaction; after that the fix is
forward only. Minted and burned PEARL and fish, and paid BLEND, are never rolled back.

## The daily reward (`grantEnergy`, `DailyRewards`)

The reward for a full day of daily challenges (+4 energy; `web/DAILY_REWARDS.md` has the whole design) is the
first change since release 001 that adds to the game's interface. It is two pieces.

**In `FishingGame`: one hook, 348 bytes.**

```solidity
address public energyGranter;                                 // appended after totalBlendWon
function setEnergyGranter(address granter) external onlyOwner;
function grantEnergy(address player, uint256 amount) external; // only energyGranter
```

`grantEnergy` settles regeneration with the function `cast` uses, adds the amount, and reverts with `EnergyFull`
when the result would be over `config.maxEnergy`: all of it or nothing. It does not touch `energyUpdatedAt` beyond
what the settlement does, so a regeneration period that is running keeps its remainder. It emits nothing; the
event is `DailyRewardClaimed` on the rewards contract (an event here cost another 50 bytes). With `energyGranter`
zero, which is its value after the upgrade, nobody can call it.

**`DailyRewards`: a plain contract, 3,802 bytes, not a proxy.** It holds what the game has no room for: the
EIP-712 check of the verifier's authorization, the list of accepted signer keys, the first claimable day and the
bitmap of claimed days. It keeps no energy and no balances: energy stays in the game's `players` mapping. It is
called, never delegatecalled, and the game calls nothing on it.

Why this shape: everything in one contract did not fit (ECDSA, the domain separator and a bitmap are over 2 KB),
and the alternatives that make room in the game are the ones in the table at the end of this file, each a larger
change than this feature. A separate contract that the game merely listens to costs the game 348 bytes, cannot
corrupt its storage, and can be replaced by deploying another and pointing `energyGranter` at it; the claimed
days would then start empty, so a replacement must set its `firstDay` after the last day the old one paid.

### Compatibility

- **Storage**: one variable appended at the end (`energyGranter`). No struct changed. `./check-layout.sh` and
  `./validate-upgrade.sh` passed against release 001 before the upgrade.
- **ABI**: three functions added, nothing changed or removed. The released `GameLens`, the released `Tournaments`
  and a web client built before this change work with the new code as they are.
- **Rules**: `_reel`, the config, pools and species are untouched, so casts in the water and running tournaments
  are not affected and step 3 of the procedure needs no waiting.
- **State**: `test/Upgrade.t.sol` (`test_dailyRewardOnTopOfTheReleasedState`) plays the world on the released
  bytecode, upgrades, deploys and activates the rewards, and claims: the claimant's energy goes up by four with the
  timer where it was, and every other player, fish and cup reads as before.
  `test/UpgradeFork.t.sol` (`test_dailyRewardOnTheForkAfterTheUpgrade`) does it on a fork of Fluent Testnet with
  the real scripts: a newcomer and the players the chain already knows claim once and cannot claim twice.
- **Rollback**: pointing the proxy back at release 001 is safe at any time. The old code never reads the new slot,
  and a claim then reverts as a whole (`DailyRewards` calls a function the game no longer has), so no day is
  marked claimed without its energy.

### Gas

From `forge test --gas-report`: `claimDailyReward` 77,808 median, 91,871 at most (the first claim of a player
whose bitmap word and energy slot are both cold). The same 77,808 was measured for a claim on a fork of Fluent
Testnet. A claim that reverts for a full bar costs about 26,000. Deploying `DailyRewards` is about 920,000 gas.

### Procedure

The upgrade of the game is the procedure below, unchanged (`TARGET=game`). After it the hook exists and is
closed. Deploying `DailyRewards`, giving it a signer and a first day, and opening the hook are separate, explicit
transactions of `script/DailyRewards.s.sol` (`deploy`, `activate`, and for incidents `revoke`, `stop`, `detach`);
`web/DAILY_REWARDS.md`, "Deployment", has them in order together with the verifier's side. No reward exists
before `activate`, and none ever for a day before the first day it sets.

`DailyRewards` is not behind a proxy and has no release snapshot; `preflight.sh` lists its size with the others.

On Fluent Testnet all of it was done on 24 November 2026: release 002, `DailyRewards` at
`0xDDDb1066366525A560277e895B8A254c83cCCB35` (in `deployments/20994.json`), first day 20781. From now on the fork
rehearsal (`test_dailyRewardOnTheForkAfterTheUpgrade`) checks that an upgrade leaves the game listening to that
contract and that it keeps paying.

## Season Hunt (`castFor`, `landFor`, `SeasonHunt`)

Season Hunt ([SEASON_HUNT.md](../SEASON_HUNT.md) has the whole design) is the second change that adds to the
game's interface, built the same way as the daily reward: a thin hook in the game, everything else in a plain
contract the game merely listens to. **It is in the source and not deployed anywhere**; release 002 on Fluent
Testnet does not have the hook.

**In `FishingGame`: one hook, 605 bytes.**

```solidity
address public seasonHunt;                                          // appended after energyGranter
function setSeasonHunt(address hunt) external onlyOwner;
function castFor(address player, uint8 locationId) external;        // only seasonHunt
function landFor(address player, FishNFT.Fish calldata f) external; // only seasonHunt
```

`cast(locationId)` is now `_cast(msg.sender, locationId)`, and `castFor` calls the same internal function: the
body of `cast` moved, unchanged, with `msg.sender` replaced by its parameter. `landFor` forwards one
`fishNft.mint`. With `seasonHunt` zero, which is its value after the upgrade, nobody can call either.

**`SeasonHunt` (15,455 bytes) and its beacon (`DrandBeacon` 4,158, or `BlockhashBeacon` 552): plain contracts,
not proxies.** Seasons, attempts, the winner and the BLEND escrow live there. The game calls nothing on them and
is never delegatecalled by them.

### Compatibility

- **Storage**: one variable appended at the end (`seasonHunt`, after `energyGranter`). No struct changed.
  `./check-layout.sh` and `./validate-upgrade.sh` pass against release 002.
- **ABI**: four functions added, nothing changed or removed. `cast` keeps its selector, its events and its
  reverts. The released `GameLens`, the released `Tournaments`, the released `DailyRewards` and a web client built
  before this change work with the new code as they are.
- **Rules**: `_reel`, the config, the catalog, energy and prices are untouched. A cast in the water at the moment
  of the upgrade is landed as before, and step 3 of the procedure needs no waiting.
- **Gameplay**: `test/Upgrade.t.sol`'s gameplay comparison (the same stretch of play on the released code and on
  the new code must emit the same events and leave the same state) passes unchanged, which is the proof that
  moving the body of `cast` changed nothing. `test_the_ordinary_catch_is_the_same_through_the_hunt` shows the same
  for a cast made through the hunt.
- **State**: `test_seasonHuntOnTopOfTheReleasedState` plays the world on the released bytecode, upgrades, checks
  that the hook is closed, deploys and attaches a hunt, and has a player of the released world cast at the Golden
  Lake they had unlocked, hook the target, land the ordinary catch and claim. Their energy, rod and lure are
  charged as by `cast`; every other player, fish and tournament reads as before.
  `test/UpgradeFork.t.sol` (`test_seasonHuntOnTheForkAfterTheUpgrade`) does it on a fork of Fluent Testnet with
  the real scripts and the network's own BLEND and fish contracts: upgrade, `SeasonHuntScript` deploy and attach on
  the drand beacon, a season from the repository's season file, a newcomer's cast decided by a round drand really
  made, the prize and the trophy; the holdings of every player the chain knows are compared before and after.
- **Rollback**: detach the hunt (`setSeasonHunt(0)`), then pointing the proxy back at release 002 is safe: the old
  code never reads the new slot. If the hunt is still attached to old code, `SeasonHunt.cast` reverts as a whole,
  because the game has no `castFor`: nothing is charged and no attempt is recorded. Prizes already in escrow are in
  `SeasonHunt`, not in the game, and stay claimable or reclaimable whatever the game runs; only the trophy mint
  needs the hook, and `claim` pays without it.

### What the hook can do

The hunt's address can make a cast for any player and mint any fish; that is the whole trust the game places in
it. `SeasonHunt` passes only `msg.sender` to `castFor`, and calls `landFor` once per won season with the season's
species for the season's winner. It has no owner function that reaches the game, it is not upgradeable, and the
game's owner can detach it with one transaction. A wrong address in `setSeasonHunt` would be able to spend
players' energy and tackle and mint fish (which sell for PEARL), so setting it is an owner action of the same
weight as an upgrade, and `script/SeasonHunt.s.sol` (`attach`) checks that the address is a hunt bound to this
game and this fish contract before it sends.

### Gas

From `forge test --gas-report`: a seasonal cast (`SeasonHunt.cast`) 206,000 median, of which the game's own cast
(`castFor`) is 88,000; the rest is the attempt's storage slot, the daily tally and the calls. `settle` 70,000
with the block-hash beacon and 207,000 with a drand proof (the pairing check is 135,600 of that); `claim` with the
trophy mint 240,000 median, and 351,352 for a first claim measured on a local chain. Deploying `DrandBeacon` and
verifying one round in the same creation was estimated by a Fluent Testnet node at 1,182,472 gas.

### Procedure

The upgrade of the game is the procedure above, unchanged (`TARGET=game`). After it the hook exists and is
closed. Deploying the hunt, attaching it, announcing and funding a season are separate, explicit transactions of
`script/SeasonHunt.s.sol` (`deploy`, `attach`, `create`, `fund`, and for incidents `detach`, `cancel`);
SEASON_HUNT.md, "Deployment", has them in order. `SeasonHunt` and the beacons have no release snapshot;
`preflight.sh` lists their sizes with the others.

## Contract size

**Fluent enforces EIP-170.** Checked on Fluent Testnet by simulating a contract creation (`eth_estimateGas`, no
transaction): a runtime of 24,576 bytes is accepted, 24,577 is refused with `CreateContractSizeLimit`.

| `FishingGame` runtime bytecode | Bytes | Free |
|---|---|---|
| release 001, on Fluent Testnet until 24 November 2026 | 24,336 | 240 |
| after the optimizations below (never deployed by itself) | 23,340 | 1,236 |
| release 002, on Fluent Testnet now: the above plus the daily reward hook | 23,688 | 888 |
| the source now, not deployed: the above plus the Season Hunt hook | 24,293 | 283 |

`DailyRewards`, the plain contract that goes with the daily reward hook, is 3,802 bytes; `SeasonHunt` is 15,455 and
`DrandBeacon` 4,158. See "The daily reward" and "Season Hunt" above.

**283 bytes is all that is left.** The Season Hunt hook was first written to land the trophy through the game's own
catch code (dex, XP, the `Caught` event): 2,078 bytes, which did not fit. What is in the source mints the fish and
nothing else. The next feature that needs code in `FishingGame` needs one of the options under "What 1,236 bytes
buy" first; paid location unlocks (838 bytes) no longer fit beside the hunt.

### What was optimized

Every external function, event and error is as it was, and so is the storage layout: the released `GameLens`, the
released `Tournaments` and the web client work with the new code unchanged. Nothing about the rules changed either;
`test/Upgrade.t.sol` plays the same game on the released bytecode and on this source (the pending cast and fight,
buying, repairing, a prize, and 150 rounds of fishing by three players with waits of odd lengths) and requires the
same events and the same state.

| Change | Bytes saved |
|---|---|
| A species is read as the four numbers the game uses, at the words where the ABI puts them, instead of decoding the whole struct with its name on every roll | 448 |
| Energy: `currentEnergy` and the settlement in `cast` share one function instead of two copies of the same arithmetic | 228 |
| A fish is read the same way, once per sale instead of twice | 222 |
| The weekly board shifts lower scores down and writes the catch once, instead of swapping entries through memory | 84 |
| `setConfig` validates the calldata and stores it, without a copy through memory | 46 |

Each was measured alone against the released source. Together they save 996 bytes: the two readers share a helper
that passes on the fish contract's own error when a read fails, as a plain call did, and that costs 32.

Gas, from the test suite (`forge test --gas-report`), before → after:

| Call | Average gas |
|---|---|
| `reel` | 252,418 → 244,689 (−3.1%) |
| `sellFish` | 308,456 → 292,406 (−5.2%) |
| `fishValue` | 21,847 → 20,767 (−4.9%) |
| `cast` | 68,496 → 68,709 (+0.3%) |
| `setConfig` (owner) | 64,812 → 66,256 (+2.2%) |

Tried and not taken: `optimizer_runs = 1` saves another 102 bytes and makes every call a little dearer;
`optimizer_runs = 1000` was 1,502 bytes over the limit before these changes; the legacy pipeline (`via_ir = false`) does not
compile `FishNFT` ("stack too deep"); `CatchMath` as a linked library makes the game 298 bytes larger, because
calling a small function costs more code than the function; moving `quoteSell` to the lens saves 69 bytes and would
break the released lens.

### What 1,236 bytes buy

The daily reward hook took 348 of them and the Season Hunt hook 605; 283 are left. Paid location unlocks (`buyLocation`,
`setLocationOffer`, one mapping) measured 838 bytes on top of the 23,340: with the daily reward hook that was
24,526, with 50 bytes left; with the Season Hunt hook as well it is over the limit. The target of 3 KB needs one of the
following. All sizes were measured on the source before the hook (23,340), each in a throwaway copy; none of it is
in the repository.

| | Size | Free | Content setters stay on the game | Delegatecall | Changes the ABI |
|---|---|---|---|---|---|
| Now | 23,340 | 1,236 | yes | no | no |
| A. Lens-only views move to `GameLens` (raw storage reads) | 20,042 | 4,534 | yes | no | read functions |
| A, keeping `playerOf` and `castOf` | 20,904 | 3,672 | yes | no | read functions |
| B. Content setters in a linked library | 22,205 | 2,371 | yes | compiler-generated | no |
| A and B | 18,946 | 5,630 | yes | compiler-generated | read functions |
| C. Content setters removed | 19,941 | 4,635 | no | no | owner functions |
| D. Catalog in a contract of its own | not built | | yes, on that contract | no | owner functions |
| E. Delegatecall extension (setters and shop moved) | 16,882 + a fallback | about 7,600 | yes | hand-written | no |

**A. Views to `GameLens`.** `rodItem`, `lureItem`, `specialInfo`, `achievement`, the weekly views and the public
getters of the mappings exist only for `GameLens` and the tests; the client reads everything through the lens, and
`Tournaments` needs only `location`, `loadout`, the counts and `ownsRod`, which stay. They are replaced by one
`extsload(bytes32[])` that returns raw storage slots, and the lens turns slots into the catalog and a player's
state. Storage is public on a chain, so this exposes nothing. Adding rods, lures and locations works exactly as
today. The price: the lens must know the storage layout (slot numbers, packing, mapping keys), so a mistake shows
wrong data to players without touching their state; the released lens stops working at the upgrade, so a new one
must ship in the same release; and the tests read through a lens-like helper instead of getters. What makes it
safe to build: the lens can be tested against the released bytecode, where the getters still exist, field by field.

**B. Linked library for the setters.** `addRod` … `addAchievement` keep their signatures and owner check on the game
and call a library that validates and writes through typed storage pointers. Adding content works exactly as today.
It is a delegatecall, but one the compiler generates with typed arguments: no fallback, no selector routing, no
second contract with its own idea of the layout. The price: bytecode must be linked at deployment and in every
bytecode comparison (`release.py`, the upgrade script), and OpenZeppelin's validator reports
`external-library-linking`, which would be a third named exception. Alone it does not reach 3 KB.

**C. Removing the content setters.** New rods, lures, locations, special fish and achievements are appended by the
initializer of an upgrade; ids continue from the current counts, existing ones are untouched. No new mechanism and
no new trust, but every content drop becomes a code upgrade with the whole procedure, and later with the timelock.

**D. A catalog contract.** A contract that only owns the game and calls its setters frees nothing: the setters are
the bytes. To free them, the catalog itself (rods, lures, locations and their setters) has to live in the new
contract, and the game reads it by external call. Adding content is then a transaction to the catalog contract, no
game upgrade. The existing entries must be copied there in the same order to keep their ids, the old arrays stay in
the game's layout as dead storage, every `cast` and `reel` pays for external reads of items and pools, and the game
must keep `location` and `loadout` as pass-throughs for the released `Tournaments`. It is the option with the most
moving parts, and two contracts that must agree on ids. Not prototyped, so its size and gas are not measured.

**E. A delegatecall extension.** The implementation forwards unknown selectors to a second contract that runs on
the proxy's storage. The setters and the shop keep their signatures at the game's address, so adding content works
exactly as today. It frees the most, and it is the one to justify carefully before building:

- the extension has the implementation's full authority over every player's state, so it belongs to the same
  release, the same rehearsal and the same snapshot as the implementation, pinned in it as an immutable;
- both contracts must have the same storage layout: one shared base contract for the variables, the layout check
  run on both and against each other, new state only in ERC-7201 namespaces;
- a selector that exists in both is served by the implementation and the extension's version is unreachable,
  silently: a test has to list the selectors of both and require them to be disjoint;
- the fallback forwards calls from anyone, so every extension function does its own access control;
- the extension must be inert when called directly (its own storage is empty), as the bare implementation is;
- OpenZeppelin's validator reports `delegatecall`; passing it needs a reviewed exception at that one line.

### Recommendation

1. Ship the optimizations above with the next upgrade. They are in the source, change no interface and no rule, and
   make room for paid location unlocks. (Done in release 002. With the Season Hunt hook in as well, paid location
   unlocks need point 2 first.)
2. For 3 KB and more with content management kept on the chain: **A**, keeping `playerOf` and `castOf` (3,672 free)
   or not (4,534 free). It is the only option above 3 KB that adds no delegatecall, no new privilege and no
   migration. It changes the read interface, so it is a decision to take before it is built.
3. If more is needed after that, **B** on top (5,630 free), before anything hand-written.
4. Not now: **D** (most moving parts, gas on every cast) and **E** (only when the player-facing code itself no
   longer fits). **C** stays the fallback if the read interface must not change.

## Secrets

Checked on this repository: `contracts/.env` and `web/.env.local` are ignored and were never committed; the deployer
key does not occur in any commit; `web/.env.example` holds placeholders. `contracts/broadcast/` is tracked for
public networks and holds public transaction data only.

One exposure to know about: the deployer key is a plain-text key on a developer machine, and that one address owns
both proxy admins, the game, the tournaments, `PearlToken`, `FishNFT` and `BottlePool`. It is a testnet-only key. A
network with real value needs the owner to be a multisig behind a timelock before launch.

## Remaining risks

- **Rules in flight.** A cast in the water and a running tournament read the live config and catalog. Today this is
  a rule of the procedure (step 3), not something the contracts enforce.
- **Fish metadata.** `FishNFT.updateSpecies` rewrites the name, rarity and weight range of every fish of a species,
  and a raised minimum weight makes `tokenURI` revert for lighter fish. Do not call it; add a new species instead.
- **One key** owns everything (see "Secrets").
- **The daily reward trusts an off-chain verifier** for "this player completed this day". Its key can add at most
  4 energy per player and day, for today and yesterday, never over the bar, and nothing else; the owner revokes it
  with one transaction (`web/DAILY_REWARDS.md`, "What the key can do" and "Switching it off"). `energyGranter` is
  set by the same one key as everything else.
- **The hunt's address is trusted by the game** to cast for players and to mint fish (see "What the hook can do").
  It is set by the same one key as everything else.
- **Season Hunt randomness and Sybil resistance** are testnet-grade: SEASON_HUNT.md, "Randomness", "Security
  assessment" and "Before a public launch".
- **Players the chain cannot name.** The fork rehearsal compares every player it can find through fish, boards and
  tournaments. A player who cast and never landed anything is not found; their state is covered by the slot
  comparison of the local test only in kind, not individually.
- **`GameLens` and the client** are bound to the ABI: a struct returned by a view may only gain fields at its end,
  and a release that changes the ABI needs a new lens and a client release.
- **The two layout checks agree on storage only.** Neither sees a field whose meaning changed while its type stayed.

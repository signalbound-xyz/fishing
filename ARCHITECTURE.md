# Fishing flow: who decides what

This note covers one question: how far player skill can count in a game whose valuable outcomes are decided by a
contract, when the only client is a browser the player controls.

## The lifecycle

```
cast(location)            transaction   spends energy, rod wear and a lure cast; fixes the tackle;
                                        commits to the hash of block N+2
… the block is produced   ~2 s          from here the outcome is fixed and public
bite · hook · fight       in the client the client works the outcome out and plays it
reel()                    transaction   the contract computes the same outcome and applies it:
                                        mints the fish, XP, encyclopedia, records, weekly score
```

Two transactions per catch, and none in the middle of the game. A cast with nothing on the hook needs no
settlement transaction at all: the next `cast()` settles it.

### What decides the result

| | Local game | On the contracts |
|---|---|---|
| Does anything bite | client RNG | contract, from the block hash |
| Species, weight | client RNG | contract, from the block hash |
| Quality (D–S) | share of the fight spent in the green | contract; a better rod shifts the roll, a rarer fish lowers it |
| Hooking too late | the fish is lost | the fish bites again |
| Losing the fight | the fish is lost | another try, with an easier fight; after three the fish is hauled in |
| Price, tournament score | from the above | from the above |

Location, rod and lure matter in both modes. In the local game the hook and the fight decide whether the fish is
landed and how good it is. On the contracts they decide only how soon the player gets to settle, and they produce
the "your fight" line on the catch card, which is information for the player and worth nothing.

## Why skill does not change value on the contracts

The contract cannot see the fight, so skill could only reach it as a number the browser reports. Three ways to do
that were considered.

**A. The contract decides everything (chosen).** Nothing reported by the client is used. Nothing can be forged.
Skill cannot change value.

**B. A backend validates the fight and signs the result.** The contract would check the signature. This is the
only option where skill changes value and a casual forger is stopped. It needs a server that holds a signing key,
replays or re-simulates the input log, enforces nonces, expiry and rate limits, and stays online; and it still
cannot tell a person from a bot that plays the mini-game well. That is a project of its own, not a change to this
one. Not built.

**C. The client reports its result and the contract takes the lower of that and its own roll.** No forgery is
possible upward. But a modified client simply always reports the maximum, so in practice everyone who cheats gets
today's outcome and everyone who plays honestly gets less. It would add an unfairness to the weekly table that
does not exist now. Rejected.

A signature made in the browser adds nothing to C: the player holds the key.

So the fight was made real in the only way that needs no trust: the outcome of a cast is a pure function of public
data once its block exists, so the client computes it (`web/src/game/chainOutcome.ts`), shows a bite only when
there is one, sets the hook window and the fight to the fish that is actually there, and settles afterwards.
A player who bypasses the client gains nothing but time: they can call `reel()` directly and get exactly the fish
the contract would have given them anyway.

### Keeping the prediction honest

The prediction decides nothing, but a wrong one would show the player a fish that is not there. So:

- `contracts/test/Vectors.t.sol` writes 240 real outcomes with all their inputs to
  `web/src/game/fixtures/outcomes.json`; the client's tests replay every one through the prediction.
  Regenerate after changing `_reel`: `WRITE_VECTORS=true forge test --match-contract VectorsTest`.
- The prediction uses the contracts' own catalog and `loadout()` view, not the client's copy.
- At settlement the client compares what it predicted with what the contract emitted and logs any difference.
  The contract's answer is the one shown.
- If the prediction cannot be made (RPC trouble), the client falls back to settling first and showing the fight
  as a replay.

## Failure handling

- **Transaction rejected or failed at cast:** nothing was spent; back to "ready".
- **Transaction rejected or failed at settlement:** the fish waits "at the pier" with a *Land it* button. The fight
  is not replayed.
- **Reload or a second tab mid-cast:** the pending cast is read from the contract and the bite is staged again.
- **Double settlement:** the contract deletes the cast when it settles; a second `reel()` reverts `NoActiveCast`.
- **Expiry:** a cast can be landed for as long as the chain has the hash of its randomness block. From release 004
  that is 8,191 blocks on Fluent, a little over two hours (the chain's block-hash history, EIP-2935); on release
  003 and on a chain without the history it is 256 blocks, about four minutes. The client asks the chain which it
  is and settles with blocks to spare; past the window the cast is void, which is the contract's rule, not the
  client's. The operator's keeper reels in casts that are about to expire ([web/KEEPER.md](web/KEEPER.md)), so a
  closed tab does not lose the fish once the keeper runs.

## Randomness

Outcomes come from `blockhash(targetBlock)` of a block two after the cast, mixed with the player, a per-player
nonce and the contract address. This is **not** manipulation-resistant randomness.

- **Sequencer.** Fluent blocks are produced by a sequencer. Whoever builds block N+2 can choose its contents and
  so its hash, and can grind for an outcome on a cast it cares about. Players cannot; the sequencer can.
- **Selective settlement.** A player sees the outcome before settling. Tested: energy, rod wear and the lure cast
  are spent at cast time, no counter moves on a skipped cast, and the next cast gets fresh randomness, so letting
  a poor result expire only wastes the cast.
- **Delay.** Settling later changes nothing while the hash is readable (fuzz-tested: any settler, any block in
  the window, same result).
- **Reverting what one does not like.** A contract that finishes a cast and reverts unless a fish was landed gets
  the same answer every time: the cast stays charged and pending with the same block, anybody else can finish it,
  and a new cast lands the old one first instead of replacing it
  (`test_revertingAPoorOutcomeCannotRedrawIt`, `test_whoFinishesACastDoesNotChangeTheFish`).
- **What is fixed at the cast and what is read at the reel.** Fixed: the water, the rod, the lure, the active
  special bonus, the block (`test_tackleIsFixedAtCastTime`, `test_activeSpecialIsFixedAtCastTime`). Read when
  the cast is landed: the config and the catalog, the pity counter, and, for a bottle, the pool's own conditions
  (the player's level, today's limit, BLEND left). From release 004 the config and the catalog cannot change
  under a cast: the game counts the casts in the water and refuses `setConfig`, `updateLocation` and `setHidden`
  while there is one ("Still water" in `contracts/UPGRADES.md`, which also says what that does not reach: the
  species table, the bottle rules, the code behind the proxy). A player who already knows the draw can still
  change the pity counter and the bottle's conditions for as long as the cast can be landed, 8,191 blocks from
  release 004; with the bottle switched off, as it is, nothing there is worth anything.
- **Value at stake.** Today: testnet tokens and NFTs with no market. That is why this is acceptable now.

Before anything with real value rides on a catch, the source should be a VRF or a randomness beacon.
**Consequences of switching:** the randomness source is compiled into `FishingGame`. The game runs behind an
upgradeable proxy, so a new source is an upgrade that keeps all player progress, not a new game. An oracle-based
source also changes the flow: the contract waits for a callback instead of reading a block hash, so `reel()`
becomes "claim when fulfilled". Not done here; it needs a decision first. Season Hunt, where a prize does ride
on the draw, already uses a beacon: drand signatures verified on the chain (`contracts/src/DrandBeacon.sol`,
[SEASON_HUNT.md](SEASON_HUNT.md)). The same beacon could decide ordinary casts with no callback, `reel` taking
the round's signature, at the price of about 35 seconds between the cast and the bite and 135,000 gas per reel.

### Compared with potion-game

[potion-game](https://github.com/signalbound-xyz/potion-game), another game on Fluent, was read on 24 November
2026 for its random draws (`docs/SETTLEMENT.md` there). Its protocol and this one have the same shape: the player's
transaction spends the attempt and fixes a future block, a later transaction that anyone may send lands the result,
nothing can be redrawn, and after 256 blocks (here, from release 004, 8,191) the result is forfeited with no
refund and no other seed.

| | potion-game | This game |
|---|---|---|
| Entropy | `PREVRANDAO` of block N+1, read in that block or later proven from its RLP header against `blockhash` | `blockhash` of block N+2 |
| Earliest result | block N+1 | block N+3 |
| Who can bias it | the block producer | the block producer |
| Inputs fixed at the request | the whole fight as a snapshot, the rules contract, the verifier's code hash | water, rod, lure, special bonus; the catalog and config are read at the reel, and from release 004 cannot change while a cast is in the water |
| Sub-draws | one tagged hash per draw | slices of one 256-bit seed |
| Left unfinished | an operator's settler finishes or expires it every minute | the player's client; anyone may call `reelFor`; the operator's keeper (built, not yet running) |
| Time to finish | 256 blocks | 256 blocks; 8,191 from release 004 |

- **The entropy is the same in strength.** Fluent's block producer fills `PREVRANDAO` with fresh random bytes for
  every block (`prev_randao: B256::random()` in the node's payload builder, checked at the revision the testnet
  reported, `fluent/v1.5.2-6e880d5e`; blocks read from the testnet carry a different value each, empty ones
  too). The block hash covers that field, so a player can predict neither, and the producer can choose both.
  Reading `PREVRANDAO` instead would bring the result two blocks sooner and needs an RLP header parser, for which
  `FishingGame` (283 bytes under its size limit) has no room. Not taken.
- **Slices against tagged hashes.** The bite, the bottle, the special fish, the species, the weight and the
  quality are cut from one seed with moduli that are not powers of two, so they are not strictly independent.
  Measured for the bite against the bottle: the bite chance among bottle-winning seeds differs from the plain one
  by less than 0.03 percentage points. Not worth a change that would alter every recorded test vector.
- **Taken:** the adversarial tests above, which potion-game has and this game lacked, and this account of where
  the guarantees end.
- **Taken since, in release 004 and beside it** (built and rehearsed; the upgrade and the keeper's key are the
  operator's to switch on):
  - *An operator's settler.* The keeper records Season Hunt hits for the players and reels in casts about to
    expire ([web/KEEPER.md](web/KEEPER.md)). Like potion-game's, it sends only what anyone may send and decides
    nothing; unlike it, it is not needed for a result to exist, only for it not to be lost.
  - *The rules of a cast fixed when it is made.* potion-game stores a snapshot with every request. Here there
    was no room for that, so the game holds the rules still instead: no change of config or pools while a cast
    is in the water, and a pause that lets the operator drain it.
  - *Not from potion-game:* the EIP-2935 history contract, which Fluent serves, gives a cast 8,191 blocks instead
    of 256.

## Contract changes that would help (none are deployed)

1. **`GameLens.previewCast(player)`**: the same prediction as a view function. It would replace the TypeScript
   mirror with code that can be fuzz-tested against the game in the same Foundry suite. The lens holds no state and
   no permissions, so deploying a new one touches no progress.
2. **Tackle passed to `cast(location, rod, lure)`** instead of separate `equipRod`/`equipLure` transactions:
   two fewer confirmation windows when changing gear. An upgrade of the game proxy; progress is kept.
3. **A session key or sponsored, review-free calls** for `cast`/`reel`, if the wallet supports it: the remaining
   friction is the confirmation window, not the gas.
4. **Verified skill (option B)**: a signer address in the contract and `reel(result, signature)`, plus the backend
   described above.
5. **VRF or beacon randomness**, as above.

## Limits

- In free play on the contracts, skill changes time and nothing else. In tournaments the fight is replayed by the
  contract and decides the score; see above for what that does not prove.
- The model players in `web/BALANCE.md` are models. The landing rates are estimates to check by hand.
- A bot can play the mini-game. On the contracts that buys nothing; in the local game nothing is at stake.

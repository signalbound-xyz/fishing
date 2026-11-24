# Location mastery and daily challenges

Two things to come back for, both built on what the game already stores. No contract was changed or deployed, no
PEARL is minted, no energy is granted, and no gameplay number (energy, fish odds, tackle, prices) was touched.

## Location mastery

Three tiers for each of the eight waters, completed in order. The rules are `MASTERY` in `src/game/mastery.ts`.

| Tier | Rule |
|---|---|
| Explorer | every ordinary species of the water discovered |
| Experienced Angler | each ordinary species landed 20 / 12 / 6 / 3 / 1 / 1 times (Common … Mythic) |
| Master | a personal best of at least 70% of the species' top weight, for every ordinary species up to Epic |

"Ordinary" is the water's pool without its hidden species; the special collectibles are not in a pool at all.

**Where the data comes from.** The encyclopedia keeps, per species, how many were landed and the heaviest one: in
the local save (`Save.dex`) and on the contracts (`GameLens.playerView().dex`, which the client already reads).
Mastery is a pure function of that, so:

- it needs no new contract state and nothing of its own to store or to get out of sync;
- everything landed before this release counts;
- selling a fish changes nothing (the encyclopedia never forgets);
- it does not touch XP, PEARL or energy. It is a badge in the Collection tab.

**Limit.** The encyclopedia counts a species, not the water it was caught in. A species that lives in two waters
(Perch: pond and river; Golden Carp: pond, Golden Lake, the rapids) counts toward each of them.

## Daily challenges

Three a day (easy, medium, hard), the same all day, new at 00:00 UTC. The rules are `DAILY` in
`src/game/daily.ts`; `generateDaily(day, player, profile)` is a pure function and always gives the same set for
the same input.

| Tier | Goals |
|---|---|
| Easy | catch N fish; catch N fish in a water |
| Medium | catch a named species; catch 2 different species; catch a Rare or better fish |
| Hard | land a fish of a given weight in a water; catch 3 different species in a water |

How a day is drawn:

1. **One water is the day's water**, drawn from the waters the player has opened, the cheap ones more often. All
   three goals are sized there, so one sitting can finish them together, and one fish counts for every goal it fits.
2. **Every candidate goal is priced** as the energy it is expected to take there with the starter rod and no lure,
   and dropped when that is over its tier's budget (5 / 8 / 10 energy), or when it hangs on one lucky fish that one
   player in ten would not see within a full bar.
3. **A Rare fish is asked for only with a rod in hand that makes it likely enough.** This is the one place the
   player's tackle is an input: better tackle never makes any other goal harder to reach than it was priced.
4. Hidden and special fish are never asked for, and neither is anything in a water the player has not opened.
5. A weight goal is one of the two heaviest round weights the budget allows in that water, so the hard one is hard.

A water can be the day's water only if it has an affordable goal in every tier. With a bar of 20 that leaves out
the waters where a cast costs 3 or 4 energy (Northern Sea, Ancient Swamp, Phantom Waters, and Taimen Rapids on most
days): a late-game player's days are spent in the pond, the river and the two lakes. That is the price of keeping a
day inside half a bar; see "What it costs".

Ids are stable and versioned (`d1.hard.weight.l0.g400`). `DAILY.version` is part of the id and of the seed: bump it
when a rule changes what a day's set is.

### Where progress comes from

**Local game.** The save keeps the day: the set (fixed when the day is first seen), the day's catches and the
streak. `landFish` writes them in the same step as the catch itself.

**On the contracts.** Nothing is stored for challenges. The day is read from events the game already emits:

- `Caught(player, fishId, speciesId, weight, quality, locationId, score, special)` is a landed fish. The player is
  indexed, so one `eth_getLogs` filtered by player returns only their events.
- `LocationUnlocked` and `RodBought` in the same range say what the player gained during the day. "What the player
  had when the day began" is what they have now, less that, which is how every device arrives at the same set.

Reading it (`src/game/dailyLog.ts`, `src/play/daily.ts`):

- The day's first block is found from block timestamps (a guess from the block time and a few reads to pin it), and
  remembered. Events are attributed to a day by their block's timestamp.
- The first read of a day asks for the blocks since its first block, in ranges of 50,000 (the Fluent RPC accepts
  100,000; a day is 86,400 blocks). Every later read asks only for the blocks since the last one. It runs after each
  read of the player's state, never on render.
- What is two blocks under the head is cached in `localStorage` per account. A reload starts from the cache.
- A fish is known by its NFT id: reading a range twice, or two overlapping ranges, counts it once.
- If the chain cannot be read, the page shows the cached day marked as possibly behind, and on a device with no
  cache it shows nothing rather than a guess. A day is only ever as complete as confirmed events make it.
- The streak is checked the same way: day by day backwards, each day judged by the set of that day and its own
  events, up to 30 days. Days already read are kept and not asked for again.

The telemetry log is not used for any of this.

### What it costs

`pnpm sim:daily` plays the sets with a model player and rewrites this table.

<!-- sim:daily:begin -->
Rules version 1: budgets 5 / 8 / 10 energy (easy / medium / hard), 200 days × 40 runs per player, the "average" model player on the contracts' rules, starter rod and no lure except for a Rare goal.

| Player | Has | Energy, mean | median | 9 days in 10 within | Share of a full bar | Share of a day’s energy | Casts | Minutes, mean | 9 in 10 within | Done inside one bar |
|---|---|---|---|---|---|---|---|---|---|---|
| New player | Village Pond, Willow Rod | 8.2 | 7 | 15 | 41% | 17% | 8.2 | 2.7 | 5.0 | 97% |
| Level 3 | pond and river, Carbon Spinner | 8.6 | 7 | 16 | 43% | 18% | 8.6 | 2.9 | 5.3 | 95% |
| Mid game | pond, river, Deep Lake, Golden Lake; Taiga Fly Rod | 9.3 | 8 | 17 | 46% | 19% | 7.4 | 2.5 | 4.8 | 94% |
| Late game | every water, every rod | 9.2 | 8 | 18 | 46% | 19% | 6.9 | 2.4 | 4.6 | 94% |
<!-- sim:daily:end -->

The energy columns are arithmetic over the real rules. The minutes rest on the lab's timing assumptions (about 20
seconds a cast on the contracts), which are a model and not a measurement.

**The 5–10 minute target is not met, on purpose.** A day takes about 3 minutes. Time here is bought with energy:
5 minutes would be about 15 casts, three quarters of the bar in the cheapest waters, and the bar is all a player
who comes once a day has. The sets are sized by energy instead: under half a bar on average, nine days in ten
inside one bar. To make a day longer without that cost, the goals would have to be something that does not spend
energy (the cups are; see BALANCE_REVIEW.md §5.2).

### Limits

- **Display only.** The cache and the local save are in the player's browser and can be edited. Nothing is granted
  on their word.
- **The tackle a goal was caught with is not checked.** No goal needs it.
- **A change of what the player has is seen through two events.** If a contract upgrade ever opened a water or
  granted a rod without `LocationUnlocked` / `RodBought`, the set of that day could differ between devices.
- **The local game's clock is the computer's.** Changing it changes the day. Nothing depends on it but the badge.
- **Fishing in the local game costs more casts** than the table says, because there a fish can be lost at the hook
  or in the fight. Its energy comes back thirty times faster, so the budgets were not changed for it.
- **The streak reaches back before this release.** A day's set is a function of the day, so the days already
  fished are judged like any other: a player may open the page for the first time and find a streak.
- **Tournament casts do not count.** They are another contract and emit another event.

## Rewards

A challenge gives a "Done" stamp, a day gives its three pips and feeds the streak, a water gives a mastery badge.
On top of that a full day, all three challenges, earns **+4 energy**. Nothing is paid for a single challenge, and
no PEARL is paid for anything here.

- It is claimed by hand in the Daily tab (`Claim +4 Energy`); completing the day does not claim it.
- Once per player and UTC day, on the day itself or the day after. The panel says until when.
- It is added in full or not at all, and never lifts energy over the bar of 20: with more than 16 energy the claim
  waits ("Spend 2 energy to claim your full +4 reward.") and opens when the energy is spent. Regenerated energy
  counts. Regeneration, the bar and the cost of a cast are as they were.
- The streak and mastery do not depend on it.

Who checks the day is different in the two games, and the two never mix:

- **On the contracts** the page decides nothing. A verifier reads the player's catches from the chain, rebuilds the
  day's set by the rules above and signs an authorization for that player, day and contract; the `DailyRewards`
  contract checks it, records the claim and has the game add the energy. Nothing a browser says about catches,
  no local save and no telemetry is an input. Until `DailyRewards` is deployed and its first day has come, the tab
  promises nothing and shows no claim button. All of it: [DAILY_REWARDS.md](DAILY_REWARDS.md).
- **In the local game** the reward is an action on the save (`claimDailyReward` in `src/game/actions.ts`), labelled
  as a local reward. A completed day is written into the save when the day turns, so yesterday's reward is still
  there today; the first paying day is `DAILY_REWARD.localFirstDay` (24 November 2026), and days completed before
  it stay badges. A local save cannot authorize anything on a chain.

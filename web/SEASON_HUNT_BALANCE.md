# Season Hunt: balance

How likely one seasonal cast should be to hook the target, what tackle should add to it, and what follows for the
length of a season, the share of wins and the price of a wallet. The design is in
[SEASON_HUNT.md](../SEASON_HUNT.md).

## Recommendation

| Parameter | Value | Why |
|---|---|---|
| Bonus table | **Recommended**: rod, lure and water bonuses added, capped at +200% | The best tackle is worth exactly 3×, mid-range tackle 2.45×, a first bought rod and lure 1.7×: inside the 2–3× the brief asks for, and every step up the ladder buys something |
| Base chance | **3 divided by the casts the crowd is expected to make**, counted at base-chance weight: about 1 in 43 per expected angler (1 in 4,300 for 100, 1 in 42,800 for 1,000) | Three expected hits a season: about one season in twenty ends with no winner, the median season is won on day 2, about a third are over on day 1 |
| Daily cap | 20 casts per wallet and UTC day | A full energy bar's worth. Players in the model stay under it; it stops a scripted pond wallet at 140 casts a season where its energy would allow 356 |
| Length | 7 days | Long enough that a player who joins on day 3 still has most of their chances |
| Entry | Free on the testnet. **Not free for a prize worth scripting for**: see "Many wallets in one hand" | A free wallet has the base chance at no cost |

Three things in these tables do not depend on how the model crowd is drawn, and they are the ones to rely on:

1. **Tackle changes who wins, not whether somebody does.** With the base chance fitted to the crowd, every table
   gives the same season: the same share with no winner, the same winning day. The cap only moves the wins between
   kinds of players.
2. **The base chance has to match the crowd, and nothing else matters as much.** Set for 1,000 anglers when 100
   come, three seasons in four end empty; set for 100 when 1,000 come, the season is over on its first day. A tenfold
   miss in either direction breaks the season. Until attendance is known from real seasons, set the base chance
   from the last season's cast count, not from hope.
3. **A free season belongs to whoever runs the most wallets.** A wallet with the free rod costs nothing and is
   worth 140 base-chance casts; a hundred of them equal a hundred real players.

The season file in the repository (`contracts/script/seasons/stray-taimen.json`) uses the recommended table with a
base chance of 1 in 125, which is this rule applied to the testnet's present crowd of about five players.

## How it is simulated

`pnpm sim:hunt` (`sim/hunt.ts`, `sim/hunt.sim.ts`) plays whole seasons and rewrites the tables below.

- **The chance of a cast is the contract's arithmetic**, taken from `src/game/hunt.ts`, the module the client
  uses, which is tested against the contract's own numbers. Energy, prices, rod wear and XP come from the game's
  content tables.
- **The crowd is a model, not a measurement.** Four kinds of anglers, each with a tackle set, a water, a number of
  casts they would like to make a day and a share of the crowd. The testnet has had three or four active players a
  week, far too few to measure a mix from. The shares and appetites are written down in `ANGLERS` and can be
  changed in one place.
- **Casts are limited as in the game**: by the daily cap and by energy (a full bar of 20 and a point every half
  hour, 356 over a week), at the energy price of the angler's water.
- **A season is played day by day.** Each cast is an independent draw. Within a day everybody's casts are taken
  to be evenly mixed, so the earliest hit of the day is equally likely to be any of the day's hits; it wins and
  ends the season. 20,000 seasons per row (4,000 per cell of the mismatch matrix), from a fixed seed, so the
  tables are reproducible.
- **Fitting.** The base chance of a row is chosen so that the crowd's casts add up to a given number of expected
  hits, three unless stated.

What is not modelled: players changing behaviour during a season (stopping after a few days, or fishing harder as
the end nears), the casts refused after a hit is recorded but before it is final, and anybody's choice of water for
ordinary reasons. None of these changes the three conclusions above.

## Tables

<!-- sim:hunt:begin -->
### The model crowd

A season of 7 days, 20 seasonal casts per wallet and UTC day. A wallet has 356 energy over the season (a full bar and a point every half hour).

| Angler | Tackle and water | Share of the crowd | Casts a day | Energy per cast |
|---|---|---|---|---|
| Newcomer | Willow Rod, bare hook, Village Pond | 55% | 8.0 | 1 |
| Regular | Carbon Spinner, Copper Spinner, Forest River | 30% | 14.0 | 1 |
| Enthusiast | Taiga Fly, Feather Fly, Deep Lake | 12% | 18.0 | 2 |
| Best equipped | Pearl Master, Abyss Spoon, Northern Sea | 3% | 17.0 | 3 |

### What tackle buys under each bonus table

The chance of one cast as a multiple of the base chance.

| Table | Newcomer | Regular | Enthusiast | Best equipped | Cap |
|---|---|---|---|---|---|
| Flat: tackle changes nothing | ×1.00 | ×1.00 | ×1.00 | ×1.00 | ×1 |
| Gentle: the same bonuses, capped at +100% (2×) | ×1.00 | ×1.70 | ×2.00 | ×2.00 | ×2 |
| Recommended: capped at +200% (3×) | ×1.00 | ×1.70 | ×2.45 | ×3.00 | ×3 |
| Steep: every bonus doubled, capped at +400% (5×) | ×1.00 | ×2.40 | ×3.90 | ×5.00 | ×5 |

### The recommended table, item by item

Bonuses are percentages of the base chance. They are added, and the sum is capped at +200%.

| Rod | Bonus | Lure | Bonus | Water | Bonus |
|---|---|---|---|---|---|
| Willow Rod | +0% | Silver Spoon | +20% | Village Pond | +0% |
| Carbon Spinner | +30% | Copper Spinner | +30% | Forest River | +10% |
| Ironwood Rod | +20% | Feather Fly | +60% | Deep Lake | +25% |
| Taiga Fly Rod | +60% | Glow Jig | +20% | Northern Sea | +40% |
| Deep Troller | +30% | Topwater Popper | +10% |  |  |
| Pearl Master | +80% | Abyss Spoon | +80% |  |  |

### Seasons by crowd size, each with the base chance fitted to it

The base chance is set so that the crowd hooks the target 3 times a season on average; 20,000 seasons per row.

| Table | Anglers | Casts in a season | Base chance per cast | Nobody wins | Casts until the win, median | mean | Winning day, median | Over on day 1 | Won by Newcomer | Won by Regular | Won by Enthusiast | Won by Best equipped |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Flat | 10 | 756 | 1 in 252 | 5.0% | 163 | 213 | 2 | 35% | 45% | 39% | 16% | 0% |
| Flat | 100 | 7,888 | 1 in 2,630 | 5.1% | 1,691 | 2,184 | 2 | 35% | 39% | 37% | 19% | 5% |
| Flat | 1,000 | 78,880 | 1 in 26,300 | 5.2% | 17,021 | 22,175 | 2 | 35% | 39% | 37% | 19% | 5% |
| Flat | 10,000 | 788,800 | 1 in 263,000 | 5.0% | 167,605 | 218,766 | 2 | 35% | 39% | 37% | 19% | 4% |
| Gentle | 10 | 756 | 1 in 363 | 4.6% | 165 | 214 | 2 | 35% | 31% | 46% | 23% | 0% |
| Gentle | 100 | 7,888 | 1 in 3,940 | 4.7% | 1,701 | 2,220 | 2 | 34% | 25% | 42% | 26% | 6% |
| Gentle | 1,000 | 78,880 | 1 in 39,400 | 5.0% | 16,667 | 21,979 | 2 | 35% | 26% | 42% | 25% | 6% |
| Gentle | 10,000 | 788,800 | 1 in 393,900 | 4.8% | 166,227 | 218,969 | 2 | 35% | 26% | 42% | 26% | 6% |
| Recommended | 10 | 756 | 1 in 381 | 5.0% | 165 | 214 | 2 | 35% | 30% | 44% | 27% | 0% |
| Recommended | 100 | 7,888 | 1 in 4,280 | 5.0% | 1,689 | 2,210 | 2 | 35% | 24% | 39% | 29% | 8% |
| Recommended | 1,000 | 78,880 | 1 in 42,800 | 4.9% | 17,027 | 22,139 | 2 | 35% | 24% | 39% | 29% | 8% |
| Recommended | 10,000 | 788,800 | 1 in 428,300 | 4.8% | 170,234 | 222,721 | 2 | 35% | 24% | 39% | 29% | 8% |
| Steep | 10 | 756 | 1 in 511 | 4.9% | 165 | 214 | 2 | 34% | 22% | 46% | 32% | 0% |
| Steep | 100 | 7,888 | 1 in 5,940 | 4.9% | 1,688 | 2,214 | 2 | 35% | 17% | 40% | 33% | 10% |
| Steep | 1,000 | 78,880 | 1 in 59,400 | 4.9% | 17,025 | 22,247 | 2 | 35% | 17% | 40% | 33% | 10% |
| Steep | 10,000 | 788,800 | 1 in 593,800 | 5.1% | 171,705 | 223,818 | 2 | 34% | 17% | 40% | 33% | 10% |

### Who wins, against who fishes (1,000 anglers)

| Table | Newcomer | Regular | Enthusiast | Best equipped |
|---|---|---|---|---|
| Share of the anglers | 55% | 30% | 12% | 3% |
| Share of the casts | 39% | 37% | 19% | 5% |
| Share of the wins, Flat | 39% | 37% | 19% | 4% |
| Share of the wins, Gentle | 26% | 43% | 25% | 6% |
| Share of the wins, Recommended | 24% | 39% | 29% | 8% |
| Share of the wins, Steep | 17% | 40% | 33% | 10% |

### When the crowd is not the one the season was set for (recommended table)

Rows: the crowd the base chance was fitted to. Columns: the crowd that came. Each cell: seasons nobody wins / the median winning day of the seasons that are won / seasons over on day 1.

| Fitted to | 10 came | 100 came | 1,000 came | 10,000 came |
|---|---|---|---|---|
| 10 (1 in 381) | 5% / day 2 / 35% | 0% / day 1 / 99% | 0% / day 1 / 100% | 0% / day 1 / 100% |
| 100 (1 in 4,280) | 76% / day 4 / 4% | 5% / day 2 / 34% | 0% / day 1 / 99% | 0% / day 1 / 100% |
| 1,000 (1 in 42,800) | 98% / day 4 / 0% | 75% / day 4 / 4% | 5% / day 2 / 35% | 0% / day 1 / 99% |
| 10,000 (1 in 428,300) | 100% / no winner / 0% | 97% / day 4 / 1% | 75% / day 4 / 4% | 5% / day 2 / 34% |

### How often a season has no winner, by how many hits it is set for

1,000 anglers, recommended table. Fewer expected hits make a season last longer and end empty more often.

| Expected hits in a season | Base chance per cast | Nobody wins | Winning day, median | Over on day 1 |
|---|---|---|---|---|
| 1 | 1 in 128,500 | 37.1% | 3 | 13% |
| 2 | 1 in 64,300 | 13.1% | 2 | 25% |
| 3 | 1 in 42,800 | 5.3% | 2 | 35% |
| 5 | 1 in 25,700 | 0.7% | 1 | 51% |
| 8 | 1 in 16,100 | 0.0% | 1 | 68% |

### What a season costs a player (recommended table, 1,000 anglers)

| Angler | Casts | Energy | Share of the season’s energy | PEARL for lures | PEARL of rod wear | Rod, once | Chance per cast | Own chance to hook it in the season |
|---|---|---|---|---|---|---|---|---|
| Newcomer | 56 | 56 | 16% | 0 | 0 | 0 | 1 in 42,800 | 0.13% |
| Regular | 98 | 98 | 28% | 300 | 147 | 1,500 | 1 in 25,200 | 0.39% |
| Enthusiast | 126 | 252 | 71% | 1,200 | 378 | 12,000 | 1 in 17,500 | 0.72% |
| Best equipped | 119 | 357 | 100% | 15,000 | 1,190 | 150,000 | 1 in 14,300 | 0.83% |

### Many wallets in one hand (recommended table)

Extra wallets with free tackle, each making all 20 casts every day, join the crowd. The cell is the chance that the winner is one of them.

| Honest anglers | 10 wallets | 100 wallets | 1,000 wallets | 10,000 wallets |
|---|---|---|---|---|
| 10 | 55% | 92% | 99% | 100% |
| 100 | 10% | 52% | 92% | 99% |
| 1,000 | 1% | 10% | 52% | 92% |
| 10,000 | 0% | 1% | 10% | 52% |

What each extra wallet costs its owner under a season’s entry rules:

| Entry rule | Cost per wallet |
|---|---|
| None (the MVP season) | Nothing but gas: energy is free and refills |
| Level 3 | 300 XP: about 42 ordinary casts at the pond, 0.9 days of a wallet’s energy |
| Level 5 | 1,000 XP: about 139 ordinary casts at the pond, 2.9 days of a wallet’s energy |
| Level 8 | 2,800 XP: about 390 ordinary casts at the pond, 8.1 days of a wallet’s energy |
| A paid rod (Carbon Spinner) | 1,500 PEARL, earned by selling fish or bought |

For scale: the honest crowd of 1,000 makes 128,504 base-chance casts’ worth of attempts a season, and one full-cap free wallet 140.
<!-- sim:hunt:end -->

## Reading the tables

**Why 3× and not more.** Under the steep table the 15% of the crowd with the two best tackle sets take 43% of the
wins and the newcomers, more than half the crowd, 17%. Under the recommended table the newcomers keep 24%, about
two thirds of their share of the casts, and the best-equipped 3% take 8%. Under the gentle table the best rod buys
nothing over the mid-range one, because both hit the cap. The recommended cap is the highest one at which the whole
ladder still matters.

**Why bonuses are added, not multiplied.** Multiplied bonuses compound: a rod at 1.8×, a lure at 1.8× and a water
at 1.4× would be 4.5×, and every new item would move the top of the range. Added and capped, the best possible
chance is `baseChance × (100 + maxBonus) / 100`, known when the season is announced.

**No tackle guarantees the fish.** With the best tackle, every cast of the week and the base chance fitted to a
crowd of 1,000, a player hooks the target in fewer than one season in a hundred. The contract also refuses a season
whose best chance is above 10% per cast.

**Three expected hits.** One expected hit leaves 37% of seasons empty. Five make the season shorter than a day
half of the time. Three is the lowest setting at which an empty season is rare (about 5%) while the median season
still reaches its second day. An empty season is not lost: its prize goes back to the sponsor or rolls into the
next one.

**What a season costs.** Seasonal casts are ordinary casts, so their price is the ordinary price: energy, lure
uses, rod wear. A newcomer spends 56 energy and no PEARL. The best-equipped player spends the whole week's energy
at the Northern Sea and about 16,000 PEARL on lures and repairs, for a chance per cast three times the newcomer's.
All of them also land their ordinary catches on those casts, so none of this is spent on the hunt alone.

**Many wallets in one hand.** The cap is per wallet and cannot be anything else. The matrix shows that a farm
needs about as many wallets as there are honest players to take half of the seasons. For a testnet prize that is
nobody's business case; for a prize of value it is, and a season then needs an entry rule that costs something
per wallet. The two the contract already has are `minLevel` and `rods`; their prices per wallet are in the last
table. Neither stops a patient farm, they only price it, and a real launch needs more (see "Before a public
launch" in SEASON_HUNT.md).

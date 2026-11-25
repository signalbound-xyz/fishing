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

## Weekly seasons: three hunts

A weekly season is three hunts one after another, each a season of the contract with its own fish, rules and
prize (see "Weekly seasons" in [SEASON_HUNT.md](../SEASON_HUNT.md)). `pnpm sim:week` (`sim/week.ts`,
`sim/week.sim.ts`) reads the repository's week file, `contracts/script/seasons/weeks/2026-w50.json`, and rewrites
the tables of this section, so they describe the rules that would be created and not a copy of them.

**What makes a hunt harder.** Not a rarer fish alone: the target's ordinary rarity plays no part in the seasonal
draw, and ordinary fishing odds, equipment attributes, energy and cast prices are not touched. A hunt's difficulty
is five numbers of its own rules:

| Lever | Easy | Medium | Hard | What it does |
|---|---|---|---|---|
| Who may enter (`minLevel`, `waters`) | everybody, from the first water | level 2, three waters | level 3, and no Village Pond | Fewer anglers and fewer casts for the same prize |
| Casts a day (`dailyAttempts`) | 20 | 16 | 12 | Fewer chances per wallet, and a scripted wallet is worth less |
| Expected hits (the base chance against the crowd) | 3 | 2.5 | 2 | A longer hunt, and one that ends with no winner more often |
| What tackle can add (`maxBonus` and the bonus tables) | +50% | +100% | +200% | Progress counts for more: the best tackle is worth 1.5×, 2× and 3× the base chance |
| Length | 2 days | 2 days | 3 days | Room for the lower chance to be met |

The prizes follow the same order: 20%, 30% and 50% of the pool.

**What the first testnet week is balanced for.** A crowd of ten, about what the testnet has. The base chances in
the file are the ones `fitBase` gives for ten model anglers (1 in 86, 1 in 121, 1 in 147), and a test fails if the
file and the model disagree. The tables then say, for that crowd: a winner in 95%, 92% and 86% of hunts; half of
the hunts over after 9, 11 and 25 hours; about three weeks in four pay all three prizes, and about one week in a
hundred has every hunt over within two hours of opening.

**What the simulation assumes**, beyond the season simulation above:

- *Levels and waters.* The four model anglers are given a level (2, 5, 8, 12) and opened waters (`LEVEL`,
  `OPENED` in `sim/week.ts`). An angler who cannot enter a hunt makes no casts in it. An angler who can fishes the
  water that gives the most chance a day, counting what the water's energy price lets them cast: a full bar when
  the hunt opens and what regenerates while it runs.
- *The hour of a cast.* A hunt is played hour by hour. Of the anglers fishing on a hunt's first day, 15% (`EAGER`)
  are taken to be waiting for it to open and make that day's casts in its first two hours; everybody else, and
  everybody on later days, is spread evenly over the day. This is the number the "within 2 h" column leans on, and
  it is a guess: nobody has watched a hunt open yet. At 30% the easy hunt would be over within two hours about
  four times in ten.
- *The Hard hunt on a small testnet.* With level 3 required and no Village Pond, more than half of the model crowd
  cannot enter: 4 of 10. That is the intent (it is the hunt progress is for), and it is also why its prize is the
  largest. If the real crowd has nobody at level 3 the hunt cannot be won; check before announcing a week (four
  recent testnet players were at levels 1, 1, 2 and 4 on 25 November 2026) and lower `minLevel` in the file if so.
- *One angler, three hunts.* The three hunts are drawn independently. The same wallet may win more than one of
  them; nothing in the contract or in the model stops it.

**What does not depend on the crowd model.** As for a single season: fitted to its crowd, a hunt behaves the same
at any size, and the fit is what matters. The last but one table shows the week file meeting a crowd ten times
larger than it was written for: every hunt is over in under an hour. A week's base chances must be set from the
casts of the week before, hunt by hunt, and the file is the place to do it: `pnpm sim:week` prints the fitted
value for each size.

<!-- sim:week:begin -->
### The three hunts of `2026-w50` ("The Three Strays")

From `contracts/script/seasons/weeks/2026-w50.json`: 7 days from 2026-12-07T00:00:00Z, 1,000 BLEND in all.

| Hunt | Difficulty | Runs | Prize | Target | Waters (bonus) | Level | Casts a day | Tackle cap | Best tackle | Set for |
|---|---|---|---|---|---|---|---|---|---|---|
| 1. The Gilded Guest | Easy | day 1 to 2, 48 h | 200 BLEND (20%) | Golden Carp | Village Pond, Forest River (+10%) | any | 20 | +50% | ×1.5 | 3 hits |
| 2. The Night Catfish | Medium | day 3 to 4, 48 h | 300 BLEND (30%) | Wels Catfish | Village Pond, Forest River (+15%), Deep Lake (+30%) | 2+ | 16 | +100% | ×2.0 | 2.5 hits |
| 3. The Wandering Bluefin | Hard | day 5 to 7, 72 h | 500 BLEND (50%) | Bluefin Tuna | Forest River, Deep Lake (+25%), Northern Sea (+40%) | 3+ | 12 | +200% | ×3.0 | 2 hits |

### Who can enter, and how they fish each hunt

The model anglers of the season simulation, with a level and opened waters each. A cell is the water the angler fishes, the seasonal casts a day, and the chance of a cast against the base chance; "cannot enter" is the level or the waters.

| Angler | Share of the crowd | Level | Waters opened | 1. The Gilded Guest | 2. The Night Catfish | 3. The Wandering Bluefin |
|---|---|---|---|---|---|---|
| Newcomer | 55% | 2 | Village Pond | Village Pond, 8 a day, ×1.00 | Village Pond, 8 a day, ×1.00 | cannot enter |
| Regular | 30% | 5 | Village Pond, Forest River, Deep Lake | Forest River, 14 a day, ×1.30 | Deep Lake, 14 a day, ×1.70 | Deep Lake, 12 a day, ×1.85 |
| Enthusiast | 12% | 8 | Village Pond, Forest River, Deep Lake, Northern Sea | Forest River, 18 a day, ×1.50 | Deep Lake, 16 a day, ×2.00 | Northern Sea, 12 a day, ×2.60 |
| Best equipped | 3% | 12 | Village Pond, Forest River, Deep Lake, Northern Sea | Village Pond, 20 a day, ×1.50 | Village Pond, 16 a day, ×2.00 | Northern Sea, 12 a day, ×3.00 |

### Each hunt by crowd size, with the base chance fitted to the crowd

The base chance is set so that the crowd hooks the fish the number of times the hunt is set for. Worked out from the model, not sampled. "Within 2 h" is the chance that the hunt is over 2 hours after it opens; "half are over by" is the median time to the first catch; "mean" is the average among the hunts that have a winner.

| Hunt | Anglers | Can enter | Eligible casts | Base chance | Best tackle | A winner | No winner | Within 2 h | Half are over by | Mean time to the catch | Casts before the win |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1. The Gilded Guest | 10 | 10 | 216 | 1 in 86 | 1 in 58 | 95.0% | 5.0% | 28.2% | 8.8 h | 12.0 h | 61 |
| 1. The Gilded Guest | 100 | 100 | 2,272 | 1 in 933 | 1 in 622 | 95.0% | 5.0% | 28.2% | 8.8 h | 12.0 h | 639 |
| 1. The Gilded Guest | 1,000 | 1,000 | 22,720 | 1 in 9,330 | 1 in 6,220 | 95.0% | 5.0% | 28.2% | 8.8 h | 12.0 h | 6,389 |
| 1. The Gilded Guest | 10,000 | 10,000 | 227,200 | 1 in 93,300 | 1 in 62,200 | 95.0% | 5.0% | 28.2% | 8.8 h | 12.0 h | 63,895 |
| 2. The Night Catfish | 10 | 10 | 212 | 1 in 121 | 1 in 61 | 91.8% | 8.2% | 24.1% | 11.4 h | 13.5 h | 66 |
| 2. The Night Catfish | 100 | 100 | 2,200 | 1 in 1,310 | 1 in 654 | 91.8% | 8.2% | 24.1% | 11.4 h | 13.5 h | 684 |
| 2. The Night Catfish | 1,000 | 1,000 | 22,000 | 1 in 13,100 | 1 in 6,540 | 91.8% | 8.2% | 24.1% | 11.4 h | 13.5 h | 6,838 |
| 2. The Night Catfish | 10,000 | 10,000 | 220,000 | 1 in 130,700 | 1 in 65,400 | 91.8% | 8.2% | 24.1% | 11.4 h | 13.5 h | 68,375 |
| 3. The Wandering Bluefin | 10 | 4 | 144 | 1 in 147 | 1 in 49 | 86.5% | 13.5% | 13.7% | 25.0 h | 23.8 h | 49 |
| 3. The Wandering Bluefin | 100 | 45 | 1,620 | 1 in 1,720 | 1 in 574 | 86.5% | 13.5% | 13.7% | 25.0 h | 23.8 h | 557 |
| 3. The Wandering Bluefin | 1,000 | 450 | 16,200 | 1 in 17,200 | 1 in 5,740 | 86.5% | 13.5% | 13.7% | 25.0 h | 23.8 h | 5,565 |
| 3. The Wandering Bluefin | 10,000 | 4,500 | 162,000 | 1 in 172,300 | 1 in 57,400 | 86.5% | 13.5% | 13.7% | 25.0 h | 23.8 h | 55,655 |

### What tackle and progress buy (1,000 anglers)

The share of each hunt’s casts and of its wins by kind of angler, and the same as an advantage: wins per cast against the hunt’s average.

| Hunt | | Newcomer | Regular | Enthusiast | Best equipped |
|---|---|---|---|---|---|
| 1. The Gilded Guest | Anglers who can enter | 550 | 300 | 120 | 30 |
| | Share of the casts | 39% | 37% | 19% | 5% |
| | Share of the wins | 31% | 39% | 23% | 6% |
| | Wins per cast, against the average | ×0.81 | ×1.05 | ×1.22 | ×1.22 |
| 2. The Night Catfish | Anglers who can enter | 550 | 300 | 120 | 30 |
| | Share of the casts | 40% | 38% | 17% | 4% |
| | Share of the wins | 27% | 44% | 24% | 6% |
| | Wins per cast, against the average | ×0.67 | ×1.14 | ×1.35 | ×1.35 |
| 3. The Wandering Bluefin | Anglers who can enter | — | 300 | 120 | 30 |
| | Share of the casts | — | 67% | 27% | 7% |
| | Share of the wins | — | 58% | 33% | 9% |
| | Wins per cast, against the average | — | ×0.87 | ×1.22 | ×1.41 |

### The week as a whole, fitted to its crowd

20,000 weeks per row, sampled hour by hour. "Every hunt over within 2 h" is the week the design is meant to avoid: three hunts that all end right after they open.

| Anglers | 3 winners | 2 | 1 | None | Every hunt over within 2 h | A hunt still on a day after it opened | Share of the pool paid out |
|---|---|---|---|---|---|---|---|
| 10 | 76% | 22% | 2% | 0.1% | 0.9% | 73% | 90% |
| 100 | 76% | 22% | 2% | 0.1% | 0.8% | 73% | 90% |
| 1,000 | 76% | 22% | 2% | 0.1% | 0.9% | 73% | 90% |
| 10,000 | 75% | 23% | 2% | 0.1% | 0.9% | 73% | 90% |

### The week file as written, when another crowd comes

The file's base chances are fitted to 10 anglers. Each cell: no winner / over within 2 h / half are over by.

| Hunt | Base chance in the file | 10 come | 100 come | 1,000 come | 10,000 come |
|---|---|---|---|---|---|
| 1. The Gilded Guest | 1 in 86 | 5% / 28% / 8.8 h | 0% / 97% / 0.4 h | 0% / 100% / 0.0 h | 0% / 100% / 0.0 h |
| 2. The Night Catfish | 1 in 121 | 8% / 24% / 11.4 h | 0% / 95% / 0.5 h | 0% / 100% / 0.0 h | 0% / 100% / 0.0 h |
| 3. The Wandering Bluefin | 1 in 147 | 14% / 14% / 25.0 h | 0% / 82% / 0.8 h | 0% / 100% / 0.1 h | 0% / 100% / 0.0 h |

### How many hits to set a hunt for

Fewer expected hits make a hunt last longer and end empty more often. Any crowd, with the base chance fitted to it; the opening rush is 15% of the first day's anglers in the first 2 hours.

| Expected hits | No winner | 48 h hunt: within 2 h / half over by | 72 h hunt: within 2 h / half over by |
|---|---|---|---|
| 1 | 36.8% | 10% / 33.3 h | 7% / 2.1 d |
| 1.5 | 22.3% | 15% / 21.9 h | 10% / 33.3 h |
| 2 | 13.5% | 20% / 15.3 h | 14% / 25.0 h |
| 2.5 | 8.2% | 24% / 11.4 h | 17% / 19.3 h |
| 3 | 5.0% | 28% / 8.8 h | 20% / 15.3 h |
| 4 | 1.8% | 36% / 5.6 h | 26% / 10.4 h |
| 5 | 0.7% | 42% / 3.6 h | 31% / 7.5 h |
<!-- sim:week:end -->

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

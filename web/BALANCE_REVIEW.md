# Balance and retention review

21 November 2026. Written by hand on top of the generated tables in [BALANCE_AUDIT.md](BALANCE_AUDIT.md) (`pnpm sim:audit`); section numbers below ("audit §7") point into that file. Figures quoted here are from the audit generated on that date and will drift if the scenarios change.

**Nothing in this change alters the game's balance or the contracts.** It adds measurement (telemetry), simulation tooling and this review. Every recommendation below waits for a decision.

## Summary

1. **Sessions are short in the late game, and the cause is the cast price.** A full bar is 20 casts at the pond and 5 at Taimen Rapids or Phantom Waters: about two minutes of play, once the bar has taken ten hours to fill. This is the strongest finding and the cheapest to fix.
2. **On the contracts the fight decides nothing.** The contract rolls the fish and its quality; a lost fight is a retry. So "too easy" and "too hard" there are not about success (every bite is landed by everybody) but about a fight with nothing at stake: early fish cannot be lost, late fish are lost again and again until the third try hauls them in. Skill moves minutes, not PEARL, XP or the weekly board.
3. **The weekly board rewards energy spent and nothing else.** Three check-ins a day score 2.1× a once-a-day player; refills bought with PEARL take that to 2.75×. A beginner and an expert who cast the same number of times score the same.
4. **After level 12 the goals thin out and then stop.** Level 12 comes on day 41 of once-a-day play; the last rod on day 132; the last species and achievement on day 155. After that PEARL has nothing to buy (a simulated player ends the year with 421,000 unspent), and levels stopped meaning anything at 12.
5. **A minimal endgame fits in what is already deployed**: weekly skill cups and three short daily trials on the existing Tournaments contract (they cost no energy and mint no PEARL), and location mastery read from data the contracts already store. No new contract, token or currency.

Recommended order: collect telemetry for two weeks → ship mastery (client only) and the cup rotation (existing contract) → then one energy change, the bigger bar, measured before and after.

## 1. What is measured and what is simulated

**Measured: almost nothing yet.** The whole history of the testnet deployment, read from its event logs on 21 November 2026 (blocks 42,862,832–43,292,689):

| | |
|---|---|
| Game casts | 19, by 3 accounts (9, 7 and 3), between 17 and 19 November |
| Where and with what | all at Village Pond, all with the Willow Rod, none with a lure |
| Outcome | 13 fish, 5 without a bite, 1 expired (bite rate 13 of 18 = 72%; the rule says 65%) |
| Quality of the 13 | D 4, C 2, B 5, A 1, S 1 |
| Sold | 3 fish for 22.5 PEARL (contract units; 225 in the units of this review) |
| Bought | nothing: no rod, lure, repair, refill; no achievement claimed |
| Cup | 2 entries, 8 casts by one account: 6 landed (mean 7.7 s, 89% of the fight in the green), 2 lost |

That is test play by the people building the game, most likely. It confirms that the code does what the rules say; it cannot tune anything.

**Telemetry: none collected yet.** The recorder ships with this change (section 4). Until it has data, nobody knows how fast real players hook or which fights they lose.

**Simulated: everything else.** The audit plays the real rule code (`web/src/game`) with three model players. Their reaction times, misses and choices are assumptions (audit §0). The fight model is the game's own `simulateFight`; "beginner" and "experienced" are the "novice" and "experienced" of [BALANCE.md](BALANCE.md), "average" sits between. Treat the landing rates as estimates to be replaced, and the energy and PEARL arithmetic (which does not depend on skill on the contracts) as solid.

Two rule sets appear throughout, because the game has two: **on the contracts** (production: the contract decides the catch, the fight is retried) and the **local game** (browser only: the fight decides the catch). PEARL is in the client's units, 10× the contract's.

## 2. Assessment

### 2.1 Early fishing is easy: confirmed, and on the contracts by construction

- Village Pond and Forest River are calm water. At the pond 99% of what bites is Common or Uncommon (difficulty 0 or 1 of 5); at the river 84%, and the rest is Rare (difficulty 2).
- At levels 0–2 the average and the experienced model player land 99–100% of fights; the beginner 100%, 98% and 89% (audit §2). Per bite, hook included, the local game gives a beginner 93% at the pond and 91% at the river, an experienced player 99% (§12). That is at the top of the target band set earlier (85–95% and 95–99%), not outside it.
- The window to hook is 1.5–1.6 s; the model beginner misses about 6% (§1). Real reaction times are not known.
- On the contracts none of this can cost a fish: tries per fish are 1.01–1.10 at the pond and river (§3). And doing well earns nothing, because quality is the contract's roll (§5).

So the fight is not too easy by its own targets. It is inconsequential: a new player cannot fail and is not rewarded for skill, on the contracts at any level.

### 2.2 Late fishing is hard: confirmed for beginners, and it punishes differently in each rule set

- **Local game**, fish landed per bite on the first try (§12): Taimen Rapids 25% for a beginner (target 45–65%), 60% average, 93% experienced (above the 75–90% target). Phantom Waters 45 / 80 / 97%. Northern Sea 66 / 91 / 98%.
- The cause is the pool, not the water: Taimen Rapids is rough water (+2) with almost only Rare and Epic fish, so nearly every fight is difficulty 4 or 5, where a beginner lands 37% and 21% (§2).
- For a beginner in the local game the late waters pay *less* per energy than the first ones: 12.2 PEARL per energy at Taimen Rapids against 23.7 at Forest River, with the best tackle (§6). The player who most needs encouragement is told to go back.
- **On the contracts** the fish is never lost, so "hard" means repetition: a beginner needs 1.95 tries per fish at Taimen Rapids and spends 34 s a cast; 6% of Mythic-level fights end hauled in after three losses (§2, §3). An experienced player barely notices (1.07 tries).
- Experienced players are above target everywhere in rough water (97–99%): the fight has no ceiling for a good player.

### 2.3 Sessions are short: confirmed

One full bar on the contracts (§7), best tackle, average player:

| Water | Cast price | Casts in a bar | Minutes of play | Energy stranded |
|---|---|---|---|---|
| Village Pond, Forest River | 1 | 20 | 6.4–6.8 | 0 |
| Deep Lake, Golden Lake | 2 | 10 | 3.5–3.6 | 0 |
| Northern Sea, Ancient Swamp | 3 | 6 | 2.3–2.5 | 2 |
| Taimen Rapids, Phantom Waters | 4 | 5 | 2.1–2.3 | 0 |

- A new player's first two weeks, once a day: 13 casts and 4.5 minutes a sitting. A late-game player: 5 casts and 2.1 minutes (§13). **Progress makes the game shorter.**
- The bar takes ten hours to fill and holds 20, while a day regenerates 48. A once-a-day player uses 20 of them; somebody who checks in three times uses all 48 and earns 2.6× as much (§14). The bar size, not the regeneration rate, is what separates the two.
- At 3 energy a cast, 2 of every 20 are stranded (10% of the bar).
- About 8 of the 20–29 seconds of a cast on the contracts are assumed transaction waits. That number is a guess; telemetry on the contracts will show the real one (the gap between a cast and its bite event).

### 2.4 Nothing to aim for after level 12: partly

Once a day, on the contracts (§8, §9):

| | Day |
|---|---|
| Level 12, Taimen Rapids opens | 41 |
| Deep Troller | 50 |
| Last water (Phantom Waters, needs the Ghost Fish) | 74 |
| Pearl Master, the last rod | 132 |
| Last species and last achievement | 155 |

- On the day level 12 arrives a player has 21 of 36 species, 7 of 14 achievements, 4 of 6 rods and 7 of 8 waters. So there are goals left, but they are few and far apart: between the Deep Troller (day 50) and the Pearl Master (day 132) the only thing to do with PEARL is wait, at five casts a day.
- **Levels stop mattering at 12.** They open waters at 3, 8 and 12 and gate nothing else. Level 13 arrives on day 50, level 20 on day 146, level 25 on day 245, and none of them does anything.
- **After day 155 there is nothing.** Players who never waste energy get there on day 64; with two refills a day, day 38.
- Mid-game progress is slowed by a side effect: late waters give a third of the XP per energy of the river (4–6 against 12–16, §6), because XP is per fish and a late cast costs four times as much. A player who follows the PEARL levels up slower.

### 2.5 Leaderboards reward playtime more than skill: confirmed

The weekly board (ten best catches of the week), a late-game player on the contracts (§10):

| Play pattern | Energy a week | Weekly total | vs once a day |
|---|---|---|---|
| Every other day | 70 | 1,398 | 0.65× |
| Once a day | 140 | 2,160 | 1.00× |
| Twice a day | 280 | 4,120 | 1.91× |
| Three check-ins | 337 | 4,485 | 2.08× |
| Three check-ins + 2 refills a day | 589 | 5,459 | 2.53× |
| Every four hours + 4 refills a day | 870 | 5,947 | 2.75× |

- **Skill: 0.99×.** Beginner, average and experienced score the same on the contracts (the differences in the table are noise). The best-ten rule dampens volume (6× the energy gives 2.75× the score) but there is nothing else in the score.
- The four refills cost 1,500 PEARL a day against an income of 12,000: the top of the board is bought with PEARL the game itself hands out.
- **The cups are the skill board, when the water is rough.** Same water, tackle and casts for everybody, and the fight is replayed by the contract. An experienced player beats a beginner in 96% of pairings in a rapids cup, but only 64% in a calm pond cup, where everybody lands everything and luck in the draw decides (§10). The `waterTier` of a cup is free to set, whatever the water.

### 2.6 Found on the way

- **PEARL has no sink once the rods are bought.** A late-game player burns 4–5% of what they mint (lures and repairs); with heavy refills 17% (§14). The rest accumulates: 421,000 in hand after a year of once-a-day play.
- **Refills are profitable, not a cost.** 20 energy at Phantom Waters nets about 1,300 PEARL; the first four refills of a day (100, 200, 400, 800) each cost less than that. They turn PEARL into more PEARL and into board position.
- **BALANCE.md's progression numbers are for the local game with an expert at the reel.** On the contracts skill does not slow anybody, so the "novice" columns there do not describe production.

## 3. Alternative configurations

All simulated only (audit §11–12). Change the numbers in `web/sim/scenarios.ts` and run `pnpm sim:audit` to try others.

### 3.1 Energy

Late-game player on the contracts. "Bar" is casts in a full bar at Taimen Rapids / Phantom Waters; PEARL is net income a day relative to today.

| Configuration | Bar | Once a day: casts, minutes, PEARL | Three check-ins: PEARL | Pearl Master, once a day | PEARL minted in a new player's first year |
|---|---|---|---|---|---|
| Current | 5 | 5 casts, 2.1 min, 1.00× | 1.00× | day 132 | 629,000 |
| Cost cap 3 | 6 | 6, 2.5 min, 1.27× | 1.33× | day 120 | 766,000 |
| Cost cap 2 | 10 | 10, 4.2 min, 2.09× | 1.94× | day 78 | 1,338,000 |
| Cost cap 2, prices scaled down | 10 | 10, 4.2 min, 1.01× | 0.93× | day 133 | 657,000 |
| **Bar of 40** | 10 | 10, 4.2 min, 2.08× | 0.94× | day 67 | 1,404,000 |
| Bar of 48 | 12 | 12, 5.0 min, 2.50× | 1.02× | day 54 | 1,646,000 |

Three of these give the 10–15 late casts a bar that was asked for:

- **Cost cap 2** doubles the session and doubles late income for everybody, the heaviest players included. Tackle that was priced for months is bought in half the time and the economy inflates 2×. Not recommended on its own.
- **Cost cap 2 with prices scaled down** (fish of the four expensive waters sell for ½ or ⅔) doubles the session and the XP, leaves PEARL where it is (1.01×) and closes the XP gap described in 2.4. It is the cleanest result and the most invasive change: species prices are shared state, so every fish of those species already in a keepnet loses value the moment it lands, and upkeep per PEARL earned doubles.
- **Bar of 40** doubles the session for the player who comes once a day and changes nothing for the one who already uses every point (0.94×, noise): the ceiling of 48 energy a day stays, so the most a single account can mint does not move. It narrows the gap between casual and constant play from 2.6× to about 1.2×, on income and on the weekly board alike. Its cost: casual players progress twice as fast (Pearl Master on day 67 instead of 132), which brings the end of content forward, and with two refills a day income rises 1.41× because a refill fills a bigger bar (priced at 300 here, what 40 energy costs today).

**Recommendation: Bar of 40, after the endgame of section 5 exists**, and not before: it is one owner transaction (`FishingGame.setConfig`), needs no upgrade and no repricing, is reversible, and treats the complaint directly. Keep "cost cap 2 with prices scaled down" as the follow-up if telemetry still shows sittings under five minutes. Whichever is chosen, 3-energy casts should stop stranding 2 of 20 (a bar of 40 leaves 1; 42 leaves none).

### 3.2 Reel difficulty

Local game, fish landed per bite on the first try, starter rod (§12). Each curve remaps the six difficulty levels onto fights the game already has.

| Curve | Pond: beginner / experienced | Northern Sea | Taimen Rapids | Phantom Waters |
|---|---|---|---|---|
| Current (0–5) | 93% / 99% | 66% / 98% | 25% / 93% | 45% / 97% |
| Firmer early (1, 1.5, 2, 3, 4, 5) | 91% / 99% | 66% / 98% | 25% / 93% | 45% / 97% |
| Softer late (0, 1, 2, 3, 3.5, 4) | 93% / 99% | 68% / 99% | 38% / 98% | 51% / 99% |
| Flatter (1, 1.5, 2, 3, 3.5, 4) | 91% / 99% | 68% / 99% | 38% / 98% | 51% / 99% |
| Narrow (2, 2.25, 2.5, 3, 3.25, 3.5) | 83% / 99% | 66% / 99% | 49% / 99% | 56% / 99% |
| Target | 85–95% / 95–99% | 45–65% / 75–90% | same | same |

- **No remap makes the early game hard for a competent player.** Even at level 2 the average and experienced models land 99–100%. If early fights are to have teeth, the fight itself needs something new for good players (the tables only go so far), and that should wait for real reaction data.
- **Softer late** lifts a beginner at Taimen Rapids from 25% to 38%, still short of the band; **Narrow** reaches it (49%) and costs the beginner 10 points at the pond.
- **No remap brings experienced players down into their band** in rough water: they land 97–99% under every curve.
- On the contracts a curve changes seconds only: a beginner's cast at Taimen Rapids goes from 34.1 s to 30.7 s under Narrow.

**Recommendation: do not change the curve yet.** The model's verdict depends entirely on three assumed players. This is exactly what the telemetry measures: after a few hundred real fights per difficulty level, compare the landing rates with audit §2 and decide. The reel lives in the client (`web/src/game/minigame.ts`), so a curve change is a client release with no contract involved; the cups have their own tables on chain (FightVerifier), which stay as they are.

### 3.3 Where each number lives

| Change | Where | Needs a contract upgrade |
|---|---|---|
| Bar size, regeneration, refill price | `FishingGame.setConfig` (owner) + `TUNING` in the client | no |
| Cast price of a water | `FishingGame.updateLocation` (owner) + `LOCATIONS` in the client | no |
| What a fish sells for | `FishNFT.updateSpecies` (owner); reprices fish already held | no |
| Reel curve, hook window | client only | no |
| A cup or a daily trial | `Tournaments.create` (owner) | no |
| Paid access to secret waters, rewards for mastery, a PEARL sink | new code in `FishingGame` (1,236 bytes free in the current source, 240 in the deployed build) or a new contract | yes |

## 4. Telemetry

`web/src/telemetry` (format and summary, pure and tested) and `web/src/play/telemetry.ts` (the browser side). It records sessions, casts, bites, hook reaction times, fights with their result and reason, catches by rarity and quality, energy running out, purchases, unlocks and sales. See the README for the event list.

- **It observes only.** No rule reads it; deleting the log changes nothing in the game.
- **It stays in the browser.** No network call, no third party, no wallet address or account data in any event. `VITE_TELEMETRY=off` builds it out of the recording path.
- **It works in both modes** and tags every event with the mode, because the fights on the contracts are the same fights and that is where real players are.
- **`#/stats`** (link in the footer) shows the summary and exports or clears the log.

What to collect before deciding anything in section 3, from at least a handful of people who are not the developers:

| Question | Read from | Enough when |
|---|---|---|
| How fast do people hook? | hook reaction median and 90th percentile by difficulty | 100 hooks per level |
| Which fights do they lose? | fights by difficulty, first tries | 200 fights per level; compare with audit §2 |
| How long is a sitting, and what ends it? | sessions: length, casts, "out of energy" | 30 sessions |
| How long is a cast on the contracts? | time between cast and bite, cast and catch | 100 casts |
| Do people buy refills and lures? | purchases | any |

The model players in `web/sim/lab.ts` (`PLAYERS`) are then replaced by what was measured, and the audit is run again.

## 5. Endgame proposal

A minimal system out of what exists. Three parts; none needs a new contract, a token, a currency or an NFT.

### 5.1 Weekly skill cup (existing Tournaments contract)

*Fixed equipment, limited attempts*, which is what a tournament already is: one water, one rod and lure for everybody, 30 casts, the best 10 count, the fight replayed and scored by the contract.

- One cup a week, rotating water and tackle. Entry needs the cup's rod, so **every rod becomes a key to an event**: a reason to own the Ironwood Rod or the Pearl Master beyond PEARL per cast.
- **Set `waterTier` to 2 for every cup, calm water included.** That is what makes it a skill event: an experienced player beats a beginner in 96% of pairings at tier 2 on the rapids and 76% on the pond, against 64% on a calm pond (audit §10).
- A cup takes 12–16 minutes to fish and **no energy**: it adds play without touching the energy economy.
- Prizes as today: none, a sponsor's BLEND, or entry fees less the rake. Nothing is minted.

### 5.2 Three daily trials (the same contract)

Three 24-hour tournaments a day, free, 5 casts each with the best 3 counted: about 2.5 minutes each, 7 minutes for the three, again without energy.

- Rotation by the calendar: one calm, one choppy, one rough; one with the starter rod (everybody can enter), two with rods that have to be owned.
- **Medals, not ranks.** With five casts luck dominates (an experienced player beats a beginner only 60–70% of the time), so a trial is scored against fixed thresholds: bronze, silver, gold, set from the simulation for that setup. A medal is derived from the player's on-chain entry, so it cannot be faked and needs no storage.
- No PEARL, no BLEND. The reward is the medal count and the streak shown in the client.

### 5.3 Location mastery (client only, from data already on chain)

The contracts store, per player and species, how many were caught and the heaviest. Mastery is a reading of that, per water, in three tiers (sized in audit §15):

| Tier | Rule | Energy for all eight waters |
|---|---|---|
| Known | every species of the water met once (today's collection achievement) | 1,250 |
| Regular | 20 / 12 / 6 / 3 catches of each Common / Uncommon / Rare / Epic species, one of anything rarer | 2,150 |
| Trophy | a specimen of at least 70% of the species' maximum weight, for everything up to Epic | 3,100 |

- Tiers build on each other. All eight trophies are about 155 days at 20 energy a day, 65 at 48: the same order as the whole current game, as a second lap through every water.
- It sends players back to waters they have left, with a use for weight tackle (Ironwood Rod, Topwater Popper) that PEARL-per-cast never rewards.
- It lowers emission a little while it lasts: every water but Phantom Waters pays 41–84% of Phantom's PEARL per energy.
- No reward beyond the badge and a rank ("Master of 3 waters"). An on-chain reward would need a new achievement kind, which means an upgrade: later, if at all.

### 5.4 Considered and left out

- **PEARL rewards for dailies.** That is a daily faucet into an economy with no sink; the opposite of what it needs.
- **A challenges contract** that checks catches and grants energy. It works, but it is a new contract with minting or energy rights: more than "minimal", and not needed for the retention effect.
- **More levels with gates.** Cheap, but it is the same treadmill made longer.
- **A PEARL sink** (cup entry paid in PEARL and burned) would be the right partner to all of this. It needs a contract change, so it is noted here as the next thing to design, not proposed.

### 5.5 Implementation plan

| Step | What | Where | Contracts | Size |
|---|---|---|---|---|
| 0 | Two weeks of telemetry from real play; re-run the audit with measured players | — | none | — |
| 1 | Mastery: `game/mastery.ts` (pure, tested), badges in Collection and Trophies | client | none | 2 days |
| 2 | Cup rotation: a table of setups and a script that opens a week of cups and trials in one run (`Tournaments.create` accepts future start times) | `contracts/` script | existing, owner calls | 1 day |
| 3 | Cup page: "today's trials" and "this week's cup" on top, medals and streak from on-chain entries | client | none | 2–3 days |
| 4 | Bar of 40: `setConfig` on the testnet, `TUNING.maxEnergy` in the client, in one release; telemetry before and after | owner call + client | existing | hours |
| 5 | Decide on the reel curve and on "cost cap 2, prices scaled down" from the data | — | — | — |

Open points for steps 2–3, to check before building:

- **Bots.** The Tournaments contract says so itself: the fight seed is public, so a script can play a perfect fight. Harmless for medals, not for a cup with a real prize. Prize cups need an answer first (the earlier idea of a level gate and a minimum share in the green is a start, not a fix).
- **The owner key.** Opening tournaments is `onlyOwner`. Running the rotation from CI would put that key in CI; a weekly manual run does not.
- **Gas.** A cup cast is two transactions and the settlement replays the fight on chain. Three trials a day is about 33 transactions a player (an entry, five casts and five settlements each); whether sponsorship covers that is not measured.
- **List growth.** About 1,150 tournaments a year. `list(player, limit)` reads the newest `limit`, so the client is fine; old ones are reached by id.

## 6. Estimated impact on energy and PEARL

| Change | Energy | PEARL minted | PEARL burned | Time in the game |
|---|---|---|---|---|
| Weekly cup | none | none | none | +12–16 min a week |
| Three daily trials | none | none | none | +7 min a day (late game today: 2.1) |
| Mastery | none; redirects it | down while pursued: 41–84% of the best water's income | unchanged | a second lap: +155 days at 20 a day |
| Bar of 40 | once a day: 20 → 40 used; three check-ins: unchanged (48) | once a day 2.08×, three check-ins 0.94×, with 2 refills 1.41×; the most one account can mint without refills is unchanged | upkeep scales with casts | once a day: 2.1 → 4.2 min |
| Cost cap 2 | unchanged | late game about 2× for everybody | 2× upkeep | 2× casts |
| Cost cap 2, prices scaled down | unchanged | 1.01× | 2× upkeep | 2× casts, 2× XP |
| Reel curve | none | none on the contracts; local game up to +70% for a beginner in rough water under "softer late" | none | −1 to −4 s a cast in rough water |

The endgame parts are neutral on PEARL by design. The energy changes are not: the bigger bar doubles what the casual majority mints. With no sink after the rods, that is a reason to ship the endgame first and to design the sink next.

## 7. Limits

- **Three assumed players.** Hook and fight rates are a model. Energy, casts per bar, prices, XP and everything on the contracts that skill does not touch are arithmetic on the rules.
- **The economy player is efficient**: sells everything fresh (+20%), fishes the best water, buys in price order. Real income per energy is lower; milestone days are a lower bound for a given play pattern.
- **Transaction time is a guess** (4 s each way). Session minutes on the contracts move with it.
- **The local game regenerates energy at a point a minute**, on purpose. The simulated "local" careers use the contract's clock to compare skill alone; they are not what a local player experiences.
- **The cup fight model** is the free-play model moved onto the integer fight. It has not been checked against recorded fights; there are six on chain.
- **20 careers per cell.** Milestones that depend on a rare fish (Phantom Waters) vary by weeks between runs; medians are quoted.

## 8. Decisions needed

1. Collect telemetry first, or act on the simulation now?
2. Mastery and the cup rotation: build them (steps 1–3)?
3. Bar of 40: agreed as the energy change, after the endgame?
4. Prize cups: wait for an answer to bots, or run free cups meanwhile?

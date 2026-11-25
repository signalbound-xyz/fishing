/**
 * What losing a fish for good does to the game: `pnpm sim:reel`. Runs the balance lab (lab.ts, the real game rules
 * with model players) twice, once by the rule the contracts have up to release 004 (a lost fight is another try,
 * the third is hauled in) and once by the rule of the reel judge (one fight, checked by the contract; a lost fight
 * is a lost fish), and writes REEL_BALANCE.md with the two side by side. Not part of `pnpm test`.
 *
 * Every number it writes is a simulation with model players (lab.ts, PLAYERS): reaction lag, reading error and a
 * chance of missing a warning are assumptions, not measurements. Nothing here changes a rule of the game.
 */
import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { greenOf } from '../src/game/chainOutcome';
import { hookFish, landFish, rollBite, sellFish, startCast } from '../src/game/actions';
import { LOCATIONS, SPECIALS, SPECIES, TUNING } from '../src/game/content';
import { xpForLevel } from '../src/game/economy';
import { U } from '../src/game/fight';
import { difficultyOf } from '../src/game/minigame';
import { freshSave } from '../src/game/save';
import type { Rarity, Save } from '../src/game/types';
import { RODS } from '../src/tackle/catalog';
import { PATTERNS, PLAYERS, PLAYER_NAMES, TIMING, WORLD_NOW, bestLoadout, careers, castModel, hookStats, judgeFightStats, mean, median, milestone, mulberry32, netPerEnergy, quantile, type CareerResult, type CastModel, type Loadout, type Pattern, type PlayerName, type Rules } from './lab';

const RUNS = 20;
const DAYS = 365;
const RARITY = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic'];
const WATER = ['calm', 'choppy', 'rough'];
const pct = (x: number, d = 0): string => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const f1 = (x: number): string => x.toFixed(1);
const table = (head: string[], rows: (string | number)[][]): string => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const starter: Loadout = { rod: RODS[0], lure: null };
const model = (rules: Rules, player: PlayerName, locId: number, lo: Loadout = starter): CastModel => castModel(rules, player, 'current', WORLD_NOW, locId, lo);
const best = (rules: Rules, player: PlayerName, locId: number) => bestLoadout(rules, player, 'current', WORLD_NOW, locId);
const loName = (lo: Loadout): string => `${lo.rod.name}${lo.lure ? ` + ${lo.lure.name}` : ''}`;
/** Share of the fish that bite that end in the keepnet. */
const landShare = (m: CastModel): number => m.landed / m.bite;
/** Of the fish of the given rarities that bite: the share that gets away. */
const lostShare = (m: CastModel, rarities: number[]): number => {
  const lines = m.lines.filter((l) => rarities.includes(l.rarity));
  const p = lines.reduce((a, l) => a + l.p, 0);
  return p === 0 ? NaN : lines.reduce((a, l) => a + l.p * (1 - l.land), 0) / p;
};
const players = PLAYER_NAMES;
const head = (...first: string[]): string[] => [...first, ...players.map((p) => PLAYERS[p].name)];

const runCache = new Map<string, CareerResult[]>();
function run(rules: Rules, player: PlayerName, pattern: Pattern): CareerResult[] {
  const key = `${rules}|${player}|${pattern.name}`;
  let rs = runCache.get(key);
  // the same seeds for both rules: the two careers of a pair meet the same luck until the rules part them
  if (!rs) runCache.set(key, (rs = careers({ rules, player, reel: 'current', world: WORLD_NOW, pattern, start: 'new', days: DAYS }, RUNS, 31 + players.indexOf(player))));
  return rs;
}
const dayOf = (rs: CareerResult[], key: string): string => {
  const m = milestone(rs, key);
  return m.day === null ? (m.reached ? `${m.reached}/${rs.length} runs` : 'not in a year') : `${Math.round(m.day)}`;
};
const sum = (xs: number[], from = 0): number => xs.slice(from).reduce((a, x) => a + x, 0);

/**
 * Energy spent at one water, with the starter rod, until its special fish is in the keepnet: the game's own cast,
 * bite, special roll and pity (actions.ts), with the fight decided by the model player's landing rate. `rules`
 * 'chain': every fish that bites is landed.
 */
function energyToSpecial(rules: Rules, player: PlayerName, locId: number, seed: number): number {
  const rng = mulberry32(seed);
  const loc = LOCATIONS[locId];
  let s: Save = { ...freshSave(0), blendWins: 99, xp: xpForLevel(15), permanentUnlocks: LOCATIONS.map((l) => l.id) };
  for (let casts = 1; casts < 100_000; casts++) {
    s = { ...s, location: locId, energy: TUNING.maxEnergy, energyAt: 0 };
    const c = startCast(s, 0);
    s = c.save;
    if (!rollBite(c.ticket, rng)) continue;
    const h = hookFish(s, c.ticket, rng);
    const sp = SPECIES[h.speciesId];
    if (rules === 'strict' && rng() >= judgeFightStats(player, Math.min(5, difficultyOf(sp.rarity, loc.tier)), greenOf(c.ticket.totals.rod.catch)).land) continue;
    const l = landFish(s, c.ticket, h, 'B', casts);
    if (l.fish.isSpecial) return casts * loc.energyCost;
    s = sellFish(l.save, [l.fish.id], casts).save;
  }
  return Infinity;
}

/** Other fights the judge could be given, to weigh against the one designed. A judge is a contract of its own: giving the game another one is not an upgrade of the game. */
const JUDGES: { name: string; note: string; d: (rarity: number, tier: number) => number }[] = [
  { name: 'As designed', note: 'rarity + water tier (0 / 1 / 2), at most 5', d: (r, t) => Math.min(5, r + t) },
  { name: 'Gentler rough water', note: 'rough water adds 1, like choppy water, instead of 2', d: (r, t) => Math.min(5, r + Math.min(1, t)) },
  { name: 'Capped at 4', note: 'rarity + water tier, at most 4: no fight is harder than a Legendary fish in calm water', d: (r, t) => Math.min(4, r + t) },
  { name: 'Both', note: 'rough water adds 1, and at most 4', d: (r, t) => Math.min(4, r + Math.min(1, t)) },
];

it(
  'the reel fight, with the fish at stake',
  () => {
    const out: string[] = [];
    const push = (...lines: string[]): void => void out.push(...lines, '');

    push(
      '# Balance with a fish that can be lost',
      'Generated by `pnpm sim:reel` (web/sim/reel.sim.ts) from the real game rules. It compares two rules for the contracts:',
      '- **Before** (releases up to 004): a lost fight is another try at the same fish, each easier, and the third is hauled in. Every bite ends in the keepnet; skill costs time.\n- **After** (release 005 with the reel judge attached): one fight per fish, replayed by the contract. A lost fight is a lost fish: nothing is minted, no XP, no collection or record entry. The energy, the rod wear and the lure use of the cast stay spent. A missed hook is still another bite.',
      `Energy (a bar of ${WORLD_NOW.maxEnergy}, one point per ${WORLD_NOW.regenSeconds / 60} minutes), what a cast costs in each water, the odds of each species and what a fish sells for are the same in both. Nothing in this file changes the game.`,
      '**Every number below is a simulation.** The three players are models (web/sim/lab.ts, `PLAYERS`), not measurements:',
      table(
        ['Player', 'Reacts after', 'Reading error', 'Misses a warning'],
        players.map((p) => [PLAYERS[p].name, `${PLAYERS[p].fight.lag} s`, `±${pct(PLAYERS[p].fight.noise)} of the gauge`, pct(PLAYERS[p].fight.miss)]),
      ),
      'They hold the needle in the middle of the green and let go when they notice a warning or a jerk. A person who has learned the fight may do better than "Experienced"; a person on a phone with a slow screen may do worse than "Beginner". The telemetry of real fights (#/stats in the game) is what these should be checked against before any number is changed.',
    );

    // ---------------------------------------------------------------- findings
    const daily = PATTERNS.daily;
    const ppeBest = (rules: Rules, p: PlayerName, locId: number): number => netPerEnergy(best(rules, p, locId).model, WORLD_NOW, locId);
    const drop = (p: PlayerName): string => {
      const xs = LOCATIONS.map((l) => 1 - ppeBest('strict', p, l.id) / ppeBest('chain', p, l.id));
      return `${pct(Math.min(...xs))}–${pct(Math.max(...xs))}`;
    };
    const yearPearl = (rules: Rules, p: PlayerName): string => `${Math.round(median(run(rules, p, daily).map((r) => r.earned)) / 1000)}k`;
    const rapids = LOCATIONS.find((l) => l.name === 'Taimen Rapids')!;
    const d5 = (p: PlayerName, green = greenOf(0)): string => pct(1 - judgeFightStats(p, 5, green).land);
    const master = RODS[RODS.length - 1];
    push(
      '## Findings',
      `- **Calm water stays safe.** In the two starting waters a beginner lands ${pct(landShare(model('strict', 'beginner', 0)))} and ${pct(landShare(model('strict', 'beginner', 1)))} of what bites; the first fights a new player meets (difficulty 0–1) are not lost by any of the three models. What is at stake there is the rare fish: a Legendary in calm water is difficulty 4.`,
      `- **Rough water is where fish are lost.** ${rapids.name} is the hardest water: the beginner lands ${pct(landShare(model('strict', 'beginner', rapids.id)))} of the bites with the starter rod, the average player ${pct(landShare(model('strict', 'average', rapids.id)))}, the experienced one ${pct(landShare(model('strict', 'experienced', rapids.id)))}. The targets set earlier for a first try in rough water (BALANCE.md) were 45–65% for a novice and 75–90% for an experienced player: the other rough waters are inside or above them, ${rapids.name} is below for the novice.`,
      `- **Legendary and Mythic fish.** Outside calm water they all fight at difficulty 5, the cap: with the starter rod the beginner loses ${d5('beginner')} of them, the average player ${d5('average')}, the experienced one ${d5('experienced')}. The widest band a rod gives brings that to ${d5('beginner', Math.max(...RODS.flatMap((r) => LOCATIONS.map((l) => greenOf(model('strict', 'average', l.id, { rod: r, lure: null }).totals.rod.catch)))))} for the beginner. This is the largest single cost of the rule, and it falls on the catches players care most about.`,
      `- **Tackle keeps what it gives.** The green band is computed by the judge from the rod's catch exactly as the page shows it. A better rod is now worth fish, not only seconds: at difficulty 4 the beginner goes from ${pct(judgeFightStats('beginner', 4, greenOf(0)).land)} with the starter band to ${pct(judgeFightStats('beginner', 4, Math.max(...RODS.flatMap((r) => LOCATIONS.map((l) => greenOf(model('strict', 'average', l.id, { rod: r, lure: null }).totals.rod.catch))))).land)} with the widest. The reverse holds too: a specialist rod away from its home water narrows the band and loses more fish than the free rod.`,
      `- **PEARL per energy falls by skill.** With the best loadout in each water: ${drop('beginner')} for the beginner, ${drop('average')} for the average player, ${drop('experienced')} for the experienced one. Over a year of one sitting a day the PEARL from fish goes ${yearPearl('chain', 'beginner')} → ${yearPearl('strict', 'beginner')}, ${yearPearl('chain', 'average')} → ${yearPearl('strict', 'average')}, ${yearPearl('chain', 'experienced')} → ${yearPearl('strict', 'experienced')}. Before the change skill bought nothing but time; now it is most of the difference between players.`,
      `- **The tackle takes longer to buy**, the last rod most: ${master.name} (${master.price.toLocaleString('en-US')} PEARL) on day ${dayOf(run('chain', 'average', daily), `rod:${master.name}`)} before, and on day ${dayOf(run('strict', 'beginner', daily), `rod:${master.name}`)} / ${dayOf(run('strict', 'average', daily), `rod:${master.name}`)} / ${dayOf(run('strict', 'experienced', daily), `rod:${master.name}`)} after (beginner / average / experienced, one sitting a day).`,
      '- **Levels do not come later** in these careers: the model player moves to calm, cheap water, which gives more XP per energy. Somebody who stays in rough water levels more slowly (section 6).',
      '- **Special fish take about twice the energy for a beginner** (section 7). The pity still holds: a special fish that gets away at its pity bites again at once.',
      '- **Upkeep is paid on lost fish too.** Rod wear and lure use belong to the cast. With paid tackle the weaker player therefore loses a larger share of the net than of the fish (section 5).',
      '- **A script does not lose fish.** The fight is decided by a seed anybody can read, so a program can work out a recording that lands it (contracts/test/FightBot.sol does). Before the change everybody landed everything; after it a script earns what "before" shows and people earn what "after" shows. The check proves that the recording lands the fish, not that a person played it.',
      '## Recommendations',
      'None of these is applied. Energy, its regeneration, what a cast costs, the odds and the prices are as they were.',
      `1. **Do not tune before real fights are seen.** The three players are assumptions. The page records every fight in the browser it is played in (difficulty, band, landed / snapped / got away; #/stats, with an export). That log is local and nothing collects it: real rates have to be gathered from testers by hand, and then set against section 1 to see whether people fight like the beginner, the experienced model or neither.
2. **If people fight like the models: soften rough water in the judge, not the economy.** "Gentler rough water" (section 9) brings ${rapids.name} from ${pct(landShare(model('strict', 'beginner', rapids.id)))} to about 62% for the beginner and leaves calm water and the rarest fish as they are. It is the judge's \`tiers\` argument: a new judge deployed and attached over still water, with the same numbers in the client's content, and no upgrade of the game.
3. **Decide whether losing half of the Legendary fish is the game wanted.** For the average player it is one in two outside calm water. If that is too much, "Capped at 4" halves it (one constant in ReelJudge.sol, again a new judge). If it is the point of the game, leave it.
4. **Leave prices and energy alone for now.** Raising what fish pay to make up for lost ones would pay the same rise to players and scripts that lose nothing, and would undo the price pass in BALANCE.md. If progress proves too slow for weak players, the fight is the lever.
5. **Leave upkeep on lost casts.** It is what the rule says (nothing spent on the cast comes back), and refunding wear would need the game, not the judge.`,
    );

    // ---------------------------------------------------------------- the fight
    push('## 1. The fight itself', `The fight the contract replays (web/src/game/fight.ts): 50 ms ticks, at most 60 seconds. Its difficulty is the rarity of the fish plus the roughness of the water, capped at 5. The green band is ${pct(greenOf(0) / U)} of the gauge with the starter rod; a rod's catch widens or narrows it (${pct(greenOf(-1000) / U)}–${pct(greenOf(1000) / U)}).`);
    const greens = [...new Set(RODS.flatMap((r) => LOCATIONS.map((l) => model('strict', 'average', l.id, { rod: r, lure: null }).totals.rod.catch)))].map(greenOf);
    const widest = Math.max(...greens);
    const narrowest = Math.min(...greens);
    push(
      table(
        ['Difficulty', ...players.flatMap((p) => [`${PLAYERS[p].name}: landed`, 'snapped / got away']), 'Seconds (average player, landed)'],
        [0, 1, 2, 3, 4, 5].map((d) => [
          d,
          ...players.flatMap((p) => {
            const f = judgeFightStats(p, d, greenOf(0));
            return [pct(f.land), `${pct(f.snapped)} / ${pct(f.slack)}`];
          }),
          f1(judgeFightStats('average', d, greenOf(0)).seconds),
        ]),
      ),
      `The same with the widest band any rod gives in any water (${pct(widest / U, 1)}) and the narrowest (${pct(narrowest / U, 1)}: a specialist rod away from home):`,
      table(
        ['Difficulty', ...players.map((p) => `${PLAYERS[p].name}: widest`), ...players.map((p) => `${PLAYERS[p].name}: narrowest`)],
        [0, 1, 2, 3, 4, 5].map((d) => [d, ...players.map((p) => pct(judgeFightStats(p, d, widest).land)), ...players.map((p) => pct(judgeFightStats(p, d, narrowest).land))]),
      ),
    );

    // ---------------------------------------------------------------- by location
    push('## 2. Landing success by location', 'Share of the fish that bite that are landed, over the species of each water at their odds. "Starter" is the Willow Rod with no lure; "best" is the loadout that earns the most PEARL per cast for that player under the new rule.');
    push(
      table(
        head('Location', 'Water', 'Energy').concat(players.map((p) => `${PLAYERS[p].name}: best`), ['Best loadout (average player)']),
        LOCATIONS.map((l) => [l.name, WATER[l.tier], l.energyCost, ...players.map((p) => pct(landShare(model('strict', p, l.id)))), ...players.map((p) => pct(landShare(best('strict', p, l.id).model))), loName(best('strict', 'average', l.id).lo)]),
      ),
      'Before the change every one of these was 100%.',
    );

    // ---------------------------------------------------------------- by rarity
    push('## 3. Landing success by rarity', 'By rarity and water, starter rod (the band a new player has). Each cell is beginner / average / experienced.');
    push(
      table(
        ['Rarity', ...WATER.map((w, tier) => `${w} water (difficulty +${tier})`)],
        RARITY.map((name, r) => [
          name,
          ...[0, 1, 2].map((tier) => {
            const d = Math.min(5, difficultyOf(r as Rarity, tier));
            return `${players.map((p) => pct(judgeFightStats(p, d, greenOf(0)).land)).join(' / ')} (d ${d})`;
          }),
        ]),
      ),
    );
    push(
      `Over whole careers (a new player, one sitting a day for ${DAYS} days, ${RUNS} runs each, buying rods as they can be paid for), by the rule after the change:`,
      table(
        head('Rarity'),
        RARITY.map((name, r) => [
          name,
          ...players.map((p) => {
            const rs = run('strict', p, daily);
            const hooked = sum(rs.map((x) => x.hookedByRarity[r]));
            return hooked === 0 ? '—' : `${pct(1 - sum(rs.map((x) => x.lostByRarity[r])) / hooked)} of ${Math.round(hooked / RUNS)}`;
          }),
        ]),
      ),
      'Each cell: share landed, of the number hooked in a year by one player (mean of the runs).',
    );

    // ---------------------------------------------------------------- lost legendary and mythic
    push('## 4. Legendary and Mythic fish that get away', 'Of the Legendary and Mythic fish that bite, the share that is lost. By location, starter rod / the best loadout for PEARL, for each player. A dash: no such fish lives there.');
    push(
      table(
        head('Location'),
        LOCATIONS.map((l) => [l.name, ...players.map((p) => `${pct(lostShare(model('strict', p, l.id), [4, 5]))} / ${pct(lostShare(best('strict', p, l.id).model, [4, 5]))}`)]),
      ),
    );
    push(
      'Over the same careers as above (a year, one sitting a day), per player:',
      table(
        head('In a year'),
        [
          ['Legendary hooked', ...players.map((p) => f1(mean(run('strict', p, daily).map((x) => x.hookedByRarity[4]))))],
          ['Legendary lost', ...players.map((p) => { const rs = run('strict', p, daily); return `${f1(mean(rs.map((x) => x.lostByRarity[4])))} (${pct(sum(rs.map((x) => x.lostByRarity[4])) / Math.max(1, sum(rs.map((x) => x.hookedByRarity[4]))))})`; })],
          ['Mythic hooked', ...players.map((p) => f1(mean(run('strict', p, daily).map((x) => x.hookedByRarity[5]))))],
          ['Mythic lost', ...players.map((p) => { const rs = run('strict', p, daily); return `${f1(mean(rs.map((x) => x.lostByRarity[5])))} (${pct(sum(rs.map((x) => x.lostByRarity[5])) / Math.max(1, sum(rs.map((x) => x.hookedByRarity[5]))))})`; })],
        ],
      ),
      'The three special fish are among these (Golden Koi and Ancient Catfish are Legendary, the Ghost Fish Mythic). A special fish that gets away does not reset or advance its dry-catch counter: the pity that guarantees one after 120 / 160 / 220 dry catches is neither lost nor earned by the lost fight.',
    );

    // ---------------------------------------------------------------- pearl per energy
    push('## 5. PEARL per energy', 'Net PEARL (after lure wear and rod repair) per point of energy, with the best loadout for each player and rule. Before → after, and the change.');
    const ppe = (rules: Rules, p: PlayerName, locId: number): number => netPerEnergy(best(rules, p, locId).model, WORLD_NOW, locId);
    push(
      table(
        head('Location', 'Energy'),
        LOCATIONS.map((l) => [l.name, l.energyCost, ...players.map((p) => `${f1(ppe('chain', p, l.id))} → ${f1(ppe('strict', p, l.id))} (${pct(ppe('strict', p, l.id) / ppe('chain', p, l.id) - 1)})`)]),
      ),
      'With the starter rod and no lure (no upkeep, so the change is exactly the share of fish lost, weighted by what they sell for):',
      table(
        head('Location', 'Energy'),
        LOCATIONS.map((l) => {
          const e = (rules: Rules, p: PlayerName): number => netPerEnergy(model(rules, p, l.id), WORLD_NOW, l.id);
          return [l.name, l.energyCost, ...players.map((p) => `${f1(e('chain', p))} → ${f1(e('strict', p))} (${pct(e('strict', p) / e('chain', p) - 1)})`)];
        }),
      ),
      'Upkeep does not shrink with the catch: a rod wears and a lure is used by the cast, landed or not. That is why the drop with paid tackle is larger than the share of fish lost.',
    );

    // ---------------------------------------------------------------- xp
    push('## 6. XP', 'XP per point of energy with the starter rod, before → after. XP is given for a landed fish only, so it falls by the share of fish lost, weighted by rarity.');
    push(
      table(
        head('Location'),
        LOCATIONS.map((l) => [l.name, ...players.map((p) => { const a = model('chain', p, l.id).xp / l.energyCost; const b = model('strict', p, l.id).xp / l.energyCost; return `${f1(a)} → ${f1(b)} (${pct(b / a - 1)})`; })]),
      ),
    );
    const patterns: Pattern[] = [PATTERNS.daily, PATTERNS.thrice];
    const cell = (p: PlayerName, pattern: Pattern, key: string): string => `${dayOf(run('chain', p, pattern), key)} → ${dayOf(run('strict', p, pattern), key)}`;
    for (const pattern of patterns) {
      push(
        `Day on which a level is reached, before → after. A new player, ${pattern.name.toLowerCase()} (${pattern.note}), median of ${RUNS} careers of ${DAYS} days:`,
        table(head('Level'), [2, 3, 5, 8, 10, 12, 15].map((lv) => [lv, ...players.map((p) => cell(p, pattern, `level ${lv}`))])),
      );
    }

    push(
      'Levels come **earlier** after the change, although every water gives less XP per energy than before. The reason is where the model player fishes: it goes where PEARL per energy is best, and with fish to lose that is no longer the rough, expensive water but the calm, cheap one, which happens to give two or three times the XP per point of energy (table above). A player who keeps fishing the rough water for its own sake levels more slowly than before, by the percentages of the first table.',
    );

    // ---------------------------------------------------------------- locations and tackle
    push('## 7. Time to open the waters', 'Day on which each water opens, before → after (same careers). The ordinary waters open by level and by species met; the secret ones (Golden Lake, Ancient Swamp, Phantom Waters) by landing a special fish.');
    for (const pattern of patterns) push(`${pattern.name}:`, table(head('Water'), LOCATIONS.filter((l) => l.id !== 0).map((l) => [l.name, ...players.map((p) => cell(p, pattern, `open:${l.name}`))])));
    push(
      'The secret waters in these careers are a rough guide only. The model player hunts one special fish at a time, in whichever of the open waters pays best, and under the new rule it reaches the levels that open new waters sooner and so changes its hunt sooner: most of the delay of Ancient Swamp above is the catfish hunt being dropped for the Ghost Fish, not catfish that got away. What the rule itself costs is measured directly:',
    );
    const HUNTS = 300;
    push(
      `Energy spent at one water until its special fish is landed, starter rod, median (9 in 10 within), before → after. ${HUNTS} hunts each; pity included. A special fish that gets away at its pity bites again on the next bite, until it is landed.`,
      table(
        head('Special fish', 'Water', 'Fight'),
        SPECIALS.map((x, i) => {
          const loc = LOCATIONS.find((l) => l.special === x.id)!;
          const d = Math.min(5, difficultyOf(SPECIES[x.speciesId].rarity, loc.tier));
          const runs = (rules: Rules, p: PlayerName): number[] => Array.from({ length: HUNTS }, (_, k) => energyToSpecial(rules, p, loc.id, 9000 + i * 1000 + k));
          const cellOf = (xs: number[]): string => `${Math.round(median(xs))} (${Math.round(quantile(xs, 0.9))})`;
          return [x.name, `${loc.name}, ${loc.energyCost} energy a cast`, `difficulty ${d}`, ...players.map((p) => `${cellOf(runs('chain', p))} → ${cellOf(runs('strict', p))}`)];
        }),
      ),
      `A day gives ${Math.round(86_400 / WORLD_NOW.regenSeconds)} energy to somebody who never lets the bar fill up and ${WORLD_NOW.maxEnergy} to somebody who empties it once a day.`,
    );
    push('## 8. Time to buy the tackle', 'Day on which each rod is bought, before → after (same careers; rods are bought in price order as soon as the PEARL is there).');
    for (const pattern of patterns)
      push(`${pattern.name}:`, table(head('Rod', 'Price'), RODS.filter((r) => r.price > 0).map((r) => [r.name, r.price.toLocaleString('en-US'), ...players.map((p) => cell(p, pattern, `rod:${r.name}`))])));
    push(
      'What a year of one sitting a day adds up to, before → after:',
      table(head('In a year'), [
        ['Casts', ...players.map((p) => `${Math.round(mean(run('chain', p, daily).map((r) => r.casts)))} → ${Math.round(mean(run('strict', p, daily).map((r) => r.casts)))}`)],
        ['Fish landed', ...players.map((p) => `${Math.round(mean(run('chain', p, daily).map((r) => r.landed)))} → ${Math.round(mean(run('strict', p, daily).map((r) => r.landed)))}`)],
        ['Fish lost in the fight', ...players.map((p) => `0 → ${Math.round(mean(run('strict', p, daily).map((r) => r.fightsLost)))}`)],
        ['PEARL from fish', ...players.map((p) => `${Math.round(median(run('chain', p, daily).map((r) => r.earned))).toLocaleString('en-US')} → ${Math.round(median(run('strict', p, daily).map((r) => r.earned))).toLocaleString('en-US')}`)],
        ['Minutes at the water per sitting', ...players.map((p) => { const m = (rules: Rules): number => mean(run(rules, p, daily).flatMap((r) => r.sittings.map((s) => s.seconds / 60))); return `${f1(m('chain'))} → ${f1(m('strict'))}`; })],
      ]),
    );

    // ---------------------------------------------------------------- other judges
    push(
      '## 9. Other fights the judge could be given',
      'Not applied anywhere: a way to weigh the recommendations below. How hard a fish fights is decided by the reel judge (rarity + the water tier it was deployed with). A judge with other numbers is a new small contract attached over still water, not an upgrade of the game. Share of bites landed with the starter rod, beginner / average / experienced:',
      table(
        ['Location', ...JUDGES.map((j) => j.name)],
        LOCATIONS.map((l) => [
          l.name,
          ...JUDGES.map((j) =>
            players
              .map((p) => {
                const m = model('strict', p, l.id);
                return pct(m.lines.reduce((a, x) => a + x.p * judgeFightStats(p, j.d(x.rarity, l.tier), greenOf(m.totals.rod.catch)).land, 0));
              })
              .join(' / '),
          ),
        ]),
      ),
      'Legendary and Mythic fish lost, starter rod, beginner / average / experienced:',
      table(
        ['Water', ...JUDGES.map((j) => j.name)],
        WATER.map((w, tier) => [w, ...JUDGES.map((j) => players.map((p) => pct(1 - judgeFightStats(p, j.d(4, tier), greenOf(0)).land)).join(' / '))]),
      ),
      JUDGES.map((j) => `- **${j.name}**: ${j.note}.`).join('\n'),
    );

    // ---------------------------------------------------------------- the hook
    push(
      '## 10. What did not change',
      `- **The hook.** How fast a hook is set cannot be checked by a contract, so a missed hook is still another bite of the same fish, and the fourth bite has no window. It costs time only: the beginner misses ${pct(hookStats(PLAYERS.beginner, 0).miss)} of the hooks at difficulty 0 and ${pct(hookStats(PLAYERS.beginner, 5).miss)} at 5. A fish has ${Math.round(600 / 60)} minutes (600 blocks) from the cast to be landed, which is far more than three missed hooks and a fight of at most ${f1(TIMING.fightReady + 60)} seconds take.`,
      '- **Grades.** The grade of a landed fish (S–D) is still the contract\'s roll from the cast\'s seed and the rod\'s catch. The fight decides whether there is a fish, not how good it is.',
      '- **A clean hook.** Up to release 004 a fast hook started the fight closer to the pier. Under the judge the fight starts from the same place for everybody: a head start would be one more thing the contract cannot check.',
      '- **Energy, odds, prices.** Not touched.',
    );

    writeFileSync(new URL('../REEL_BALANCE.md', import.meta.url), `${out.join('\n')}\n`);
    expect(out.length).toBeGreaterThan(20);
  },
  1_800_000,
);

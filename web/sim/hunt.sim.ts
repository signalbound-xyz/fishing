/**
 * Season Hunt balance: `pnpm sim:hunt`. Plays tens of thousands of seasons for crowds of 10 to 10,000 model anglers
 * under four ways of drawing the bonus table, and writes the tables of SEASON_HUNT_BALANCE.md between its markers;
 * the prose around them is written by hand. Not part of `pnpm test`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { LURES, RODS } from '../src/tackle/catalog';
import { LOCATIONS } from '../src/game/content';
import { CHANCE_UNIT, chanceOf, oddsText } from '../src/game/hunt';
import { ANGLERS, CONFIGS, DAILY_ATTEMPTS, RECOMMENDED, SEASON_DAYS, calibrate, castsPerDay, crowd, multipliers, pondXpPerCast, runSeasons, seasonCost, seasonEnergy, sybilShare, weightedAttempts } from './hunt';
import { mulberry32 } from './lab';

const BEGIN = '<!-- sim:hunt:begin -->';
const END = '<!-- sim:hunt:end -->';
const CROWDS = [10, 100, 1000, 10_000];
const SEASONS = 20_000;
const pct = (x: number, digits = 0): string => `${(x * 100).toFixed(digits)}%`;
const num = (x: number): string => Math.round(x).toLocaleString('en-US');

it('writes the season hunt numbers', () => {
  const out: string[] = [];
  const rng = mulberry32(20_261_124);

  // ---------------------------------------------------------------- the model
  out.push('### The model crowd', '');
  out.push(`A season of ${SEASON_DAYS} days, ${DAILY_ATTEMPTS} seasonal casts per wallet and UTC day. A wallet has ${seasonEnergy(SEASON_DAYS)} energy over the season (a full bar and a point every half hour).`, '');
  out.push('| Angler | Tackle and water | Share of the crowd | Casts a day | Energy per cast |', '|---|---|---|---|---|');
  for (const a of ANGLERS) out.push(`| ${a.name} | ${a.has} | ${pct(a.share)} | ${castsPerDay(a).toFixed(1)} | ${LOCATIONS[a.water].energyCost} |`);
  out.push('');

  // ---------------------------------------------------------------- what tackle buys, per config
  out.push('### What tackle buys under each bonus table', '');
  out.push('The chance of one cast as a multiple of the base chance.', '');
  out.push(`| Table | ${ANGLERS.map((a) => a.name).join(' | ')} | Cap |`, `|---|${ANGLERS.map(() => '---').join('|')}|---|`);
  for (const c of CONFIGS) out.push(`| ${c.name}: ${c.note} | ${multipliers(c).map((m) => `×${m.toFixed(2)}`).join(' | ')} | ×${(1 + c.odds.maxBonus / 100).toFixed(0)} |`);
  out.push('');

  // ---------------------------------------------------------------- the full bonus table of the recommended config
  out.push('### The recommended table, item by item', '');
  out.push('Bonuses are percentages of the base chance. They are added, and the sum is capped at +200%.', '');
  out.push('| Rod | Bonus | Lure | Bonus | Water | Bonus |', '|---|---|---|---|---|---|');
  for (let i = 0; i < 6; i++) {
    const w = i < 4 ? `${LOCATIONS[i].name} | +${RECOMMENDED.odds.waterBonus[i]}%` : ' | ';
    out.push(`| ${RODS[i].name} | +${RECOMMENDED.odds.rodBonus[i]}% | ${LURES[i].name} | +${RECOMMENDED.odds.lureBonus[i]}% | ${w} |`);
  }
  out.push('');

  // ---------------------------------------------------------------- crowds, calibrated
  out.push('### Seasons by crowd size, each with the base chance fitted to it', '');
  out.push(`The base chance is set so that the crowd hooks the target 3 times a season on average; ${num(SEASONS)} seasons per row.`, '');
  out.push(
    `| Table | Anglers | Casts in a season | Base chance per cast | Nobody wins | Casts until the win, median | mean | Winning day, median | Over on day 1 | ${ANGLERS.map((a) => `Won by ${a.name}`).join(' | ')} |`,
    `|---|---|---|---|---|---|---|---|---|${ANGLERS.map(() => '---').join('|')}|`,
  );
  for (const c of CONFIGS) {
    for (const n of CROWDS) {
      const base = calibrate(c, n);
      const s = runSeasons(c, base, n, rng, SEASONS);
      const casts = crowd(n).reduce((sum, people, i) => sum + people * castsPerDay(ANGLERS[i]) * SEASON_DAYS, 0);
      out.push(`| ${c.name} | ${num(n)} | ${num(casts)} | ${oddsText(base)} | ${pct(s.noWinner, 1)} | ${num(s.medianAttempts)} | ${num(s.meanAttempts)} | ${s.medianDay} | ${pct(s.firstDay * (1 - s.noWinner))} | ${s.wins.map((w) => pct(w)).join(' | ')} |`);
    }
  }
  out.push('');

  // ---------------------------------------------------------------- shares against the crowd
  out.push('### Who wins, against who fishes (1,000 anglers)', '');
  const people = crowd(1000);
  const castShare = ANGLERS.map((a, i) => people[i] * castsPerDay(a));
  const castTotal = castShare.reduce((a, b) => a + b, 0);
  out.push(`| Table | ${ANGLERS.map((a) => a.name).join(' | ')} |`, `|---|${ANGLERS.map(() => '---').join('|')}|`);
  out.push(`| Share of the anglers | ${ANGLERS.map((a) => pct(a.share)).join(' | ')} |`);
  out.push(`| Share of the casts | ${castShare.map((x) => pct(x / castTotal)).join(' | ')} |`);
  for (const c of CONFIGS) {
    const s = runSeasons(c, calibrate(c, 1000), 1000, rng, SEASONS);
    out.push(`| Share of the wins, ${c.name} | ${s.wins.map((w) => pct(w)).join(' | ')} |`);
  }
  out.push('');

  // ---------------------------------------------------------------- the crowd that came is not the crowd planned for
  out.push('### When the crowd is not the one the season was set for (recommended table)', '');
  out.push('Rows: the crowd the base chance was fitted to. Columns: the crowd that came. Each cell: seasons nobody wins / the median winning day of the seasons that are won / seasons over on day 1.', '');
  out.push(`| Fitted to | ${CROWDS.map((n) => `${num(n)} came`).join(' | ')} |`, `|---|${CROWDS.map(() => '---').join('|')}|`);
  for (const planned of CROWDS) {
    const base = calibrate(RECOMMENDED, planned);
    const cells = CROWDS.map((actual) => {
      const s = runSeasons(RECOMMENDED, base, actual, rng, 4000);
      return `${pct(s.noWinner)} / ${s.medianDay && s.noWinner < 0.995 ? `day ${s.medianDay}` : 'no winner'} / ${pct(s.firstDay * (1 - s.noWinner))}`;
    });
    out.push(`| ${num(planned)} (${oddsText(base)}) | ${cells.join(' | ')} |`);
  }
  out.push('');

  // ---------------------------------------------------------------- how sure a season is of a winner
  out.push('### How often a season has no winner, by how many hits it is set for', '');
  out.push('1,000 anglers, recommended table. Fewer expected hits make a season last longer and end empty more often.', '');
  out.push('| Expected hits in a season | Base chance per cast | Nobody wins | Winning day, median | Over on day 1 |', '|---|---|---|---|---|');
  for (const expected of [1, 2, 3, 5, 8]) {
    const base = calibrate(RECOMMENDED, 1000, expected);
    const s = runSeasons(RECOMMENDED, base, 1000, rng, SEASONS);
    out.push(`| ${expected} | ${oddsText(base)} | ${pct(s.noWinner, 1)} | ${s.medianDay} | ${pct(s.firstDay * (1 - s.noWinner))} |`);
  }
  out.push('');

  // ---------------------------------------------------------------- what it costs a player
  out.push('### What a season costs a player (recommended table, 1,000 anglers)', '');
  const base = calibrate(RECOMMENDED, 1000);
  out.push('| Angler | Casts | Energy | Share of the season’s energy | PEARL for lures | PEARL of rod wear | Rod, once | Chance per cast | Own chance to hook it in the season |', '|---|---|---|---|---|---|---|---|---|');
  for (const a of ANGLERS) {
    const k = seasonCost(RECOMMENDED, base, a);
    const chance = chanceOf({ ...RECOMMENDED.odds, baseChance: base }, a.rod, a.lure, a.water);
    out.push(`| ${a.name} | ${k.casts} | ${k.energy} | ${pct(k.energyShare)} | ${num(k.lures)} | ${num(k.repair)} | ${num(k.rodPrice)} | ${oddsText(chance)} | ${pct(k.alone, 2)} |`);
  }
  out.push('');

  // ---------------------------------------------------------------- many wallets in one hand
  out.push('### Many wallets in one hand (recommended table)', '');
  out.push(`Extra wallets with free tackle, each making all ${DAILY_ATTEMPTS} casts every day, join the crowd. The cell is the chance that the winner is one of them.`, '');
  const packs = [10, 100, 1000, 10_000];
  out.push(`| Honest anglers | ${packs.map((k) => `${num(k)} wallets`).join(' | ')} |`, `|---|${packs.map(() => '---').join('|')}|`);
  for (const n of CROWDS) out.push(`| ${num(n)} | ${packs.map((k) => pct(sybilShare(RECOMMENDED, n, k))).join(' | ')} |`);
  out.push('');
  const xp = pondXpPerCast();
  out.push('What each extra wallet costs its owner under a season’s entry rules:', '');
  out.push('| Entry rule | Cost per wallet |', '|---|---|');
  out.push('| None (the MVP season) | Nothing but gas: energy is free and refills |');
  for (const level of [3, 5, 8]) {
    const need = 50 * level * (level - 1);
    const casts = Math.ceil(need / xp);
    out.push(`| Level ${level} | ${num(need)} XP: about ${num(casts)} ordinary casts at the pond, ${(casts / (86_400 / 1800)).toFixed(1)} days of a wallet’s energy |`);
  }
  out.push(`| A paid rod (${RODS[1].name}) | ${num(RODS[1].price)} PEARL, earned by selling fish or bought |`);
  out.push('');
  out.push(`For scale: the honest crowd of 1,000 makes ${num(weightedAttempts(RECOMMENDED, 1000))} base-chance casts’ worth of attempts a season, and one full-cap free wallet ${DAILY_ATTEMPTS * SEASON_DAYS}.`);

  // sanity: the numbers the report leans on
  expect(calibrate(RECOMMENDED, 1000)).toBeGreaterThan(0);
  expect(calibrate(RECOMMENDED, 1000) * 3).toBeLessThanOrEqual(CHANCE_UNIT / 10);

  const url = new URL('../SEASON_HUNT_BALANCE.md', import.meta.url);
  const doc = readFileSync(url, 'utf8');
  const a = doc.indexOf(BEGIN);
  const b = doc.indexOf(END);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  writeFileSync(url, `${doc.slice(0, a + BEGIN.length)}\n${out.join('\n')}\n${doc.slice(b)}`);
}, 600_000);

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
import { ANGLERS, CONFIGS, DAILY_ATTEMPTS, ENERGY_PER_DAY, RECOMMENDED, SEASON_DAYS, anglerShare, bestPack, breakEvenTicket, calibrate, castsPerDay, crowd, multipliers, packOf, packWalletCasts, pondPearlPerCast, pondXpPerCast, runSeasons, seasonCost, seasonEnergy, shareWorth, sybilShare, weightedAttempts } from './hunt';
import { PEARL_PER_BLEND } from '../src/game/content';
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

  // ---------------------------------------------------------------- a season ticket
  out.push('', '### A season ticket: what it has to cost (recommended table)', '');
  const PRIZES = [200, 300, 500, 1000];
  const pond = pondPearlPerCast();
  const dayPearl = ENERGY_PER_DAY * pond;
  out.push(
    `A ticket is PEARL burned once per wallet and season. The exchange sells ${PEARL_PER_BLEND} PEARL for 1 BLEND and buys none back. The cell is the ticket at which one more free-tackle wallet at the daily cap (${packWalletCasts()} casts) is worth exactly what it pays: its share of the season’s chance, times the prize, times the ${pct(1 - Math.exp(-3))} of seasons that are won. At that price and above, no pack of wallets pays for itself with bought PEARL.`,
    '',
  );
  out.push(`| Honest anglers | ${PRIZES.map((p) => `Prize ${num(p)} BLEND`).join(' | ')} |`, `|---|${PRIZES.map(() => '---').join('|')}|`);
  for (const n of CROWDS) out.push(`| ${num(n)} | ${PRIZES.map((p) => `${num(breakEvenTicket(RECOMMENDED, n, p))} PEARL`).join(' | ')} |`);
  out.push('');

  out.push('### A pack of wallets against a ticket (100 honest anglers, prize 500 BLEND)', '');
  const even = breakEvenTicket(RECOMMENDED, 100, 500);
  out.push('The pack is the size that earns its owner the most at that price (capped at 10,000 wallets where every further wallet pays). BLEND, averaged over seasons; the tickets are bought at the exchange.', '');
  out.push('| Ticket | Best pack | Chance the winner is in it | Wins | Pays for tickets | Net |', '|---|---|---|---|---|---|');
  for (const [label, t] of [
    ['none', 0],
    ['a quarter of break-even', even / 4],
    ['half of break-even', even / 2],
    ['break-even', even],
    ['twice break-even', even * 2],
  ] as const) {
    const p = bestPack(RECOMMENDED, 100, 500, t, 10_000);
    out.push(`| ${t ? `${num(t)} PEARL (${label})` : 'none'} | ${num(p.wallets)} wallet${p.wallets === 1 ? '' : 's'} | ${pct(p.share)} | ${p.wins.toFixed(1)} | ${p.tickets.toFixed(1)} | ${p.net >= 0 ? '+' : ''}${p.net.toFixed(1)} |`);
  }
  // the same pack, kept at 100 wallets whatever the price: what a fixed attacker loses
  const fixed = packOf(RECOMMENDED, 100, 500, even, 100);
  out.push('', `A pack of 100 wallets that comes anyway at the break-even price wins ${fixed.wins.toFixed(1)} BLEND on average and burns ${fixed.tickets.toFixed(1)} BLEND of PEARL.`, '');

  out.push('### What the same ticket is to an honest angler (100 honest anglers, prize 500 BLEND)', '');
  out.push(`The ticket is the break-even one of the table above, ${num(even)} PEARL. “Worth” is the angler’s own share of the season’s chance times the prize, in PEARL at the exchange’s rate. An ordinary cast at the Village Pond with the free rod brings ${pond.toFixed(1)} PEARL, and a wallet’s energy ${num(dayPearl)} PEARL a day there.`, '');
  out.push('| Angler | Own share of the season’s chance | Worth of that share | Ticket | Ticket ÷ worth | Ticket in pond casts |', '|---|---|---|---|---|---|');
  for (const a of ANGLERS) {
    const share = anglerShare(RECOMMENDED, 100, a);
    const worth = shareWorth(share, 500);
    out.push(`| ${a.name} | ${pct(share, 2)} | ${num(worth)} PEARL | ${num(even)} PEARL | ×${(even / worth).toFixed(1)} | ${num(even / pond)} |`);
  }
  out.push('');

  out.push('### A ticket earned, not bought', '');
  out.push(`PEARL is also earned by fishing, and energy is free. A wallet that fishes the pond with all its energy and sells every fish earns about ${num(dayPearl)} PEARL a day, ${num(dayPearl * 7)} a week. This is what a ticket costs such a wallet in its own time, every season:`, '');
  out.push('| Ticket | Pond casts to earn it | Days of a wallet’s energy | BLEND, if bought instead |', '|---|---|---|---|');
  for (const t of [100, 250, 500, 1000, 2500, 5000]) out.push(`| ${num(t)} PEARL | ${num(t / pond)} | ${(t / dayPearl).toFixed(1)} | ${(t / PEARL_PER_BLEND).toFixed(1)} |`);
  out.push('');

  // sanity: the numbers the report leans on
  expect(bestPack(RECOMMENDED, 100, 500, even, 10_000).net).toBeLessThanOrEqual(0.01);
  expect(bestPack(RECOMMENDED, 100, 500, even / 4, 10_000).net).toBeGreaterThan(0);
  expect(pond).toBeGreaterThan(10);
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

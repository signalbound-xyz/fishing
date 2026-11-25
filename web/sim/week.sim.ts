/**
 * Weekly season balance: `pnpm sim:week`. Reads the repository's week file, works out and plays its three hunts for
 * crowds of 10 to 10,000 model anglers, and writes the weekly tables of SEASON_HUNT_BALANCE.md between their
 * markers; the prose around them is written by hand. Not part of `pnpm test`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { LOCATIONS, SPECIES } from '../src/game/content';
import { bestChance, oddsText } from '../src/game/hunt';
import { DIFFICULTY_LABEL } from '../src/game/week';
import { ANGLERS, crowd } from './hunt';
import { mulberry32 } from './lab';
import { EAGER, EXAMPLE_WEEK, LEVEL, OPENED, RUSH_HOURS, TARGET_HITS, entries, fitBase, huntsOf, oddsOf, outlook, playWeeks, readWeek } from './week';

const BEGIN = '<!-- sim:week:begin -->';
const END = '<!-- sim:week:end -->';
const CROWDS = [10, 100, 1000, 10_000];
const WEEKS = 20_000;
/** The crowd the week file's base chances are fitted to. */
const PLANNED = 10;
const pct = (x: number, digits = 0): string => `${(x * 100).toFixed(digits)}%`;
const num = (x: number): string => Math.round(x).toLocaleString('en-US');
const hours = (x: number | null): string => (x === null ? 'never' : x < 48 ? `${x.toFixed(1)} h` : `${(x / 24).toFixed(1)} d`);

it('writes the weekly season numbers', () => {
  const out: string[] = [];
  const rng = mulberry32(20_261_207);
  const file = readWeek(EXAMPLE_WEEK);
  const hunts = huntsOf(EXAMPLE_WEEK);
  const label = (i: number): string => `${i + 1}. ${hunts[i].name}`;

  // ---------------------------------------------------------------- the three hunts
  out.push(`### The three hunts of \`${file.id}\` ("${file.title}")`, '');
  out.push(`From \`contracts/script/seasons/weeks/${file.id}.json\`: ${file.days} days from ${file.start}, ${num(file.totalPrizeBlend)} BLEND in all.`, '');
  out.push('| Hunt | Difficulty | Runs | Prize | Target | Waters (bonus) | Level | Casts a day | Tackle cap | Best tackle | Set for |', '|---|---|---|---|---|---|---|---|---|---|---|');
  hunts.forEach((h, i) => {
    const waters = h.waters.map((w) => `${LOCATIONS[w].name}${h.waterBonus[w] ? ` (+${h.waterBonus[w]}%)` : ''}`).join(', ');
    const from = h.startHour / 24;
    out.push(
      `| ${label(i)} | ${DIFFICULTY_LABEL[h.difficulty]} | day ${from + 1} to ${from + h.durationHours / 24}, ${h.durationHours} h | ${num(h.prize)} BLEND (${h.prizeShare}%) | ${SPECIES[h.speciesId].name} | ${waters} | ${h.minLevel > 1 ? `${h.minLevel}+` : 'any'} | ${h.dailyAttempts} | +${h.maxBonus}% | ×${(1 + h.maxBonus / 100).toFixed(1)} | ${TARGET_HITS[h.difficulty]} hits |`,
    );
  });
  out.push('');

  // ---------------------------------------------------------------- who can enter
  out.push('### Who can enter, and how they fish each hunt', '');
  out.push(`The model anglers of the season simulation, with a level and opened waters each. A cell is the water the angler fishes, the seasonal casts a day, and the chance of a cast against the base chance; "cannot enter" is the level or the waters.`, '');
  out.push(`| Angler | Share of the crowd | Level | Waters opened | ${hunts.map((_, i) => label(i)).join(' | ')} |`, `|---|---|---|---|${hunts.map(() => '---').join('|')}|`);
  ANGLERS.forEach((a, k) => {
    const cells = hunts.map((h) => {
      const e = entries(h)[k];
      return e ? `${LOCATIONS[e.water].name}, ${e.casts.toFixed(0)} a day, ×${e.mult.toFixed(2)}` : 'cannot enter';
    });
    out.push(`| ${a.name} | ${pct(a.share)} | ${LEVEL[k]} | ${OPENED[k].map((w) => LOCATIONS[w].name).join(', ')} | ${cells.join(' | ')} |`);
  });
  out.push('');

  // ---------------------------------------------------------------- each hunt by crowd, fitted
  out.push('### Each hunt by crowd size, with the base chance fitted to the crowd', '');
  out.push(
    `The base chance is set so that the crowd hooks the fish the number of times the hunt is set for. Worked out from the model, not sampled. "Within ${RUSH_HOURS} h" is the chance that the hunt is over ${RUSH_HOURS} hours after it opens; "half are over by" is the median time to the first catch; "mean" is the average among the hunts that have a winner.`,
    '',
  );
  out.push(
    `| Hunt | Anglers | Can enter | Eligible casts | Base chance | Best tackle | A winner | No winner | Within ${RUSH_HOURS} h | Half are over by | Mean time to the catch | Casts before the win |`,
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  hunts.forEach((h, i) => {
    for (const n of CROWDS) {
      const base = fitBase(h, n);
      if (base === null) {
        out.push(`| ${label(i)} | ${num(n)} | 0 | 0 | — | — | 0% | 100% | 0% | never | — | — |`);
        continue;
      }
      const o = outlook(h, n, base);
      out.push(
        `| ${label(i)} | ${num(n)} | ${num(o.eligible)} | ${num(o.casts)} | ${oddsText(base)} | ${oddsText(bestChance(oddsOf(h, base)))} | ${pct(o.winner, 1)} | ${pct(o.noWinner, 1)} | ${pct(o.early, 1)} | ${hours(o.medianHours)} | ${hours(o.meanHours)} | ${num(o.castsBeforeWin)} |`,
      );
    }
  });
  out.push('');

  // ---------------------------------------------------------------- who wins
  out.push('### What tackle and progress buy (1,000 anglers)', '');
  out.push('The share of each hunt’s casts and of its wins by kind of angler, and the same as an advantage: wins per cast against the hunt’s average.', '');
  out.push(`| Hunt | | ${ANGLERS.map((a) => a.name).join(' | ')} |`, `|---|---|${ANGLERS.map(() => '---').join('|')}|`);
  hunts.forEach((h, i) => {
    const o = outlook(h, 1000, fitBase(h, 1000)!);
    const people = crowd(1000);
    const e = entries(h);
    out.push(`| ${label(i)} | Anglers who can enter | ${people.map((p, k) => (e[k] ? num(p) : '—')).join(' | ')} |`);
    out.push(`| | Share of the casts | ${o.castShare.map((x, k) => (e[k] ? pct(x) : '—')).join(' | ')} |`);
    out.push(`| | Share of the wins | ${o.wins.map((x, k) => (e[k] ? pct(x) : '—')).join(' | ')} |`);
    out.push(`| | Wins per cast, against the average | ${o.wins.map((x, k) => (e[k] && o.castShare[k] > 0 ? `×${(x / o.castShare[k]).toFixed(2)}` : '—')).join(' | ')} |`);
  });
  out.push('');

  // ---------------------------------------------------------------- the week as a whole
  out.push('### The week as a whole, fitted to its crowd', '');
  out.push(`${num(WEEKS)} weeks per row, sampled hour by hour. "Every hunt over within ${RUSH_HOURS} h" is the week the design is meant to avoid: three hunts that all end right after they open.`, '');
  out.push(`| Anglers | 3 winners | 2 | 1 | None | Every hunt over within ${RUSH_HOURS} h | A hunt still on a day after it opened | Share of the pool paid out |`, '|---|---|---|---|---|---|---|---|');
  for (const n of CROWDS) {
    const w = playWeeks(hunts, hunts.map((h) => fitBase(h, n)), n, rng, WEEKS);
    out.push(`| ${num(n)} | ${pct(w.winners[3])} | ${pct(w.winners[2])} | ${pct(w.winners[1])} | ${pct(w.winners[0], 1)} | ${pct(w.allEarly, 1)} | ${pct(w.oneLastsADay)} | ${pct(w.paidShare)} |`);
  }
  out.push('');

  // ---------------------------------------------------------------- the file as it is, with the crowd that comes
  out.push(`### The week file as written, when another crowd comes`, '');
  out.push(`The file's base chances are fitted to ${PLANNED} anglers. Each cell: no winner / over within ${RUSH_HOURS} h / half are over by.`, '');
  out.push(`| Hunt | Base chance in the file | ${CROWDS.map((n) => `${num(n)} come`).join(' | ')} |`, `|---|---|${CROWDS.map(() => '---').join('|')}|`);
  hunts.forEach((h, i) => {
    const cells = CROWDS.map((n) => {
      const o = outlook(h, n, h.baseChance);
      return `${pct(o.noWinner)} / ${pct(o.early)} / ${hours(o.medianHours)}`;
    });
    out.push(`| ${label(i)} | ${oddsText(h.baseChance)} | ${cells.join(' | ')} |`);
  });
  out.push('');

  // ---------------------------------------------------------------- how many hits to set a hunt for
  out.push('### How many hits to set a hunt for', '');
  out.push(`Fewer expected hits make a hunt last longer and end empty more often. Any crowd, with the base chance fitted to it; the opening rush is ${pct(EAGER)} of the first day's anglers in the first ${RUSH_HOURS} hours.`, '');
  out.push(`| Expected hits | No winner | ${hunts.map((h) => `${h.durationHours} h hunt: within ${RUSH_HOURS} h / half over by`).filter((x, i, all) => all.indexOf(x) === i).join(' | ')} |`, '|---|---|---|---|');
  const shapes = hunts.filter((h, i) => hunts.findIndex((x) => x.durationHours === h.durationHours) === i);
  for (const hits of [1, 1.5, 2, 2.5, 3, 4, 5]) {
    const cells = shapes.map((h) => {
      const o = outlook(h, 1000, fitBase(h, 1000, hits)!);
      return `${pct(o.early)} / ${hours(o.medianHours)}`;
    });
    out.push(`| ${hits} | ${pct(Math.exp(-hits), 1)} | ${cells.join(' | ')} |`);
  }

  // sanity: the numbers the report leans on
  for (const h of hunts) expect(h.baseChance).toBe(fitBase(h, PLANNED));

  const url = new URL('../SEASON_HUNT_BALANCE.md', import.meta.url);
  const doc = readFileSync(url, 'utf8');
  const a = doc.indexOf(BEGIN);
  const b = doc.indexOf(END);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  writeFileSync(url, `${doc.slice(0, a + BEGIN.length)}\n${out.join('\n')}\n${doc.slice(b)}`);
}, 600_000);

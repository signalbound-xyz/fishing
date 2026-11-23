/**
 * Daily challenges: `pnpm sim:daily`. Plays 200 days of challenges for four model players and writes the table in
 * DAILY_CHALLENGES.md between its markers; the prose around the table is written by hand. Not part of `pnpm test`.
 *
 * The energy is exact arithmetic over the real rules. The minutes rest on the lab's timing assumptions (lab.ts).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { TUNING } from '../src/game/content';
import { DAILY } from '../src/game/daily';
import { DAILY_PROFILES, dayStats } from './daily';
import { mulberry32 } from './lab';

const BEGIN = '<!-- sim:daily:begin -->';
const END = '<!-- sim:daily:end -->';
const pct = (x: number): string => `${Math.round(x * 100)}%`;

it('writes the daily challenge numbers', () => {
  const dayEnergy = (86_400 / (30 * 60));
  const rows = DAILY_PROFILES.map((p) => {
    const s = dayStats(p.profile, mulberry32(2026), 200, 40);
    return `| ${p.name} | ${p.note} | ${s.energyMean.toFixed(1)} | ${s.energyMedian} | ${s.energyP90} | ${pct(s.energyMean / TUNING.maxEnergy)} | ${pct(s.energyMean / dayEnergy)} | ${s.castsMean.toFixed(1)} | ${s.minutesMean.toFixed(1)} | ${s.minutesP90.toFixed(1)} | ${pct(s.withinBar)} |`;
  });
  const table = [
    `Rules version ${DAILY.version}: budgets ${DAILY.budget.easy} / ${DAILY.budget.medium} / ${DAILY.budget.hard} energy (easy / medium / hard), 200 days × 40 runs per player, the "average" model player on the contracts' rules, starter rod and no lure except for a Rare goal.`,
    '',
    '| Player | Has | Energy, mean | median | 9 days in 10 within | Share of a full bar | Share of a day’s energy | Casts | Minutes, mean | 9 in 10 within | Done inside one bar |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
  const url = new URL('../DAILY_CHALLENGES.md', import.meta.url);
  const doc = readFileSync(url, 'utf8');
  const a = doc.indexOf(BEGIN);
  const b = doc.indexOf(END);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  writeFileSync(url, `${doc.slice(0, a + BEGIN.length)}\n${table}\n${doc.slice(b)}`);
}, 300_000);

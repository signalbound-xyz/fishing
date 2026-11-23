/** The mastery badge of a water: a pixel shield in the water's own colour with its emblem, rimmed by the tier reached. */
import { LOCATIONS } from '../../game/content';
import { TIERS } from '../../game/mastery';

const NS = 'http://www.w3.org/2000/svg';
const W = 15;
const H = 20;

/** Field colour and a 7×7 emblem for each water, by location id. */
const LOOKS: { field: string; shade: string; glyph: string[] }[] = [
  // Village Pond: a lily pad
  { field: '#4f8a5b', shade: '#3d6e48', glyph: ['..###..', '.#####.', '###.###', '###..##', '#######', '.#####.', '..###..'] },
  // Forest River: a pine
  { field: '#2f7f72', shade: '#25665c', glyph: ['...#...', '..###..', '.#####.', '..###..', '.#####.', '#######', '...#...'] },
  // Deep Lake: waves over waves
  { field: '#3a5f9a', shade: '#2e4c7c', glyph: ['.......', '.#...#.', '#.#.#.#', '...#...', '.#...#.', '#.#.#.#', '...#...'] },
  // Northern Sea: an anchor
  { field: '#4d7fae', shade: '#3c668d', glyph: ['..###..', '..#.#..', '..###..', '...#...', '#..#..#', '#..#..#', '.#####.'] },
  // Taimen Rapids: white water breaking
  { field: '#8a5a44', shade: '#6f4836', glyph: ['....##.', '...##..', '..##...', '.#####.', '...##..', '..##...', '.##....'] },
  // Golden Lake: the sun
  { field: '#b58a2e', shade: '#946f22', glyph: ['#..#..#', '.#.#.#.', '..###..', '#######', '..###..', '.#.#.#.', '#..#..#'] },
  // Ancient Swamp: a toadstool
  { field: '#5b6b3a', shade: '#48562d', glyph: ['..###..', '.#####.', '#######', '#######', '..###..', '..###..', '..###..'] },
  // Phantom Waters: a ghost
  { field: '#6d5aa8', shade: '#57478a', glyph: ['.#####.', '#######', '#.###.#', '#######', '#######', '#######', '#.#.#.#'] },
];

/** Rim by tiers completed: none, bronze, silver, gold. */
const RIMS = ['var(--line)', '#b0764a', '#c3ccd6', '#e2b84f'];
const RIM_HI = ['var(--line)', '#d39a6c', '#eef2f6', '#f6dc8c'];

/** How far the shield is cut in on each side, by row: straight sides, then a point. */
const inset = (y: number): number => (y <= 10 ? 0 : y === 11 ? 1 : y === 12 ? 2 : y === 13 ? 3 : y === 14 ? 4 : y === 15 ? 6 : 8);

/**
 * `level` is the number of tiers completed, 0–3. A badge with nothing earned is drawn blank, in the panel's own
 * colours, so that the earned ones stand out in a row of eight.
 */
export function masteryBadge(locationId: number, level: number, scale = 2): SVGSVGElement {
  const look = LOOKS[locationId] ?? LOOKS[0];
  const earned = level > 0;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', String(W * scale));
  svg.setAttribute('height', String(H * scale));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('class', `pxi mastery-badge lvl-${level}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${LOCATIONS[locationId]?.name ?? 'Water'}: ${level > 0 ? TIERS[level - 1].name : 'no mastery yet'}`);
  const rect = (x: number, y: number, w: number, h: number, fill: string): void => {
    if (w <= 0 || h <= 0) return;
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', String(x));
    r.setAttribute('y', String(y));
    r.setAttribute('width', String(w));
    r.setAttribute('height', String(h));
    if (fill.startsWith('var(')) r.style.fill = fill;
    else r.setAttribute('fill', fill);
    svg.append(r);
  };
  const rim = RIMS[level] ?? RIMS[0];
  for (let y = 0; y <= 15; y++) {
    const out = inset(y);
    rect(out, y, W - out * 2, 1, y === 0 && earned ? RIM_HI[level] : rim);
    if (y === 0) continue;
    // one pixel of rim all round, the slanted edges included
    const inn = Math.max(out, inset(y + 1)) + 1;
    rect(inn, y, W - inn * 2, 1, earned ? (y >= 9 ? look.shade : look.field) : 'var(--panel-3)');
  }
  const ink = earned ? '#fbf7ea' : 'var(--dim)';
  look.glyph.forEach((row, gy) => {
    // runs of pixels become one rect each
    for (let gx = 0; gx < row.length; gx++) {
      if (row[gx] !== '#') continue;
      let run = 1;
      while (row[gx + run] === '#') run++;
      rect(4 + gx, 2 + gy, run, 1, ink);
      gx += run - 1;
    }
  });
  // three pips under the point: one per tier
  for (let i = 0; i < TIERS.length; i++) rect(2 + i * 4, 18, 3, 2, i < level ? (RIMS[i + 1] as string) : 'var(--line-soft)');
  return svg;
}

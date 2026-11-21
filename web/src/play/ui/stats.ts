/**
 * Play stats (#/stats): a debug view of the gameplay telemetry kept in this browser, with export and clear.
 * It shows what was measured from the person at this keyboard, never a simulation. See play/telemetry.ts.
 */
import { LOCATIONS } from '../../game/content';
import { RARITY_NAMES } from '../../i18n';
import { lureById, rodById } from '../../tackle/catalog';
import type { GameMode } from '../../telemetry/events';
import type { FightRow, HookRow, Summary } from '../../telemetry/summary';
import { h, mount, sigOf } from '../../ui/dom';
import { toast } from '../../ui/toast';
import { CHAIN } from '../ops';
import { TELEMETRY_ON, clearTelemetry, telemetryExport, telemetrySummary } from '../telemetry';
import { pearl } from './fmt';

type Scope = 'all' | GameMode;
const SCOPES: [Scope, string][] = [
  ['all', 'All play'],
  ['local', 'Local game'],
  ['chain', 'On the contracts'],
];
let scope: Scope = 'all';
/** Bumped by the buttons, so the view re-reads the log. */
let stamp = 0;

const pct = (n: number, of: number): string => (of > 0 ? `${Math.round((n / of) * 100)}%` : '—');
const secs = (v: number | null, d = 2): string => (v === null ? '—' : `${v.toFixed(d)} s`);
const mins = (ms: number): string => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`);
const when = (t: number | null): string => (t === null ? '—' : new Date(t).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }));
const level = (d: number): string => (d < 0 ? 'All' : String(d));

function table(head: string[], rows: (string | number)[][], empty = 'Nothing recorded yet'): HTMLElement {
  if (rows.length === 0) return h('p', { class: 'muted small', text: empty });
  return h(
    'div',
    { class: 'ps-scroll' },
    h(
      'table',
      { class: 'ps-table' },
      h('thead', null, h('tr', null, head.map((c) => h('th', { text: c })))),
      h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', { text: String(c) }))))),
    ),
  );
}

const section = (title: string, note: string | null, ...body: (HTMLElement | null)[]): HTMLElement =>
  h('section', { class: 'card ps-card' }, h('h3', { text: title }), note ? h('p', { class: 'muted small', text: note }) : null, ...body);

const tile = (k: string, v: string, d = ''): HTMLElement => h('div', { class: 'tk-big' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v }), h('span', { class: 'd', text: d }));

const hookRow = (r: HookRow): (string | number)[] => [level(r.d), r.bites, r.missed, pct(r.missed, r.bites), secs(r.median), secs(r.p90), pct(r.clean, r.bites - r.missed)];
const fightRow = (r: FightRow): (string | number)[] => [
  level(r.d),
  r.fights,
  pct(r.landed, r.fights),
  `${r.snapped} (${pct(r.snapped, r.fights)})`,
  `${r.slack} (${pct(r.slack, r.fights)})`,
  r.landed ? secs(r.seconds, 1) : '—',
  r.landed ? `${Math.round(r.accuracy * 100)}%` : '—',
];

function save(text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { attrs: { href: url, download: `fishing-telemetry-${new Date().toISOString().slice(0, 10)}.json` } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function view(s: Summary, rerender: () => void): HTMLElement[] {
  const out: HTMLElement[] = [];
  out.push(
    h(
      'section',
      { class: 'card ps-card' },
      h('div', { class: 'picker-head' }, h('h2', { text: 'Play stats' }), h('a', { class: 'link', text: '← Back to the water', attrs: { href: '#/' } })),
      h('p', {
        class: 'muted small',
        text: TELEMETRY_ON
          ? 'Measured from play in this browser: casts, bites, hooks, fights, purchases. It is kept in this browser only, holds no wallet or account data, and is not sent anywhere. Export it to share it for balance work, or clear it.'
          : 'Recording is switched off in this build (VITE_TELEMETRY=off). What was recorded before is still shown.',
      }),
      h(
        'div',
        { class: 'ps-actions' },
        h('div', { class: 'ps-scope' }, SCOPES.map(([k, label]) => h('button', { class: `btn btn-sm${scope === k ? ' btn-primary' : ''}`, text: label, onclick: () => ((scope = k), rerender()) }))),
        h('button', { class: 'btn btn-sm', text: 'Refresh', onclick: () => (stamp++, rerender()) }),
        h('button', { class: 'btn btn-sm', text: 'Export JSON', disabled: s.events === 0, onclick: () => save(telemetryExport()) }),
        h('button', {
          class: 'btn btn-sm btn-danger',
          text: 'Clear',
          disabled: s.events === 0,
          onclick: () => {
            if (!confirm('Delete the recorded play stats in this browser? The game itself is not affected.')) return;
            clearTelemetry();
            stamp++;
            rerender();
            toast('Play stats cleared', 'ok');
          },
        }),
      ),
      h('p', { class: 'muted small', text: `${s.events.toLocaleString('en-US')} events · ${when(s.from)} – ${when(s.to)}${s.dropped ? ` · ${s.dropped.toLocaleString('en-US')} older events were dropped to keep the log small` : ''} · this page is ${CHAIN ? 'on the contracts' : 'the local game'}` }),
    ),
  );
  if (s.events === 0) return out;

  const st = s.sessionStats;
  const landed = s.catches;
  out.push(
    section(
      'Overview',
      null,
      h(
        'div',
        { class: 'tk-lo-out bonus-row' },
        tile('Sessions', String(st.count), `median ${mins(st.medianMs)}`),
        tile('Casts', String(s.casts), `${s.energy} energy`),
        tile('Landed', String(landed), `${pct(landed, s.casts)} of casts`),
        tile('PEARL / energy', s.pearlPerEnergy === null ? '—' : s.pearlPerEnergy.toFixed(1), 'sell price of the catch'),
      ),
    ),
  );

  out.push(
    section(
      'Sessions',
      `Active play, from the first action to the last. A pause of ten minutes ends a session. ${st.outOfEnergy} of ${st.count} ended with the energy bar too low for another cast; energy ran out ${s.energyOut} time(s) in all.`,
      table(
        ['Started', 'Length', 'Casts', 'Landed', 'Ended'],
        [...s.sessions].reverse().slice(0, 30).map((x) => [when(x.start), mins(x.duration), x.casts, x.caught, x.outOfEnergy ? 'out of energy' : x.reason === 'open' ? 'in progress' : x.reason === 'idle' ? 'went idle' : x.reason === 'lost' ? 'tab closed' : 'left']),
      ),
      s.sessions.length > 30 ? h('p', { class: 'muted small', text: `The latest 30 of ${s.sessions.length}; the export has all of them.` }) : null,
    ),
  );

  out.push(
    section(
      'Casts by location',
      'Bite: something took the lure. Landed: a fish in the keepnet. PEARL is the sell price of what was landed, before the fresh-catch bonus.',
      table(
        ['Location', 'Casts', 'Energy', 'Bites', 'No bite', 'Landed', 'Landed / cast', 'PEARL / energy'],
        s.locations.map((l) => [LOCATIONS[l.loc]?.name ?? `#${l.loc}`, l.casts, l.energy, l.bites, l.noBite, l.caught, pct(l.caught, l.casts), l.energy ? (l.pearl / l.energy).toFixed(1) : '—']),
      ),
    ),
  );

  out.push(
    section(
      'Hook',
      'Reaction is the time from the float dipping to the hook, for the hooks that were set. Difficulty is the rarity of the fish plus how rough the water is.',
      table(['Difficulty', 'Bites', 'Missed', 'Miss rate', 'Median reaction', '90% within', 'Clean hooks'], [hookRow(s.hooks), ...s.hooksByDifficulty.map(hookRow)]),
    ),
  );

  out.push(
    section(
      'Reel fight',
      `Every fight, retries included. First tries alone: ${s.firstTries.fights} fights, ${pct(s.firstTries.landed, s.firstTries.fights)} landed. On the contracts a lost fight is a retry, in the local game a lost fish.`,
      table(['Difficulty', 'Fights', 'Landed', 'Line snapped', 'Got away (slack)', 'Mean length', 'Time in the green'], [fightRow(s.fights), ...s.fightsByDifficulty.map(fightRow)]),
    ),
  );

  out.push(
    section(
      'Catch',
      `${s.specials} special fish · ${s.newSpecies} new species · sold ${s.sales.fish} fish for ${pearl(s.sales.earned)} PEARL.`,
      table(
        ['Rarity', 'Landed', 'Share'],
        s.byRarity.map((n, r) => [RARITY_NAMES[r], n, pct(n, landed)] as (string | number)[]).filter((r) => r[1] !== 0),
      ),
      table(
        ['Quality', 'Landed', 'Share'],
        (['S', 'A', 'B', 'C', 'D'] as const).map((q) => [q, s.byQuality[q], pct(s.byQuality[q], landed)]),
      ),
    ),
  );

  const itemName = (kind: string, id: string): string =>
    kind === 'rod' || kind === 'repair' ? rodById(id)?.name ?? id : kind === 'lure' ? lureById(id)?.name ?? id : kind === 'location' ? LOCATIONS[Number(id)]?.name ?? id : kind === 'refill' ? 'Energy refill' : 'PEARL for BLEND';
  out.push(
    section(
      'Purchases and progress',
      `${pearl(s.pearlSpent)} PEARL spent in all.`,
      table(
        ['What', 'Kind', 'Times', 'Paid'],
        s.purchases.map((p) => [itemName(p.kind, p.id), p.kind, p.count, p.kind === 'pearl' ? `${p.pearl.toLocaleString('en-US')} BLEND` : `${pearl(p.pearl)} PEARL`]),
        'No purchases recorded',
      ),
      table(
        ['Location unlocked', 'How', 'When'],
        s.unlocks.map((u) => [LOCATIONS[u.loc]?.name ?? `#${u.loc}`, u.how === 'purchase' ? 'bought for PEARL' : 'earned by play', when(u.t)]),
        'No locations unlocked while recording',
      ),
      table(
        ['Level reached', 'When'],
        s.levels.map((l) => [l.level, when(l.t)]),
        'No level-ups recorded',
      ),
    ),
  );
  return out;
}

export function initStats(host: HTMLElement): () => void {
  const rerender = mount(
    host,
    // the log is re-read when the page is opened, on Refresh, and once a minute while it is on screen
    () => sigOf(location.hash === '#/stats', scope, stamp, Math.floor(Date.now() / 60_000)),
    () => (location.hash === '#/stats' ? view(telemetrySummary(scope === 'all' ? undefined : scope), rerender) : []),
  );
  return rerender;
}

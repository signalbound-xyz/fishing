/**
 * My Stats (#/profile): the player's fishing career. Lifetime numbers, fishing by water, personal records and
 * progress.
 *
 * Where each number comes from, because there are two kinds on this page:
 * - the lifetime numbers, the records, the encyclopedia, mastery, the achievements: the player's state
 *   (game/career.ts `lifetime`, game/mastery.ts, game/progress.ts). On the contracts that is the game's own state,
 *   the same on every device;
 * - casts and catches by water: on the contracts, the game's events (play/career.ts); in the local game, the
 *   save's own counts. The page says when those are still being read or do not cover everything.
 *
 * Nothing here reads the telemetry log: that is the debug page (#/stats, ui/stats.ts), a different thing.
 */
import { SPECIES, LOCATIONS } from '../../game/content';
import { fmtRate, lifetime, type WaterStats } from '../../game/career';
import { trophiesOf } from '../../game/favorites';
import { TIERS, allMastery, masterySummary, percent, type LocationMastery } from '../../game/mastery';
import { achievements, isUnlocked } from '../../game/progress';
import type { Save } from '../../game/types';
import { openFluentConnect } from '../../fluent';
import { RARITY_CLASS, RARITY_NAMES } from '../../i18n';
import { emit, state } from '../../store';
import { fmtWeight, h, icon, mount, segBar, shortAddr, sigOf } from '../../ui/dom';
import { careerView, type CareerView } from '../career';
import { dailyView } from '../daily';
import { CHAIN, playerRead } from '../ops';
import { getSave, rev } from '../state';
import { ago } from './fmt';

/** Waters whose details are open. */
const open = new Set<number>();
/** The list of records by species is long: it opens on request. */
let speciesOpen = false;

const num = (n: number): string => n.toLocaleString('en-US');
const castWord = (n: number): string => (n === 1 ? 'cast' : 'casts');
const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export function initProfile(host: HTMLElement): () => void {
  return mount(
    host,
    () => {
      if (location.hash !== '#/profile') return 'closed';
      const c = careerView();
      const d = dailyView();
      return sigOf(rev(), state.wallet?.address, playerRead(), c.status, c.stale, Math.round(c.progress * 100), c.counted, c.gap, c.pending, d.status, d.streak, d.streakOpen, [...open], speciesOpen);
    },
    render,
  );
}

const dot = (speciesId: number): HTMLElement => h('span', { class: RARITY_CLASS[SPECIES[speciesId].rarity] }, h('span', { class: 'dot' }), SPECIES[speciesId].name);

const tile = (k: string, v: string | HTMLElement, d: string | HTMLElement | null = null, cls = ''): HTMLElement =>
  h('div', { class: `pf-tile ${cls}` }, h('span', { class: 'k', text: k }), typeof v === 'string' ? h('span', { class: 'v', text: v }) : v, d === null ? null : typeof d === 'string' ? h('span', { class: 'd', text: d }) : d);

const section = (title: string, note: string | null, ...body: (HTMLElement | null)[]): HTMLElement =>
  h('section', { class: 'card pf-card' }, h('h3', { text: title }), note ? h('p', { class: 'muted small', text: note }) : null, ...body);

// ------------------------------------------------------------------ 1. overview

function overview(s: Save): HTMLElement {
  const l = lifetime(s);
  const b = l.biggest;
  return section(
    'Overview',
    CHAIN ? 'Lifetime numbers, read from the game contract: the same on every device, and a fish you sold still counts.' : 'Lifetime numbers of this browser’s local game. A fish you sold still counts.',
    h(
      'div',
      { class: 'pf-tiles' },
      tile('Fish caught', num(l.catches), 'lifetime'),
      tile('Casts', num(l.casts), 'lifetime'),
      tile('Catch rate', fmtRate(l.rate), l.casts ? `${num(l.catches)} of ${num(l.casts)} casts` : 'no casts yet'),
      tile('Species discovered', `${l.discovered}/${l.species}`, segBar(l.discovered, l.species, 12, 'pf-meter')),
      tile(
        'Biggest fish',
        b ? fmtWeight(b.weight) : '—',
        b ? h('span', { class: 'd' }, dot(b.speciesId), ` · ${LOCATIONS[b.locationId]?.name ?? 'Unknown waters'}`) : 'no catches yet',
        'pf-wide',
      ),
      tile('Legendary caught', num(l.legendary), `${l.byRarity[4].discovered}/${l.byRarity[4].species} species`, 'r4'),
      tile('Mythic caught', num(l.mythic), `${l.byRarity[5].discovered}/${l.byRarity[5].species} species`, 'r5'),
      tile('Waters unlocked', `${l.unlocked}/${l.waters}`, segBar(l.unlocked, l.waters, l.waters, 'pf-meter'), 'pf-wide'),
      tile('Level', String(l.level), h('span', { class: 'd' }, `${num(l.xp)} XP in all · ${num(l.levelNeeds - l.levelXp)} to level ${l.level + 1}`), 'pf-wide'),
    ),
  );
}

// ------------------------------------------------------------------ 2. fishing by location

/** What the page says about how whole the counts by water are. Null: they are whole and there is nothing to add. */
function careerNote(c: CareerView): HTMLElement | null {
  const pct = Math.round(c.progress * 100);
  if (c.status === 'reading') {
    return h(
      'div',
      { class: 'pf-note', attrs: { role: 'status' } },
      h('b', { text: `Reading your fishing history from the chain… ${pct}%` }),
      segBar(pct, 100, 20, 'pf-meter'),
      h('span', { class: 'muted small', text: 'The counts below are incomplete until this reaches the end. It is done once per device; later visits read only what is new.' }),
    );
  }
  if (c.status === 'error') {
    return h(
      'div',
      { class: 'pf-note warn-box', attrs: { role: 'status' } },
      h('b', { text: 'Your fishing history could not be read from the chain.' }),
      h('span', { class: 'muted small', text: `${pct > 0 ? `It was read ${pct}% of the way: the counts below are incomplete. ` : 'Nothing is shown by water rather than a guess. '}Trying again shortly.` }),
    );
  }
  const stale = c.stale ? ' The chain could not be read just now: this is the last copy kept on this device.' : '';
  if (c.status === 'partial') {
    const parts = [c.gap.catches ? `${num(c.gap.catches)} fish` : '', c.gap.casts ? `${num(c.gap.casts)} ${castWord(c.gap.casts)}` : ''].filter(Boolean).join(' and ');
    const why =
      c.source === 'local'
        ? `This game counts by water since ${DATE.format(c.since ?? Date.now())}. What you fished before that is in your lifetime totals, but no water can be named for it.`
        : 'The game’s event history does not account for all of your lifetime totals, so the counts by water are incomplete.';
    return h('div', { class: 'pf-note warn-box', attrs: { role: 'status' } }, h('b', { text: `Not counted by water: ${parts}.` }), h('span', { class: 'muted small', text: why + stale }));
  }
  if (c.status === 'unverified') {
    return h(
      'div',
      { class: 'pf-note warn-box', attrs: { role: 'status' } },
      h('b', { text: 'These counts could not be checked against the game’s own totals.' }),
      h('span', { class: 'muted small', text: `They are every cast and catch found in the game’s events, but treat them as possibly incomplete.${stale}` }),
    );
  }
  if (stale) return h('div', { class: 'pf-note warn-box', attrs: { role: 'status' } }, h('span', { class: 'muted small', text: stale.trim() }));
  if (c.pending.casts || c.pending.catches) {
    const parts = [c.pending.catches ? `${num(c.pending.catches)} fish` : '', c.pending.casts ? `${num(c.pending.casts)} ${castWord(c.pending.casts)}` : ''].filter(Boolean).join(' and ');
    return h('div', { class: 'pf-note', attrs: { role: 'status' } }, h('span', { class: 'muted small', text: `Your latest ${parts} will be counted here in a few seconds, once the chain has settled them.` }));
  }
  return null;
}

function waterRow(s: Save, w: WaterStats, m: LocationMastery, c: CareerView): HTMLElement {
  const loc = LOCATIONS[w.locationId];
  const isOpen = open.has(loc.id);
  const locked = !isUnlocked(s, loc);
  const best = s.records.byLocation[loc.id];
  const most = Math.max(1, ...c.waters.map((x) => x.catches));
  const id = `pf-water-${loc.id}`;
  const fact = (k: string, v: string | HTMLElement): HTMLElement => h('div', { class: 'pf-fact' }, h('dt', { text: k }), h('dd', null, v));
  return h(
    'article',
    { class: `pf-water${isOpen ? ' open' : ''}${w.catches === 0 && w.casts === 0 ? ' idle' : ''}` },
    h(
      'button',
      {
        class: 'pf-water-head',
        attrs: { type: 'button', 'aria-expanded': String(isOpen), 'aria-controls': id },
        onclick: () => {
          if (isOpen) open.delete(loc.id);
          else open.add(loc.id);
          emit();
        },
      },
      h('span', { class: 'pf-water-name' }, locked ? icon('lock', 'Locked') : null, loc.name),
      segBar(w.catches, most, 24, 'pf-bar'),
      h('span', { class: 'pf-water-n', text: `${num(w.catches)} fish` }),
      h('span', { class: 'pf-water-r muted', text: w.casts ? `${num(w.casts)} ${castWord(w.casts)} · ${fmtRate(w.rate)}` : 'no casts' }),
      h('span', { class: 'pf-caret', text: isOpen ? '−' : '+', attrs: { 'aria-hidden': 'true' } }),
    ),
    isOpen
      ? h(
          'div',
          { class: 'pf-water-more', attrs: { id } },
          h(
            'dl',
            { class: 'pf-facts' },
            fact('Fish caught', num(w.catches)),
            fact('Casts', num(w.casts)),
            fact('Catch rate', fmtRate(w.rate)),
            c.source === 'chain' ? fact('No bite', num(w.misses)) : null,
            fact('Biggest fish here', best ? h('span', null, dot(best.speciesId), ` · ${fmtWeight(best.weight)}`) : '—'),
            fact('Most caught', w.top ? h('span', null, dot(w.top.speciesId), ` ×${num(w.top.count)}`) : '—'),
            fact('Mastery', m.level > 0 ? TIERS[m.level - 1].name : m.current ? `${percent(m.progress, false)}% of ${TIERS[0].name}` : '—'),
          ),
          w.species.length > 1
            ? h(
                'div',
                { class: 'pf-species' },
                w.species.map((x) => h('span', { class: 'pf-chip' }, dot(x.speciesId), ` ×${num(x.count)}`)),
              )
            : null,
          locked ? h('p', { class: 'muted small', text: 'This water is still locked.' }) : w.casts === 0 && w.catches === 0 ? h('p', { class: 'muted small', text: 'Nothing fished here yet.' }) : null,
        )
      : null,
  );
}

function byLocation(s: Save, c: CareerView, mastery: LocationMastery[]): HTMLElement {
  const empty = c.status === 'error' && c.counted.casts === 0 && c.counted.catches === 0;
  return section(
    'Fishing by location',
    c.source === 'chain' ? 'Counted from the game’s own events on chain, water by water. Fish you sold or sent away are still here.' : 'Counted by this game as you fish, water by water.',
    careerNote(c),
    empty ? null : h('div', { class: 'pf-waters' }, c.waters.map((w) => waterRow(s, w, mastery[w.locationId], c))),
  );
}

// ------------------------------------------------------------------ 3. personal records

function records(s: Save): HTMLElement {
  const l = lifetime(s);
  const o = s.records.overall;
  const perSpecies = Object.entries(s.dex)
    .map(([id, e]) => ({ id: Number(id), ...e }))
    .sort((a, b) => b.best - a.best);
  return section(
    'Personal records',
    null,
    o
      ? h(
          'div',
          { class: `weekly ${RARITY_CLASS[SPECIES[o.speciesId].rarity]}` },
          h('div', { class: 'weekly-weight', text: fmtWeight(o.weight) }),
          h('div', null, h('b', { text: SPECIES[o.speciesId].name }), h('div', { class: 'muted small', text: `Biggest catch · ${LOCATIONS[o.locationId]?.name ?? 'Unknown waters'} · ${ago(o.at)}` })),
        )
      : h('p', { class: 'empty', text: 'No catches yet. Your biggest fish will be framed here.' }),
    h('h4', { text: 'Biggest catch by location' }),
    h(
      'table',
      { class: 'board board-list' },
      h(
        'tbody',
        null,
        LOCATIONS.map((loc) => {
          const r = s.records.byLocation[loc.id];
          return h('tr', { class: r ? '' : 'none' }, h('td', { text: loc.name }), h('td', null, r ? dot(r.speciesId) : h('span', { class: 'muted', text: '—' })), h('td', { text: r ? fmtWeight(r.weight) : '' }));
        }),
      ),
    ),
    h('h4', { text: 'Species discovered by rarity' }),
    h(
      'div',
      { class: 'pf-rarities' },
      l.byRarity.map((r) =>
        h(
          'div',
          { class: `pf-rarity ${RARITY_CLASS[r.rarity]}`, title: `${num(r.caught)} ${RARITY_NAMES[r.rarity]} fish caught in all` },
          h('span', { class: 'k' }, h('span', { class: 'dot' }), RARITY_NAMES[r.rarity]),
          h('span', { class: 'v', text: `${r.discovered}/${r.species}` }),
          h('span', { class: 'd', text: `${num(r.caught)} caught` }),
        ),
      ),
    ),
    h(
      'button',
      {
        class: 'btn btn-sm btn-ghost pf-toggle',
        text: speciesOpen ? 'Hide records by species' : `Show records by species (${perSpecies.length})`,
        attrs: { type: 'button', 'aria-expanded': String(speciesOpen) },
        disabled: perSpecies.length === 0,
        onclick: () => {
          speciesOpen = !speciesOpen;
          emit();
        },
      },
    ),
    speciesOpen ? speciesRecords(perSpecies) : null,
  );
}

function speciesRecords(list: { id: number; count: number; best: number }[]): HTMLElement {
  const rows = list.map((e, i) =>
    h('tr', { attrs: { 'data-name': SPECIES[e.id].name.toLowerCase() } }, h('td', { text: String(i + 1) }), h('td', null, dot(e.id)), h('td', { text: fmtWeight(e.best) }), h('td', { text: `×${num(e.count)}` })),
  );
  const none = h('p', { class: 'muted small hidden', text: 'No species matches.' });
  const search = h('input', {
    class: 'pf-search',
    attrs: { type: 'search', placeholder: 'Find a species', 'aria-label': 'Find a species' },
    // filters the rows in place: redrawing the table would take the cursor out of the field
    oninput: (e: Event) => {
      const q = (e.target as HTMLInputElement).value.trim().toLowerCase();
      let shown = 0;
      for (const r of rows) {
        const hit = (r.dataset.name ?? '').includes(q);
        r.classList.toggle('hidden', !hit);
        if (hit) shown++;
      }
      none.classList.toggle('hidden', shown > 0);
    },
  });
  return h(
    'div',
    { class: 'pf-by-species' },
    search,
    h('table', { class: 'board' }, h('thead', null, h('tr', null, h('th', { text: '#' }), h('th', { text: 'Species' }), h('th', { text: 'Best' }), h('th', { text: 'Caught' }))), h('tbody', null, rows)),
    none,
  );
}

// ------------------------------------------------------------------ 4. progress and achievements

function progress(s: Save, mastery: LocationMastery[]): HTMLElement {
  const sum = masterySummary(mastery);
  const ach = achievements(s);
  const collections = ach.filter((a) => a.id.startsWith('loc:'));
  const done = ach.filter((a) => a.done).length;
  const waiting = ach.filter((a) => a.done && !a.claimed).length;
  const d = dailyView();
  const trophies = trophiesOf(s).length;
  const goTab = (tab: string): (() => void) => () => {
    location.hash = '#/';
    window.dispatchEvent(new CustomEvent('fishing:open-tab', { detail: tab }));
  };
  const link = (text: string, tab: string): HTMLElement => h('button', { class: 'pf-link', text, attrs: { type: 'button' }, onclick: goTab(tab) });
  return section(
    'Progress & achievements',
    null,
    h(
      'div',
      { class: 'pf-tiles' },
      tile('Location mastery', `${sum.tiers}/${sum.tiersTotal}`, h('span', { class: 'd' }, `${sum.title}. `, link('Collection', 'dex')), 'pf-wide'),
      tile('Collections complete', `${collections.filter((a) => a.done).length}/${collections.length}`, h('span', { class: 'd' }, `${done}/${ach.length} achievements${waiting ? `, ${waiting} to claim` : ''}. `, link('Ranks', 'ranks')), 'pf-wide'),
      tile(
        'Daily streak',
        d.streak === null ? '—' : `${d.streak}${d.streakOpen && d.streak > 0 ? '+' : ''}`,
        h('span', { class: 'd' }, d.streak === null ? (d.status === 'guest' ? 'sign in to see it. ' : d.status === 'error' ? 'could not be read just now. ' : 'being counted… ') : `${d.streak === 1 ? 'day' : 'days'} in a row with all three challenges done. `, link('Daily', 'daily')),
        'pf-wide',
      ),
      tile('Saved trophies', num(trophies), h('span', { class: 'd' }, 'in your keepnet now. ', link('Trophies', 'trophy')), 'pf-wide'),
    ),
    h(
      'div',
      { class: 'pf-mastery' },
      mastery.map((m) =>
        h(
          'div',
          { class: `pf-mastery-row lvl-${m.level}`, title: `${LOCATIONS[m.locationId].name}: ${m.level > 0 ? TIERS[m.level - 1].name : 'no tier yet'}` },
          h('span', { class: 'pf-mastery-name', text: LOCATIONS[m.locationId].name }),
          segBar(m.level, TIERS.length, TIERS.length, 'pf-tiers'),
          h('span', { class: 'muted small', text: m.level > 0 ? TIERS[m.level - 1].name : `${percent(m.progress, false)}% to ${TIERS[0].name}` }),
        ),
      ),
    ),
  );
}

// ------------------------------------------------------------------ the page

function render(): HTMLElement[] {
  const w = state.wallet;
  const head = h(
    'div',
    { class: 'pf-head' },
    h('h2', { text: 'My Stats' }),
    h('span', { class: 'muted', text: CHAIN ? (w ? `${shortAddr(w.address)} · your fishing career on chain` : 'Your fishing career on chain') : 'Your fishing career in the local game' }),
  );
  if (CHAIN && !w) {
    return [
      head,
      h(
        'section',
        { class: 'card pf-card pf-empty' },
        h('p', { text: 'Sign in to see your fishing career.' }),
        h('p', { class: 'muted small', text: 'Your catches, records and progress are kept by the game contract, so they follow your account to any device.' }),
        h('button', { class: 'btn btn-wallet', text: 'Connect with Fluent', attrs: { type: 'button' }, onclick: openFluentConnect }),
      ),
    ];
  }
  if (CHAIN && !playerRead()) {
    return [head, h('section', { class: 'card pf-card pf-empty', attrs: { role: 'status', 'aria-busy': 'true' } }, h('p', { class: 'muted', text: 'Reading your game from the chain…' }))];
  }
  const s = getSave();
  const mastery = allMastery(s.dex);
  return [head, overview(s), byLocation(s, careerView(), mastery), records(s), progress(s, mastery)];
}

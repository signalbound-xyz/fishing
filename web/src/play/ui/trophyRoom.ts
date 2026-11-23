/**
 * My Trophy Room: every saved fish of the keepnet, framed. There is one action that fills it (☆ Save, on a keepnet
 * card or on the card of a fresh catch) and one that empties it (★ Remove from favorites, on the frame). No slots,
 * no limit, no second list: what is saved is here, and what is here is protected from selling.
 *
 * A frame is drawn from plain data (`Trophy`), not from the save: a public room of another account can be drawn
 * with the same `frame` once the saved ids come from an account-based store (game/favorites.ts).
 *
 * A large room is drawn a page at a time (`pageOf`), so hundreds of trophies are never in the page at once.
 */
import { LOCATIONS, SPECIES } from '../../game/content';
import { ALL, TROPHY_PAGE, defaultQuery, pageOf, trophiesOf, trophyFish, type TrophySort } from '../../game/favorites';
import type { FishInstance, Quality, Save } from '../../game/types';
import { RARITY_CLASS, RARITY_NAMES } from '../../i18n';
import { state } from '../../store';
import { fmtWeight, h, icon } from '../../ui/dom';
import { dropdown } from '../../ui/dropdown';
import { toast } from '../../ui/toast';
import { fishArt } from '../fishSprite';
import { CHAIN, ops } from '../ops';
import { getSave } from '../state';
import { pearl, qualityTag, rarityTag } from './fmt';

// ------------------------------------------------------------------ what a frame shows

export interface Trophy {
  id: string;
  speciesId: number;
  rarity: number;
  /** Grams. */
  weight: number;
  quality: Quality;
  locationId: number;
  /** ms since epoch */
  caughtAt: number;
  /** PEARL it sells for once it is no longer saved. */
  value: number;
  special: boolean;
  /** The player's heaviest fish of all, or the heaviest of its species. */
  record: 'overall' | 'species' | null;
}

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
export const catchDate = (ms: number): string => DATE.format(ms);

/** Is this fish the player's record? Judged by the encyclopedia and the records, which outlive any sale. */
export function recordOf(s: Save, f: FishInstance): Trophy['record'] {
  const top = s.records.overall;
  if (top && top.speciesId === f.speciesId && top.weight === f.weight) return 'overall';
  return s.dex[f.speciesId]?.best === f.weight ? 'species' : null;
}

export const trophyOf = (s: Save, f: FishInstance): Trophy => ({
  id: f.id,
  speciesId: f.speciesId,
  rarity: f.rarity,
  weight: f.weight,
  quality: f.quality,
  locationId: f.locationId,
  caughtAt: f.caughtAt,
  value: f.sellPrice,
  special: f.isSpecial,
  record: recordOf(s, f),
});

const RECORD_LABEL = { overall: 'Heaviest catch ever', species: 'Personal best' } as const;
const label = (t: { speciesId: number; weight: number }): string => `${SPECIES[t.speciesId]?.name ?? 'Fish'} ${fmtWeight(t.weight)}`;

/** One framed trophy. Without `onRemove` it is a picture, as in somebody else's room. */
export function frame(t: Trophy, onRemove?: () => void): HTMLElement {
  const sp = SPECIES[t.speciesId];
  const where = LOCATIONS[t.locationId]?.name ?? 'Unknown waters';
  return h(
    'article',
    { class: `frame ${RARITY_CLASS[t.rarity]}`, attrs: { 'aria-label': `${sp.name}, ${RARITY_NAMES[t.rarity]}, ${fmtWeight(t.weight)}, quality ${t.quality}, caught in ${where} on ${catchDate(t.caughtAt)}` } },
    fishArt(t.speciesId, { cls: 'frame-art' }),
    h(
      'div',
      { class: 'frame-plate' },
      h('span', { class: 'frame-name', text: sp.name }),
      h('span', { class: 'item-tags' }, rarityTag(t.rarity), qualityTag(t.quality), t.special ? h('span', { class: 'badge', text: 'Special' }) : null),
      h('span', { class: 'frame-meta' }, h('span', { class: 'frame-weight', text: fmtWeight(t.weight) }), h('span', { class: 'pearl', title: 'What it sells for once it is no longer a favorite', text: `${pearl(t.value)} P` })),
      h('span', { class: 'frame-where', text: `${where} · ${catchDate(t.caughtAt)}` }),
      // a medal, not the star: the star means "saved"
      t.record ? h('span', { class: 'frame-record' }, icon('medal'), RECORD_LABEL[t.record]) : null,
    ),
    onRemove
      ? h('button', {
          class: 'btn btn-sm btn-ghost frame-remove',
          text: '★ Remove from favorites',
          title: 'Takes it out of your Trophy Room. The fish stays in your Keepnet and can be sold again',
          attrs: { type: 'button', 'aria-label': `Remove ${label(t)} from favorites` },
          onclick: onRemove,
        })
      : null,
  );
}

// ------------------------------------------------------------------ the player's own room

const SORTS: [TrophySort, string][] = [
  ['date', 'Newest'],
  ['rarity', 'Rarest'],
  ['weight', 'Heaviest'],
  ['value', 'Most valuable'],
];

const ui = {
  ...defaultQuery(),
  /** How many trophies are drawn: a page, plus one more for every "Load more". */
  shown: TROPHY_PAGE,
};

/** Part of the Trophies tab's render signature. */
export const roomSig = (): unknown => ui;

/** Brings the room into view. */
export function showRoom(): void {
  window.dispatchEvent(new CustomEvent('fishing:open-tab', { detail: 'trophy' }));
}

/** On the contracts the room belongs to an account: with nobody signed in there is nothing to show. */
const isGuest = (): boolean => CHAIN && !state.wallet;

function remove(f: FishInstance): void {
  // explicit, one fish at a time; nothing is sold, the fish only stops being protected
  if (ops.toggleFavorite(f.id)) toast(`${label(f)} is no longer a favorite. It stays in your Keepnet and can be sold again.`, 'info');
}

function select<T extends string | number>(name: string, value: T, options: [T, string][], onPick: (v: string) => void): HTMLElement {
  return dropdown({ label: name, value: String(value), small: true, options: options.map(([v, text]) => ({ value: String(v), label: text })), onPick });
}

export function renderRoom(rerender: () => void): HTMLElement[] {
  const s = getSave();
  const all = trophiesOf(s);
  const total = all.length;
  // a filter whose last trophy is gone would hide the rest of the room behind an option that no longer exists
  const rarities: number[] = [...new Set(all.map((f) => f.rarity))].sort((a, b) => a - b);
  const places = [...new Set(all.map((f) => f.locationId))].sort((a, b) => a - b);
  if (!rarities.includes(ui.rarity)) ui.rarity = ALL;
  if (!places.includes(ui.location)) ui.location = ALL;

  const list = trophyFish(s, ui);
  const page = pageOf(list, ui.shown);
  /** A new order or filter starts from the first page again. */
  const ask = (change: () => void): void => {
    change();
    ui.shown = TROPHY_PAGE;
    rerender();
  };

  const head = h('div', { class: 'dex-head' }, h('h3', { text: total ? `My Trophy Room — ${total} ${total === 1 ? 'trophy' : 'trophies'}` : 'My Trophy Room' }));
  const about = h('p', {
    class: 'muted small',
    text: `Your favorite catches, protected from selling. Tap ★ to remove a fish from your collection.${
      CHAIN ? ' The star is kept in this browser for this account. It does not lock the NFT: outside the game a fish can still be transferred or traded.' : ''
    }`,
  });
  if (total === 0) {
    return [
      h(
        'section',
        { class: 'room', attrs: { 'aria-label': 'My Trophy Room' } },
        head,
        about,
        h('p', {
          class: 'empty room-empty',
          text: isGuest() ? 'Your Trophy Room is empty. Sign in, catch a fish and tap ☆ Save to add your first trophy.' : 'Your Trophy Room is empty. Catch a fish and tap ☆ Save to add your first trophy.',
        }),
      ),
    ];
  }

  const filtered = list.length !== total;
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h('span', { class: 'muted small', attrs: { role: 'status' }, text: filtered ? `${list.length} of ${total} match` : '' }),
    h('div', { class: 'spacer' }),
    select('Sort', ui.sort, SORTS, (v) => ask(() => (ui.sort = v as TrophySort))),
    select('Rarity', ui.rarity, [[ALL, 'All rarities'], ...rarities.map((r) => [r, RARITY_NAMES[r]] as [number, string])], (v) => ask(() => (ui.rarity = Number(v)))),
    select('Location', ui.location, [[ALL, 'All locations'], ...places.map((l) => [l, LOCATIONS[l]?.name ?? `Location ${l}`] as [number, string])], (v) => ask(() => (ui.location = Number(v)))),
  );

  return [
    h(
      'section',
      { class: 'room', attrs: { 'aria-label': 'My Trophy Room' } },
      head,
      about,
      toolbar,
      list.length === 0
        ? h('p', { class: 'empty', text: 'No trophies match these filters.' })
        : h(
            'div',
            { class: 'room-grid' },
            page.items.map((f) => frame(trophyOf(s, f), () => remove(f))),
          ),
      page.rest > 0
        ? h(
            'div',
            { class: 'room-more' },
            h('span', { class: 'muted small', text: `Showing ${page.items.length} of ${list.length}` }),
            h('button', {
              class: 'btn btn-sm',
              text: `Load more (${page.next})`,
              attrs: { type: 'button', 'aria-label': `Load ${page.next} more trophies, ${page.rest} not shown yet` },
              onclick: () => {
                ui.shown = page.items.length + TROPHY_PAGE;
                rerender();
              },
            }),
          )
        : null,
    ),
  ];
}

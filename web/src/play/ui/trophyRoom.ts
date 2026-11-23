/**
 * The Trophy Room (six frames, in the player's order) and the Saved Fish below it.
 *
 * The room is drawn from plain data (`Trophy`), not from the save: a public room of another account can be drawn
 * with the same `frame` once the six ids come from an account-based store (game/showcase.ts).
 *
 * Nothing here is a dialog. Choosing a fish for a frame, and choosing which trophy a seventh fish replaces, both
 * happen in place, under the room.
 */
import { isShowcased, saleValue } from '../../game/actions';
import { LOCATIONS, SPECIES } from '../../game/content';
import { SHOWCASE_SLOTS, freeSlot, shownCount, slotOf } from '../../game/showcase';
import type { FishInstance, Quality, Save } from '../../game/types';
import { RARITY_CLASS, RARITY_NAMES } from '../../i18n';
import { emit, state } from '../../store';
import { fmtWeight, h } from '../../ui/dom';
import { dropdown } from '../../ui/dropdown';
import { toast } from '../../ui/toast';
import { fishArt } from '../fishSprite';
import { CHAIN, ops } from '../ops';
import { getSave } from '../state';
import { ago, pearl, qualityTag, rarityTag } from './fmt';

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

export const trophyOf = (s: Save, f: FishInstance): Trophy => ({ id: f.id, speciesId: f.speciesId, rarity: f.rarity, weight: f.weight, quality: f.quality, locationId: f.locationId, caughtAt: f.caughtAt, record: recordOf(s, f) });

/** The six frames of a save: a trophy, or null for an empty frame (also when the fish is no longer there). */
export function trophiesOf(s: Save): (Trophy | null)[] {
  return Array.from({ length: SHOWCASE_SLOTS }, (_, i) => {
    const f = s.showcase[i] ? s.fish.find((x) => x.id === s.showcase[i]) : undefined;
    return f ? trophyOf(s, f) : null;
  });
}

const RECORD_LABEL = { overall: 'Heaviest catch ever', species: 'Personal best' } as const;
const label = (t: { speciesId: number; weight: number }): string => `${SPECIES[t.speciesId]?.name ?? 'Fish'} ${fmtWeight(t.weight)}`;

interface FrameOpts {
  /** Extra classes: selected, a target for a replacement, just hung. */
  cls?: string;
  onclick?: () => void;
  /** What a click does, for assistive technology. */
  action?: string;
}

/** One frame of the room. Without `onclick` it is a picture, as in somebody else's room. */
export function frame(t: Trophy | null, slot: number, o: FrameOpts = {}): HTMLElement {
  const n = slot + 1;
  if (!t) {
    return h(
      o.onclick ? 'button' : 'div',
      { class: `frame empty ${o.cls ?? ''}`, attrs: o.onclick ? { type: 'button', 'aria-label': `Frame ${n}, empty. ${o.action ?? 'Add trophy'}` } : { 'aria-label': `Frame ${n}, empty` }, onclick: o.onclick },
      h('span', { class: 'frame-no', text: String(n) }),
      h('span', { class: 'frame-hole', attrs: { 'aria-hidden': 'true' }, text: '+' }),
      o.onclick ? h('span', { class: 'frame-add', text: o.action ?? 'Add trophy' }) : h('span', { class: 'muted small', text: 'Empty frame' }),
    );
  }
  const sp = SPECIES[t.speciesId];
  return h(
    o.onclick ? 'button' : 'div',
    {
      class: `frame ${RARITY_CLASS[t.rarity]} ${o.cls ?? ''}`,
      attrs: o.onclick
        ? { type: 'button', 'aria-label': `Frame ${n}: ${sp.name}, ${RARITY_NAMES[t.rarity]}, ${fmtWeight(t.weight)}, quality ${t.quality}. ${o.action ?? ''}` }
        : { 'aria-label': `Frame ${n}: ${sp.name}, ${RARITY_NAMES[t.rarity]}, ${fmtWeight(t.weight)}, quality ${t.quality}` },
      onclick: o.onclick,
    },
    h('span', { class: 'frame-no', text: String(n) }),
    fishArt(t.speciesId, { cls: 'frame-art' }),
    h(
      'span',
      { class: 'frame-plate' },
      h('span', { class: 'frame-name', text: sp.name }),
      h('span', { class: 'item-tags' }, rarityTag(t.rarity), qualityTag(t.quality), h('span', { class: 'frame-weight', text: fmtWeight(t.weight) })),
      h('span', { class: 'frame-where', title: `Caught in ${LOCATIONS[t.locationId]?.name ?? 'unknown waters'} on ${catchDate(t.caughtAt)}`, text: `${LOCATIONS[t.locationId]?.name ?? ''} · ${catchDate(t.caughtAt)}` }),
      t.record ? h('span', { class: 'frame-record', text: `★ ${RECORD_LABEL[t.record]}` }) : null,
    ),
  );
}

// ------------------------------------------------------------------ the player's own room

type Sort = 'date' | 'rarity' | 'weight' | 'value';
const SORTS: [Sort, string][] = [
  ['date', 'Newest'],
  ['rarity', 'Rarity'],
  ['weight', 'Weight'],
  ['value', 'Value'],
];

const ui = {
  sort: 'date' as Sort,
  /** The frame whose actions are open. */
  selected: null as number | null,
  /** The frame a fish is being chosen for. */
  picking: null as number | null,
  /** The fish waiting for the player to say which trophy it replaces (the room is full). */
  placing: null as string | null,
  /** The frame that was just filled: it plays the hanging animation once. */
  fresh: null as number | null,
};
let freshTimer = 0;

/** Part of the Trophies tab's render signature. */
export const roomSig = (): unknown => ui;

function hung(slot: number): void {
  ui.fresh = slot;
  ui.selected = null;
  ui.picking = null;
  ui.placing = null;
  window.clearTimeout(freshTimer);
  freshTimer = window.setTimeout(() => {
    ui.fresh = null;
    emit();
  }, 900);
  emit();
}

/**
 * Hangs a fish from anywhere in the game (the Saved Fish, the catch card). With a free frame it is done at once;
 * with a full room the player is asked, in the room, which trophy it replaces: 'choose'.
 */
export function addToRoom(id: string): 'hung' | 'choose' | 'refused' {
  const s = getSave();
  const f = s.fish.find((x) => x.id === id);
  if (!f) return 'refused';
  if (slotOf(s.showcase, id) >= 0) {
    toast('This fish is already on display', 'info');
    return 'refused';
  }
  if (freeSlot(s.showcase) < 0) {
    ui.placing = id;
    ui.picking = null;
    ui.selected = null;
    emit();
    return 'choose';
  }
  const done = ops.showcaseFish(id);
  if (!done) return 'refused';
  hung(done.slot);
  toast(`${label(f)} hangs in frame ${done.slot + 1} of your Trophy Room`, 'ok');
  return 'hung';
}

/** Brings the room into view: it is where a replacement is chosen. */
export function showRoom(): void {
  window.dispatchEvent(new CustomEvent('fishing:open-tab', { detail: 'trophy' }));
}

function place(id: string, slot: number): void {
  const before = getSave();
  const f = before.fish.find((x) => x.id === id);
  const done = ops.showcaseFish(id, slot);
  if (!done || !f) return;
  const old = done.replaced ? before.fish.find((x) => x.id === done.replaced) : undefined;
  hung(done.slot);
  toast(old ? `${label(f)} replaces ${label(old)}, which stays in your Saved Fish` : `${label(f)} hangs in frame ${done.slot + 1}`, 'ok');
}

const by: Record<Sort, (a: FishInstance, b: FishInstance) => number> = {
  date: (a, b) => b.caughtAt - a.caughtAt,
  rarity: (a, b) => b.rarity - a.rarity || b.weight - a.weight,
  weight: (a, b) => b.weight - a.weight,
  value: (a, b) => b.sellPrice - a.sellPrice,
};

/** On the contracts the room belongs to an account: with nobody signed in there is nothing to hang and nowhere to keep it. */
const isGuest = (): boolean => CHAIN && !state.wallet;

function roomSection(s: Save, rerender: () => void): HTMLElement {
  const frames = trophiesOf(s);
  const count = shownCount(s.showcase);
  if (isGuest()) {
    return h(
      'section',
      { class: 'room', attrs: { 'aria-label': 'My Trophy Room' } },
      h('div', { class: 'dex-head' }, h('h3', { text: 'My Trophy Room' }), h('span', { class: 'badge', text: `0/${SHOWCASE_SLOTS} frames` })),
      h('p', { class: 'muted small', text: 'Six frames for the catches that matter to you. Sign in, catch a fish, and hang it here.' }),
      h('div', { class: 'room-grid' }, frames.map((_, i) => frame(null, i))),
    );
  }
  const placing = ui.placing ? s.fish.find((f) => f.id === ui.placing) : undefined;
  if (ui.placing && (!placing || isShowcased(s, ui.placing))) ui.placing = null;
  if (ui.selected !== null && !frames[ui.selected]) ui.selected = null;
  const picked = ui.selected !== null ? frames[ui.selected] : null;

  const grid = h(
    'div',
    { class: `room-grid${placing ? ' placing' : ''}` },
    frames.map((t, i) => {
      const cls = `${ui.fresh === i ? 'just-set ' : ''}${ui.selected === i || ui.picking === i ? 'sel ' : ''}${placing ? 'target' : ''}`;
      if (placing) return frame(t, i, { cls, action: t ? `Replace with ${label(placing)}` : 'Hang here', onclick: () => place(placing.id, i) });
      if (!t) {
        return frame(null, i, {
          cls,
          onclick: () => {
            ui.picking = ui.picking === i ? null : i;
            ui.selected = null;
            rerender();
          },
        });
      }
      return frame(t, i, {
        cls,
        action: 'Open its actions',
        onclick: () => {
          ui.selected = ui.selected === i ? null : i;
          ui.picking = null;
          rerender();
        },
      });
    }),
  );

  let below: HTMLElement | null = null;
  if (placing) {
    below = h(
      'div',
      { class: 'room-bar', attrs: { role: 'status' } },
      h('span', null, h('b', { text: 'The room is full. ' }), `Choose the trophy that ${label(placing)} replaces. It goes back to your Saved Fish and stays protected.`),
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'btn btn-sm btn-ghost',
        text: 'Cancel',
        attrs: { type: 'button' },
        onclick: () => {
          ui.placing = null;
          rerender();
        },
      }),
    );
  } else if (ui.picking !== null) {
    below = picker(s, ui.picking, rerender);
  } else if (picked && ui.selected !== null) {
    const i = ui.selected;
    const move = (to: number): void => {
      if (ops.moveTrophy(i, to)) ui.selected = to;
      rerender();
    };
    below = h(
      'div',
      { class: 'room-bar' },
      h('span', null, h('b', { text: `Frame ${i + 1} · ` }), label(picked)),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn btn-sm btn-ghost', text: '◀ Move', disabled: i === 0, attrs: { type: 'button', 'aria-label': 'Move one frame back' }, onclick: () => move(i - 1) }),
      h('button', { class: 'btn btn-sm btn-ghost', text: 'Move ▶', disabled: i === SHOWCASE_SLOTS - 1, attrs: { type: 'button', 'aria-label': 'Move one frame forward' }, onclick: () => move(i + 1) }),
      h('button', {
        class: 'btn btn-sm',
        text: 'Replace',
        attrs: { type: 'button' },
        onclick: () => {
          ui.picking = i;
          rerender();
        },
      }),
      h('button', {
        class: 'btn btn-sm',
        text: 'Take down',
        title: 'Leaves the frame empty. The fish stays in your Saved Fish, protected from selling',
        attrs: { type: 'button' },
        onclick: () => {
          if (ops.unshowcaseFish(picked.id)) toast(`${label(picked)} is back in your Saved Fish, still protected`, 'info');
          ui.selected = null;
          rerender();
        },
      }),
    );
  }

  return h(
    'section',
    { class: 'room', attrs: { 'aria-label': 'My Trophy Room' } },
    h('div', { class: 'dex-head' }, h('h3', { text: 'My Trophy Room' }), h('span', { class: `badge${count ? ' badge-on' : ''}`, text: `${count}/${SHOWCASE_SLOTS} frames` })),
    h('p', {
      class: 'muted small',
      text: count
        ? 'Six frames for the catches that matter to you, in your order. A fish on display is saved: no Sell button takes it. Tap a frame to move, replace or take it down.'
        : 'Six frames for the catches that matter to you: not the most expensive ones, the ones you choose. Tap a frame to hang a fish. A fish on display is saved: no Sell button takes it.',
    }),
    grid,
    below,
  );
}

/** Choosing a fish for a frame: everything in the keepnet that is not on display, the saved ones first. */
function picker(s: Save, slot: number, rerender: () => void): HTMLElement {
  const current = s.showcase[slot] ? s.fish.find((f) => f.id === s.showcase[slot]) : undefined;
  const list = s.fish.filter((f) => !isShowcased(s, f.id)).sort((a, b) => Number(b.isFavorite) - Number(a.isFavorite) || by.rarity(a, b));
  const close = (): void => {
    ui.picking = null;
    rerender();
  };
  return h(
    'div',
    { class: 'room-pick' },
    h(
      'div',
      { class: 'room-bar' },
      h('span', null, h('b', { text: current ? `Replace ${label(current)} in frame ${slot + 1}` : `Choose a fish for frame ${slot + 1}` }), current ? '. It stays in your Saved Fish.' : ''),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn btn-sm btn-ghost', text: 'Cancel', attrs: { type: 'button' }, onclick: close }),
    ),
    list.length === 0
      ? h('p', { class: 'empty', text: s.fish.length ? 'Every fish in your keepnet is already on display.' : 'Your keepnet is empty. Catch a fish and it can hang here.' })
      : h(
          'div',
          { class: 'grid pick-grid' },
          list.map((f) =>
            h(
              'button',
              { class: `item ${RARITY_CLASS[f.rarity]}`, attrs: { type: 'button', 'aria-label': `Hang ${label(f)} in frame ${slot + 1}` }, onclick: () => place(f.id, slot) },
              fishArt(f.speciesId),
              h('span', { class: 'item-name', text: SPECIES[f.speciesId].name }),
              h('span', { class: 'item-tags' }, rarityTag(f.rarity), qualityTag(f.quality)),
              h('span', { class: 'item-meta' }, h('span', { text: fmtWeight(f.weight) }), f.isFavorite ? h('span', { class: 'saved-mark', text: '★ Saved' }) : null),
            ),
          ),
        ),
  );
}

function savedSection(s: Save, rerender: () => void): HTMLElement {
  const list = s.fish.filter((f) => f.isFavorite).sort(by[ui.sort]);
  const now = Date.now();
  const full = freeSlot(s.showcase) < 0;
  return h(
    'section',
    { class: 'saved', attrs: { 'aria-label': 'Saved Fish' } },
    h(
      'div',
      { class: 'dex-head' },
      h('h3', { text: 'Saved Fish' }),
      h('span', { class: 'badge', text: String(list.length) }),
      h('div', { class: 'spacer' }),
      list.length > 1 ? dropdown({ label: 'Sort', value: ui.sort, small: true, options: SORTS.map(([value, text]) => ({ value, label: text })), onPick: (v) => ((ui.sort = v as Sort), rerender()) }) : null,
    ),
    h('p', {
      class: 'muted small',
      text: `Every fish you starred. Saved fish are skipped by Sell all and cannot be picked for a sale until you remove the star.${
        CHAIN ? ' The star is kept in this browser for this account. It does not lock the NFT: outside the game a fish can still be transferred or traded.' : ''
      }`,
    }),
    list.length === 0
      ? h('p', { class: 'empty', text: isGuest() ? 'Sign in to see the fish you saved.' : 'No saved fish yet. Tap ☆ Save on a fish in the Keepnet, or on the card of a fresh catch.' })
      : h(
          'div',
          { class: 'grid saved-grid' },
          list.map((f) => {
            const slot = slotOf(s.showcase, f.id);
            const shown = slot >= 0;
            return h(
              'div',
              { class: `item ${RARITY_CLASS[f.rarity]}${shown ? ' shown' : ''}` },
              fishArt(f.speciesId),
              h('span', { class: 'item-name', text: SPECIES[f.speciesId].name }),
              h('span', { class: 'item-tags' }, rarityTag(f.rarity), qualityTag(f.quality), f.isSpecial ? h('span', { class: 'badge', text: 'Special' }) : null),
              h('span', { class: 'item-meta' }, h('span', { text: fmtWeight(f.weight) }), h('span', { class: 'pearl', text: `${pearl(saleValue(f, now))} P` })),
              h('span', { class: 'muted small', text: `${LOCATIONS[f.locationId]?.name ?? ''} · ${ago(f.caughtAt)}` }),
              shown ? h('span', { class: 'saved-mark', text: `On display · frame ${slot + 1}` }) : null,
              shown
                ? h('button', { class: 'btn btn-sm', text: 'Take down', attrs: { type: 'button' }, onclick: () => void ops.unshowcaseFish(f.id) })
                : h('button', {
                    class: 'btn btn-sm btn-primary',
                    text: 'Add to Trophy Room',
                    title: full ? 'The room is full: you will choose which trophy it replaces' : undefined,
                    attrs: { type: 'button' },
                    onclick: () => {
                      if (addToRoom(f.id) !== 'refused') document.querySelector('.room')?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
                    },
                  }),
              h('button', {
                class: 'btn btn-sm btn-ghost',
                text: '★ Remove star',
                title: shown ? 'Take it down from the Trophy Room first' : 'It can be sold again',
                attrs: { type: 'button' },
                // a fish on display is refused by the rules, with the reason as a message
                onclick: () => void ops.toggleFavorite(f.id),
              }),
            );
          }),
        ),
  );
}

export function renderRoom(rerender: () => void): HTMLElement[] {
  const s = getSave();
  return [roomSection(s, rerender), savedSection(s, rerender)];
}

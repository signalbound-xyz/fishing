/**
 * Keepnet: the fish you hold. Sort, filter, save the ones that matter (the star: a saved fish hangs in the Trophy
 * Room and no Sell button takes it), sell one, several, or everything that is not protected.
 */
import { bulkSellable, isFresh, isValuable, saleValue } from '../../game/actions';
import { LOCATIONS, SPECIES } from '../../game/content';
import type { FishInstance } from '../../game/types';
import { RARITY_CLASS, RARITY_NAMES } from '../../i18n';
import { fmtWeight, h, mount, sigOf } from '../../ui/dom';
import { dropdown } from '../../ui/dropdown';
import { toast } from '../../ui/toast';
import { fishArt } from '../fishSprite';
import { ops } from '../ops';
import { showRoom } from './trophyRoom';
import { getSave, rev } from '../state';
import { ago, pearl, qualityTag, rarityTag } from './fmt';

type Sort = 'date' | 'rarity' | 'weight' | 'value';
const SORTS: [Sort, string][] = [
  ['date', 'Newest'],
  ['value', 'Value'],
  ['rarity', 'Rarity'],
  ['weight', 'Weight'],
];
const ui = { sort: 'date' as Sort, rarity: -1, location: -1 };
const selected = new Set<string>();
/** What the armed confirm button is about to sell, as a signature of ids. */
let confirming: string | null = null;

export function initKeepnet(host: HTMLElement): () => void {
  const rerender = mount(
    host,
    () => sigOf(rev(), ui, [...selected], confirming),
    () => render(rerender),
  );
  return rerender;
}

function sorted(list: FishInstance[]): FishInstance[] {
  const by: Record<Sort, (a: FishInstance, b: FishInstance) => number> = {
    date: (a, b) => b.caughtAt - a.caughtAt,
    value: (a, b) => b.sellPrice - a.sellPrice,
    rarity: (a, b) => b.rarity - a.rarity || b.sellPrice - a.sellPrice,
    weight: (a, b) => b.weight - a.weight,
  };
  return [...list].sort(by[ui.sort]);
}

function select<T extends string | number>(label: string, value: T, options: [T, string][], onPick: (v: string) => void): HTMLElement {
  return dropdown({ label, value: String(value), small: true, options: options.map(([v, text]) => ({ value: String(v), label: text })), onPick });
}

function render(rerender: () => void): HTMLElement[] {
  const s = getSave();
  for (const id of [...selected]) if (!s.fish.some((f) => f.id === id && bulkSellable(f))) selected.delete(id);

  const shown = sorted(s.fish.filter((f) => (ui.rarity < 0 || f.rarity === ui.rarity) && (ui.location < 0 || f.locationId === ui.location)));
  const eligible = shown.filter(bulkSellable);
  const picked = s.fish.filter((f) => selected.has(f.id));
  const now = Date.now();
  const worth = (f: FishInstance): number => saleValue(f, now);
  const pickedValue = picked.reduce((a, f) => a + worth(f), 0);
  const allValue = s.fish.reduce((a, f) => a + worth(f), 0);
  const eligibleValue = eligible.reduce((a, f) => a + worth(f), 0);

  /** Sells `list`; a sale that includes valuable fish needs a second click on the same button. */
  const sell = (list: FishInstance[], key: string): void => {
    const ids = list.map((f) => f.id);
    const sig = `${key}:${ids.join(',')}`;
    if (list.some(isValuable) && confirming !== sig) {
      confirming = sig;
      rerender();
      return;
    }
    confirming = null;
    rerender();
    void ops.sellFish(ids).then((earned) => {
      if (earned === undefined) return;
      ids.forEach((id) => selected.delete(id));
      toast(`Sold ${ids.length} fish for ${pearl(earned)} PEARL`, 'ok');
      rerender();
    });
  };
  const armed = (key: string, list: FishInstance[]): boolean => confirming === `${key}:${list.map((f) => f.id).join(',')}`;
  const valuableIn = (list: FishInstance[]): number => list.filter(isValuable).length;

  const rarities = [...new Set(s.fish.map((f) => f.rarity))].sort();
  const locs = [...new Set(s.fish.map((f) => f.locationId))].sort();
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h('span', { class: 'muted', text: `Fish: ${s.fish.length} · worth ${pearl(allValue)} PEARL` }),
    h('div', { class: 'spacer' }),
    select('Sort', ui.sort, SORTS, (v) => ((ui.sort = v as Sort), rerender())),
    select('Rarity', ui.rarity, [[-1, 'All rarities'], ...rarities.map((r) => [r, RARITY_NAMES[r]] as [number, string])], (v) => ((ui.rarity = Number(v)), rerender())),
    select('Location', ui.location, [[-1, 'All locations'], ...locs.map((l) => [l, LOCATIONS[l].name] as [number, string])], (v) => ((ui.location = Number(v)), rerender())),
  );
  const actions = h(
    'div',
    { class: 'toolbar' },
    h('button', {
      class: 'btn btn-ghost btn-sm',
      disabled: eligible.length === 0,
      text: eligible.length > 0 && eligible.every((f) => selected.has(f.id)) ? 'Deselect all' : 'Select all',
      onclick: () => {
        if (eligible.every((f) => selected.has(f.id))) eligible.forEach((f) => selected.delete(f.id));
        else eligible.forEach((f) => selected.add(f.id));
        confirming = null;
        rerender();
      },
    }),
    h('div', { class: 'spacer' }),
    h('button', {
      class: `btn btn-sm${armed('sel', picked) ? ' btn-danger' : ' btn-primary'}`,
      disabled: picked.length === 0,
      text: armed('sel', picked) ? `Confirm: ${valuableIn(picked)} valuable fish` : `Sell selected (${picked.length}) · ${pearl(pickedValue)}`,
      onclick: () => sell(picked, 'sel'),
    }),
    h('button', {
      class: `btn btn-sm${armed('all', eligible) ? ' btn-danger' : ''}`,
      disabled: eligible.length === 0,
      title: 'Sells every fish shown here except your favorites (★, the fish in your Trophy Room) and special fish',
      text: armed('all', eligible) ? `Confirm: ${valuableIn(eligible)} valuable fish` : `Sell all (${eligible.length}) · ${pearl(eligibleValue)}`,
      onclick: () => sell(eligible, 'all'),
    }),
  );
  if (s.fish.length === 0) return [toolbar, h('p', { class: 'empty', text: 'Your keepnet is empty. Go cast a line!' })];
  const savedCount = s.fish.filter((f) => f.isFavorite).length;
  // said in words, next to the buttons it changes: on a phone there is no hover to explain a star
  const about = h(
    'p',
    { class: 'save-hint' },
    h('span', { class: 'save-hint-star', attrs: { 'aria-hidden': 'true' }, text: '★' }),
    h('span', null, 'Save your favorite catches to protect them from selling.', savedCount ? ` ${savedCount} in your Trophy Room: Sell all skips ${savedCount === 1 ? 'it' : 'them'}.` : ' Tap ☆ Save on a fish and it hangs in your Trophy Room.'),
    h('div', { class: 'spacer' }),
    h('button', { class: 'link', text: savedCount ? `My Trophy Room (${savedCount}) →` : 'My Trophy Room →', attrs: { type: 'button' }, onclick: showRoom }),
  );

  const grid = h(
    'div',
    { class: 'grid' },
    shown.map((f) => {
      const sp = SPECIES[f.speciesId];
      const can = bulkSellable(f);
      const on = selected.has(f.id);
      const why = f.isFavorite ? 'In your Trophy Room: protected from selling' : f.isSpecial ? 'Special fish: sold one at a time from the Trophies tab' : '';
      const card = h(
        'div',
        {
          class: `item pick ${on ? 'sel' : ''} ${RARITY_CLASS[f.rarity]}${can ? '' : ' kept'}${f.isFavorite ? ' saved' : ''}`,
          title: `${LOCATIONS[f.locationId].name} · ${ago(f.caughtAt)} · ${f.tournamentScore} pts${why ? ` · ${why}` : ''}`,
          attrs: { role: 'checkbox', 'aria-checked': String(on), 'aria-disabled': String(!can), tabindex: '0', 'aria-label': `${sp.name}, ${fmtWeight(f.weight)}, ${pearl(worth(f))} PEARL${why ? `. ${why}` : ''}` },
          onclick: () => {
            if (!can) {
              // a tap on a protected fish says why nothing happened
              toast(f.isFavorite ? 'This fish is in your Trophy Room. Tap ★ Saved to remove it from your favorites, then it can be sold.' : 'Special fish are sold one at a time, from the Trophies tab.', 'info');
              return;
            }
            if (on) selected.delete(f.id);
            else selected.add(f.id);
            confirming = null;
            rerender();
          },
        },
        fishArt(f.speciesId),
        h('span', { class: 'item-name', text: sp.name }),
        h('span', { class: 'item-tags' }, rarityTag(f.rarity), qualityTag(f.quality), f.isSpecial ? h('span', { class: 'badge', text: 'Special' }) : null),
        h('span', { class: 'item-meta' }, h('span', { text: fmtWeight(f.weight) }), h('span', { class: 'pearl', text: `${pearl(worth(f))} P${isFresh(f, now) ? ' · fresh' : ''}`, title: isFresh(f, now) ? `Fresh catch: +20% for 10 minutes after landing, then ${pearl(f.sellPrice)}` : '' })),
        f.isFavorite ? h('span', { class: 'saved-mark', text: 'In Trophy Room · not for sale' }) : null,
        h('button', {
          class: `save-btn on-art${f.isFavorite ? ' on' : ''}`,
          text: f.isFavorite ? '★ Saved' : '☆ Save',
          title: f.isFavorite ? 'In your Trophy Room, protected from selling. Tap to remove it from your favorites' : 'Save this fish to your Trophy Room: no Sell button will take it',
          attrs: { type: 'button', 'aria-pressed': String(f.isFavorite), 'aria-label': f.isFavorite ? `${sp.name}: saved, in your Trophy Room. Remove from favorites` : `Save ${sp.name} to your Trophy Room` },
          onclick: (e) => {
            e.stopPropagation();
            selected.delete(f.id);
            ops.toggleFavorite(f.id);
          },
        }),
        on ? h('span', { class: 'check', text: '✓' }) : null,
      );
      card.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === card) {
          e.preventDefault();
          card.click();
        }
      });
      return card;
    }),
  );
  return [toolbar, actions, about, shown.length ? grid : h('p', { class: 'empty', text: 'No fish match these filters.' })];
}

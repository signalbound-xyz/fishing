/**
 * The Tackle page: rods and reusable lures, with a loadout estimate per location. In the local game it is the
 * shop (buy, equip, repair). With `shop` off (the onchain client, whose contracts know rod levels and bait only)
 * it stays a preview.
 */
import { activeSpecialOf, rodRepairPrice } from '../game/actions';
import { LOCATIONS, PEARL_PER_BLEND } from '../game/content';
import { itemEffects, spotEffects, totals } from '../game/equipment';
import { greenWidth } from '../game/minigame';
import { isUnlocked } from '../game/progress';
import type { Effects as Fx } from '../game/types';
import { openFluentConnect } from '../fluent';
import { RARITY_CLASS, RARITY_NAMES } from '../i18n';
import { EXCHANGE_DEPLOYED, world } from '../play/chain';
import { CHAIN, ops } from '../play/ops';
import { emit, state } from '../store';
import { getSave, rev } from '../play/state';
import { h, icon, mount, setTip, sigOf } from '../ui/dom';
import { LURES, RODS, lureById, rodById, type Effects, type TackleItem } from './catalog';
import { lureSprite, rodSprite } from './sprites';

/** What the loadout card previews: starts as the equipped tackle at the current location. */
const view: { rod: string | null; lure: string | null | undefined; spot: number | null } = { rod: null, lure: undefined, spot: null };

const sign = (n: number): string => (n > 0 ? `+${n}` : String(n));
const pearl = (n: number): string => n.toLocaleString('en-US');

/** One stat row: label, a 10-segment bar scaled to `max`, and the value. */
function statRow(label: string, value: number, max: number, suffix: string, cls: string): HTMLElement {
  const segs = 10;
  const on = value <= 0 ? 0 : Math.max(1, Math.min(segs, Math.round((value / max) * segs)));
  return h(
    'div',
    { class: 'tk-stat' },
    h('span', { class: 'tk-stat-k', text: label }),
    h(
      'span',
      { class: `segbar tk-bar ${cls}`, attrs: { 'aria-hidden': 'true' } },
      Array.from({ length: segs }, (_, i) => h('span', { class: i < on ? 'seg on' : 'seg' })),
    ),
    h('span', { class: value ? 'tk-stat-v' : 'tk-stat-v dim', text: value ? `${sign(value)}${suffix}` : '—' }),
  );
}

function effectRows(e: Effects): HTMLElement[] {
  return [
    statRow('Catch', e.catch ?? 0, 10, '', 'tk-catch'),
    statRow('Rarity', e.rarity ?? 0, 150, '', 'tk-rarity'),
    statRow('Weight', e.weight ?? 0, 20, '%', 'tk-weight'),
  ];
}

/** "+3 catch, +15 rarity" */
const effectText = (e: Effects): string => [e.catch ? `${sign(e.catch)} catch` : '', e.rarity ? `${sign(e.rarity)} rarity` : '', e.weight ? `${sign(e.weight)}% weight` : ''].filter(Boolean).join(', ');

function spotLine(item: TackleItem): HTMLElement | null {
  const s = item.spot;
  if (!s) return null;
  const parts = effectText(s);
  return h(
    'div',
    { class: 'tk-spot' },
    h('span', { class: 'tk-spot-k', text: `Bonus ${s.label}` }),
    h('span', { class: 'tk-spot-v', text: parts }),
    h(
      'span',
      { class: 'tk-chips' },
      s.spots.map((i) => h('span', { class: 'tk-chip', text: LOCATIONS[i].name })),
    ),
  );
}

/** "vs your Willow Rod here: +9 catch, +20 rarity" */
function versus(item: TackleItem, current: TackleItem | undefined, spot: number): HTMLElement | null {
  if (!current || current.id === item.id) return null;
  const a = itemEffects(item, LOCATIONS[spot]);
  const b = itemEffects(current, LOCATIONS[spot]);
  const d: Fx = { catch: a.catch - b.catch, rarity: a.rarity - b.rarity, weight: a.weight - b.weight };
  const parts = [d.catch ? `${sign(d.catch)} catch` : '', d.rarity ? `${sign(d.rarity)} rarity` : '', d.weight ? `${sign(d.weight)}% weight` : ''].filter(Boolean);
  const better = d.catch + d.rarity / 10 + d.weight;
  return h('div', { class: `tk-vs ${better > 0 ? 'up' : better < 0 ? 'down' : ''}`, text: `vs your ${current.name} at ${LOCATIONS[spot].name}: ${parts.length ? parts.join(', ') : 'the same'}` });
}

/**
 * The shop action on its way, e.g. "buy:rod:carbon". On the contracts it is a transaction: its button says so and
 * every other action waits, because a second click would send a second transaction and fail.
 */
let pending: string | null = null;

function run(key: string, op: () => Promise<unknown>): void {
  if (pending) return;
  pending = key;
  emit();
  void op().finally(() => {
    pending = null;
    emit();
  });
}

interface ButtonOpts {
  primary?: boolean;
  title?: string;
  disabled?: boolean;
  /** With `busy`: the action's key and what the button says while it is on its way. */
  key?: string;
  busy?: string;
}

function button(text: string, onclick: (() => void) | null, opts: ButtonOpts = {}): HTMLElement {
  const mine = pending !== null && pending === opts.key;
  return h('button', {
    class: `btn btn-sm${opts.primary ? ' btn-primary' : ''}${mine ? ' busy' : ''}`,
    text: mine ? opts.busy ?? text : text,
    title: mine ? 'Waiting for the transaction' : pending ? 'Another action is on its way' : opts.title,
    disabled: pending !== null || (opts.disabled ?? !onclick),
    attrs: mine ? { 'aria-busy': 'true' } : undefined,
    onclick: (e) => {
      e.stopPropagation();
      onclick?.();
    },
  });
}

/** On the contracts the tackle belongs to an account: with nobody signed in the shop is a showcase. */
const isGuest = (): boolean => CHAIN && !state.wallet;

function actions(item: TackleItem, shop: boolean): HTMLElement[] {
  if (isGuest()) return item.price ? [button('Sign in to buy', openFluentConnect, { title: 'Connect with Fluent to buy and equip tackle' })] : [];
  if (!shop) return [button('Soon', null, { title: 'Not onchain yet: rod types and lures need a contract update' })];
  const s = getSave();
  const short = s.pearl < item.price;
  const shortTitle = short ? `You need ${pearl(Math.ceil(item.price - s.pearl))} more PEARL` : undefined;
  const key = (what: string): string => `${what}:${item.kind}:${item.id}`;
  if (item.kind === 'rod') {
    if (!s.rods[item.id]) {
      return [button(`Buy · ${pearl(item.price)}`, () => ((view.rod = item.id), run(key('buy'), () => ops.buyRod(item.id))), { primary: true, disabled: short, title: shortTitle, key: key('buy'), busy: 'Buying…' })];
    }
    const repair = rodRepairPrice(s, item.id);
    const own = s.rods[item.id];
    const repairTitle =
      s.pearl < repair
        ? `Not enough PEARL: the repair costs ${pearl(repair)}, you have ${pearl(Math.floor(s.pearl))}. Sell fish to earn ${pearl(Math.ceil(repair - s.pearl))} more.`
        : `Restores durability from ${own.durability} to ${item.wear}`;
    return [
      repair > 0 ? button(`Repair · ${pearl(repair)}`, () => run(key('repair'), () => ops.repairRod(item.id)), { disabled: s.pearl < repair, title: repairTitle, key: key('repair'), busy: 'Repairing…' }) : null,
      s.equipped.rod === item.id
        ? button('Equipped', null, { title: 'You are fishing with this rod' })
        : button('Equip', () => ((view.rod = item.id), run(key('equip'), () => ops.equipRod(item.id))), { primary: true, key: key('equip'), busy: 'Equipping…' }),
    ].filter((x): x is HTMLElement => !!x);
  }
  const own = s.lures[item.id];
  if (!own) {
    return [button(`Buy · ${pearl(item.price)}`, () => ((view.lure = item.id), run(key('buy'), () => ops.buyLure(item.id))), { primary: true, disabled: short, title: shortTitle, key: key('buy'), busy: 'Buying…' })];
  }
  return [
    button(`+${item.wear} casts · ${pearl(item.price)}`, () => run(key('buy'), () => ops.buyLure(item.id)), { disabled: short, title: shortTitle ?? 'Adds casts to the lure you already carry', key: key('buy'), busy: 'Buying…' }),
    s.equipped.lure === item.id
      ? button('Take off', () => ((view.lure = null), run(key('off'), () => ops.equipLure(null))), { key: key('off'), busy: 'Taking off…' })
      : button('Equip', () => ((view.lure = item.id), run(key('equip'), () => ops.equipLure(item.id))), { primary: true, key: key('equip'), busy: 'Equipping…' }),
  ];
}

/** `onPick` null: nothing to preview the item in (a visitor sees no loadout), so the card is not a button. */
function card(item: TackleItem, selected: boolean, onPick: (() => void) | null, shop: boolean, spot: number): HTMLElement {
  const s = getSave();
  const sprite = item.kind === 'rod' ? rodSprite(item.id, item.name) : lureSprite(item.id, item.name);
  const owned = item.kind === 'rod' ? s.rods[item.id] : s.lures[item.id];
  const equipped = shop && (item.kind === 'rod' ? s.equipped.rod === item.id : s.equipped.lure === item.id);
  let wear: string;
  if (item.kind === 'rod') wear = item.wear === 0 ? 'Never wears out' : shop && s.rods[item.id] ? `${s.rods[item.id].durability}/${item.wear} durability` : `${item.wear} durability · ${pearl(item.repair ?? 0)} PEARL to mend`;
  else wear = shop && s.lures[item.id] ? `${s.lures[item.id].casts} casts left` : `${item.wear} casts`;
  const current = item.kind === 'rod' ? rodById(s.equipped.rod) : lureById(s.equipped.lure);
  return h(
    'article',
    {
      class: `tk-card ${RARITY_CLASS[item.tier]}${selected ? ' sel' : ''}${shop && owned ? ' owned' : ''}`,
      attrs: onPick ? { tabindex: '0', role: 'button', 'aria-pressed': String(selected), 'aria-label': `${item.name}: preview in the loadout` } : undefined,
      onclick: onPick ?? undefined,
    },
    h(
      'div',
      { class: 'tk-card-top' },
      h('div', { class: 'tk-well' }, sprite),
      h(
        'div',
        { class: 'tk-head' },
        h('span', { class: 'tk-tags' }, h('span', { class: `rarity ${RARITY_CLASS[item.tier]}`, text: RARITY_NAMES[item.tier] }), equipped ? h('span', { class: 'badge badge-on', text: 'Equipped' }) : shop && owned ? h('span', { class: 'badge', text: 'Owned' }) : null),
        h('h4', { class: 'tk-name', text: item.name }),
        h('p', { class: 'tk-blurb', text: item.blurb }),
      ),
    ),
    h('div', { class: 'tk-stats' }, effectRows(item.base)),
    spotLine(item),
    h(
      'ul',
      { class: 'tk-perks' },
      item.pros.map((p) => h('li', { class: 'pro', text: p })),
      item.cons.map((c) => h('li', { class: 'con', text: c })),
    ),
    shop ? versus(item, current, spot) : null,
    h(
      'div',
      { class: 'tk-foot' },
      h('span', { class: 'tk-wear', text: wear }),
      h('span', { class: 'tk-price' }, item.price ? h('span', { class: 'pearl', text: `${pearl(item.price)} PEARL` }) : h('span', { class: 'muted', text: 'Starter' })),
      h('span', { class: 'tk-acts' }, actions(item, shop)),
    ),
  );
}

function loadoutCard(rod: TackleItem, lure: TackleItem | null, spot: number, shop: boolean, rerender: () => void): HTMLElement {
  const s = getSave();
  const loc = LOCATIONS[spot];
  const special = shop ? activeSpecialOf(s) : null;
  const t = totals(rod, lure, loc, special);
  const eqRod = rodById(s.equipped.rod) ?? RODS[0];
  const eqLure = lureById(s.equipped.lure) ?? null;
  const base = totals(eqRod, eqLure, loc, special);
  const previewing = shop && (rod.id !== eqRod.id || (lure?.id ?? null) !== (eqLure?.id ?? null));
  const delta = (now: number, was: number, unit = ''): HTMLElement | null =>
    previewing && now !== was ? h('span', { class: `delta ${now > was ? 'up' : 'down'}`, text: ` ${sign(Math.round((now - was) * 10) / 10)}${unit}` }) : null;
  // what this water does to the chosen tackle: the numbers above move only by these
  const here = (item: TackleItem): HTMLElement => {
    const e = spotEffects(item, loc);
    const gain = e ? (e.catch ?? 0) + (e.rarity ?? 0) + (e.weight ?? 0) > 0 : false;
    const home = item.spot ? item.spot.spots.map((i) => LOCATIONS[i].name).join(', ') : '';
    return h(
      'li',
      { class: e ? (gain ? 'up' : 'down') : '' },
      h('strong', { text: item.name }),
      e ? h('span', { class: 'v', text: `${effectText(e)} in ${loc.name}` }) : h('span', { class: 'muted', text: item.spot ? `no bonus in ${loc.name} · its water: ${home}` : 'the same in every water' }),
    );
  };
  /** How a water treats the chosen pair: a bonus for the rod or the lure, only a penalty, or nothing. */
  const mark = (l: (typeof LOCATIONS)[number]): { cls: string; title: string } => {
    const lines = [rod, lure].flatMap((it) => {
      const e = it ? spotEffects(it, l) : null;
      return it && e ? [{ text: `${it.name}: ${effectText(e)}`, gain: (e.catch ?? 0) + (e.rarity ?? 0) + (e.weight ?? 0) > 0 }] : [];
    });
    if (!lines.length) return { cls: '', title: 'The chosen tackle has no bonus here' };
    return { cls: lines.some((x) => x.gain) ? ' boost' : ' drag', title: lines.map((x) => x.text).join(' · ') };
  };
  const marks = LOCATIONS.map(mark);
  const tile = (k: string, v: string, d: HTMLElement | null, hint: string): HTMLElement => h('div', { class: 'tk-big' }, h('span', { class: 'k', text: k }), h('span', { class: 'v' }, v, d), h('span', { class: 'd', text: hint }));
  return h(
    'section',
    { class: 'card tk-loadout', attrs: { 'aria-label': 'Loadout estimate' } },
    h(
      'div',
      { class: 'dex-head' },
      h('h3', { text: 'Loadout' }),
      previewing ? h('span', { class: 'badge', text: 'Preview · compared with your equipped tackle' }) : null,
    ),
    h(
      'div',
      { class: 'tk-lo-grid' },
      h(
        'div',
        { class: 'tk-lo-gear' },
        h('div', { class: 'tk-well sm' }, rodSprite(rod.id, rod.name, 2)),
        h('span', { class: 'tk-plus', text: '+' }),
        h('div', { class: 'tk-well sm' }, lure ? lureSprite(lure.id, lure.name, 3) : h('span', { class: 'muted small', text: 'no lure' })),
        h(
          'div',
          { class: 'tk-lo-names' },
          h('strong', { text: rod.name }),
          h('span', { class: 'muted', text: lure ? lure.name : 'No lure' }),
          special ? h('span', { class: 'muted small', text: `+ ${special.name}: ${special.bonus.label}` }) : null,
          previewing ? h('button', { class: 'btn btn-ghost btn-sm', text: 'Back to equipped', onclick: () => ((view.rod = null), (view.lure = undefined), rerender()) }) : null,
        ),
      ),
      h(
        'div',
        { class: 'tk-lo-spots', attrs: { role: 'radiogroup', 'aria-label': 'Location' } },
        LOCATIONS.map((l, i) => {
          const m = marks[i];
          return h(
            'button',
            {
              class: `tk-spotbtn${spot === l.id ? ' active' : ''}${m.cls}`,
              title: m.title,
              attrs: { role: 'radio', 'aria-checked': String(spot === l.id) },
              onclick: () => ((view.spot = l.id), rerender()),
            },
            shop && !isUnlocked(s, l) ? icon('lock', 'Locked') : null,
            l.name,
          );
        }),
        marks.some((m) => m.cls === ' boost') ? h('span', { class: 'tk-spot-legend', text: 'bonus for this tackle' }) : null,
        marks.some((m) => m.cls === ' drag') ? h('span', { class: 'tk-spot-legend drag', text: 'penalty' }) : null,
      ),
      h(
        'div',
        { class: 'tk-lo-out' },
        tile('Bite chance', `${t.biteChance}%`, delta(t.biteChance, base.biteChance), 'lure catch: more bites, sooner'),
        tile('Green zone', `${Math.round(greenWidth(t.zone) * 100)}%`, delta(Math.round(greenWidth(t.zone) * 100), Math.round(greenWidth(base.zone) * 100)), 'rod catch: wider safe tension band'),
        tile('Rare odds', t.total.rarity ? `+${t.total.rarity}` : '—', delta(t.total.rarity, base.total.rarity), 'weighting toward rarer fish'),
        tile('Fish weight', t.total.weight ? `+${t.total.weight}%` : '—', delta(t.total.weight, base.total.weight, '%'), 'heavier: more PEARL, more points'),
      ),
      h('ul', { class: 'tk-lo-here', attrs: { 'aria-label': `What ${loc.name} changes for this tackle` } }, here(rod), lure ? here(lure) : null),
    ),
    h('p', {
      class: 'tk-note',
      text: 'Rarity is a relative weighting, not percentage points: +100 makes a Rare fish three times as likely against a Common one. Bonuses add up: rod + lure + location bonus + active special fish.',
    }),
  );
}

/** In place of the wallet for a visitor who is not signed in: what the sign-in gives, and the way in. */
function signInCard(): HTMLElement {
  return h(
    'section',
    { class: 'card tk-signin', attrs: { 'aria-label': 'Sign in to shop' } },
    h(
      'div',
      { class: 'tk-signin-text' },
      h('h3', { text: 'Sign in to shop' }),
      h('p', { class: 'muted', text: 'Your PEARL, rods and lures belong to your account. Until you connect, the rods and lures below are open to browse.' }),
    ),
    h('button', { class: 'btn btn-primary btn-wallet', attrs: { type: 'button' }, onclick: openFluentConnect }, icon('bobber'), 'Connect with Fluent'),
  );
}

/** What the player typed into the exchange box; kept across re-renders. */
let blendInput = '';
let buyingPearl = false;

/**
 * The shop's wallet: the PEARL in hand on the left, and next to it the way to get more of it for BLEND (one way,
 * fixed rate). On the contracts that is the PearlExchange; locally, the bottle's BLEND. Without an exchange only
 * the balance is shown.
 */
function walletCard(rerender: () => void): HTMLElement {
  const s = getSave();
  const balanceTile = h(
    'div',
    { class: 'xc-wallet' },
    h('span', { class: 'xc-k', text: 'Your PEARL' }),
    // whole PEARL, rounded down: on the contracts a balance has a fraction (a price is base × weight × quality)
    h('span', { class: 'xc-balance pearl', text: pearl(Math.floor(s.pearl)), title: `${s.pearl.toLocaleString('en-US', { maximumFractionDigits: 4 })} PEARL` }),
    h('span', { class: 'muted small', text: 'pays for rods, lures, repairs and energy' }),
  );
  if (CHAIN && !EXCHANGE_DEPLOYED) return h('section', { class: 'card xc xc-solo', attrs: { 'aria-label': 'Your PEARL' } }, balanceTile);

  const balance = CHAIN ? (world.blend?.balance ?? 0) : s.blend;
  const rate = CHAIN ? (world.blend?.pearlPerBlend ?? PEARL_PER_BLEND) : PEARL_PER_BLEND;
  const paused = CHAIN && !!world.blend?.paused;
  const signedOut = CHAIN && !state.wallet;
  const amount = (): number => Number(blendInput.replace(',', '.')) || 0;
  const fmt = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  const out = h('span', { class: 'xc-out' });
  const buy = h('button', { class: 'btn btn-primary xc-buy' });
  const sync = (): void => {
    const a = amount();
    out.textContent = `${fmt(a * rate)} PEARL`;
    out.classList.toggle('zero', a <= 0);
    buy.textContent = buyingPearl ? 'Buying…' : a > 0 ? `Buy ${fmt(a * rate)} PEARL` : 'Buy PEARL';
    buy.disabled = buyingPearl || pending !== null || paused || signedOut || a <= 0 || a > balance;
    buy.classList.toggle('busy', buyingPearl);
    setTip(buy, signedOut ? 'Connect with Fluent first' : a > balance ? 'You do not have that much BLEND' : a <= 0 ? 'Enter how much BLEND to spend' : '');
  };
  const input = h('input', {
    class: 'num xc-input',
    attrs: { type: 'text', inputmode: 'decimal', placeholder: '0', value: blendInput, 'aria-label': 'BLEND to spend' },
    oninput: (e) => {
      blendInput = (e.target as HTMLInputElement).value;
      sync();
    },
  });
  buy.addEventListener('click', () => {
    buyingPearl = true;
    sync();
    void ops.buyPearl(blendInput).then((ok) => {
      buyingPearl = false;
      if (ok) blendInput = '';
      rerender();
    });
  });
  sync();
  const note = paused
    ? 'The exchange is paused right now.'
    : signedOut
      ? 'Connect with Fluent to trade. One way: PEARL cannot be turned back into BLEND.'
      : `One way: PEARL cannot be turned back into BLEND. ${CHAIN ? 'The BLEND leaves your wallet for the game treasury.' : 'Local game: this spends the BLEND from your bottle.'}`;
  return h(
    'section',
    { class: 'card xc', attrs: { 'aria-label': 'Your PEARL, and buying more for BLEND' } },
    balanceTile,
    h(
      'div',
      { class: 'xc-trade' },
      h('div', { class: 'xc-head' }, h('h3', { text: 'Need more? Buy PEARL with BLEND' }), h('span', { class: 'badge xc-rate', text: `1 BLEND = ${fmt(rate)} PEARL` })),
      h(
        'div',
        { class: 'xc-row' },
        h(
          'div',
          { class: 'xc-field' },
          h('span', { class: 'xc-k' }, 'You pay · you have ', h('span', { class: 'blend', text: `${fmt(balance)} BLEND` })),
          h(
            'div',
            { class: 'xc-pay' },
            input,
            h('span', { class: 'blend xc-unit', text: 'BLEND' }),
            h('button', {
              class: 'btn btn-ghost btn-sm',
              text: 'Max',
              disabled: balance <= 0,
              onclick: () => {
                blendInput = String(balance);
                input.value = blendInput;
                sync();
              },
            }),
          ),
        ),
        h('span', { class: 'xc-arrow', text: '→', attrs: { 'aria-hidden': 'true' } }),
        h('div', { class: 'xc-field' }, h('span', { class: 'xc-k', text: 'You get' }), out),
        buy,
      ),
      h('p', { class: 'muted small xc-note', text: note }),
    ),
  );
}

export function initTackle(host: HTMLElement, shop = false): () => void {
  const render = (): (HTMLElement | null)[] => {
    const s = getSave();
    const guest = shop && isGuest();
    // whose tackle the page talks about: the player's own, or nobody's (a preview, or a visitor not signed in)
    const mine = shop && !guest;
    const rod = rodById(view.rod ?? (mine ? s.equipped.rod : 'carbon')) ?? RODS[0];
    const lureId = view.lure === undefined ? (mine ? s.equipped.lure : 'spoon') : view.lure;
    const lure = lureById(lureId) ?? null;
    const spot = view.spot ?? (mine ? s.location : 0);
    const pickRod = (id: string) => () => {
      view.rod = id;
      rerender();
    };
    const pickLure = (id: string) => () => {
      view.lure = lure?.id === id ? null : id;
      rerender();
    };
    return [
      h(
        'div',
        { class: 'tk-intro' },
        h('h2', { class: 'tk-title', text: 'Tackle' }),
        h(
          'p',
          { class: 'muted' },
          'Rods and lures with different strengths. A rod makes the fight easier, a lure brings more bites; both can pull rarer and heavier fish. Lures are reusable and wear out over their casts. ',
          shop ? null : h('span', { class: 'badge tk-badge', text: 'Preview · not onchain yet' }),
        ),
      ),
      // the PEARL in hand and the way to get more: first, and apart from the loadout's numbers
      guest ? signInCard() : shop ? walletCard(rerender) : null,
      // a visitor has no tackle to estimate: the page stays a sign-in panel and the catalogue
      guest ? null : loadoutCard(rod, lure, spot, mine, rerender),
      h('h3', { class: 'tk-section', text: 'Rods' }),
      h('div', { class: 'tk-grid' }, RODS.map((r) => card(r, !guest && rod.id === r.id, guest ? null : pickRod(r.id), mine, spot))),
      h('h3', { class: 'tk-section', text: 'Lures' }),
      h('div', { class: 'tk-grid' }, LURES.map((l) => card(l, !guest && lure?.id === l.id, guest ? null : pickLure(l.id), mine, spot))),
    ];
  };
  const rerender = mount(host, () => sigOf(rev(), view, shop, world.blend?.balance, world.blend?.paused, state.wallet?.address, buyingPearl, pending), render);
  host.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if ((e.key === 'Enter' || e.key === ' ') && t.classList.contains('tk-card')) {
      e.preventDefault();
      t.click();
    }
  });
  rerender();
  return rerender;
}

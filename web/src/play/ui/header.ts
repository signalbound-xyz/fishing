/**
 * Header: level, PEARL, energy and the Fluent Connect sign-in. BLEND is not shown here: it is not spent at the
 * water, and its balance is on the Tackle page, where it buys PEARL. The lifetime numbers (catches and the rest)
 * are on the Stats page (ui/profile.ts).
 */
import { energyCountdown, energyNow, refillPrice } from '../../game/actions';
import { TUNING } from '../../game/content';
import { levelOf, xpForLevel } from '../../game/economy';
import { TIME_SETTINGS, setTimeSetting, timeOfDay, timeSetting, type TimeSetting } from '../../daytime';
import { emit, state } from '../../store';
import { fmtCountdown, h, icon, mount, segBar, shortAddr, sigOf } from '../../ui/dom';
import { confirmDialog } from '../../ui/confirm';
import { fluentButton, type HeaderHandlers } from '../../ui/header';
import { CHAIN, ops, playerRead } from '../ops';
import { getSave, rev } from '../state';
import { pearl } from './fmt';
import { levelShow } from './levelup';

let regenEl: HTMLElement | null = null;
/** The refill is on its way (a transaction on the contracts): the button waits, a second click would fail. */
let refilling = false;

/**
 * While the player's state is on its way from the contracts the numbers are drawn as blank blocks of the same
 * size, so the header does not jump when they arrive. The shape of the last signed-in header (how long the
 * numbers were, whether Refill was there) is remembered in this browser, to draw the blocks the right size.
 */
interface Shape {
  refill: boolean;
  level: number;
  pearl: number;
}
const SHAPE_KEY = 'onchain-fishing:header-shape';
const DEFAULT_SHAPE: Shape = { refill: true, level: 1, pearl: 3 };
/** If the sign-in has not come back by then, the header stops waiting and offers to connect. */
const RESTORE_WAIT_MS = 8_000;
const bootAt = Date.now();

function recallShape(): Shape | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(SHAPE_KEY) ?? 'null');
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const len = (x: unknown, d: number): number => (typeof x === 'number' && x >= 1 && x <= 12 ? Math.floor(x) : d);
    // a shape stored by an older build has more fields than this: they are ignored
    return { refill: o.refill === true, level: len(o.level, 1), pearl: len(o.pearl, 3) };
  } catch {
    return null;
  }
}
/** Null: this browser was signed out last time, so a page that opens signed out has nothing to wait for. */
let shape: Shape | null = CHAIN ? recallShape() : null;

function rememberShape(next: Shape | null): void {
  if (JSON.stringify(next) === JSON.stringify(shape)) return;
  shape = next;
  try {
    if (next) localStorage.setItem(SHAPE_KEY, JSON.stringify(next));
    else localStorage.removeItem(SHAPE_KEY);
  } catch {
    /* storage is blocked: the blocks are drawn in the default size next time */
  }
}

function loading(now: number): boolean {
  if (!CHAIN) return false;
  if (state.wallet) return !playerRead();
  return state.fluentStatus === 'restoring' && shape !== null && now - bootAt < RESTORE_WAIT_MS;
}

export function initLocalHeader(host: HTMLElement, on: HeaderHandlers): () => void {
  if (loading(bootAt)) setTimeout(emit, RESTORE_WAIT_MS + 50);
  return mount(
    host,
    () => sigOf(rev(), energyNow(getSave(), Date.now()), state.wallet?.address, state.fluentStatus, location.hash, refilling, timeSetting(), timeOfDay(), levelShow(Date.now()) !== null, loading(Date.now())),
    () => render(on),
  );
}

export function tickLocalHeader(): void {
  if (!regenEl) return;
  const left = energyCountdown(getSave(), Date.now());
  regenEl.textContent = left === 0 ? 'full' : `+1 in ${fmtCountdown(left)}`;
}

/** Morning, day, evening or night for the scene and the whole interface; "Auto" follows the player's clock. */
function timeSwitch(): HTMLElement {
  const chosen = timeSetting();
  const button = (id: TimeSetting, label: string, hint: string): HTMLElement =>
    h(
      'button',
      {
        class: chosen === id ? 'time-btn active' : 'time-btn',
        title: id === 'auto' ? `${hint} (now: ${timeOfDay()})` : hint,
        attrs: { type: 'button', 'aria-label': label, 'aria-pressed': String(chosen === id) },
        onclick: () => setTimeSetting(id),
      },
      id === 'auto' ? h('span', { class: 'time-auto', text: 'Auto' }) : icon(id),
    );
  return h('div', { class: 'time-switch', attrs: { role: 'group', 'aria-label': 'Time of day' } }, ...TIME_SETTINGS.map((t) => button(t.id, t.label, t.hint)));
}

/** Refill costs PEARL and cannot be undone, so one click is not enough: the player sees the price and agrees to it. */
async function askRefill(): Promise<void> {
  if (refilling) return;
  const s = getSave();
  const now = Date.now();
  const price = refillPrice(s, now);
  const left = Math.floor(s.pearl) - price;
  const yes = await confirmDialog({
    title: 'Refill energy?',
    rows: [
      ['Energy', `${energyNow(s, now)} → ${TUNING.maxEnergy}`],
      ['Price', `${pearl(price)} PEARL`],
      ['PEARL left', pearl(left)],
    ],
    note: `The next refill today will cost ${pearl(price * TUNING.refillGrowth)} PEARL. The price returns to ${pearl(TUNING.refillPrice)} at midnight UTC.`,
    confirm: `Refill · ${pearl(price)}`,
  });
  if (!yes || refilling) return;
  refilling = true;
  emit();
  void ops.refillEnergy().finally(() => {
    refilling = false;
    emit();
  });
}

/** The stats while they load: the same boxes with blank blocks for everything that is not known yet. */
function loadingStats(on: HeaderHandlers, sh: Shape): HTMLElement {
  const blank = (n: number): string => '0'.repeat(n);
  const w = state.wallet;
  return h(
    'div',
    { class: 'stats', attrs: { 'aria-busy': 'true', 'aria-label': 'Loading your game' } },
    h('div', { class: 'stat' }, h('span', { class: 'k skel', text: `Level ${blank(sh.level)}` }), segBar(0, 1, 8, 'xp skel')),
    h('div', { class: 'stat' }, h('span', { class: 'k', text: 'PEARL' }), h('span', { class: 'v skel', text: blank(sh.pearl) })),
    h(
      'div',
      { class: 'stat energy' },
      h('span', { class: 'k skel', text: `Energy 00/${TUNING.maxEnergy}` }),
      segBar(0, 1, 10, 'en skel'),
      h('span', { class: 'regen skel', text: sh.refill ? '+1 in 00:00' : 'full' }),
    ),
    sh.refill ? h('button', { class: 'btn btn-sm skel', text: 'Refill · 100', disabled: true }) : null,
    w
      ? who(on)
      : h('div', { class: 'stat who' }, h('span', { class: 'addr skel', text: '0x0000…0000' }), h('button', { class: 'btn btn-ghost btn-sm skel', text: 'Log out', disabled: true })),
  );
}

function who(on: HeaderHandlers): HTMLElement {
  const w = state.wallet;
  if (!w) return fluentButton(on);
  return h(
    'div',
    { class: 'stat who' },
    h('span', { class: 'addr', text: shortAddr(w.address), title: `${w.address} — open account`, onclick: on.openAccount }),
    h('button', { class: 'btn btn-ghost btn-sm', text: 'Log out', onclick: on.disconnect }),
  );
}

function render(on: HeaderHandlers): HTMLElement[] {
  const s = getSave();
  const now = Date.now();
  const wait = loading(now);
  const page = location.hash === '#/tackle' ? 'tackle' : location.hash === '#/hunt' ? 'hunt' : location.hash === '#/cup' ? 'cup' : location.hash === '#/profile' ? 'profile' : location.hash === '#/stats' ? 'debug' : 'pond';
  const link = (id: string, text: string, href: string): HTMLElement =>
    h('a', { class: page === id ? 'active' : '', text, attrs: { href, ...(page === id ? { 'aria-current': 'page' } : {}) } });
  const level = levelOf(s.xp);
  const from = xpForLevel(level);
  const to = xpForLevel(level + 1);
  const energy = energyNow(s, now);
  const price = refillPrice(s, now);
  const show = levelShow(now);
  regenEl = wait ? null : h('span', { class: 'regen' });
  tickLocalHeader();
  if (CHAIN && !wait) {
    if (state.wallet) rememberShape({ refill: energy < TUNING.maxEnergy, level: String(level).length, pearl: pearl(Math.floor(s.pearl)).length });
    else if (state.fluentStatus !== 'restoring' && state.fluentStatus !== 'connecting') rememberShape(null);
  }
  const head = [
    h(
      'div',
      { class: 'brand', attrs: { 'aria-label': 'Onchain Fishing' } },
      h('span', { class: 'logo' }, icon('bobber')),
      h('span', { class: 'wordmark' }, h('span', { class: 'wm-top', text: 'Onchain' }), h('span', { class: 'wm-main', text: 'Fishing' })),
    ),
    h('nav', { class: 'topnav', attrs: { 'aria-label': 'Pages' } }, link('pond', 'Pond', '#/'), link('hunt', 'Season Hunt', '#/hunt'), link('tackle', 'Tackle', '#/tackle'), link('profile', 'Stats', '#/profile')),
    timeSwitch(),
  ];
  if (wait) return [...head, loadingStats(on, shape ?? DEFAULT_SHAPE)];
  // on the contracts the numbers belong to an account: with nobody signed in there is nothing to show but the way in
  if (CHAIN && !state.wallet) return [...head, h('div', { class: 'stats' }, fluentButton(on))];
  return [
    ...head,
    h(
      'div',
      { class: 'stats' },
      h(
        'div',
        // a new level: the block is lit for a moment (levelup.ts); the delay keeps the animation in step across re-renders
        { class: show === null ? 'stat' : 'stat levelup', style: show === null ? undefined : `--lvl-t:-${show}ms`, title: `${s.xp} XP · ${to - s.xp} to level ${level + 1}` },
        h('span', { class: 'k', text: `Level ${level}` }),
        segBar(s.xp - from, to - from, 8, 'xp'),
      ),
      h('div', { class: 'stat' }, h('span', { class: 'k', text: 'PEARL' }), h('span', { class: 'v pearl', text: pearl(Math.floor(s.pearl)) })),
      h(
        'div',
        { class: 'stat energy' },
        h('span', { class: 'k', text: `Energy ${energy}/${TUNING.maxEnergy}` }),
        segBar(energy, TUNING.maxEnergy, 10, 'en'),
        regenEl,
      ),
      energy < TUNING.maxEnergy
        ? h('button', {
            class: `btn btn-sm${refilling ? ' busy' : ''}`,
            text: refilling ? 'Refilling…' : `Refill · ${pearl(price)}`,
            title: refilling ? 'Waiting for the transaction' : 'Fills energy to the maximum. Each further refill on the same day costs twice as much.',
            disabled: refilling || s.pearl < price,
            onclick: () => void askRefill(),
          })
        : null,
      who(on),
    ),
  ];
}

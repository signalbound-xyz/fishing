/** Entry of the local game: layout, routing and render wiring. No contracts and no RPC are involved. */
import { fluentWallet } from '../clients';
import { CHAIN_ID, chain, deployment } from '../config';
import { FLUENT_CONFIGURED, disconnectFluent, mountFluent, openFluentAccount, openFluentConnect, type FluentAccountState } from '../fluent';
import { emit, state, subscribe } from '../store';
import { initTackle } from '../tackle/page';
import { h } from '../ui/dom';
import { toast } from '../ui/toast';
import { initCollection } from './ui/collection';
import { initCup, tickCup } from './ui/cup';
import { initHunt, tickHunt } from './ui/hunt';
import { dailyBadge, initDaily } from './ui/daily';
import { initLocalHeader, tickLocalHeader } from './ui/header';
import { initKeepnet } from './ui/keepnet';
import { initPond, pondBusy, tickPond } from './ui/pond';
import { initRanks, tickRanks } from './ui/ranks';
import { initProfile } from './ui/profile';
import { initStats } from './ui/stats';
import { initTrophies } from './ui/trophies';
import { catalogMismatches, forgetInventory } from './chain';
import { wantCareer } from './career';
import { CHAIN, refresh, refreshStandings } from './ops';
import { tickDaily } from './daily';
import { replaceSave } from './state';
import { freshSave } from '../game/save';

const app = document.getElementById('app')!;

const headerEl = h('header', { class: 'header' });
const sceneEl = h('div', { class: 'scene' });
const controlsEl = h('div', { class: 'controls card' });

type Tab = 'inv' | 'daily' | 'dex' | 'trophy' | 'ranks';
const TABS: [Tab, string][] = [
  ['inv', 'Keepnet'],
  ['daily', 'Daily'],
  ['dex', 'Collection'],
  ['trophy', 'Trophies'],
  ['ranks', 'Ranks'],
];
const panels: Record<Tab, HTMLElement> = {
  inv: h('div', { class: 'panel' }),
  daily: h('div', { class: 'panel' }),
  dex: h('div', { class: 'panel' }),
  trophy: h('div', { class: 'panel' }),
  ranks: h('div', { class: 'panel' }),
};
const TAB_KEY = 'onchain-fishing:play-tab';
let tab: Tab = (() => {
  try {
    const t = localStorage.getItem(TAB_KEY);
    return TABS.some(([k]) => k === t) ? (t as Tab) : 'inv';
  } catch {
    return 'inv';
  }
})();
const tabBtns = TABS.map(([k, label]) => h('button', { class: 'tab', text: label, attrs: { role: 'tab', 'data-tab': k }, onclick: () => selectTab(k) }));
/** The Daily tab carries the day's count, so it can be read without opening it. */
const dailyTab = tabBtns[TABS.findIndex(([k]) => k === 'daily')];
let dailyTabText = '';
function paintDailyTab(): void {
  const b = dailyBadge();
  const text = b ? `Daily ${b.text}` : 'Daily';
  if (text !== dailyTabText) dailyTab.textContent = dailyTabText = text;
  dailyTab.classList.toggle('tab-done', !!b?.complete);
}
// Another part of the page asks for a tab (the daily strip under the Cast button): open it and bring it into view,
// since on a phone the tabs sit under the controls.
window.addEventListener('fishing:open-tab', (e) => {
  const k = (e as CustomEvent<string>).detail as Tab;
  if (!TABS.some(([t]) => t === k)) return;
  selectTab(k);
  tabBtns[0].parentElement?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
});
function selectTab(k: Tab): void {
  tab = k;
  try {
    localStorage.setItem(TAB_KEY, k);
  } catch {
    /* a remembered tab is a convenience only */
  }
  tabBtns.forEach((b) => b.classList.toggle('active', b.dataset.tab === k));
  // five tabs do not fit a narrow column: keep the chosen one in sight
  const btn = tabBtns.find((b) => b.dataset.tab === k);
  const nav = btn?.parentElement;
  if (btn && nav) nav.scrollLeft = btn.offsetLeft - (nav.clientWidth - btn.offsetWidth) / 2;
  (Object.keys(panels) as Tab[]).forEach((p) => panels[p].classList.toggle('hidden', p !== k));
}

const tackleEl = h('main', { class: 'tackle hidden' });
const cupEl = h('main', { class: 'layout cup hidden' });
const huntEl = h('main', { class: 'layout hunt hidden' });
const statsEl = h('main', { class: 'playstats hidden' });
const profileEl = h('main', { class: 'profile hidden' });
const pondEl = h(
  'main',
  { class: 'layout' },
  h('div', { class: 'col-left' }, sceneEl, controlsEl),
  h('div', { class: 'col-right card' }, h('nav', { class: 'tabs', attrs: { role: 'tablist' } }, tabBtns), ...Object.values(panels)),
);

app.append(
  headerEl,
  pondEl,
  huntEl,
  cupEl,
  tackleEl,
  profileEl,
  statsEl,
  h(
    'footer',
    { class: 'footer' },
    CHAIN ? `${chain.name} (${CHAIN_ID}) · game ${deployment?.game} · every catch is decided and stored onchain` : 'Local game · progress is saved in this browser · no contracts or transactions',
    ' · ',
    // the player's own numbers are on the Stats page (#/profile); this one is the browser's telemetry log, for debugging
    h('a', { text: 'Debug telemetry', title: 'What this browser has recorded about your play, for debugging. Nothing is sent anywhere. Your fishing career is on the Stats page.', attrs: { href: '#/stats' } }),
  ),
);
selectTab(tab);

function route(): void {
  const tackle = location.hash === '#/tackle';
  const cup = location.hash === '#/cup';
  const hunt = location.hash === '#/hunt';
  const stats = location.hash === '#/stats';
  const profile = location.hash === '#/profile';
  pondEl.classList.toggle('hidden', tackle || cup || hunt || stats || profile);
  statsEl.classList.toggle('hidden', !stats);
  profileEl.classList.toggle('hidden', !profile);
  // the history by water is read from the chain only while its page is open
  wantCareer(profile);
  cupEl.classList.toggle('hidden', !cup);
  huntEl.classList.toggle('hidden', !hunt);
  tackleEl.classList.toggle('hidden', !tackle);
  document.title = tackle ? 'Tackle · Onchain Fishing' : hunt ? 'Season Hunt · Onchain Fishing' : cup ? 'Tournaments · Onchain Fishing' : profile ? 'My Stats · Onchain Fishing' : stats ? 'Debug telemetry · Onchain Fishing' : 'Onchain Fishing';
  emit();
}
window.addEventListener('hashchange', () => {
  route();
  window.scrollTo(0, 0);
});

// The local game does not depend on the sign-in. On the contracts the connected account is the player.
function onFluentChange(s: FluentAccountState): void {
  state.fluentStatus = s.status;
  const before = state.wallet?.address;
  if (s.status === 'connected' && s.address) state.wallet = fluentWallet(s.address, s.kind);
  else if (s.status === 'disconnected') state.wallet = null;
  if (CHAIN && state.wallet?.address !== before) {
    if (state.wallet) void refresh().then(refreshStandings);
    else {
      // signed out: back to an empty view
      forgetInventory();
      replaceSave(freshSave(Date.now()));
    }
  }
  emit();
}
if (FLUENT_CONFIGURED) {
  state.fluentStatus = 'restoring';
  mountFluent(onFluentChange, (m) => {
    state.fluentStatus = 'off';
    toast(`Fluent Connect: ${m}`, 'err');
    emit();
  });
}

const renders = [
  initLocalHeader(headerEl, {
    connectFluent: openFluentConnect,
    openAccount: openFluentAccount,
    disconnect: () => {
      state.wallet = null;
      if (CHAIN) {
        forgetInventory();
        replaceSave(freshSave(Date.now()));
      }
      emit();
      void disconnectFluent().catch((e) => console.warn('fluent disconnect', e));
    },
  }),
  initPond(sceneEl, controlsEl),
  initKeepnet(panels.inv),
  initDaily(panels.daily, pondBusy),
  paintDailyTab,
  initCollection(panels.dex),
  initTrophies(panels.trophy),
  initRanks(panels.ranks),
  initTackle(tackleEl, true),
  initHunt(huntEl),
  initCup(cupEl),
  initStats(statsEl),
  initProfile(profileEl),
];
subscribe(() => renders.forEach((r) => r()));
route();
setInterval(() => {
  // a new UTC day: the local game turns the page itself, on the contracts the player's state is read again
  if (tickDaily()) void refresh();
  tickLocalHeader();
  tickRanks();
  tickPond();
  tickCup();
  tickHunt();
}, 1000);

if (CHAIN) {
  void refreshStandings();
  // other tabs, a keeper finishing a cast, or a marketplace trade can change the player's state
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    void refresh();
    void refreshStandings();
  }, 20_000);
  void catalogMismatches()
    .then((diff) => {
      if (diff.length === 0) return;
      console.warn('[catalog] the client and the contracts disagree:', diff);
      toast(`The game data in this client differs from the contracts in ${diff.length} place(s). Numbers on screen may be off; see the console.`, 'err', 12_000);
    })
    .catch((e) => {
      console.warn('catalog check failed', e);
      toast(`Cannot read the game contracts on ${chain.name}. Check the network and reload.`, 'err', 12_000);
    });
}

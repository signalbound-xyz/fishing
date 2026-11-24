/**
 * The Season Hunt page, and the hunt's strip under the pond's Cast button.
 *
 * A season: one target fish, one prize, the first angler to hook it. Fishing for it happens at the pond, with the
 * player's own tackle: a seasonal cast is an ordinary cast that is also an attempt at the target. This page says
 * what the season is, what the player's tackle is worth in it, who holds the catch, and keeps the older seasons.
 *
 * Every number on it is the contract's: the chance of a cast is the season's own table (game/hunt.ts mirrors the
 * contract's arithmetic exactly), and whether a cast hooked the target is the contract's answer, never a guess.
 */
import { EXPLORER_URL, deployment } from '../../config';
import { LOCATIONS, SPECIES } from '../../game/content';
import { STATUS_LABEL, atLeastOnce, bestChance, bonusParts, chanceOf, countdown, levelOfXp, oddsText, shareText, timesText, type HuntStatus } from '../../game/hunt';
import { canEnter } from '../../game/progress';
import type { Save } from '../../game/types';
import { openFluentConnect } from '../../fluent';
import { emit, state } from '../../store';
import { LURES, RODS } from '../../tackle/catalog';
import { h, mount, shortAddr, sigOf } from '../../ui/dom';
import { fishArt } from '../fishSprite';
import { HUNT_DEPLOYED, activeHunt, armHunt, featuredHunt, huntBlocker, huntCastFor, huntNow, huntOps, hunts, isFinal, loadHunts, myChance, myHits, myWaiting, showMoreHunts, statusNow, syncHunt, tackleOf, type HuntSeason, type PendingAttempt } from '../hunt';
import { CHAIN, ops } from '../ops';
import { getSave, rev } from '../state';
import { rarityTag } from './fmt';

const visible = (): boolean => location.hash === '#/hunt';
const blend = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const fishName = (s: HuntSeason): string => SPECIES[s.speciesId]?.name ?? `Fish #${s.speciesId}`;
const waterName = (id: number): string => LOCATIONS[id]?.name ?? `Water ${id}`;
const rodName = (id: number): string => RODS[id]?.name ?? `Rod ${id}`;
const lureName = (id: number | null): string => (id === null ? 'No lure' : (LURES[id]?.name ?? `Lure ${id}`));
const date = (unix: number): string => new Date(unix * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const explorer = (path: string, text: string, title?: string): HTMLElement =>
  EXPLORER_URL ? h('a', { class: 'link', text, title, attrs: { href: `${EXPLORER_URL}/${path}`, target: '_blank', rel: 'noopener' } }) : h('span', { text, title });

/** The season the page shows; null = the featured one. */
let picked: number | null = null;
let loadingMore = false;

function shownSeason(): HuntSeason | null {
  if (picked !== null) {
    const s = hunts.list.find((x) => x.id === picked);
    if (s) return s;
  }
  return featuredHunt();
}

/** A countdown the page repaints every second without re-rendering: `data-until` holds the unix time. */
function until(unix: number, cls = ''): HTMLElement {
  return h('span', { class: `hunt-clock ${cls}`, text: countdown(unix - huntNow()), attrs: { 'data-until': String(unix) } });
}

function paintClocks(root: ParentNode = document): void {
  const now = huntNow();
  root.querySelectorAll<HTMLElement>('[data-until]').forEach((el) => {
    const text = countdown(Number(el.dataset.until) - now);
    if (el.textContent !== text) el.textContent = text;
  });
}

const statusPill = (st: HuntStatus, final = false): HTMLElement => h('span', { class: `hunt-pill hunt-${st}`, text: st === 'winner' && !final ? 'Target hooked' : STATUS_LABEL[st] });

// ------------------------------------------------------------------ the page

export function initHunt(root: HTMLElement): () => void {
  if (!CHAIN || !HUNT_DEPLOYED) {
    root.append(
      h(
        'div',
        { class: 'card hunt-off' },
        h('span', { class: 'hunt-kicker', text: 'Season Hunt' }),
        h('h2', { text: 'One fish. One prize. The first angler to hook it.' }),
        h('p', {
          class: 'muted',
          text: CHAIN
            ? 'The Season Hunt is not deployed on this network yet. When a season opens, it is fished right at the pond, with your own rod and lures.'
            : 'The Season Hunt runs on the contracts: its casts, its winner and its prize live onchain. This is the local game, so there is none here.',
        }),
        h('a', { class: 'link', text: 'Tournaments →', attrs: { href: '#/cup' } }),
      ),
    );
    return () => undefined;
  }
  const main = h('div', { class: 'col-left hunt-main' });
  const side = h('div', { class: 'col-right card hunt-side' });
  root.append(main, side);
  const sig = (): string => {
    const s = shownSeason();
    const save = getSave();
    return sigOf(hunts.rev, s?.id, s ? statusNow(s) : '', s ? isFinal(s) : '', state.wallet?.address, visible(), rev(), save.location, save.equipped, hunts.busy, loadingMore, picked);
  };
  const renderMain = mount(main, sig, mainView);
  const renderSide = mount(side, sig, sideView);
  return () => {
    syncHunt();
    if (!visible()) return;
    renderMain();
    renderSide();
  };
}

let ticks = 0;
/** Once a second: the countdowns, a status that the clock moved on, and a fresh read every 15 seconds. */
export function tickHunt(): void {
  if (!CHAIN || !HUNT_DEPLOYED) return;
  paintClocks();
  ticks++;
  const open = visible() && document.visibilityState === 'visible';
  // the pond shows the hunt's strip, so the seasons are kept fresh there too, less often
  if (ticks % (open ? 15 : 45) === 0 && document.visibilityState === 'visible' && !hunts.busy) void loadHunts();
  else if (ticks % 5 === 0) emit(); // statuses and the strip follow the clock
}

function mainView(): HTMLElement[] {
  if (!hunts.loaded) {
    return [h('div', { class: 'card hunt-card' }, h('p', { class: 'muted', text: hunts.failed ? 'Cannot read the seasons from the network. Trying again…' : 'Reading the seasons…' }))];
  }
  const s = shownSeason();
  if (!s) {
    return [
      h(
        'div',
        { class: 'card hunt-card' },
        h('span', { class: 'hunt-kicker', text: 'Season Hunt' }),
        h('h2', { text: 'No season has been announced yet' }),
        h('p', { class: 'muted', text: 'A season names one target fish and a BLEND prize. The first angler to hook the fish takes the whole prize. Check back soon.' }),
      ),
    ];
  }
  return [overview(s), ...hitBanners(s), resultCard(s), rulesCard(s)].filter((x): x is HTMLElement => !!x);
}

/** What the season is: its fish, its prize, its clock, where it is fished and what is asked of the angler. */
function overview(s: HuntSeason): HTMLElement {
  const st = statusNow(s);
  const sp = SPECIES[s.speciesId];
  const now = huntNow();
  const me = state.wallet;
  const save = getSave();

  let clock: HTMLElement;
  if (st === 'upcoming') clock = h('div', { class: 'hunt-when' }, h('span', { class: 'k', text: 'Starts in' }), until(s.start, 'v'));
  else if (st === 'active') clock = h('div', { class: 'hunt-when' }, h('span', { class: 'k', text: 'Ends in' }), until(s.end, 'v'));
  else if (st === 'closing') clock = h('div', { class: 'hunt-when' }, h('span', { class: 'k', text: 'Casting is over · late catches recorded for' }), until(s.finalAt, 'v'));
  else if (st === 'winner' && now <= s.finalAt) clock = h('div', { class: 'hunt-when' }, h('span', { class: 'k', text: 'Result final in' }), until(s.finalAt, 'v'));
  else clock = h('div', { class: 'hunt-when' }, h('span', { class: 'k', text: st === 'cancelled' ? 'Called off' : 'Ended' }), h('span', { class: 'v', text: date(Math.min(s.end, st === 'winner' ? s.finalAt : s.end)) }));

  const entry: string[] = [];
  entry.push(s.rods.length ? `Rod: ${s.rods.map(rodName).join(' or ')}` : 'Any rod, the free Willow Rod included');
  if (s.minLevel > 1) entry.push(`Level ${s.minLevel} and up`);
  entry.push(`${s.dailyAttempts} seasonal casts per day`);

  return h(
    'section',
    { class: `card hunt-card hunt-hero hunt-is-${st}` },
    h(
      'div',
      { class: 'hunt-hero-top' },
      h('span', { class: 'hunt-kicker', text: `Season Hunt · #${s.id + 1}` }),
      statusPill(st, isFinal(s)),
    ),
    h(
      'div',
      { class: 'hunt-hero-body' },
      h('div', { class: 'hunt-target' }, fishArt(s.speciesId, { cls: 'hunt-art' }), h('div', { class: 'hunt-target-name' }, h('span', { class: 'k', text: 'Target' }), h('b', { text: fishName(s) }), sp ? rarityTag(sp.rarity) : null)),
      h(
        'div',
        { class: 'hunt-hero-text' },
        h('h2', { text: s.name }),
        s.description ? h('p', { class: 'hunt-desc', text: s.description }) : null,
        h(
          'div',
          { class: 'hunt-facts' },
          h(
            'div',
            { class: 'hunt-prize', title: s.sponsor ? 'The whole prize is held by the hunt contract since before the season started. It goes to the winner, all of it.' : 'The prize is not in the contract yet: nobody can cast until it is.' },
            h('span', { class: 'k', text: 'Prize' }),
            h('span', { class: 'v' }, `${blend(s.prize)} `, h('small', { text: 'BLEND' })),
            h('span', { class: s.sponsor ? 'd' : 'd warn', text: s.sponsor ? 'held in escrow · winner takes all' : 'not funded yet' }),
          ),
          clock,
        ),
      ),
    ),
    h(
      'div',
      { class: 'hunt-where' },
      h('span', { class: 'k', text: 'Hunted in' }),
      h(
        'div',
        { class: 'hunt-waters' },
        s.waters.map((w) => {
          const loc = LOCATIONS[w];
          const open = !me || !loc || canEnter(save, loc);
          const bonus = s.odds.waterBonus[w] ?? 0;
          return h('span', { class: `hunt-water${open ? '' : ' locked'}`, title: open ? loc?.blurb : 'You have not opened this water yet' }, waterName(w), bonus ? h('em', { text: `+${bonus}%` }) : null);
        }),
      ),
    ),
    h('ul', { class: 'hunt-entry' }, entry.map((t) => h('li', { text: t }))),
    heroAction(s, st, save),
  );
}

/** The one thing to do about the season right now. */
function heroAction(s: HuntSeason, st: HuntStatus, save: Save): HTMLElement | null {
  if (st === 'upcoming') return h('div', { class: 'hunt-cta' }, h('span', { class: 'muted', text: 'Get your tackle ready: a seasonal cast uses your own rod and lure, and costs energy like any cast.' }), h('a', { class: 'btn', text: 'Tackle shop', attrs: { href: '#/tackle' } }));
  if (st !== 'active') return null;
  if (!state.wallet) return h('div', { class: 'hunt-cta' }, h('button', { class: 'btn btn-primary hunt-go', text: 'Connect to hunt', attrs: { type: 'button' }, onclick: openFluentConnect }));
  // the water the player stands at, if the fish is hunted there; else the best one they have opened
  const openWaters = s.waters.filter((w) => LOCATIONS[w] && canEnter(save, LOCATIONS[w]));
  const here = s.waters.includes(save.location) ? save.location : null;
  const best = openWaters.slice().sort((a, b) => myChance(s, save, b) - myChance(s, save, a))[0];
  const water = here ?? best;
  if (water === undefined) return h('div', { class: 'hunt-cta' }, h('span', { class: 'warn', text: 'You have not opened any of this season’s waters yet.' }));
  const blocker = huntBlocker(s, save, water);
  const left = h('span', { class: s.attemptsLeft > 0 ? 'hunt-left' : 'hunt-left warn', text: `${s.attemptsLeft} of ${s.dailyAttempts} seasonal casts left today`, title: 'The count starts again at midnight UTC' });
  return h(
    'div',
    { class: 'hunt-cta' },
    h('button', {
      class: 'btn btn-primary hunt-go',
      text: `Fish for it at ${waterName(water)}`,
      title: blocker ?? 'Opens the pond with the hunt switched on: every cast there counts for the season until you switch it off',
      disabled: !!blocker,
      attrs: { type: 'button' },
      onclick: () => {
        if (getSave().location !== water) ops.setLocation(water);
        armHunt(true);
        location.hash = '#/';
      },
    }),
    blocker ? h('span', { class: 'warn', text: blocker }) : left,
  );
}

/** The player's casts that hooked the target and still have to be recorded. */
function hitBanners(s: HuntSeason): HTMLElement[] {
  return myHits()
    .filter((p) => p.season === s.id)
    .map((p) => hitBanner(s, p));
}

function hitBanner(s: HuntSeason, p: PendingAttempt): HTMLElement {
  return h(
    'section',
    { class: 'card hunt-card hunt-hit' },
    h('b', { text: `Your cast #${p.seq + 1} hooked the ${fishName(s)}!` }),
    h('span', { class: 'muted' }, 'Record it on the chain within ', until(p.deadline), ' or it is lost. An earlier cast that also hooked it would still come first.'),
    h('button', { class: `btn btn-primary${hunts.busy === 'record' ? ' busy' : ''}`, text: hunts.busy === 'record' ? 'Recording…' : 'Record the catch', disabled: !!hunts.busy, attrs: { type: 'button' }, onclick: () => void huntOps.record(p) }),
  );
}

/** Who holds the catch, with what and when; the prize and the trophy. */
function resultCard(s: HuntSeason): HTMLElement | null {
  const st = statusNow(s);
  const me = state.wallet?.address.toLowerCase();
  const w = s.winner;
  if (!w) {
    if (st !== 'expired' && st !== 'cancelled') return null;
    const mine = !!me && s.sponsor?.toLowerCase() === me;
    return h(
      'section',
      { class: 'card hunt-card hunt-result' },
      h('h3', { text: st === 'cancelled' ? 'This season did not run' : 'Nobody hooked it' }),
      h('p', {
        class: 'muted',
        text:
          st === 'cancelled'
            ? s.sponsor
              ? 'It was called off before it started. The prize goes back to its sponsor.'
              : 'Its prize was never put up, so nobody could cast.'
            : `${s.attempts.toLocaleString('en-US')} seasonal casts were made and the ${fishName(s)} got away from every one. The prize goes back to its sponsor, who may put it into a later season.`,
      }),
      s.sponsor ? h('div', { class: 'hunt-row' }, h('span', { class: 'k', text: 'Prize' }), h('span', { text: s.returned ? `${blend(s.prize)} BLEND · returned to the sponsor` : `${blend(s.prize)} BLEND · still in escrow` })) : null,
      mine && !s.returned
        ? h('button', { class: `btn${hunts.busy === 'reclaim' ? ' busy' : ''}`, text: hunts.busy === 'reclaim' ? 'Taking it back…' : 'Take the prize back', disabled: !!hunts.busy, attrs: { type: 'button' }, onclick: () => void huntOps.reclaim(s) })
        : null,
    );
  }
  const final = isFinal(s);
  const isMe = !!me && w.player.toLowerCase() === me;
  const row = (k: string, ...v: (Node | string | null)[]): HTMLElement => h('div', { class: 'hunt-row' }, h('span', { class: 'k', text: k }), h('span', null, ...v));
  const chance = chanceOf(s.odds, w.rod, w.lure, w.water);
  return h(
    'section',
    { class: `card hunt-card hunt-result${final ? ' final' : ''}${isMe ? ' mine' : ''}` },
    h('h3', { text: final ? (isMe ? 'You won the season' : 'Winner') : isMe ? 'You hold the catch' : 'The target is hooked' }),
    final
      ? null
      : h('p', { class: 'muted' }, 'This cast holds the catch. It becomes final in ', until(s.finalAt), ': until then a cast made earlier that also hooked the fish can still be recorded, and would come first.'),
    row('Angler', explorer(`address/${w.player}`, shortAddr(w.player), w.player), isMe ? h('span', { class: 'hunt-you', text: 'you' }) : null),
    row('Fish', `${fishName(s)} at ${waterName(w.water)}`),
    row('Tackle', `${rodName(w.rod)} · ${lureName(w.lure)}`),
    row('Odds of that cast', `${oddsText(chance)} (${timesText(s.odds, chance)} the base chance)`),
    row('Cast', `#${w.seq + 1} of ${s.attempts.toLocaleString('en-US')} · `, explorer(`block/${w.blockNumber}`, `block ${w.blockNumber.toLocaleString('en-US')}`, 'The block the winning cast was made in')),
    row('Prize', `${blend(s.prize)} BLEND · ${s.paid ? 'claimed' : final ? 'waiting for the winner' : 'in escrow'}`),
    row('Trophy', s.trophyId > 0n ? `${fishName(s)} · fish #${s.trophyId}` : final ? 'not landed yet' : 'landed with the prize'),
    final && isMe && !s.paid
      ? h('button', { class: `btn btn-primary hunt-go${hunts.busy === 'claim' ? ' busy' : ''}`, text: hunts.busy === 'claim' ? 'Claiming…' : `Claim ${blend(s.prize)} BLEND`, disabled: !!hunts.busy, attrs: { type: 'button' }, onclick: () => void huntOps.claim(s) })
      : null,
    final && s.paid && s.trophyId === 0n
      ? h('button', { class: `btn${hunts.busy === 'trophy' ? ' busy' : ''}`, text: hunts.busy === 'trophy' ? 'Landing…' : 'Land the trophy fish', title: 'The prize was paid without the fish. Anyone may send this; the fish goes to the winner.', disabled: !!hunts.busy, attrs: { type: 'button' }, onclick: () => void huntOps.trophy(s) })
      : null,
  );
}

function rulesCard(s: HuntSeason): HTMLElement {
  const b = hunts.beacon;
  const minutes = Math.max(1, Math.round(s.settleWindow / 60));
  return h(
    'section',
    { class: 'card hunt-card hunt-rules' },
    h('h3', { text: 'How the hunt works' }),
    h(
      'ol',
      null,
      h('li', { text: 'A seasonal cast is an ordinary cast made with the hunt switched on. It costs the same energy, wears the same rod and uses the same lure, and you land whatever bites, as always.' }),
      h('li', { text: `On top of that, each such cast is one attempt at the ${fishName(s)}: a separate draw, with the odds shown here for your tackle and water. It changes nothing about your ordinary catch.` }),
      h('li', { text: 'Casts are numbered in the order they enter the chain. The lowest-numbered cast that hooks the target wins the whole prize. Sending a transaction faster later on does not change that order.' }),
      h('li', { text: `A hit has to be recorded on the chain within ${minutes} min of its cast; the game does that for you, and anyone may do it for anyone. Once that time is over for the recorded hit, the result is final.` }),
      h('li', { text: 'The winner claims the prize and a trophy fish of the target species. If nobody hooks it, the prize goes back to its sponsor.' }),
    ),
    b
      ? h(
          'p',
          { class: b.unbiasable ? 'hunt-rng' : 'hunt-rng warn' },
          b.unbiasable
            ? 'Randomness: a drand round fixed by the time of your cast and not yet made when you cast. Its signature is checked by the contract, so neither the network’s operator nor the game can choose it.'
            : 'Test randomness: the hash of a later block, which the network’s operator could in principle choose. This hunt is a testnet prototype and must not carry a prize of real value.',
        )
      : null,
    deployment?.seasonHunt ? h('p', { class: 'muted small' }, 'Contract: ', explorer(`address/${deployment.seasonHunt}`, shortAddr(deployment.seasonHunt), deployment.seasonHunt)) : null,
  );
}

// ------------------------------------------------------------------ the side column: tackle, then history

function sideView(): HTMLElement[] {
  if (!hunts.loaded) return [h('p', { class: 'muted', text: '…' })];
  const s = shownSeason();
  return [s ? tackleSection(s) : null, historySection(s), h('p', { class: 'hunt-also' }, 'Looking for scored fishing with a leaderboard? ', h('a', { class: 'link', text: 'Tournaments →', attrs: { href: '#/cup' } }))].filter((x): x is HTMLElement => !!x);
}

/** What the player's tackle is worth in the season, and what other tackle would be. */
function tackleSection(s: HuntSeason): HTMLElement | null {
  const st = statusNow(s);
  if (st !== 'active' && st !== 'upcoming') return null;
  const save = getSave();
  const me = !!state.wallet;
  const t = tackleOf(save);
  const water = s.waters.includes(save.location) ? save.location : s.waters[0];
  const chance = chanceOf(s.odds, t.rod, t.lure, water);
  const parts = bonusParts(s.odds, t.rod, t.lure, water);
  const best = bestChance(s.odds);
  const today = Math.max(1, me && st === 'active' ? s.attemptsLeft : s.dailyAttempts);
  const tile = (k: string, v: string, d: string, title: string): HTMLElement => h('div', { class: 'tk-big', title }, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v }), h('span', { class: 'd', text: d }));

  const option = (name: string, bonus: number, on: boolean, note: string, cls = ''): HTMLElement =>
    h('li', { class: `hunt-opt${on ? ' on' : ''} ${cls}` }, h('span', { class: 'n', text: name }), h('span', { class: 'note', text: note }), h('span', { class: bonus ? 'b' : 'b zero', text: bonus ? `+${bonus}%` : '—' }));
  const allowed = (rod: number): boolean => s.rods.length === 0 || s.rods.includes(rod);
  const rods = RODS.map((r, i) => ({ r, i }))
    .filter(({ i }) => allowed(i))
    .map(({ r, i }) => option(r.name, s.odds.rodBonus[i] ?? 0, i === t.rod, i === t.rod ? 'on your line' : !me ? '' : save.rods[r.id] ? 'owned' : `${r.price.toLocaleString('en-US')} PEARL`));
  const lures = [option('No lure', 0, t.lure === null, t.lure === null ? 'on your line' : ''), ...LURES.map((l, i) => option(l.name, s.odds.lureBonus[i] ?? 0, i === t.lure, i === t.lure ? 'on your line' : !me ? '' : save.lures[l.id] ? `${save.lures[l.id].casts} casts` : `${l.price.toLocaleString('en-US')} PEARL`))];
  const waters = s.waters.map((w) => {
    const loc = LOCATIONS[w];
    const open = !me || !loc || canEnter(save, loc);
    return option(waterName(w), s.odds.waterBonus[w] ?? 0, w === water, w === water ? (s.waters.includes(save.location) ? 'you are here' : 'shown') : open ? `${loc?.energyCost ?? '?'} energy a cast` : 'locked', open ? '' : 'locked');
  });

  return h(
    'section',
    { class: 'hunt-tackle' },
    h('div', { class: 'picker-head' }, h('h3', { text: me ? 'Your odds' : 'The odds' }), h('a', { class: 'link', text: 'Tackle shop →', attrs: { href: '#/tackle' } })),
    h('p', { class: 'muted small', text: `${rodName(t.rod)} · ${lureName(t.lure)} · ${waterName(water)}` }),
    h(
      'div',
      { class: 'hunt-odds' },
      tile('One cast', oddsText(chance), `${timesText(s.odds, chance)} the base chance`, 'The chance that one seasonal cast with this tackle in this water hooks the target. Exactly what the contract uses.'),
      tile(`${today} casts`, shareText(atLeastOnce(chance, today)), me && st === 'active' ? 'your casts left today' : 'a full day of casts', 'The chance that at least one of that many casts hooks the target. Somebody else may hook it first: this is your own luck, not your chance to win.'),
    ),
    h(
      'p',
      { class: 'hunt-parts' },
      `Rod +${parts.rod}% · lure +${parts.lure}% · water +${parts.water}%`,
      parts.capped ? ` · capped at +${s.odds.maxBonus}%` : '',
      '. Bonuses add up; they do not multiply.',
    ),
    h('div', { class: 'hunt-opts' }, h('div', null, h('h4', { text: 'Rods' }), h('ul', null, rods)), h('div', null, h('h4', { text: 'Lures' }), h('ul', null, lures)), h('div', null, h('h4', { text: 'Waters' }), h('ul', null, waters))),
    h('p', { class: 'muted small', text: `The base chance is ${oddsText(s.odds.baseChance)} per cast, with the free rod and a bare hook. The best tackle there is reaches ${oddsText(best)} (${timesText(s.odds, best)}) and guarantees nothing.` }),
    me && s.minLevel > 1 && levelOfXp(save.xp) < s.minLevel ? h('p', { class: 'warn small', text: `This season starts at level ${s.minLevel}; you are level ${levelOfXp(save.xp)}.` }) : null,
  );
}

/** Every season the contract holds, newest first; a click shows one on the left. */
function historySection(shownNow: HuntSeason | null): HTMLElement {
  const me = state.wallet?.address.toLowerCase();
  const rows = hunts.list.map((s) => {
    const st = statusNow(s);
    const w = s.winner;
    const outcome = w ? (me && w.player.toLowerCase() === me ? 'you' : shortAddr(w.player)) : st === 'expired' ? 'no winner' : st === 'cancelled' ? '—' : '';
    return h(
      'button',
      {
        class: `hunt-past${shownNow?.id === s.id ? ' sel' : ''}`,
        attrs: { type: 'button', 'aria-pressed': String(shownNow?.id === s.id) },
        onclick: () => {
          picked = s.id;
          emit();
          if (matchMedia('(max-width: 860px)').matches) window.scrollTo({ top: 0 });
        },
      },
      fishArt(s.speciesId, { cls: 'hunt-past-art' }),
      h('span', { class: 'hunt-past-main' }, h('b', { text: s.name }), h('span', { class: 'muted small', text: `${fishName(s)} · ${blend(s.prize)} BLEND · ${date(s.end)}` })),
      h('span', { class: 'hunt-past-end' }, statusPill(st, isFinal(s)), outcome ? h('span', { class: 'muted small', text: outcome }) : null),
    );
  });
  return h(
    'section',
    { class: 'hunt-history' },
    h('h3', { text: 'Seasons' }),
    rows.length ? h('div', { class: 'hunt-past-list' }, rows) : h('p', { class: 'muted', text: 'No seasons yet.' }),
    hunts.list.length < hunts.total
      ? h('button', {
          class: 'btn btn-sm',
          text: loadingMore ? 'Loading…' : `Show older seasons (${hunts.total - hunts.list.length})`,
          disabled: loadingMore,
          attrs: { type: 'button' },
          onclick: () => {
            loadingMore = true;
            emit();
            void showMoreHunts().finally(() => {
              loadingMore = false;
              emit();
            });
          },
        })
      : null,
  );
}

// ------------------------------------------------------------------ at the pond

/** What the pond's controls depend on of the hunt, for their render signature. */
export function huntStripSig(): unknown {
  if (!CHAIN || !HUNT_DEPLOYED) return null;
  const s = activeHunt();
  return [hunts.rev, s?.id, s ? statusNow(s) : null, hunts.armed, myWaiting().length, myHits().length];
}

/** True when the next cast at the pond will count for the season: the Cast button says so. */
export const huntCastArmed = (): HuntSeason | null => (CHAIN && HUNT_DEPLOYED ? huntCastFor(getSave()) : null);

/**
 * The hunt at the pond: a strip under the Cast button while a season is being fished. It is the switch between
 * ordinary casts and seasonal ones, it says what a cast here is worth, and what became of the last one.
 */
export function huntStrip(busy: boolean): HTMLElement | null {
  if (!CHAIN || !HUNT_DEPLOYED || !state.wallet) return null;
  syncHunt();
  const s = activeHunt();
  if (!s) return null;
  const save = getSave();
  const blocker = huntBlocker(s, save);
  const on = hunts.armed && !blocker;
  const chance = myChance(s, save);
  const hits = myHits().filter((p) => p.season === s.id);
  const waiting = myWaiting().filter((p) => p.season === s.id).length;

  let line: string;
  if (blocker) line = hunts.armed ? `${blocker}. Casts here are ordinary casts.` : blocker;
  else if (on) line = `Every cast here is also a shot at the ${fishName(s)}: ${oddsText(chance)} per cast (${timesText(s.odds, chance)}) · ${s.attemptsLeft} left today`;
  else line = `Switch the hunt on to make your casts here count: ${oddsText(chance)} per cast · ${s.attemptsLeft} left today`;

  const last = hunts.last && hunts.last.season === s.id ? hunts.last : null;
  const LAST: Record<string, string> = {
    miss: `no ${fishName(s)} this time`,
    recorded: `HOOKED the ${fishName(s)}! It is recorded for you`,
    beaten: `hooked the ${fishName(s)}, but an earlier cast had it first`,
    lost: 'its result could not be read in time',
    late: 'hooked it, but was not recorded in time',
  };
  const status = waiting > 0 ? `Checking ${waiting === 1 ? 'your seasonal cast' : `${waiting} seasonal casts`}…` : last ? `Seasonal cast #${last.seq + 1}: ${LAST[last.result]}` : null;

  return h(
    'div',
    { class: `hunt-strip${on ? ' on' : ''}` },
    h(
      'div',
      { class: 'hunt-strip-head' },
      h('a', { class: 'hunt-strip-name', attrs: { href: '#/hunt' }, title: 'Open the Season Hunt page' }, h('span', { class: 'hunt-kicker', text: 'Season Hunt' }), h('b', { text: s.name }), h('span', { class: 'hunt-strip-prize', text: `${blend(s.prize)} BLEND` })),
      h('button', {
        class: `btn btn-sm hunt-switch${hunts.armed ? ' on' : ''}`,
        text: hunts.armed ? 'Hunt: on' : 'Hunt: off',
        title: hunts.armed ? 'Switch off: your casts become ordinary casts again' : 'Switch on: your casts in this season’s waters also count as attempts at its fish',
        disabled: busy,
        attrs: { type: 'button', 'aria-pressed': String(hunts.armed) },
        onclick: () => armHunt(!hunts.armed),
      }),
    ),
    h('div', { class: blocker && hunts.armed ? 'hunt-strip-line warn' : 'hunt-strip-line', text: line }),
    status ? h('div', { class: `hunt-strip-last${last?.result === 'recorded' && waiting === 0 ? ' win' : ''}`, text: status }) : null,
    ...hits.map((p) =>
      h(
        'div',
        { class: 'hunt-strip-hit' },
        h('b', { text: `Cast #${p.seq + 1} hooked the ${fishName(s)}!` }),
        h('button', { class: `btn btn-primary btn-sm${hunts.busy === 'record' ? ' busy' : ''}`, text: hunts.busy === 'record' ? 'Recording…' : 'Record the catch', disabled: !!hunts.busy, attrs: { type: 'button' }, onclick: () => void huntOps.record(p) }),
        h('span', { class: 'muted small' }, 'within ', until(p.deadline)),
      ),
    ),
  );
}

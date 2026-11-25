/**
 * The pond: scene, cast → bite → hook → reel flow, and the controls under it.
 *
 * A hooked fish gets one fight, and a lost fight is a lost fish. The fight is the integer machine of game/fight.ts
 * on fixed 50 ms ticks, in the local game and on the contracts alike; on the contracts its recording is what the
 * settlement carries, and the game mints the fish only if the recording lands it (contracts/src/ReelJudge.sol).
 * A bottle does not fight.
 *
 * One older flow is kept beside it: a cast made on the contracts before fights were checked (a release up to 004,
 * or no judge attached) is a catch for any bite, so there a lost fight is another try. That flow goes when no such
 * cast can exist any more.
 */
import {
  GameError,
  castBlocker,
  currentTotals,
  energyNow,
  hookFish,
  landFish,
  landPrize,
  recordEscape,
  rodBroken,
  rodRepairPrice,
  rollBite,
  startCast,
  isValuable,
  type CastTicket,
  type Hooked,
  type Landing,
  saleValue,
} from '../../game/actions';
import { BLEND_PRIZE, LOCATIONS, QUALITIES, SPECIES, TUNING, special } from '../../game/content';
import { fishPrice, levelOf } from '../../game/economy';
import type { CastFight, CastOutcome } from '../../game/chainOutcome';
import { MAX_TICKS, PULL as JERK, TICK_MS, U, WARN as TELL, fightBand, fightParams, fightStart, fightTick, packInputs, type FightParams, type FightState } from '../../game/fight';
import type { LocationDef, Save } from '../../game/types';
import {
  CLEAN_HOOK_HEAD_START,
  START_DIST,
  accuracy,
  bandOf,
  biteDelay,
  difficultyOf,
  greenWidth,
  hookWindow,
  isCleanHook,
  qualityOf,
  reelParams,
  reelStart,
  reelStep,
  type Difficulty,
  type ReelParams,
  type ReelState,
} from '../../game/minigame';
import { canEnter, isUnlocked, purchaseState, unlockText } from '../../game/progress';
import { RARITY_CLASS } from '../../i18n';
import { WaterScene } from '../../scene';
import { emit, state } from '../../store';
import { lureById, rodById } from '../../tackle/catalog';
import { lureSprite, rodSprite } from '../../tackle/sprites';
import { fmtWeight, h, icon, mount, segBar, sigOf } from '../../ui/dom';
import { dropdown } from '../../ui/dropdown';
import { openFluentConnect } from '../../fluent';
import { toast } from '../../ui/toast';
import { fishArt } from '../fishSprite';
import { blocksUntilExpiry, fightBlocksLeft, haulCall, outcomeOf, previewCast, reelCall, tx, waitPastBlock, world, type Preview } from '../chain';
import { CHAIN_ID, deployment } from '../../config';
import { fightEnded, fightOf, fightStarted, recordingOf, type FightRecord, type FightScope } from '../fightLog';
import { CHAIN, ops, refresh, refreshStandings } from '../ops';
import { completedBy, dailySettled } from '../daily';
import { describeGoal } from '../../game/daily';
import { dailyBadge } from './daily';
import { act, commit, getSave, rev } from '../state';
import { track, trackCast, trackLanding } from '../telemetry';
import { pearl, qualityTag, rarityTag } from './fmt';
import { celebrateLevel } from './levelup';
import { showPrizeReveal } from './prize';
import { castForHunt } from '../hunt';
import { huntCastArmed, huntStrip, huntStripSig } from './hunt';

/** 'landing' exists on the contracts only: the reel transaction is on its way. */
type Phase = 'idle' | 'casting' | 'waiting' | 'bite' | 'landing' | 'reeling' | 'result';

let scene: WaterScene;
let statusEl: HTMLElement;
let overlayEl: HTMLElement;
let lockEl: HTMLElement;
let hookBtn: HTMLButtonElement;
let landBtn: HTMLButtonElement;
let reelEl: HTMLElement;
let phase: Phase = 'idle';
let ticket: CastTicket | null = null;
let hooked: Hooked | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Location whose details are shown under the picker (may be a locked one). */
let viewLoc: number | null = null;

export function initPond(sceneHost: HTMLElement, controlsHost: HTMLElement): () => void {
  const canvas = h('canvas', { class: 'water', attrs: { 'aria-label': 'Water' } });
  statusEl = h('div', { class: 'scene-status' });
  overlayEl = h('div', { class: 'scene-overlay hidden' });
  lockEl = h('div', { class: 'scene-lock hidden' });
  hookBtn = h('button', { class: 'btn btn-reel hidden', text: 'Hook!', onclick: () => doHook() });
  landBtn = h('button', { class: 'btn btn-reel hidden', text: 'Land it', title: 'Send the settlement transaction again', onclick: () => void settleOnChain() });
  reelEl = h('div', { class: 'reel hidden' });
  sceneHost.append(canvas, statusEl, lockEl, hookBtn, landBtn, reelEl, overlayEl);
  scene = new WaterScene(canvas);

  sceneHost.addEventListener('pointerdown', (e) => {
    if (phase === 'reeling') {
      e.preventDefault();
      holding = true;
    }
  });
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('pointerup', () => (holding = false));
  window.addEventListener('blur', () => (holding = false));

  const renderControls = mount(controlsHost, () => sigOf(rev(), phase, viewLoc, energyNow(getSave(), Date.now()), state.wallet?.address, dailyBadge(), huntStripSig(), world.castingPaused, world.fights.on), renderControlsView);
  return () => {
    renderControls();
    resumeChainCast();
    syncScene();
  };
}

/** A locked water the player picked to look at: the scene shows it behind a lock. Never while a cast is out. */
function peekLocation(): number | null {
  if (viewLoc === null || pondBusy()) return null;
  return canEnter(getSave(), LOCATIONS[viewLoc]) ? null : viewLoc;
}

let lockShown: number | null = null;
/** The water in the scene: the one being fished, or a locked one the player is looking at. */
function syncScene(): void {
  const peek = peekLocation();
  scene.setSpot(peek ?? ticket?.locationId ?? getSave().location);
  statusEl.textContent = statusText();
  lockEl.classList.toggle('hidden', peek === null);
  if (peek === lockShown) return;
  lockShown = peek;
  if (peek === null) return lockEl.replaceChildren();
  const loc = LOCATIONS[peek];
  lockEl.replaceChildren(h('div', { class: 'scene-lock-card' }, icon('lock', 'Locked'), h('b', { text: loc.name }), h('span', { text: unlockText(loc.unlock, getSave()) })));
}

export const pondBusy = (): boolean => phase !== 'idle' && phase !== 'result';

function setPhase(p: Phase): void {
  phase = p;
  hookBtn.classList.toggle('hidden', p !== 'bite');
  hookBtn.disabled = false;
  landBtn.classList.toggle('hidden', !(p === 'landing' && landRetry));
  landBtn.textContent = lostOnLine() ? 'Reel in the line' : 'Land it';
  reelEl.classList.toggle('hidden', p !== 'reeling');
  statusEl.textContent = statusText();
  emit();
}

function statusText(): string {
  switch (phase) {
    case 'casting':
      return 'Casting…';
    case 'waiting':
      return 'Waiting for a bite…';
    case 'bite':
      return 'Bite! Hook it!';
    case 'landing':
      if (lostOnLine()) return landRetry ? 'The fish is gone: reel in the line to cast again' : 'Reeling in the empty line…';
      return landRetry ? 'At the pier: land it to claim it' : reveal || !predicted ? 'Setting the hook…' : 'Landing your catch…';
    case 'reeling':
      return 'Fish on! Reel it in';
    default: {
      const peek = peekLocation();
      return peek === null ? 'Ready to cast' : `${LOCATIONS[peek].name} · locked`;
    }
  }
}

// ------------------------------------------------------------------ cast → bite → hook

/** What the player did in the current fight. Shown on the catch card; in local play it also decides the result. */
interface Fight {
  d: Difficulty;
  /** Seconds from the float dipping to the hook. */
  reaction: number;
  clean: boolean;
  /** 0 for the first try at this fish. Only a cast from before fights were checked has a second one. */
  attempt: number;
  accuracy: number;
}
let fight: Fight | null = null;
let biteAt = 0;
/**
 * Bites of the fish on the line so far: a hook set too late is another bite, on the contracts. For a cast from
 * before fights were checked it also counts the fights, each one a little easier than the last.
 */
let attempt = 0;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const round = (v: number, digits: number): number => Number(v.toFixed(digits));
/** The cast whose bite the telemetry already has: a cast picked up again after a reload is not counted twice in one visit. */
let biteTracked: bigint | null = null;
function trackChainBite(ok: boolean, loc: number): void {
  const nonce = world.cast?.nonce ?? null;
  if (nonce !== null && nonce === biteTracked) return;
  biteTracked = nonce;
  track({ e: 'bite', ok, loc });
}
const hookedRarity = (hk: Hooked) => (hk.prize ? BLEND_PRIZE.fightRarity : SPECIES[hk.speciesId].rarity);
const difficultyNow = (): Difficulty => difficultyOf(hookedRarity(hooked!), LOCATIONS[ticket!.locationId].tier);
/** A lure with catch makes fish find it sooner. */
const quickness = (t: CastTicket): number => 1 - Math.min(0.4, Math.max(0, t.totals.lure.catch) * 0.03);

function doCast(): void {
  if (pondBusy()) return;
  if (CHAIN) return void castOnChain();
  hideOverlay();
  const r = act(
    (s) => startCast(s, Date.now()),
    (x) => x.save,
  );
  if (!r) return;
  ticket = r.ticket;
  trackCast(r.save, r.ticket.locationId);
  scene.setSpot(ticket.locationId);
  scene.setPhase('casting');
  setPhase('casting');
  timer = setTimeout(() => {
    scene.setPhase('waiting');
    setPhase('waiting');
    timer = setTimeout(onWaitOver, biteDelay(LOCATIONS[r.ticket.locationId].tier, quickness(r.ticket), Math.random) * 1000);
  }, 900);
}

function onWaitOver(): void {
  if (!ticket) return;
  const bit = rollBite(ticket, Math.random);
  track({ e: 'bite', ok: bit, loc: ticket.locationId });
  if (!bit) {
    scene.setPhase('idle');
    finish();
    showMessage('Nothing is biting', 'The float never moved. A lure with catch brings more bites.');
    return;
  }
  hooked = hookFish(getSave(), ticket, Math.random);
  attempt = 0;
  beginBite();
}

/** The float dips: the player has a short window to set the hook. Rarer fish and rougher water leave less time. */
function beginBite(): void {
  if (!ticket || !hooked) return;
  scene.setPhase('bite');
  setPhase('bite');
  biteAt = performance.now();
  // On the contracts the fish cannot be lost to slow hands, so after three misses it simply stays on.
  if (CHAIN && attempt >= 3) return;
  timer = setTimeout(onHookMissed, hookWindow(difficultyNow()) * 1000);
}

function onHookMissed(): void {
  if (phase !== 'bite') return;
  if (ticket && hooked) track({ e: 'hook', ok: false, reaction: null, window: hookWindow(difficultyNow()), clean: false, d: difficultyNow() });
  if (CHAIN) {
    attempt++;
    scene.setPhase('waiting');
    setPhase('waiting');
    showMessage('Too slow!', 'It dropped the lure, but it is still circling. Watch the float and hit Hook! the moment it dips.');
    retryOrSettle();
    return;
  }
  commit(recordEscape(getSave()));
  scene.setPhase('missed');
  finish();
  showMessage('Too slow!', 'The fish spat the hook. Hit "Hook!" as soon as the float dips.');
}

function doHook(): void {
  // a cast that has to be reeled in is never settled before its fight: with no prediction there is nothing to hook yet
  if (CHAIN && !predicted) return strict ? undefined : void legacyHookOnChain();
  if (phase !== 'bite' || !ticket || !hooked) return;
  clearTimeout(timer);
  const d = difficultyNow();
  const reaction = (performance.now() - biteAt) / 1000;
  const clean = isCleanHook(reaction, d);
  const old = CHAIN && !strict;
  // a clean hook is a head start only in the old flow: the contract cannot check how fast a hook was set
  fight = { d, reaction, clean: old && clean, attempt: old ? attempt : 0, accuracy: 0 };
  track({ e: 'hook', ok: true, reaction: round(reaction, 3), window: hookWindow(d), clean, d });
  if (old) {
    scene.setPhase('reeling');
    setPhase('reeling');
    // a retried fish is tired: each try widens the green band and softens its jerks
    startReel(reelParams(d, ticket.totals.zone, attempt), clean ? CLEAN_HOOK_HEAD_START : 0, d);
    return;
  }
  if (hooked.prize) return haulPrize();
  // on the contracts the fight is the one fixed with the cast, or there is none to play
  if (CHAIN && predicted?.kind !== 'caught') return;
  // on the contracts the fight is the cast's own, fixed with it; in the local game it is drawn here
  const plan: CastFight = predicted?.kind === 'caught' ? predicted.fight : { seed: (BigInt(Math.floor(Math.random() * 0xffff_fffe)) + 1n) << 224n, difficulty: d, green: Math.round(greenWidth(ticket.totals.zone) * U) };
  startFight(plan, d);
}

/** A bottle does not fight: it is hauled straight in. */
function haulPrize(): void {
  const hk = hooked;
  if (!hk?.prize) return;
  if (CHAIN) return void settleOnChain();
  const amount = hk.prize;
  const ok = act((s) => landPrize(s, hk), (x) => x) !== undefined;
  scene.setPhase('caught');
  finish();
  if (ok) {
    phase = 'result';
    showPrize(amount);
  }
}

// ------------------------------------------------------------------ the same flow on the contracts
//
// cast() transaction → wait for the randomness block → the outcome is now fixed and public, so the client works
// it out (game/chainOutcome.ts) and plays bite, hook and fight on it → reel(recording) transaction settles.
// The contract decides what is on the hook, and replays the recording to decide whether it was landed: a fish is
// minted for a recording that lands it and for nothing else. A lost fight is settled too, with its own recording:
// that is what takes the cast out of the water.
//
// A cast from before fights were checked is settled as it always was: the fight decides only how soon.

/** The pending cast as the client predicts it; null while unknown (then the fallback path settles first). */
let predicted: CastOutcome | null = null;
/**
 * The cast in the water has to be reeled in: one fight, and a fish that is not landed is gone. It is the cast's
 * own word, written by the game when the cast was made (`world.cast.fight`), not a guess from the release.
 */
let strict = false;
/** A fight needs this many blocks to be played and sent: a minute of ticks and the transaction. With fewer left the fish is let go. */
const MIN_FIGHT_BLOCKS = 75;
let fightClock: ReturnType<typeof setInterval> | undefined;

const fightScope = (me: string): FightScope => ({ chainId: CHAIN_ID, game: deployment?.game ?? '', address: me });
/** What this browser knows of the fight for the cast in the water (play/fightLog.ts). */
function fightRecord(): FightRecord | null {
  const me = state.wallet?.address;
  return me && world.cast ? fightOf(fightScope(me), world.cast.nonce) : null;
}
/** A fish was on the line and its one fight is over without a landing: all that is left is to take the line in. */
const lostOnLine = (): boolean => strict && predicted?.kind === 'caught' && fightRecord()?.landed !== true;
/** A pending cast known to hold nothing (no bite, or its block expired). The next cast() settles it for free. */
let deadNonce: bigint | null = null;
/** The settlement transaction did not go through: the fish waits at the pier for another try. */
let landRetry = false;
/** Fallback path only: what to show once the replayed fight ends. */
let reveal: (() => void) | null = null;

async function castOnChain(): Promise<void> {
  hideOverlay();
  const s = getSave();
  const me = state.wallet?.address;
  const locationId = s.location;
  const totalsNow = currentTotals(s, locationId);
  scene.setSpot(locationId);
  scene.setPhase('casting');
  setPhase('casting');
  // with the hunt switched on, the same cast goes through the season hunt: the game makes it exactly as always
  // (its events are in the receipt), and it is numbered as an attempt at the season's fish as well
  const season = huntCastArmed();
  const receipt = season ? await castForHunt(season, locationId) : await tx('Cast', { functionName: 'cast', args: [locationId] }, true);
  if (!receipt) {
    scene.setPhase('idle');
    finish();
    return;
  }
  // cast() settles a finished earlier cast first; normally that one was an empty hook the player already saw
  const earlier = me ? outcomeOf(receipt, me) : null;
  if (earlier?.kind === 'caught') toast(`Your previous cast landed a ${SPECIES[earlier.speciesId]?.name ?? 'fish'}: it is in the keepnet`, 'ok');
  else if (earlier?.kind === 'bottle') toast(`Your previous cast landed a bottle: +${earlier.amount} BLEND`, 'ok');
  ticket = { locationId, totals: totalsNow };
  await refresh();
  trackCast(getSave(), locationId);
  if (world.cast) void watchChainCast(world.cast.targetBlock);
  else finish();
}

/** Waits for the randomness block, works out what the cast holds, and stages the bite. */
async function watchChainCast(target: bigint): Promise<void> {
  predicted = null;
  hooked = null;
  strict = !!world.cast?.fight;
  scene.setPhase('waiting');
  setPhase('waiting');
  const since = performance.now();
  await waitPastBlock(target, () => phase === 'waiting');
  if (phase !== 'waiting') return;
  let out: Preview | null = null;
  for (let tries = 1; ; tries++) {
    try {
      out = await previewCast();
    } catch (e) {
      console.warn(`[preview] could not predict the cast${strict ? ', asking again' : ', settling first instead'}`, e);
    }
    // a cast that has to be reeled in is never settled blind: what it holds is asked until the chain says
    if (out || !strict) break;
    await sleep(Math.min(8_000, 1_500 * tries));
    if (phase !== 'waiting') return;
  }
  if (phase !== 'waiting' || !ticket) return;
  if (!out) {
    scene.setPhase('bite');
    setPhase('bite');
    return;
  }
  // a fight this browser already knows of: the cast has had its one try, and is not given another
  const known = strict && out.kind === 'caught' ? fightRecord() : null;
  if (known && out.kind === 'caught') {
    predicted = out;
    hooked = { speciesId: out.speciesId, weight: out.weight, isSpecial: out.special };
    fight = null;
    landRetry = true;
    setPhase('landing');
    if (!known.landed) showMessage('The fish got away', known.inputs ? 'This fight was lost. Reel in the line to cast again.' : 'The fight was left unfinished, and the fish did not wait. Reel in the line to cast again.', 5_000);
    return;
  }
  // the block arrives in a couple of seconds; fish do not always bite that fast
  const wait = biteDelay(LOCATIONS[ticket.locationId].tier, quickness(ticket), Math.random) * 1000 - (performance.now() - since);
  if (wait > 0) await sleep(wait);
  if (phase !== 'waiting' || !ticket) return;
  if (out.kind !== 'expired' && out.kind !== 'escaped') trackChainBite(out.kind !== 'missed', ticket.locationId);
  if (out.kind === 'missed' || out.kind === 'expired' || out.kind === 'escaped') {
    deadNonce = world.cast?.nonce ?? null;
    scene.setPhase('idle');
    finish();
    if (out.kind === 'expired') showMessage('Too late', 'Too much time passed: the chain no longer keeps the randomness for this cast, and the fish is gone with it.');
    else if (out.kind === 'escaped') showMessage('It got away', `The ${SPECIES[out.speciesId]?.name ?? 'fish'} was left on the line too long: a hooked fish has to be reeled in within about ten minutes of the cast. No transaction needed: just cast again.`, 5_000);
    else showMessage('Nothing is biting', 'The float never moved. A lure with catch brings more bites. No transaction needed: just cast again.');
    return;
  }
  predicted = out;
  attempt = 0;
  hooked = out.kind === 'bottle' ? { speciesId: -1, weight: 0, isSpecial: false, prize: out.amount } : { speciesId: out.speciesId, weight: out.weight, isSpecial: out.special };
  beginBite();
  if (strict && out.kind === 'caught') watchFightClock();
}

/**
 * A fish on the line can be landed for a limited number of blocks (`world.fights.blocks` after its bite). While it
 * waits to be hooked the clock is watched, and when too little is left for a fight the fish is let go, here, as
 * the game is about to do anyway: a fight that could only arrive too late is not started.
 */
function watchFightClock(): void {
  clearInterval(fightClock);
  const check = (): void =>
    void fightBlocksLeft()
      .then((left) => {
        if (!strict || predicted?.kind !== 'caught' || (phase !== 'bite' && phase !== 'waiting')) return clearInterval(fightClock);
        if (left >= MIN_FIGHT_BLOCKS) return;
        clearInterval(fightClock);
        clearTimeout(timer);
        const me = state.wallet?.address;
        // written down as a fight that was never played: what is sent for it is the empty recording
        if (me && world.cast) fightStarted(fightScope(me), world.cast.nonce);
        landRetry = true;
        scene.setPhase('missed');
        setPhase('landing');
        showMessage('It got away', 'The fish was left on the line too long: a hooked fish has to be reeled in within about ten minutes of the cast. Reel in the line to cast again.', 5_000);
      })
      .catch(() => undefined);
  fightClock = setInterval(check, 8_000);
  check();
}

/** A cast left in the water by an earlier visit (or another tab) is picked up again. */
function resumeChainCast(): void {
  if (!CHAIN || phase !== 'idle' || !world.cast || !state.wallet || world.cast.nonce === deadNonce) return;
  const s = getSave();
  ticket = { locationId: world.cast.locationId, totals: currentTotals(s, world.cast.locationId) };
  void watchChainCast(world.cast.targetBlock);
}

/** After a missed hook or a lost fight: bite again shortly, unless the cast is about to expire. */
function retryOrSettle(): void {
  const again = (): void => {
    if (phase === 'waiting' && predicted) beginBite();
  };
  timer = setTimeout(again, 2900 + Math.random() * 1400);
  // a fish that has to be reeled in cannot be hauled in without its fight: its clock is watched elsewhere
  if (strict && predicted?.kind === 'caught') return;
  void blocksUntilExpiry()
    .then((left) => {
      if (left < 45 && phase === 'waiting' && predicted) {
        clearTimeout(timer);
        showMessage('No time left', 'This cast is about to expire, so the fish is hauled straight in.');
        void settleOnChain();
      }
    })
    .catch(() => undefined);
}

/**
 * The settlement: one transaction. Whatever the contract says is the result.
 *
 * For a fish that has to be reeled in it carries the recording of the one fight this browser knows of, won or
 * lost: the contract replays it, mints the fish if it was landed and lets it go if not. A bottle and a cast from
 * before fights were checked need no recording.
 */
async function settleOnChain(): Promise<void> {
  const me = state.wallet?.address;
  if (!me || (phase === 'landing' && !landRetry)) return;
  if (strict && !predicted) return;
  const fishOn = strict && predicted?.kind === 'caught';
  const rec = fishOn ? fightRecord() : null;
  // never without its fight: an empty recording would let the fish go
  if (fishOn && !rec) return;
  const bottle = strict && predicted?.kind === 'bottle';
  landRetry = false;
  setPhase('landing');
  const before = getSave();
  const receipt = await tx(rec && !rec.landed ? 'Reel in the line' : 'Land the catch', bottle ? haulCall(me) : reelCall(rec ? recordingOf(rec) : '0x'), true);
  if (!receipt) {
    // rejected or failed: the cast is still there for as long as the chain keeps it
    await refresh();
    if (world.cast && bottle) {
      // the game would not haul it in as a bottle. The pool may have changed since it was looked at, and then
      // what bit is a fish: the cast is looked at again
      return void watchChainCast(world.cast.targetBlock);
    }
    if (world.cast) {
      landRetry = true;
      setPhase('landing');
    } else {
      // the cast is no longer in the water: somebody reeled it in for the player (anyone may once nothing on it
      // is fighting; the operator does it for casts that are about to expire, and before a change of rules)
      scene.setPhase('idle');
      finish();
      showMessage('Already reeled in', fishOn ? 'This cast is already closed. A fish that was not landed in time is gone.' : 'This cast was reeled in for you. Whatever it held is in your keepnet.');
    }
    return;
  }
  const out = outcomeOf(receipt, me);
  await refresh();
  // the day's challenges are read from the same block: a moment for them, so the catch card can say what it completed
  if (out?.kind === 'caught') await dailySettled();
  void refreshStandings();
  const guess = predicted;
  predicted = null;
  const same = guess && out && guess.kind === out.kind && (guess.kind !== 'caught' || (out.kind === 'caught' && guess.speciesId === out.speciesId && guess.weight === out.weight && guess.quality === out.quality));
  const lostAsSeen = out?.kind === 'escaped' && !!rec && !rec.landed;
  if (guess && !same && !lostAsSeen) console.warn('[preview] predicted', guess, 'but the contract settled', out, '— the contract is right');
  if (out?.kind === 'escaped') {
    // a fight the page saw lost has had its say already; this is for one the contract judged otherwise
    scene.setPhase(lostAsSeen ? 'idle' : 'missed');
    finish();
    if (!lostAsSeen) showMessage('It got away at the pier', 'The game replayed your fight and did not count it as a landing: it reached the chain too late, or the page and the contract disagree. No fish this time.', 6_000);
    return;
  }
  if (!out || out.kind === 'missed' || out.kind === 'expired') {
    scene.setPhase('missed');
    finish();
    if (out?.kind === 'expired') showMessage('Too late', 'Too much time passed: the chain no longer keeps the randomness for this cast, and the fish is gone with it.');
    else showMessage('It got away!', 'Nothing stayed on the hook this time.');
    return;
  }
  const note = fightNote();
  scene.setPhase('caught');
  finish();
  phase = 'result';
  if (out.kind === 'bottle') return showPrize(out.amount);
  const landing = landingFrom(out, before);
  trackLanding(landing);
  showCatch(landing, note);
}

type CaughtOutcome = Extract<NonNullable<ReturnType<typeof outcomeOf>>, { kind: 'caught' }>;

/** The catch card's data for a fish the contract just minted. `before` is the save from before the settlement. */
function landingFrom(out: CaughtOutcome, before: ReturnType<typeof getSave>): Landing {
  const sp = SPECIES[out.speciesId];
  const after = getSave();
  const quality = QUALITIES[out.quality] ?? 'B';
  const prev = before.dex[out.speciesId];
  return {
    save: after,
    fish: after.fish.find((f) => f.id === out.fishId) ?? {
      id: out.fishId,
      speciesId: out.speciesId,
      rarity: sp.rarity,
      weight: out.weight,
      quality,
      locationId: out.locationId,
      caughtAt: Date.now(),
      sellPrice: fishPrice(sp, out.weight, quality),
      tournamentScore: out.score,
      isFavorite: false,
      isSpecial: out.special,
    },
    newSpecies: !prev,
    newBest: !!prev && out.weight > prev.best,
    newOverallRecord: !!before.records.overall && out.weight > before.records.overall.weight,
    levelUp: levelOf(after.xp) > levelOf(before.xp) ? levelOf(after.xp) : null,
    unlocked: out.unlocked,
    countedThisWeek: out.counted,
  };
}

/** One line about how the player fought, for the catch card. */
function fightNote(): string | null {
  const f = fight;
  if (!f) return null;
  const parts = [`hook ${f.reaction.toFixed(2)} s${f.clean ? ' (clean)' : ''}`, `${Math.round(f.accuracy * 100)}% in the green`];
  if (f.attempt > 0) parts.push(`try ${f.attempt + 1}`);
  return `Your fight: ${parts.join(' · ')}`;
}

/**
 * Fallback when the outcome could not be predicted (RPC trouble): settle first, then play the fight as a replay
 * of a catch that is already final.
 */
async function legacyHookOnChain(): Promise<void> {
  if (phase !== 'bite') return;
  const me = state.wallet?.address;
  if (!me) return;
  setPhase('landing');
  const before = getSave();
  const receipt = await tx('Reel in', reelCall(), true);
  if (!receipt) {
    // rejected or failed: the fish is still on the line, for as long as the chain keeps the hash of its randomness block
    await refresh();
    if (world.cast) setPhase('bite');
    else {
      scene.setPhase('idle');
      finish();
    }
    return;
  }
  const out = outcomeOf(receipt, me);
  await refresh();
  if (out?.kind === 'caught') await dailySettled();
  void refreshStandings();
  if (!out || out.kind === 'missed' || out.kind === 'expired' || out.kind === 'escaped') {
    scene.setPhase('missed');
    finish();
    if (out?.kind === 'expired') showMessage('Too late', 'Too much time passed: the chain no longer keeps the randomness for this cast, and the fish is gone with it.');
    else showMessage('It got away!', 'Nothing stayed on the hook this time. A lure with catch brings more bites.');
    return;
  }
  if (out.kind === 'bottle') {
    hooked = { speciesId: -1, weight: 0, isSpecial: false, prize: out.amount };
    reveal = () => showPrize(out.amount);
  } else {
    const landing = landingFrom(out, before);
    trackLanding(landing);
    hooked = { speciesId: out.speciesId, weight: out.weight, isSpecial: out.special };
    reveal = () => showCatch(landing);
  }
  scene.setPhase('reeling');
  setPhase('reeling');
  fight = null;
  const d = difficultyOf(hookedRarity(hooked), LOCATIONS[ticket?.locationId ?? before.location].tier);
  startReel(reelParams(d, (ticket ?? { totals: currentTotals(before) }).totals.zone), 0, d);
}

function finish(): void {
  clearTimeout(timer);
  clearInterval(fightClock);
  strict = false;
  ticket = null;
  hooked = null;
  holding = false;
  setPhase('idle');
}

// ------------------------------------------------------------------ the reel fight
//
// Two engines draw into the same panel. `startFight` is the fight: integer ticks, one try, recorded. `startReel`
// is the older floating-point one, kept for casts from before fights were checked and for the replay of a catch
// that was settled first; nothing it does reaches a contract.

let holding = false;
let reel: ReelState | null = null;
let reelP: ReelParams | null = null;
/** Difficulty of the fight on screen, for the telemetry. */
let reelD: Difficulty = 0;
let promptEl: HTMLElement;
let needleEl: HTMLElement;
let gaugeEl: HTMLElement;
let fishEl: HTMLElement;
let tautEl: HTMLElement;
let holdBtn: HTMLButtonElement;

const PULL = ['A light tug', 'A steady pull', 'A strong fish', 'A heavy fish!', 'A monster!', 'Something unreal…'];

function startReel(p: ReelParams, headStart: number, d: Difficulty): void {
  fs = null;
  fp = null;
  reelEl.classList.remove('ticks', 'lost', 'snapped', 'slack');
  reelP = p;
  reelD = d;
  reel = reelStart(Math.random, headStart);
  promptEl = h('div', { class: 'reel-prompt', attrs: { role: 'status', 'aria-live': 'assertive' } });
  needleEl = h('div', { class: 'gauge-needle' });
  const pc = (v: number): string => `${v * 100}%`;
  gaugeEl = h(
    'div',
    { class: 'gauge', attrs: { 'aria-hidden': 'true' } },
    h('div', { class: 'gauge-seg slack', style: `width:${pc(p.green[0])}` }, h('span', { text: 'Slack' })),
    h('div', { class: 'gauge-seg green', style: `width:${pc(p.green[1] - p.green[0])}` }, h('span', { text: 'Good' })),
    h('div', { class: 'gauge-seg red', style: `width:${pc(1 - p.green[1])}` }, h('span', { text: 'Snap!' })),
    needleEl,
  );
  // the fish is dragged in by the hook in its mouth, on a taut line from the angler
  fishEl = h('div', { class: 'haul-fish' }, icon('hook'), icon('fish'));
  tautEl = h('div', { class: 'haul-taut' });
  holdBtn = h('button', { class: 'btn btn-primary reel-hold', text: 'Hold to reel' });
  const down = (e: Event): void => {
    e.preventDefault();
    holding = true;
  };
  holdBtn.addEventListener('pointerdown', down);
  holdBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  const parts = [
    promptEl,
    h('div', { class: 'reel-label' }, h('span', { text: 'Line tension' }), h('span', { class: 'muted', text: `${hooked!.prize ? 'Something odd on the line…' : PULL[fight?.d ?? hookedRarity(hooked!)]}${headStart > 0 ? ' · clean hook: head start' : ''}` })),
    CHAIN
      ? h('div', {
          class: 'reel-note',
          text: reveal
            ? 'Already yours: the contract decided this catch. The fight is for the joy of it.'
            : fight && fight.attempt > 0
              ? `Try ${fight.attempt + 1}: it is tiring, the green zone is wider now.`
              : 'The contract has fixed what is on the hook. Land it to claim it: a lost fight means another try, not a lost fish.',
        })
      : null,
    gaugeEl,
    h('div', { class: 'haul', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'haul-you', text: 'You' }), h('div', { class: 'haul-line' }, tautEl, fishEl)),
    holdBtn,
  ];
  reelEl.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
  paintReel();
  let last = performance.now();
  const frame = (now: number): void => {
    if (phase !== 'reeling' || !reel || !reelP) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    reel = reelStep(reel, holding, dt, reelP, Math.random);
    paintReel();
    if (reel.result === 'fighting') requestAnimationFrame(frame);
    else endReel(reel);
  };
  requestAnimationFrame(frame);
}

/** One plain instruction at a time: what to do with the button right now. */
function promptFor(r: ReelState, p: ReelParams): { text: string; cls: string } {
  const band = bandOf(r.tension, p);
  if (band === 'red') return { text: 'Let go! The line is about to snap', cls: 'bad' };
  if (r.mood === 'pull') return band === 'slack' ? { text: 'It jerks: take up the slack gently', cls: 'warn' } : { text: 'It jerks: let go!', cls: 'warn' };
  if (r.mood === 'warn') return { text: 'Careful: it is about to jerk', cls: 'warn' };
  if (band === 'slack') return { text: 'Hold to reel in', cls: '' };
  return { text: 'Good! Keep the needle in the green', cls: 'good' };
}

function paintReel(): void {
  if (!reel || !reelP) return;
  needleEl.style.left = `${reel.tension * 100}%`;
  const at = `${Math.min(1, reel.dist / START_DIST) * 100}%`;
  fishEl.style.left = at;
  tautEl.style.width = at;
  tautEl.classList.toggle('slack', bandOf(reel.tension, reelP) === 'slack');
  const pr = promptFor(reel, reelP);
  if (promptEl.textContent !== pr.text) promptEl.textContent = pr.text;
  promptEl.className = `reel-prompt ${pr.cls}`;
  gaugeEl.classList.toggle('pulling', reel.mood === 'pull');
  gaugeEl.classList.toggle('warning', reel.mood === 'warn');
  fishEl.classList.toggle('pulling', reel.mood === 'pull');
  holdBtn.classList.toggle('down', holding);
}

/** The end of a fight in the older flow: a replay of a settled catch, or one try of several at a fish that cannot be lost. */
function endReel(r: ReelState): void {
  if (fight) fight.accuracy = accuracy(r);
  track({
    e: 'fight',
    result: r.result === 'landed' ? 'landed' : r.lost ?? 'slack',
    seconds: round(r.t, 2),
    accuracy: round(accuracy(r), 3),
    d: reelD,
    green: reelP ? round(reelP.green[1] - reelP.green[0], 3) : 0,
    attempt,
    replay: reveal !== null,
  });
  if (reveal) {
    // fallback path: the catch was settled before the fight, so the fight was only a replay
    const show = reveal;
    reveal = null;
    scene.setPhase('caught');
    finish();
    phase = 'result';
    show();
    return;
  }
  if (r.result === 'landed') return void settleOnChain();
  attempt++;
  if (attempt >= 3) {
    showMessage('Worn out at last', 'Three rounds were enough: it has no fight left. Hauling it in.');
    return void settleOnChain();
  }
  scene.setPhase('waiting');
  setPhase('waiting');
  showMessage(
    r.lost === 'snapped' ? 'Too much tension!' : 'It ran with your line!',
    r.lost === 'snapped' ? 'You had to give line to save it. The hook held: it will bite again, and it is tiring.' : 'The line went slack and it took off. The hook held: it will bite again, and it is tiring.',
  );
  retryOrSettle();
}

// ------------------------------------------------------------------ one try

let fs: FightState | null = null;
let fp: FightParams | null = null;
/** One bit per tick: was the player reeling. This is the fight, as far as the contract is concerned. */
let recording: boolean[] = [];
/** The rule is on screen, and the fish waits, for this long before the first tick. */
const READY_MS = 2_400;
const LOSS_MS = 1_100;
type Lost = 'snapped' | 'slack';

/**
 * The fight: fixed 50 ms ticks of the integer machine the contract replays (game/fight.ts), one recorded bit a
 * tick. The red part of the gauge only warns; the line snaps when the needle reaches its end, and the fish swims
 * away when the line has been slack for too long. Either way that fish is gone.
 */
function startFight(plan: CastFight, d: Difficulty): void {
  reel = null;
  reelP = null;
  reelD = d;
  const p = (fp = fightParams(plan.difficulty, plan.green));
  fs = fightStart(plan.seed);
  recording = [];
  holding = false;
  // from this moment the cast has had its fight: a page that comes back to it does not get another
  const me = state.wallet?.address;
  if (CHAIN && me && world.cast) fightStarted(fightScope(me), world.cast.nonce);
  promptEl = h('div', { class: 'reel-prompt', attrs: { role: 'status', 'aria-live': 'assertive' } });
  needleEl = h('div', { class: 'gauge-needle' });
  const pc = (v: number): string => `${(v / U) * 100}%`;
  gaugeEl = h(
    'div',
    { class: 'gauge', attrs: { 'aria-hidden': 'true' } },
    h('div', { class: 'gauge-seg slack', style: `width:${pc(p.lo)}` }, h('span', { text: 'Slack' })),
    h('div', { class: 'gauge-seg green', style: `width:${pc(p.hi - p.lo)}` }, h('span', { text: 'Good' })),
    // the red warns; the striped end of it is where the line snaps
    h('div', { class: 'gauge-seg red', style: `width:${pc(U - p.hi)}` }, h('span', { text: 'Risk' }), h('span', { class: 'gauge-snap', text: 'Snap' })),
    needleEl,
  );
  fishEl = h('div', { class: 'haul-fish' }, icon('hook'), icon('fish'));
  tautEl = h('div', { class: 'haul-taut' });
  holdBtn = h('button', { class: 'btn btn-primary reel-hold', text: 'Hold to reel' });
  holdBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    holding = true;
  });
  holdBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  reelEl.classList.remove('lost', 'snapped', 'slack');
  reelEl.classList.add('ticks');
  reelEl.replaceChildren(
    promptEl,
    h('div', { class: 'reel-label' }, h('span', { text: 'Line tension' }), h('span', { class: 'muted', text: PULL[d] })),
    h('div', { class: 'reel-note reel-rule' }, h('b', { text: 'One try. ' }), 'If the needle reaches the end of the red, the line snaps; if the line stays slack, the fish swims away. Either way it is gone for good. The red only warns: let go and the needle comes back.'),
    gaugeEl,
    h('div', { class: 'haul', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'haul-you', text: 'You' }), h('div', { class: 'haul-line' }, tautEl, fishEl)),
    holdBtn,
  );
  scene.setPhase('reeling');
  setPhase('reeling');
  paintFight();
  const startAt = performance.now() + READY_MS;
  let last = startAt;
  let acc = 0;
  const frame = (now: number): void => {
    if (phase !== 'reeling' || !fs || !fp) return;
    if (now < startAt) {
      // the rule first: the fish does not move until the count is over
      const text = `Get ready… ${Math.ceil((startAt - now) / (READY_MS / 3))}`;
      if (promptEl.textContent !== text) promptEl.textContent = text;
      promptEl.className = 'reel-prompt warn';
      holdBtn.classList.toggle('down', holding);
      return void requestAnimationFrame(frame);
    }
    // fixed ticks: the contract replays exactly these, one recorded bit each
    acc += Math.min(250, now - last);
    last = now;
    while (acc >= TICK_MS && fs.result === 'fighting' && recording.length < MAX_TICKS) {
      recording.push(holding);
      fightTick(fs, holding, fp);
      acc -= TICK_MS;
    }
    paintFight();
    if (fs.result === 'fighting' && recording.length < MAX_TICKS) requestAnimationFrame(frame);
    else endFight();
  };
  requestAnimationFrame(frame);
}

function fightPrompt(s: FightState, p: FightParams): { text: string; cls: string } {
  const band = fightBand(s.tension, p);
  if (band === 'red') return { text: 'Let go! The line is about to snap', cls: 'bad' };
  if (s.mood === JERK) return band === 'slack' ? { text: 'It jerks: take up the slack gently', cls: 'warn' } : { text: 'It jerks: let go!', cls: 'warn' };
  if (s.mood === TELL) return { text: 'Careful: it is about to jerk', cls: 'warn' };
  if (band === 'slack') return { text: 'Hold to reel in', cls: '' };
  return { text: 'Good! Keep the needle in the green', cls: 'good' };
}

function paintFight(): void {
  if (!fs || !fp) return;
  needleEl.style.left = `${Math.min(100, (fs.tension / U) * 100)}%`;
  const at = `${Math.min(1, fs.dist / 70_000) * 100}%`;
  fishEl.style.left = at;
  tautEl.style.width = at;
  tautEl.classList.toggle('slack', fightBand(fs.tension, fp) === 'slack');
  const pr = fightPrompt(fs, fp);
  if (promptEl.textContent !== pr.text) promptEl.textContent = pr.text;
  promptEl.className = `reel-prompt ${pr.cls}`;
  gaugeEl.classList.toggle('pulling', fs.mood === JERK);
  gaugeEl.classList.toggle('warning', fs.mood === TELL);
  fishEl.classList.toggle('pulling', fs.mood === JERK);
  holdBtn.classList.toggle('down', holding);
}

/** The line parts, or goes limp, and the fish is off: a moment to see it before anything is said. */
function playLoss(lost: Lost, then: () => void): void {
  holding = false;
  holdBtn.disabled = true;
  gaugeEl.classList.remove('pulling', 'warning');
  fishEl.classList.remove('pulling');
  reelEl.classList.add('lost', lost);
  promptEl.textContent = lost === 'snapped' ? 'The line snapped!' : 'It swam away!';
  promptEl.className = 'reel-prompt bad';
  scene.setPhase('missed');
  timer = setTimeout(then, LOSS_MS);
}

function showLoss(lost: Lost, chain: boolean): void {
  const cost = `No catch and no XP for it; the energy of the cast${chain ? ', the rod wear and the lure use' : ' and the wear of your tackle'} are spent. Cast again when you are ready.`;
  if (lost === 'snapped') showMessage('The line snapped! The fish escaped.', `The needle reached the end of the red. Let go as soon as it enters the red, and the moment the fish warns of a jerk. ${cost}`, 6_000);
  else showMessage('The fish escaped!', `The line stayed slack too long and it swam away. Hold to reel and keep the needle in the green. ${cost}`, 6_000);
}

function endFight(): void {
  const s = fs;
  if (!s || !fp) return;
  holding = false;
  const landed = s.result === 'landed';
  // a fight that ran its full minute without an end is a fish that was never brought in
  const lost: Lost = s.result === 'snapped' ? 'snapped' : 'slack';
  const share = s.ticks > 0 ? s.good / s.ticks : 0;
  if (fight) fight.accuracy = share;
  track({ e: 'fight', result: landed ? 'landed' : lost, seconds: round((s.ticks * TICK_MS) / 1000, 2), accuracy: round(share, 3), d: reelD, green: round((fp.hi - fp.lo) / U, 3), attempt: 0, replay: false });
  if (CHAIN) {
    // the recording is what the contract will replay; it is kept so that nothing else is ever sent for this cast
    const me = state.wallet?.address;
    if (me && world.cast) fightEnded(fightScope(me), world.cast.nonce, packInputs(recording), landed);
    if (landed) return void settleOnChain();
    playLoss(lost, () => {
      showLoss(lost, true);
      void settleOnChain();
    });
    return;
  }
  const t = ticket;
  const hk = hooked;
  if (!t || !hk) return finish();
  if (!landed) {
    commit(recordEscape(getSave()));
    playLoss(lost, () => {
      finish();
      showLoss(lost, false);
    });
    return;
  }
  const quality = qualityOf(share);
  let landing: Landing;
  try {
    landing = landFish(getSave(), t, hk, quality, Date.now());
  } catch (e) {
    finish();
    if (e instanceof GameError) toast(e.message, 'err');
    else throw e;
    return;
  }
  commit(landing.save);
  trackLanding(landing);
  const note = fightNote();
  scene.setPhase('caught');
  finish();
  phase = 'result';
  showCatch(landing, note);
}

function onKey(e: KeyboardEvent): void {
  if (e.code !== 'Space' && e.code !== 'Enter') return;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (phase === 'bite') {
    e.preventDefault();
    doHook();
  } else if (phase === 'reeling') {
    e.preventDefault();
    holding = true;
  }
}
function onKeyUp(e: KeyboardEvent): void {
  if (e.code !== 'Space' && e.code !== 'Enter') return;
  if (phase === 'reeling' || holding) {
    e.preventDefault();
    holding = false;
  }
}

// ------------------------------------------------------------------ overlays

/** Stops the bottle reveal's animation loop, while one is on screen. */
let stopPrize: (() => void) | null = null;

function hideOverlay(): void {
  clearTimeout(overlayTimer);
  stopPrize?.();
  stopPrize = null;
  overlayEl.classList.add('hidden');
  overlayEl.replaceChildren();
  if (phase === 'result') {
    phase = 'idle';
    scene.setPhase('idle');
    statusEl.textContent = statusText();
    emit();
  }
}

let overlayTimer: ReturnType<typeof setTimeout> | undefined;
function showMessage(title: string, text: string, ms = 2_600): void {
  clearTimeout(overlayTimer);
  overlayEl.replaceChildren(h('div', { class: 'reveal reveal-miss' }, h('div', { class: 'reveal-title', text: title }), h('p', { text })));
  overlayEl.classList.remove('hidden');
  overlayTimer = setTimeout(hideOverlay, ms);
}

/**
 * The bottle: the scene shows it coming out of the water in a golden splash, then the reveal takes the screen
 * (play/ui/prize.ts).
 */
function showPrize(amount: number): void {
  clearTimeout(overlayTimer);
  scene.prize();
  overlayTimer = setTimeout(() => {
    stopPrize = showPrizeReveal(overlayEl, amount, {
      note: `Not a fish at all: there are tokens inside. ${CHAIN ? 'The game contract has sent them to your wallet.' : 'Local game: the balance is stored in this browser.'}`,
      onClose: hideOverlay,
    });
  }, 750);
}

function showCatch(l: Landing, fightLine: string | null = null): void {
  clearTimeout(overlayTimer);
  const f = l.fish;
  const sp = SPECIES[f.speciesId];
  const notes: HTMLElement[] = [];
  const note = (cls: string, text: string): void => void notes.push(h('div', { class: `note ${cls}`, text }));
  // a record wears a medal; the star is kept for "saved"
  const record = (text: string): void => void notes.push(h('div', { class: 'note gold record' }, icon('medal'), text));
  if (f.isSpecial) note('gold', 'Special fish! See the Trophies tab');
  if (l.newSpecies) note('gold', 'New species discovered');
  if (l.newOverallRecord) record('Heaviest catch ever');
  else if (l.newBest) record(`Personal best for ${sp.name}`);
  if (l.levelUp) {
    note('gold', `Level ${l.levelUp}!`);
    celebrateLevel();
  }
  for (const id of l.unlocked) note('gold', `${LOCATIONS[id].name} unlocked`);
  for (const c of completedBy(f.id)) note('gold', `Daily challenge done: ${describeGoal(c.goal)}`);
  const canQuickSell = !f.isSpecial && !isValuable(f);
  // A catch the player may want to keep: the Save action stands out. It is the one collection action there is: a
  // saved fish hangs in the Trophy Room. Nothing has to be decided: Continue fishing is always the main button.
  const notable = f.rarity >= 2 || f.isSpecial || l.newBest || l.newOverallRecord;
  const actionsEl = h('div', { class: 'reveal-actions' });
  const keepEl = h('div', { class: 'reveal-keep', attrs: { role: 'status' } });
  const paint = (): void => {
    const mine = getSave().fish.find((x) => x.id === f.id);
    const isSaved = !!mine?.isFavorite;
    keepEl.replaceChildren(
      ...[
        notable && !isSaved ? h('div', { class: 'note', text: 'A catch worth keeping? Save it: it hangs in your Trophy Room and no Sell button will take it.' }) : null,
        isSaved ? h('div', { class: 'note saved-mark', text: '★ Saved to your Trophy Room · protected from selling' }) : null,
      ].filter((x) => x !== null),
    );
    actionsEl.replaceChildren(
      ...[
        canQuickSell && !isSaved
          ? h('button', {
              class: 'btn',
              text: `Sell now · ${pearl(saleValue(f, Date.now()))}`,
              attrs: { type: 'button' },
              onclick: () => {
                hideOverlay();
                void ops.sellFish([f.id]);
              },
            })
          : null,
        // only a fish that is really in the keepnet can be saved (after a failed read it is not there yet)
        mine
          ? h('button', {
              class: `btn save-btn${isSaved ? ' on' : notable ? ' hot' : ''}`,
              text: isSaved ? '★ Saved' : '☆ Save fish',
              title: isSaved ? 'In your Trophy Room, protected from selling. Tap to remove it from your favorites' : 'Hangs it in your Trophy Room and keeps it out of every sale',
              attrs: { type: 'button', 'aria-pressed': String(isSaved) },
              onclick: () => {
                ops.toggleFavorite(f.id);
                paint();
              },
            })
          : null,
        h('button', { class: 'btn btn-primary', text: 'Continue fishing', attrs: { type: 'button' }, onclick: hideOverlay }),
      ].filter((x) => x !== null),
    );
  };
  paint();
  overlayEl.replaceChildren(
    h(
      'div',
      { class: `reveal reveal-catch ${RARITY_CLASS[f.rarity]}` },
      h('div', { class: 'reveal-title', text: 'Catch!' }),
      fishArt(f.speciesId, { cls: 'reveal-img' }),
      h('div', { class: 'reveal-name', text: sp.name }),
      h('div', { class: 'reveal-tags' }, rarityTag(f.rarity), qualityTag(f.quality)),
      h('div', { class: 'reveal-stats' }, h('span', { text: fmtWeight(f.weight) }), h('span', { class: 'pearl', text: `${pearl(f.sellPrice)} PEARL` })),
      h('div', { class: 'muted small', text: l.countedThisWeek ? `+${f.tournamentScore} pts · counts in this week's top 10` : `${f.tournamentScore} pts · below your weekly top 10` }),
      fightLine ? h('div', { class: 'muted small', text: fightLine }) : null,
      notes,
      h('div', { class: 'muted small', text: `Fresh catch: +${Math.round(TUNING.freshBonus * 100)}% if sold within ${TUNING.freshWindowMs / 60_000} min, ${pearl(f.sellPrice)} after` }),
      keepEl,
      actionsEl,
    ),
  );
  overlayEl.classList.remove('hidden');
}

// ------------------------------------------------------------------ controls

/**
 * The PEARL way into a locked secret water: the price, the level it is sold from, and the button. Local game only:
 * the contracts have no such purchase yet, and there the chain decides what is unlocked.
 */
function purchaseOffer(s: Save, loc: LocationDef): HTMLElement | null {
  const offer = loc.purchase;
  const st = CHAIN ? null : purchaseState(s, loc);
  if (!offer || !st) return null;
  const label = st === 'level' ? `Requires Level ${offer.level}` : st === 'pearl' ? 'Not enough PEARL' : `Unlock for ${pearl(offer.price)} PEARL`;
  return h(
    'div',
    { class: 'loc-buy' },
    h('p', { class: 'small' }, h('span', { class: 'muted', text: 'Or buy access: ' }), `${pearl(offer.price)} PEARL, from level ${offer.level} (you are level ${levelOf(s.xp)})`),
    h(
      'button',
      {
        class: 'btn btn-sm btn-primary',
        disabled: st !== 'ok' || pondBusy(),
        onclick: async () => {
          if (await ops.buyLocation(loc.id)) toast(`${loc.name} unlocked: ${pearl(offer.price)} PEARL paid`, 'ok');
        },
      },
      label,
    ),
  );
}

function locationInfo(id: number): HTMLElement {
  const s = getSave();
  const loc = LOCATIONS[id];
  const open = isUnlocked(s, loc);
  const sp = loc.special ? special(loc.special) : undefined;
  const names = loc.pool.map(([sid]) => (s.dex[sid] ? SPECIES[sid].name : '???'));
  const rec = loc.recommended.map((t) => rodById(t)?.name ?? lureById(t)?.name).filter(Boolean);
  return h(
    'div',
    { class: `loc-info${open ? '' : ' locked'}` },
    h('div', { class: 'loc-head' }, h('b', { text: loc.name }), h('span', { class: 'muted small' }, icon('bolt', 'Energy'), ` ${loc.energyCost} per cast · ${loc.water} water`)),
    h('p', { class: 'muted small', text: loc.blurb }),
    open ? null : h('p', { class: 'warn small' }, icon('lock', 'Locked'), ` ${unlockText(loc.unlock, s)}`),
    open ? null : purchaseOffer(s, loc),
    h('p', { class: 'small' }, h('span', { class: 'muted', text: 'Fish: ' }), names.join(', ')),
    sp ? h('p', { class: 'small' }, h('span', { class: 'muted', text: 'Special: ' }), s.specialsFound.includes(sp.id) ? sp.name : 'a very rare fish lives here') : null,
    rec.length ? h('p', { class: 'small' }, h('span', { class: 'muted', text: 'Good tackle: ' }), rec.join(', ')) : null,
  );
}

const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

function renderControlsView(): HTMLElement[] {
  const s = getSave();
  const now = Date.now();
  const busy = pondBusy();
  const out: HTMLElement[] = [];

  const guest = CHAIN && !state.wallet;
  // on the contracts the owner may stop new casts for a while; whatever is in the water is still reeled in
  const reason = guest ? null : CHAIN && world.castingPaused ? 'Casting is paused for maintenance. It will be back shortly.' : castBlocker(s, now);
  const cost = LOCATIONS[s.location].energyCost;
  const hunting = guest ? null : huntCastArmed();
  out.push(
    h(
      'div',
      { class: 'cast-row' },
      // nobody is signed in: the big button is the way in, not a dead Cast
      guest
        ? h('button', { class: 'btn btn-cast btn-wallet', attrs: { type: 'button' }, onclick: openFluentConnect }, icon('bobber'), 'Connect to cast')
        : h('button', { class: `btn btn-cast${hunting ? ' btn-hunt' : ''}`, disabled: busy || !!reason, title: hunting ? `A seasonal cast: an ordinary cast that is also an attempt at the season’s fish (${hunting.name})` : undefined, onclick: doCast }, busy ? 'In the water…' : hunting ? 'Hunt cast' : 'Cast'),
      guest
        ? null
        : h(
            'div',
            { class: 'cast-info' },
            h('div', { class: reason && !busy ? 'warn' : 'muted', text: busy ? 'Press Hook! the moment the float dips, then hold to reel (Space works too)' : reason ?? `Costs ${cost} energy · you have ${energyNow(s, now)}` }),
            // said before the cast, not in the middle of the fight: what losing it costs
            !CHAIN || world.fights.on ? h('div', { class: 'cast-rule', text: 'One fight per fish: if the needle reaches the end of the red the line snaps, and that fish is gone for good.' }) : null,
          ),
    ),
  );

  // a season is being fished: the switch between ordinary and seasonal casts, and what a cast here is worth
  const strip = guest ? null : huntStrip(busy);
  if (strip) out.push(strip);

  // the day's challenges at a glance; the cards are in the Daily tab
  const daily = guest ? null : dailyBadge();
  if (daily) {
    out.push(
      h(
        'button',
        {
          class: `daily-strip${daily.complete ? ' complete' : ''}`,
          title: 'Open today’s challenges',
          attrs: { type: 'button' },
          onclick: () => window.dispatchEvent(new CustomEvent('fishing:open-tab', { detail: 'daily' })),
        },
        h('span', { class: 'daily-strip-k', text: 'Daily challenges' }),
        h('span', { class: 'daily-strip-v', text: daily.complete ? 'all done' : `${daily.text} done` }),
        h('span', { class: 'daily-strip-go', text: '→' }),
      ),
    );
  }

  out.push(
    h(
      'section',
      { class: 'picker' },
      h('h3', { text: 'Location' }),
      h(
        'div',
        { class: 'spots' },
        LOCATIONS.map((loc) => {
          const open = canEnter(s, loc);
          return h(
            'button',
            {
              class: `spot ${s.location === loc.id ? 'sel' : ''} ${open ? '' : 'locked'} ${viewLoc === loc.id && !open ? 'peek' : ''}`,
              disabled: busy,
              title: open ? loc.blurb : unlockText(loc.unlock, s),
              onclick: () => {
                viewLoc = loc.id;
                if (open) ops.setLocation(loc.id);
                emit();
              },
            },
            h('span', { class: 'spot-name', text: loc.name }),
            h('span', { class: 'spot-meta' }, open ? null : icon('lock', 'Locked'), open ? null : 'locked', open ? icon('bolt', 'Energy') : null, open ? String(loc.energyCost) : null),
          );
        }),
      ),
      locationInfo(viewLoc ?? s.location),
    ),
  );

  // tackle
  const rod = rodById(s.equipped.rod)!;
  const lure = lureById(s.equipped.lure);
  const own = s.rods[rod.id];
  const broken = rodBroken(s, rod.id);
  const repair = rodRepairPrice(s, rod.id);
  const rodSel = dropdown({
    label: 'Rod',
    value: rod.id,
    disabled: busy,
    options: Object.keys(s.rods).map((id) => {
      const r = rodById(id);
      return { value: id, label: r?.name ?? id, hint: r && r.wear > 0 ? `${s.rods[id].durability}/${r.wear}` : undefined };
    }),
    onPick: (v) => void ops.equipRod(v),
  });
  const lureSel = dropdown({
    label: 'Lure',
    value: s.equipped.lure ?? '',
    disabled: busy,
    options: [{ value: '', label: 'No lure' }, ...Object.keys(s.lures).map((id) => ({ value: id, label: lureById(id)?.name ?? id, hint: `${s.lures[id].casts} casts` }))],
    onPick: (v) => void ops.equipLure(v || null),
  });
  const t = currentTotals(s);
  const tile = (k: string, v: string, d: string, title: string): HTMLElement => h('div', { class: 'tk-big', title }, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v }), h('span', { class: 'd', text: d }));
  out.push(
    h(
      'section',
      { class: 'picker' },
      h('div', { class: 'picker-head' }, h('h3', { text: 'Tackle' }), h('a', { class: 'link', text: 'Tackle shop →', attrs: { href: '#/tackle' } })),
      h(
        'div',
        { class: 'gear' },
        h(
          'div',
          { class: `gear-slot${broken ? ' broken' : ''}` },
          h('div', { class: 'tk-well sm' }, rodSprite(rod.id, rod.name, 2)),
          h(
            'div',
            { class: 'gear-body' },
            rodSel,
            rod.wear > 0 ? segBar(own.durability, rod.wear, 8, 'dur') : null,
            h('span', { class: broken ? 'warn small' : 'muted small', text: rod.wear > 0 ? `durability ${own.durability}/${rod.wear}` : 'never wears out' }),
            repair > 0
              ? h('button', {
                  class: 'btn btn-sm',
                  text: `Repair · ${pearl(repair)}`,
                  title:
                    s.pearl < repair
                      ? `Not enough PEARL: the repair costs ${pearl(repair)}, you have ${pearl(Math.floor(s.pearl))}. Sell fish to earn ${pearl(Math.ceil(repair - s.pearl))} more.`
                      : busy
                        ? 'Finish this cast first'
                        : `Restores durability from ${own.durability} to ${rod.wear}`,
                  disabled: busy || s.pearl < repair,
                  onclick: () => void ops.repairRod(rod.id),
                })
              : null,
          ),
        ),
        h(
          'div',
          { class: 'gear-slot' },
          h('div', { class: 'tk-well sm' }, lure ? lureSprite(lure.id, lure.name, 3) : h('span', { class: 'muted small', text: 'none' })),
          h(
            'div',
            { class: 'gear-body' },
            lureSel,
            lure ? segBar(s.lures[lure.id].casts, Math.max(lure.wear, s.lures[lure.id].casts), 8, 'dur') : null,
            h('span', { class: 'muted small', text: lure ? `${s.lures[lure.id].casts} casts left` : Object.keys(s.lures).length ? 'no lure on the line' : 'buy lures in the tackle shop' }),
          ),
        ),
      ),
      h(
        'div',
        { class: 'tk-lo-out bonus-row' },
        tile('Bite chance', `${t.biteChance}%`, t.lure.catch ? `lure ${signed(t.lure.catch)}` : 'from the lure', 'How often a fish bites. Raised by the lure’s catch.'),
        tile('Green zone', `${Math.round(greenWidth(t.zone) * 100)}%`, t.rod.catch ? `rod ${signed(t.rod.catch)}` : 'from the rod', 'Width of the safe green band on the line-tension gauge while reeling. Raised by the rod’s catch.'),
        tile('Rare odds', t.total.rarity ? `+${t.total.rarity}` : '—', 'weighting, not %', 'Relative weighting of rarer species: rod + lure + active special fish.'),
        tile('Fish weight', t.total.weight ? `+${t.total.weight}%` : '—', 'and sell price', 'Heavier fish sell for more and score higher.'),
      ),
    ),
  );

  return out;
}

export function tickPond(): void {
  // energy may have regenerated: lets the controls refresh their "not enough energy" state
  emit();
}

// On the dev server: `fishingCard(i, { best: true })` shows the catch card of the i-th fish in the keepnet without
// a cast, to look at what the card offers (save it, hang it, sell it).
if (import.meta.env.DEV) {
  (window as unknown as { fishingCard?: unknown }).fishingCard = (i = 0, o: { best?: boolean; record?: boolean } = {}): void => {
    const s = getSave();
    const fish = s.fish[i];
    if (fish) showCatch({ save: s, fish, newSpecies: false, newBest: !!o.best, newOverallRecord: !!o.record, levelUp: null, unlocked: [], countedThisWeek: false });
  };
}

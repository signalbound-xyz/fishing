/** Daily challenges: three cards, how far each one is, the countdown to the next day and the streak. */
import { LOCATIONS } from '../../game/content';
import { describeGoal, goalHint, progressLabel, type DailyChallenge, type Progress } from '../../game/daily';
import { openFluentConnect } from '../../fluent';
import { state } from '../../store';
import { h, mount, segBar, sigOf } from '../../ui/dom';
import { toast } from '../../ui/toast';
import { dailyView, takeCompletions, type DailyView } from '../daily';
import { CHAIN, ops } from '../ops';
import { getSave, rev } from '../state';
import { duration } from './fmt';
import { confetti } from './levelup';

const TIER_NAME = { easy: 'Easy', medium: 'Medium', hard: 'Hard' } as const;

/** Busy while a cast is out: the water cannot be changed then. Set by the pond, which this module must not import. */
let busy: () => boolean = () => false;

export function initDaily(host: HTMLElement, pondBusy: () => boolean): () => void {
  busy = pondBusy;
  return mount(
    host,
    () => {
      const v = dailyView();
      // the countdown moves by the minute, and by the second in the last minute
      return sigOf(rev(), state.wallet?.address, v.status, v.day, v.stale, v.streak, v.streakOpen, v.set?.challenges.map((c) => c.id), v.progress?.each, v.resetIn > 60 ? Math.floor(v.resetIn / 60) : v.resetIn, busy(), getSave().location);
    },
    render,
  );
}

/** "2/3" for the tab and the strip on the main screen; null while there is nothing to count. */
export function dailyBadge(v: DailyView = dailyView()): { text: string; complete: boolean } | null {
  if (v.status !== 'ready' || !v.progress) return null;
  return { text: `${v.progress.done}/${v.progress.each.length}`, complete: v.progress.complete };
}

function card(c: DailyChallenge, p: Progress, fresh: boolean): HTMLElement {
  const g = c.goal;
  const hint = goalHint(c);
  const here = getSave().location === c.at;
  const canGo = !p.done && !here && !busy() && getSave().permanentUnlocks.includes(c.at);
  return h(
    'article',
    { class: `daily-card tier-${c.tier}${p.done ? ' done' : ''}${fresh ? ' just-done' : ''}`, attrs: { 'data-id': c.id } },
    h('div', { class: 'daily-top' }, h('span', { class: `daily-tier tier-${c.tier}`, text: TIER_NAME[c.tier] }), h('div', { class: 'spacer' }), p.done ? h('span', { class: 'daily-stamp', text: 'Done' }) : null),
    h('div', { class: 'daily-goal', text: describeGoal(g) }),
    hint ? h('div', { class: 'muted small', text: hint }) : null,
    h('div', { class: 'daily-progress' }, segBar(p.have, p.need, g.kind === 'weight' ? 10 : Math.min(10, p.need), 'daily-bar'), h('span', { class: 'daily-count', text: progressLabel(g, p) })),
    canGo
      ? h('button', { class: 'btn btn-sm btn-ghost daily-go', text: `Fish in ${LOCATIONS[c.at].name}`, attrs: { type: 'button' }, onclick: () => void ops.setLocation(c.at) })
      : !p.done && here && ('loc' in g && g.loc !== undefined)
        ? h('span', { class: 'muted small', text: 'You are fishing here' })
        : null,
  );
}

function streakLine(v: DailyView): HTMLElement | null {
  if (v.streak === null) return null;
  if (v.streak === 0) return h('span', { class: 'muted small', text: 'No streak yet: finish all three to start one' });
  return h('span', { class: 'daily-streak', title: 'Days in a row with all three challenges done' }, `${v.streak}${v.streakOpen ? '+' : ''}-day streak`);
}

function render(): HTMLElement[] {
  const v = dailyView();
  const head = h(
    'div',
    { class: 'toolbar' },
    h('span', { class: 'muted', text: 'Three challenges a day' }),
    h('div', { class: 'spacer' }),
    h('span', { class: 'badge', title: 'The day turns at 00:00 UTC', text: `New in ${duration(v.resetIn * 1000)}` }),
  );
  if (v.status === 'guest') {
    return [
      head,
      h(
        'section',
        { class: 'daily-empty' },
        h('p', { text: 'Sign in to get today’s three challenges.' }),
        h('p', { class: 'muted small', text: 'They are drawn for your account from the waters you have opened, and counted from your catches on chain.' }),
        h('button', { class: 'btn btn-wallet', text: 'Connect with Fluent', attrs: { type: 'button' }, onclick: openFluentConnect }),
      ),
    ];
  }
  if (v.status === 'loading' || v.status === 'error' || !v.set || !v.progress) {
    return [
      head,
      h(
        'section',
        { class: 'daily-empty', attrs: { role: 'status' } },
        h('p', { class: v.status === 'error' ? 'warn' : 'muted', text: v.status === 'error' ? 'Today’s catches could not be read from the chain. Trying again shortly.' : CHAIN ? 'Reading today’s catches from the chain…' : 'Drawing today’s challenges…' }),
        v.status === 'error' ? h('p', { class: 'muted small', text: 'Nothing is shown rather than a guess: progress here is only what the chain confirms.' }) : null,
      ),
    ];
  }
  const { done, full } = takeCompletions(v);
  const freshIds = new Set(done.map((c) => c.id));
  for (const c of done) toast(`Daily challenge done: ${describeGoal(c.goal)}`, 'ok');
  if (full) toast('All three daily challenges done!', 'ok', 5000);
  if (done.length || full) requestAnimationFrame(() => celebrate([...freshIds], full));

  const p = v.progress;
  return [
    head,
    v.stale ? h('p', { class: 'warn small', attrs: { role: 'status' }, text: 'The chain could not be read just now. This is the last copy kept on this device; it may be behind.' }) : null,
    h(
      'section',
      { class: `daily-sum${p.complete ? ' complete' : ''}` },
      h(
        'div',
        { class: 'daily-pips', attrs: { role: 'img', 'aria-label': `${p.done} of ${p.each.length} done` } },
        p.each.map((e) => h('span', { class: e.done ? 'pip on' : 'pip' })),
      ),
      h('div', { class: 'daily-sum-text' }, h('b', { text: p.complete ? 'Day complete' : `${p.done} of ${p.each.length} done` }), streakLine(v)),
    ),
    h(
      'div',
      { class: 'daily-cards' },
      v.set.challenges.map((c, i) => card(c, p.each[i], freshIds.has(c.id))),
    ),
    h(
      'p',
      { class: 'muted small' },
      CHAIN ? 'Counted from your catches confirmed on chain since 00:00 UTC, on any device. ' : 'Local game: the day is kept in this browser. ',
      'A fish counts for every challenge it fits. The reward is the badge and the streak: no PEARL or energy.',
    ),
  ].filter((x): x is HTMLElement => !!x);
}

/** Confetti off the cards that were just completed, and a bigger burst off the summary when that was the last one. */
function celebrate(ids: string[], full: boolean): void {
  for (const id of ids) {
    const el = document.querySelector(`.daily-card[data-id="${id}"]`);
    const box = el?.getBoundingClientRect();
    if (box && box.width > 0) confetti(box, 22, 0.7);
  }
  if (!full) return;
  const box = document.querySelector('.daily-sum')?.getBoundingClientRect();
  if (box && box.width > 0) {
    confetti(box, 40, 1);
    setTimeout(() => confetti(box, 24, 0.75), 320);
  }
}

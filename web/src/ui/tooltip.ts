/**
 * Tooltips that appear at once.
 *
 * The browser's own `title` tooltip waits a second or more, which is too long for "why is this button off". So the
 * hint is kept in `data-tip` (`h` writes it there, see `setTip`) and one floating box shows it the moment the
 * pointer or the keyboard focus is on the element. A plain `title` met on the way (third-party markup) is taken over
 * the same way.
 *
 * Touch has no hover: there a tap on a disabled control shows its hint for a few seconds, since that is the one
 * place a tap does nothing else. Enabled controls just do their thing.
 */
import { TIP, setTip } from './dom';

const GAP = 8;
const EDGE = 8;
const TOUCH_MS = 3200;

let box: HTMLElement | null = null;
let owner: Element | null = null;
let shown = '';
let timer = 0;
let watch = 0;
let lastX = -1;
let lastY = -1;

/** The nearest element with a hint, from `from` upwards. */
function holder(from: EventTarget | null): Element | null {
  for (let el = from instanceof Element ? from : null; el; el = el.parentElement) {
    const native = el.getAttribute('title');
    if (native) {
      el.removeAttribute('title');
      setTip(el, native);
    }
    if (el.getAttribute(TIP)) return el;
  }
  return null;
}

const isOff = (el: Element): boolean => el.matches(':disabled, [aria-disabled="true"]');

function place(): void {
  if (!box || !owner) return;
  const r = owner.getBoundingClientRect();
  const w = box.offsetWidth;
  const hgt = box.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const above = r.top - GAP - hgt >= EDGE || r.top > vh - r.bottom;
  const top = above ? r.top - GAP - hgt : r.bottom + GAP;
  const left = Math.min(Math.max(EDGE, r.left + r.width / 2 - w / 2), Math.max(EDGE, vw - EDGE - w));
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(Math.min(Math.max(EDGE, top), Math.max(EDGE, vh - EDGE - hgt)))}px`;
  box.classList.toggle('below', !above);
}

function show(el: Element): void {
  const text = el.getAttribute(TIP) ?? '';
  if (!text) return hide();
  if (el === owner && text === shown) return;
  if (!box) {
    box = document.createElement('div');
    box.className = 'tip';
    box.setAttribute('role', 'tooltip');
    document.body.append(box);
  }
  owner = el;
  shown = text;
  box.textContent = text;
  box.hidden = false;
  place();
  window.clearInterval(watch);
  // the page re-renders under a still pointer: follow the element that is there now, or go away with the old one
  watch = window.setInterval(() => {
    if (!owner) return;
    if (owner.isConnected && owner.getAttribute(TIP) === shown) return;
    const next = lastX >= 0 ? holder(document.elementFromPoint(lastX, lastY)) : null;
    if (next) show(next);
    else hide();
  }, 150);
}

function hide(): void {
  window.clearTimeout(timer);
  window.clearInterval(watch);
  owner = null;
  shown = '';
  if (box) box.hidden = true;
}

export function initTooltips(): void {
  document.addEventListener('pointerover', (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
    const el = holder(e.target);
    if (e.pointerType === 'touch') {
      // a tap: only where it would otherwise do nothing
      if (!el || !isOff(el)) return hide();
      show(el);
      window.clearTimeout(timer);
      timer = window.setTimeout(hide, TOUCH_MS);
      return;
    }
    if (el) show(el);
    else hide();
  });
  document.addEventListener('pointermove', (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
  });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType === 'touch' || !owner) return;
    if (e.relatedTarget instanceof Node && owner.contains(e.relatedTarget)) return;
    if (!holder(e.relatedTarget)) hide();
  });
  // pressing a button answers the question the hint was answering
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' && owner && !isOff(owner)) hide();
  });
  document.addEventListener('focusin', (e) => {
    const el = holder(e.target);
    if (el && el === e.target && el.matches(':focus-visible')) show(el);
  });
  document.addEventListener('focusout', () => {
    if (owner && owner === document.activeElement) hide();
    else if (owner && !owner.matches(':hover')) hide();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
  window.addEventListener('scroll', hide, { capture: true, passive: true });
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);
}

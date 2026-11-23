/**
 * A new level, celebrated in the header: the level bar flashes and rings, and square confetti flies off it.
 * Purely a show: it reads nothing from the game and changes nothing in it.
 */
import { emit } from '../../store';

/** How long the header keeps the level block lit. */
const SHOW_MS = 2400;
const COLOURS = ['--r4', '--accent-hi', '--pearl', '--r2', '--r5', '--r1'];
const GRAVITY = 1100;

let startedAt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Milliseconds since the celebration began, or null when there is none. The header renders the lit block from it. */
export function levelShow(now: number): number | null {
  return startedAt > 0 && now - startedAt < SHOW_MS ? now - startedAt : null;
}

export function celebrateLevel(): void {
  startedAt = Date.now();
  clearTimeout(timer);
  timer = setTimeout(() => {
    startedAt = 0;
    emit();
  }, SHOW_MS);
  emit();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // after the header has drawn the lit block, so the confetti starts from where the bar really is
  requestAnimationFrame(() => {
    const bar = document.querySelector('.stat.levelup .segbar');
    if (!bar) return;
    const box = bar.getBoundingClientRect();
    if (box.width === 0) return;
    burst(box, 34, 1);
    setTimeout(() => burst(box, 20, 0.7), 320);
  });
}

/** Square confetti thrown from a box on the page. Does nothing for people who asked for less motion. */
export function confetti(box: DOMRect, count: number, power: number): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  burst(box, count, power);
}

function burst(box: DOMRect, count: number, power: number): void {
  const layer = document.createElement('div');
  layer.className = 'lvl-burst';
  layer.setAttribute('aria-hidden', 'true');
  let longest = 0;
  for (let i = 0; i < count; i++) {
    const bit = document.createElement('span');
    const size = 4 + 2 * Math.floor(Math.random() * 2);
    bit.style.width = bit.style.height = `${size}px`;
    bit.style.left = `${box.left + Math.random() * box.width - size / 2}px`;
    bit.style.top = `${box.top + box.height / 2 - size / 2}px`;
    bit.style.background = `var(${COLOURS[i % COLOURS.length]})`;
    // every direction; the header sits at the top of the page, so the pieces thrown up come back down into view
    const angle = Math.random() * Math.PI * 2;
    const speed = (160 + Math.random() * 260) * power;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed - 140 * power;
    const life = 900 + Math.random() * 600;
    longest = Math.max(longest, life);
    const frames: Keyframe[] = [];
    const steps = 14;
    for (let k = 0; k <= steps; k++) {
      const t = (k / steps) * (life / 1000);
      // on a 2px grid, like everything else on the page; the last pieces blink out instead of fading
      const x = Math.round((vx * t) / 2) * 2;
      const y = Math.round((vy * t + (GRAVITY * t * t) / 2) / 2) * 2;
      frames.push({ transform: `translate(${x}px, ${y}px)`, opacity: k >= steps - 3 && k % 2 === 0 ? 0 : 1 });
    }
    frames[steps].opacity = 0;
    bit.animate(frames, { duration: life, easing: 'linear', fill: 'forwards' });
    layer.append(bit);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), longest + 100);
}

// On the dev server only: `fishingLevelUp()` in the console plays the show without earning a level.
if (import.meta.env.DEV) (window as unknown as { fishingLevelUp?: () => void }).fishingLevelUp = celebrateLevel;

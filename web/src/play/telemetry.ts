/**
 * Gameplay telemetry in the browser: one recorder over localStorage, and the few calls the UI makes into it.
 *
 * What it is for: balance work needs to know how people actually play (how fast they hook, which fights they
 * lose, when the energy runs out), and until now the only numbers were a bot's. See telemetry/ for the format.
 *
 * What it is not: it is not part of the rules (nothing reads it back into the game), it holds no wallet address
 * or account data, and it is not sent anywhere: the log lives in this browser until the player exports or clears
 * it on the #/stats page. `VITE_TELEMETRY=off` switches recording off altogether.
 */
import { LOCAL_GAME } from '../config';
import { energyNow, type Landing } from '../game/actions';
import { LOCATIONS } from '../game/content';
import { levelOf } from '../game/economy';
import type { Save } from '../game/types';
import type { EventBody, TelemetryLog } from '../telemetry/events';
import { Recorder, type LogStore } from '../telemetry/recorder';
import { summarize, type Summary } from '../telemetry/summary';

const KEY = 'onchain-fishing:telemetry';
export const TELEMETRY_ON: boolean = import.meta.env.VITE_TELEMETRY !== 'off';

const storage: LogStore = {
  read() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  write(v) {
    localStorage.setItem(KEY, v);
  },
};

const recorder = new Recorder(storage, LOCAL_GAME ? 'local' : 'chain');
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/** Records one event. Never throws: a telemetry fault must not reach the game. */
export function track(body: EventBody): void {
  if (!TELEMETRY_ON) return;
  try {
    recorder.track(body);
    flushTimer ??= setTimeout(() => {
      flushTimer = undefined;
      recorder.flush();
    }, 1_000);
  } catch (e) {
    console.warn('telemetry', e);
  }
}

if (TELEMETRY_ON) {
  // 'pagehide' is the last event a mobile browser is sure to deliver; a hidden tab may never come back
  window.addEventListener('pagehide', () => recorder.close());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') recorder.flush();
  });
}

// ------------------------------------------------------------------ what the game reports

/** A cast went out. `s` is the save after it, so the energy left is what the player sees. */
export function trackCast(s: Save, locationId: number): void {
  const cost = LOCATIONS[locationId]?.energyCost ?? 0;
  const energy = energyNow(s, Date.now());
  track({ e: 'cast', loc: locationId, cost, rod: s.equipped.rod, lure: s.equipped.lure, level: levelOf(s.xp), energy });
  if (energy < cost) track({ e: 'energy_out', loc: locationId, cost, left: energy });
}

/** A fish was landed: the catch, and the level and the waters it brought. */
export function trackLanding(l: Landing): void {
  const f = l.fish;
  track({ e: 'catch', loc: f.locationId, species: f.speciesId, rarity: f.rarity, quality: f.quality, weight: f.weight, price: f.sellPrice, score: f.tournamentScore, special: f.isSpecial, newSpecies: l.newSpecies });
  if (l.levelUp) track({ e: 'level', level: l.levelUp });
  for (const loc of l.unlocked) track({ e: 'unlock', loc, how: 'progress' });
}

// ------------------------------------------------------------------ the debug view's side

export const telemetryLog = (): TelemetryLog => recorder.log();
export const telemetrySummary = (mode?: 'local' | 'chain'): Summary => summarize(recorder.log(), mode);
export const clearTelemetry = (): void => recorder.clear();

/** The whole log with its summaries, as the file the Export button saves. */
export function telemetryExport(): string {
  const log = recorder.log();
  return JSON.stringify({ exportedAt: new Date().toISOString(), note: 'Onchain Fishing gameplay telemetry. No wallet or account data.', summary: { all: summarize(log), local: summarize(log, 'local'), chain: summarize(log, 'chain') }, log }, null, 1);
}

// handy in the console while tuning
(window as unknown as Record<string, unknown>).fishingTelemetry = { log: telemetryLog, summary: telemetrySummary, export: telemetryExport, clear: clearTelemetry };

import { describe, expect, it } from 'vitest';
import { GameError, bulkSellable, isProtected, isShowcased, landFish, moveTrophy, sellFish, setActiveSpecial, showcaseFish, toggleFavorite, unshowcaseFish, type CastTicket } from './actions';
import { LOCATIONS, SPECIALS, SPECIES } from './content';
import { avgWeight } from './economy';
import { totals } from './equipment';
import { holdsSpecial, isUnlocked } from './progress';
import { freshSave, loadSave } from './save';
import { SHOWCASE_SLOTS, cleanShowcase, emptyPrefs, emptyShowcase, parsePrefs, reconcile, serializePrefs, shownCount, type Prefs } from './showcase';
import type { FishInstance, Save } from './types';
import { rodById } from '../tackle/catalog';
import { legacyFavsKey, loadPrefs, prefsKey, storePrefs, type KV, type PrefsScope } from '../play/prefs';

const NOW = 1_700_000_000_000;
const LATER = NOW + 3_600_000;

const fishOf = (over: Partial<FishInstance> = {}): FishInstance => ({
  id: 'x1',
  speciesId: 0,
  rarity: 0,
  weight: 200,
  quality: 'B',
  locationId: 0,
  caughtAt: NOW,
  sellPrice: 10,
  tournamentScore: 10,
  isFavorite: false,
  isSpecial: false,
  ...over,
});
const keepnet = (...ids: string[]): Save => ({ ...freshSave(NOW), fish: ids.map((id) => fishOf({ id })) });
const saved = (s: Save): string[] => s.fish.filter((f) => f.isFavorite).map((f) => f.id);
/** A full room: f1…f6 in frames 0…5, and a seventh fish in the keepnet. */
function fullRoom(): Save {
  let s = keepnet('f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7');
  for (const id of ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']) s = showcaseFish(s, id).save;
  return s;
}

describe('saving a fish (the star)', () => {
  it('marks and unmarks', () => {
    const s = keepnet('a', 'b');
    const on = toggleFavorite(s, 'a');
    expect(saved(on)).toEqual(['a']);
    expect(saved(toggleFavorite(on, 'a'))).toEqual([]);
    expect(saved(s)).toEqual([]); // the input save is untouched
    expect(() => toggleFavorite(s, 'ghost')).toThrow(GameError);
  });

  it('survives a reload of the local save', () => {
    const s = toggleFavorite(keepnet('a', 'b'), 'b');
    const back = loadSave(JSON.stringify(s), LATER);
    expect(back.status).toBe('ok');
    expect(saved(back.save)).toEqual(['b']);
  });

  it('keeps a saved fish out of every sale', () => {
    const s = toggleFavorite(keepnet('a', 'b', 'c'), 'b');
    // "Sell all" and "Select all" take what is bulk-sellable
    expect(s.fish.filter(bulkSellable).map((f) => f.id)).toEqual(['a', 'c']);
    expect(isProtected(s, s.fish[1])).toBe(true);
    // and a sale that names it is refused whole
    expect(() => sellFish(s, ['b'], LATER)).toThrow(/Saved fish are protected/);
    expect(() => sellFish(s, ['a', 'b'], LATER)).toThrow(GameError);
    expect(sellFish(s, ['a', 'c'], LATER).save.fish.map((f) => f.id)).toEqual(['b']);
    // off with the star, and it sells
    expect(sellFish(toggleFavorite(s, 'b'), ['b'], LATER).earned).toBe(10);
  });
});

describe('the Trophy Room', () => {
  it('starts with six empty frames', () => {
    expect(freshSave(NOW).showcase).toEqual([null, null, null, null, null, null]);
    expect(SHOWCASE_SLOTS).toBe(6);
  });

  it('hangs a fish in the first empty frame and saves it', () => {
    const s = keepnet('a', 'b');
    const h = showcaseFish(s, 'b');
    expect(h.slot).toBe(0);
    expect(h.replaced).toBeNull();
    expect(h.save.showcase).toEqual(['b', null, null, null, null, null]);
    expect(saved(h.save)).toEqual(['b']); // displayed means saved
    expect(isShowcased(h.save, 'b')).toBe(true);
    expect(s.showcase).toEqual(emptyShowcase()); // the input save is untouched
    // the next one takes the next frame; a named frame is honoured
    expect(showcaseFish(h.save, 'a').slot).toBe(1);
    expect(showcaseFish(h.save, 'a', 4).save.showcase).toEqual(['b', null, null, null, 'a', null]);
  });

  it('shows only fish that are in the keepnet', () => {
    expect(() => showcaseFish(keepnet('a'), 'ghost')).toThrow(/keepnet/);
  });

  it('never shows the same fish twice', () => {
    const s = showcaseFish(keepnet('a', 'b'), 'a').save;
    expect(() => showcaseFish(s, 'a')).toThrow(/already on display/);
    expect(() => showcaseFish(s, 'a', 3)).toThrow(/already on display/);
    expect(s.showcase.filter((x) => x === 'a')).toHaveLength(1);
  });

  it('takes a fish down and leaves it saved', () => {
    const s = showcaseFish(keepnet('a', 'b'), 'a').save;
    const down = unshowcaseFish(s, 'a');
    expect(down.showcase).toEqual(emptyShowcase());
    expect(saved(down)).toEqual(['a']);
    expect(() => unshowcaseFish(down, 'a')).toThrow(/not on display/);
  });

  it('refuses a seventh fish, and no frame beyond the sixth', () => {
    const s = fullRoom();
    expect(shownCount(s.showcase)).toBe(6);
    expect(() => showcaseFish(s, 'f7')).toThrow(/full/);
    expect(() => showcaseFish(s, 'f7', 6)).toThrow(/6 frames/);
    expect(() => showcaseFish(s, 'f7', -1)).toThrow(GameError);
    expect(s.showcase).toHaveLength(6);
    expect(saved(s)).not.toContain('f7'); // a refusal saves nothing
  });

  it('replaces one of six: the old trophy goes back to the saved fish', () => {
    const s = fullRoom();
    const h = showcaseFish(s, 'f7', 2);
    expect(h.replaced).toBe('f3');
    expect(h.save.showcase).toEqual(['f1', 'f2', 'f7', 'f4', 'f5', 'f6']);
    expect(isShowcased(h.save, 'f3')).toBe(false);
    expect(saved(h.save)).toContain('f3'); // still protected
    expect(saved(h.save)).toContain('f7');
    expect(() => sellFish(h.save, ['f3'], LATER)).toThrow(/protected/);
  });

  it('keeps the order the player chose', () => {
    let s = keepnet('a', 'b', 'c');
    s = showcaseFish(s, 'c').save; // not sorted by anything: first hung, first frame
    s = showcaseFish(s, 'a').save;
    expect(s.showcase.slice(0, 2)).toEqual(['c', 'a']);
    s = moveTrophy(s, 0, 1);
    expect(s.showcase.slice(0, 2)).toEqual(['a', 'c']);
    s = moveTrophy(s, 1, 5); // into an empty frame
    expect(s.showcase).toEqual(['a', null, null, null, null, 'c']);
    expect(moveTrophy(s, 2, 2)).toBe(s);
    expect(() => moveTrophy(s, 0, 6)).toThrow(GameError);
  });

  it('protects a displayed fish from selling, directly and in bulk', () => {
    const s = showcaseFish(keepnet('a', 'b'), 'a').save;
    expect(() => sellFish(s, ['a'], LATER)).toThrow(/Trophy Room/);
    expect(() => sellFish(s, ['a', 'b'], LATER)).toThrow(/Trophy Room/);
    expect(s.fish.filter(bulkSellable).map((f) => f.id)).toEqual(['b']);
    // even if a hand-edited save took the star off
    const edited: Save = { ...s, fish: s.fish.map((f) => ({ ...f, isFavorite: false })) };
    expect(() => sellFish(edited, ['a'], LATER)).toThrow(/Trophy Room/);
    expect(isProtected(edited, edited.fish[0])).toBe(true);
  });

  it('will not take the star off a displayed fish', () => {
    const s = showcaseFish(keepnet('a'), 'a').save;
    expect(() => toggleFavorite(s, 'a')).toThrow(/take it down first/);
    // down first, then the star, then it sells
    const free = toggleFavorite(unshowcaseFish(s, 'a'), 'a');
    expect(sellFish(free, ['a'], LATER).save.fish).toHaveLength(0);
  });
});

describe('a fish that is gone', () => {
  it('leaves its frame when the local save is loaded without it', () => {
    const s = showcaseFish(showcaseFish(keepnet('a', 'b'), 'a').save, 'b').save;
    const without: Save = { ...s, fish: s.fish.filter((f) => f.id !== 'a') };
    const back = loadSave(JSON.stringify(without), LATER).save;
    expect(back.showcase).toEqual([null, 'b', null, null, null, null]);
  });

  it('repairs a showcase that was edited by hand', () => {
    const s = keepnet('a', 'b');
    const raw = { ...s, showcase: ['a', 'a', 7, 'ghost', 'b', null, 'b', 'a'] };
    const back = loadSave(JSON.stringify(raw), LATER).save;
    expect(back.showcase).toEqual(['a', null, null, null, 'b', null]);
    expect(saved(back).sort()).toEqual(['a', 'b']); // on display means saved
    expect(cleanShowcase('nonsense')).toEqual(emptyShowcase());
  });

  it('on the contracts: a sold or transferred fish leaves its frame and its star', () => {
    const p: Prefs = { saved: ['1', '2', '3', '9'], showcase: ['3', null, '9', '1', null, null] };
    const r = reconcile(p, ['1', '2', '3', '4']); // 9 was sold or sent away
    expect(r.prefs.showcase).toEqual(['3', null, null, '1', null, null]); // the other frames do not move
    expect(r.prefs.saved).toEqual(['1', '2', '3']);
    expect(r.droppedTrophies).toEqual(['9']);
    expect(r.droppedSaved).toEqual(['9']);
    expect(r.changed).toBe(true);
    expect(p.showcase[2]).toBe('9'); // the input is untouched
  });

  it('on the contracts: nothing changes while every fish is still there', () => {
    const p: Prefs = { saved: ['1', '3'], showcase: ['3', null, null, null, null, null] };
    const r = reconcile(p, ['1', '2', '3']);
    expect(r.changed).toBe(false);
    expect(r.prefs).toBe(p);
  });

  it('on the contracts: an empty keepnet that was really read empties the room; a failed read is never passed in', () => {
    const p: Prefs = { saved: ['1'], showcase: ['1', null, null, null, null, null] };
    expect(reconcile(p, []).prefs).toEqual(emptyPrefs());
  });
});

// ------------------------------------------------------------------ the contracts: this browser's preferences

function memory(initial: Record<string, string> = {}): KV & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}
const ALICE = '0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
const BOB = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
const scope = (address: string, chainId = 20994, collection = '0x3Ec62368e2cEDE35C2027cf0BbDc78a0eCaAC037'): PrefsScope => ({ chainId, collection, address });

describe('preferences on the contracts', () => {
  it('persist across a reload', () => {
    const kv = memory();
    const p: Prefs = { saved: ['12', '40'], showcase: ['40', null, null, null, null, '12'] };
    expect(storePrefs(scope(ALICE), p, kv)).toBe(true);
    expect(loadPrefs(scope(ALICE), kv)).toEqual(p); // a new page reads the same thing
    expect(loadPrefs(scope(ALICE.toLowerCase()), kv)).toEqual(p); // however the address is written
  });

  it('belong to one account: switching the wallet shows the other one’s, and coming back restores the first', () => {
    const kv = memory();
    const alice: Prefs = { saved: ['1', '2'], showcase: ['2', null, null, null, null, null] };
    const bob: Prefs = { saved: ['7'], showcase: [null, '7', null, null, null, null] };
    storePrefs(scope(ALICE), alice, kv);
    expect(loadPrefs(scope(BOB), kv)).toEqual(emptyPrefs()); // Bob starts with nothing of Alice's
    storePrefs(scope(BOB), bob, kv);
    expect(loadPrefs(scope(ALICE), kv)).toEqual(alice);
    expect(loadPrefs(scope(BOB), kv)).toEqual(bob);
  });

  it('belong to one chain and one fish collection: the same id elsewhere is another fish', () => {
    const kv = memory();
    storePrefs(scope(ALICE), { saved: ['1'], showcase: ['1', null, null, null, null, null] }, kv);
    expect(loadPrefs(scope(ALICE, 1), kv)).toEqual(emptyPrefs());
    expect(loadPrefs(scope(ALICE, 20994, '0x0000000000000000000000000000000000000001'), kv)).toEqual(emptyPrefs());
    expect(prefsKey(scope(ALICE))).not.toBe(prefsKey(scope(ALICE, 1)));
    expect(prefsKey(scope(ALICE))).not.toBe(prefsKey(scope(BOB)));
  });

  it('take over the favourites kept before the Trophy Room', () => {
    const kv = memory({ [legacyFavsKey(ALICE)]: JSON.stringify(['5', '8']) });
    expect(loadPrefs(scope(ALICE), kv)).toEqual({ saved: ['5', '8'], showcase: emptyShowcase() });
    expect(loadPrefs(scope(BOB), kv)).toEqual(emptyPrefs());
    // once stored in the new place, the new place wins
    storePrefs(scope(ALICE), { saved: ['5'], showcase: emptyShowcase() }, kv);
    expect(loadPrefs(scope(ALICE), kv).saved).toEqual(['5']);
    expect(kv.data.get(legacyFavsKey(ALICE))).toBe(JSON.stringify(['5', '8'])); // the old entry is left alone
  });

  it('read garbage as nothing, and never throw', () => {
    expect(parsePrefs('{not json')).toBeNull();
    expect(parsePrefs('42')).toBeNull();
    expect(parsePrefs(null)).toBeNull();
    const kv = memory({ [prefsKey(scope(ALICE))]: '{broken' });
    expect(loadPrefs(scope(ALICE), kv)).toEqual(emptyPrefs());
    expect(kv.data.get(prefsKey(scope(ALICE)))).toBe('{broken'); // reading does not overwrite
    const failing: KV = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadPrefs(scope(ALICE), failing)).toEqual(emptyPrefs());
    expect(storePrefs(scope(ALICE), emptyPrefs(), failing)).toBe(false);
    expect(loadPrefs(scope(ALICE), null)).toEqual(emptyPrefs());
  });

  it('treat a displayed fish as saved, and drop a fish listed twice', () => {
    const p = parsePrefs(JSON.stringify({ v: 1, saved: ['1', '1'], showcase: ['2', '2', '3'] }));
    expect(p).toEqual({ saved: ['1', '2', '3'], showcase: ['2', null, '3', null, null, null] });
    expect(parsePrefs(serializePrefs(p!))).toEqual(p);
  });
});

// ------------------------------------------------------------------ what must not change

describe('special fish and the Trophy Room', () => {
  const koi = SPECIALS[0];
  const ticket = (locationId: number): CastTicket => ({ locationId, totals: totals(rodById('willow')!, null, LOCATIONS[locationId]) });
  const landSpecial = (s: Save) => landFish(s, ticket(LOCATIONS.find((l) => l.special === koi.id)!.id), { speciesId: koi.speciesId, weight: Math.round(avgWeight(SPECIES[koi.speciesId])), isSpecial: true }, 'B', NOW);

  it('displaying a special fish changes neither its bonus nor its unlock', () => {
    const l = landSpecial(freshSave(NOW));
    const before = l.save;
    expect(before.activeSpecial).toBe(koi.id);
    const shown = showcaseFish(before, l.fish.id).save;
    expect(shown.activeSpecial).toBe(koi.id);
    expect(shown.permanentUnlocks).toEqual(before.permanentUnlocks);
    expect(shown.specialsFound).toEqual(before.specialsFound);
    expect(holdsSpecial(shown, koi.id)).toBe(true);
    // the bonus slot is still the player's to switch, on display or not
    expect(setActiveSpecial(shown, null).activeSpecial).toBeNull();
    expect(setActiveSpecial(setActiveSpecial(shown, null), koi.id).activeSpecial).toBe(koi.id);
    expect(unshowcaseFish(shown, l.fish.id).activeSpecial).toBe(koi.id);
  });

  it('a special fish is still sold one at a time, turns its bonus off and keeps its unlock, once it is neither displayed nor saved', () => {
    const l = landSpecial(freshSave(NOW));
    const s: Save = { ...l.save, fish: [...l.save.fish, fishOf({ id: 'plain' })] };
    expect(s.fish.filter(bulkSellable).map((f) => f.id)).toEqual(['plain']); // never in a bulk sale
    expect(() => sellFish(s, [l.fish.id, 'plain'], LATER)).toThrow(/one at a time/);
    const shown = showcaseFish(s, l.fish.id).save;
    expect(() => sellFish(shown, [l.fish.id], LATER)).toThrow(/Trophy Room/);
    const sold = sellFish(s, [l.fish.id], LATER).save;
    expect(sold.activeSpecial).toBeNull();
    expect(isUnlocked(sold, LOCATIONS[koi.unlocksLocation])).toBe(true);
  });
});

describe('existing progress', () => {
  it('a save from before the Trophy Room loads whole, with its favourites and an empty room', () => {
    const l = landFish(freshSave(NOW), { locationId: 0, totals: totals(rodById('willow')!, null, LOCATIONS[0]) }, { speciesId: 0, weight: 300, isSpecial: false }, 'A', NOW);
    const played: Save = { ...toggleFavorite(l.save, l.fish.id), pearl: 777, xp: 4321 };
    const old = JSON.parse(JSON.stringify(played)) as Record<string, unknown>;
    delete old.showcase; // what a save written by the previous release looks like
    const back = loadSave(JSON.stringify(old), LATER);
    expect(back.status).toBe('ok');
    expect(back.save.showcase).toEqual(emptyShowcase());
    expect({ ...back.save, showcase: undefined }).toEqual({ ...played, showcase: undefined }); // nothing else moved
    expect(saved(back.save)).toEqual([l.fish.id]);
    expect(back.save.dex).toEqual(played.dex);
    expect(back.save.daily).toEqual(played.daily);
  });

  it('saving and displaying touch nothing but the star and the frames', () => {
    const l = landFish(freshSave(NOW), { locationId: 0, totals: totals(rodById('willow')!, null, LOCATIONS[0]) }, { speciesId: 0, weight: 300, isSpecial: false }, 'A', NOW);
    const s = l.save;
    const after = unshowcaseFish(moveTrophy(showcaseFish(s, l.fish.id).save, 0, 3), l.fish.id);
    const strip = (x: Save) => ({ ...x, showcase: null, fish: x.fish.map((f) => ({ ...f, isFavorite: false })) });
    expect(strip(after)).toEqual(strip(s)); // PEARL, XP, energy, encyclopedia, records, weeks, daily: all as they were
  });
});

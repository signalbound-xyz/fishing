import { describe, expect, it } from 'vitest';
import { GameError, bulkSellable, landFish, sellFish, setActiveSpecial, toggleFavorite, type CastTicket } from './actions';
import { LOCATIONS, SPECIALS, SPECIES } from './content';
import { avgWeight } from './economy';
import { totals } from './equipment';
import { ALL, PREFS_VERSION, TROPHY_PAGE, defaultQuery, emptyPrefs, legacyShowcaseIds, pageOf, parsePrefs, reconcile, serializePrefs, trophiesOf, trophyFish, type Prefs } from './favorites';
import { holdsSpecial, isUnlocked } from './progress';
import { freshSave, loadSave } from './save';
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
const ids = (list: FishInstance[]): string[] => list.map((f) => f.id);
/** The Trophy Room, as ids. */
const room = (s: Save): string[] => ids(trophiesOf(s));
const save = (s: Save, ...which: string[]): Save => which.reduce(toggleFavorite, s);
/** What the previous release wrote: the save, with its six frames. */
const withFrames = (s: Save, showcase: unknown): string => JSON.stringify({ ...s, showcase });

describe('Save fish: the one collection action', () => {
  it('saving a fish adds it to the Trophy Room', () => {
    const s = keepnet('a', 'b');
    expect(room(s)).toEqual([]);
    const on = toggleFavorite(s, 'a');
    expect(room(on)).toEqual(['a']);
    expect(on.fish.find((f) => f.id === 'a')!.isFavorite).toBe(true);
    expect(room(s)).toEqual([]); // the input save is untouched
    expect(() => toggleFavorite(s, 'ghost')).toThrow(GameError);
  });

  it('removing the favorite takes it out of the Trophy Room', () => {
    const on = save(keepnet('a', 'b'), 'a', 'b');
    expect(room(toggleFavorite(on, 'a'))).toEqual(['b']);
    expect(room(save(on, 'a', 'b'))).toEqual([]);
  });

  it('removing the favorite neither deletes nor sells the fish', () => {
    const on = { ...toggleFavorite(keepnet('a', 'b'), 'a'), pearl: 50 };
    const off = toggleFavorite(on, 'a');
    expect(ids(off.fish)).toEqual(['a', 'b']); // still in the keepnet, in its place
    expect(off.pearl).toBe(50);
    expect(off.stats).toEqual(on.stats); // nothing was sold
    expect(off.fish[0]).toEqual({ ...on.fish[0], isFavorite: false }); // the same fish, minus the star
    expect(bulkSellable(off.fish[0])).toBe(true); // and it can be sold again
    expect(sellFish(off, ['a'], LATER).earned).toBe(10);
  });

  it('the room holds every favorite: there is no limit of six', () => {
    const names = Array.from({ length: 40 }, (_, i) => `f${i}`);
    const s = save(keepnet(...names, 'plain'), ...names);
    expect(room(s)).toHaveLength(40);
    expect(room(s)).toEqual(names);
    expect(trophyFish(s)).toHaveLength(40); // whatever the order
  });

  it('never lists a fish twice', () => {
    const s = save(keepnet('a', 'b', 'c'), 'a', 'c');
    expect(new Set(room(s)).size).toBe(room(s).length);
    // a broken save that names a fish twice still frames it once
    const broken: Save = { ...s, fish: [...s.fish, { ...s.fish[0] }, { ...s.fish[2] }] };
    expect(room(broken)).toEqual(['a', 'c']);
    for (const sort of ['date', 'rarity', 'weight', 'value'] as const) expect(ids(trophyFish(broken, { ...defaultQuery(), sort })).sort()).toEqual(['a', 'c']);
    // saving twice is removing: there is no second copy to make
    expect(room(save(s, 'b', 'b'))).toEqual(['a', 'c']);
    expect(s.fish).toHaveLength(3); // the room is a view: the keepnet holds the only fish
  });

  it('touches nothing but the star', () => {
    const l = landFish(freshSave(NOW), { locationId: 0, totals: totals(rodById('willow')!, null, LOCATIONS[0]) }, { speciesId: 0, weight: 300, isSpecial: false }, 'A', NOW);
    const strip = (x: Save) => ({ ...x, fish: x.fish.map((f) => ({ ...f, isFavorite: false })) });
    const on = toggleFavorite(l.save, l.fish.id);
    expect(strip(on)).toEqual(strip(l.save)); // PEARL, XP, energy, encyclopedia, records, weeks, daily: as they were
    expect(toggleFavorite(on, l.fish.id)).toEqual(l.save);
  });
});

describe('sale protection', () => {
  const s = save(keepnet('a', 'b', 'c', 'd'), 'b', 'd');

  it('Sell all skips favorites', () => {
    // "Sell all" and "Select all" take what is bulk-sellable
    const all = ids(s.fish.filter(bulkSellable));
    expect(all).toEqual(['a', 'c']);
    const sold = sellFish(s, all, LATER);
    expect(ids(sold.save.fish)).toEqual(['b', 'd']);
    expect(room(sold.save)).toEqual(['b', 'd']); // the room is as it was
    expect(sold.earned).toBe(20);
  });

  it('Sell selected cannot include a favorite: the whole sale is refused', () => {
    expect(() => sellFish(s, ['a', 'b'], LATER)).toThrow(/Saved fish are protected/);
    expect(() => sellFish(s, ['a', 'c', 'd'], LATER)).toThrow(GameError);
    // nothing was sold on the way to the refusal
    expect(ids(s.fish)).toEqual(['a', 'b', 'c', 'd']);
    expect(s.pearl).toBe(0);
    // a fish saved after it was selected is not sellable any more either
    const picked = ['a', 'c'];
    const then = toggleFavorite(s, 'c');
    expect(picked.filter((id) => bulkSellable(then.fish.find((f) => f.id === id)!))).toEqual(['a']);
    expect(() => sellFish(then, picked, LATER)).toThrow(/protected/);
  });

  it('a direct sale rejects a favorite, until the player removes the star', () => {
    expect(() => sellFish(s, ['b'], LATER)).toThrow(/Saved fish are protected/);
    const free = toggleFavorite(s, 'b'); // the explicit action
    expect(sellFish(free, ['b'], LATER).earned).toBe(10);
    expect(room(sellFish(free, ['b'], LATER).save)).toEqual(['d']);
  });
});

describe('the Trophy Room as a view: order, filters, pages', () => {
  const s: Save = {
    ...freshSave(NOW),
    fish: [
      fishOf({ id: 'old-big', caughtAt: NOW - 3000, weight: 900, rarity: 1, sellPrice: 40, locationId: 0, isFavorite: true }),
      fishOf({ id: 'new-small', caughtAt: NOW, weight: 100, rarity: 0, sellPrice: 5, locationId: 1, isFavorite: true }),
      fishOf({ id: 'rare', caughtAt: NOW - 1000, weight: 300, rarity: 3, sellPrice: 300, locationId: 1, isFavorite: true }),
      fishOf({ id: 'rare-heavy', caughtAt: NOW - 2000, weight: 500, rarity: 3, sellPrice: 250, locationId: 0, isFavorite: true }),
      fishOf({ id: 'not-saved', caughtAt: NOW + 1, weight: 5000, rarity: 5, sellPrice: 9999 }),
    ],
  };
  const order = (sort: 'date' | 'rarity' | 'weight' | 'value'): string[] => ids(trophyFish(s, { ...defaultQuery(), sort }));

  it('sorts by newest (the default), rarest, heaviest and most valuable', () => {
    expect(ids(trophyFish(s))).toEqual(['new-small', 'rare', 'rare-heavy', 'old-big']);
    expect(defaultQuery().sort).toBe('date');
    expect(order('rarity')).toEqual(['rare-heavy', 'rare', 'old-big', 'new-small']); // the heavier of two equals first
    expect(order('weight')).toEqual(['old-big', 'rare-heavy', 'rare', 'new-small']);
    expect(order('value')).toEqual(['rare', 'rare-heavy', 'old-big', 'new-small']);
    expect(ids(s.fish)[0]).toBe('old-big'); // sorting a view does not reorder the keepnet
  });

  it('filters by rarity and by location, never showing a fish that is not saved', () => {
    expect(ids(trophyFish(s, { sort: 'date', rarity: 3, location: ALL }))).toEqual(['rare', 'rare-heavy']);
    expect(ids(trophyFish(s, { sort: 'date', rarity: ALL, location: 1 }))).toEqual(['new-small', 'rare']);
    expect(ids(trophyFish(s, { sort: 'date', rarity: 3, location: 0 }))).toEqual(['rare-heavy']);
    expect(trophyFish(s, { sort: 'date', rarity: 2, location: ALL })).toEqual([]);
    expect(ids(trophyFish(s, { sort: 'value', rarity: 5, location: ALL }))).not.toContain('not-saved');
  });

  it('a large room is shown a page at a time', () => {
    const many = Array.from({ length: 250 }, (_, i) => fishOf({ id: `t${i}`, caughtAt: NOW - i, isFavorite: true }));
    const big: Save = { ...freshSave(NOW), fish: many };
    const list = trophyFish(big);
    expect(list).toHaveLength(250);
    expect(TROPHY_PAGE).toBeGreaterThanOrEqual(12);
    expect(TROPHY_PAGE).toBeLessThanOrEqual(18);

    const first = pageOf(list, TROPHY_PAGE);
    expect(first.items).toHaveLength(TROPHY_PAGE); // not 250
    expect(ids(first.items)).toEqual(ids(list.slice(0, TROPHY_PAGE)));
    expect(first.rest).toBe(250 - TROPHY_PAGE);
    expect(first.next).toBe(TROPHY_PAGE);

    // "Load more", again and again: every trophy is reached exactly once, in order
    let shown = TROPHY_PAGE;
    let page = first;
    let clicks = 0;
    while (page.rest > 0) {
      shown = page.items.length + TROPHY_PAGE;
      const more = pageOf(list, shown);
      expect(more.items.length - page.items.length).toBe(page.next);
      page = more;
      clicks++;
    }
    expect(ids(page.items)).toEqual(ids(list));
    expect(page.next).toBe(0);
    expect(clicks).toBe(Math.ceil(250 / TROPHY_PAGE) - 1);
    // the last page is whatever is left
    expect(pageOf(list, 240 + (TROPHY_PAGE - (240 % TROPHY_PAGE || TROPHY_PAGE))).next).toBeLessThanOrEqual(TROPHY_PAGE);
  });

  it('a page never asks for more than there is, or less than one page', () => {
    expect(pageOf(['a', 'b', 'c'], TROPHY_PAGE)).toEqual({ items: ['a', 'b', 'c'], rest: 0, next: 0 });
    expect(pageOf([], TROPHY_PAGE)).toEqual({ items: [], rest: 0, next: 0 });
    const list = Array.from({ length: 30 }, (_, i) => i);
    expect(pageOf(list, 0).items).toHaveLength(TROPHY_PAGE);
    expect(pageOf(list, Number.NaN).items).toHaveLength(TROPHY_PAGE);
    expect(pageOf(list, 1000)).toEqual({ items: list, rest: 0, next: 0 });
    expect(pageOf(list, 24)).toMatchObject({ rest: 6, next: 6 });
    // a trophy removed from a paged room: the next one moves up, the page stays as long
    expect(pageOf(list.slice(1), 24).items).toHaveLength(24);
  });
});

describe('players who used the six frames', () => {
  /** a and b in frames, c saved but not shown, d and e plain. */
  const before = (): Save => ({ ...save(keepnet('a', 'b', 'c', 'd', 'e'), 'a', 'b', 'c'), pearl: 321, xp: 999 });

  it('what hung in a frame is a favorite, and in the new room', () => {
    const back = loadSave(withFrames(before(), ['b', null, 'a', null, null, null]), LATER);
    expect(back.status).toBe('ok');
    expect(room(back.save)).toEqual(['a', 'b', 'c']);
    expect(() => sellFish(back.save, ['a'], LATER)).toThrow(/protected/);
    // even when the old save did not carry the star for it
    const noStar: Save = { ...before(), fish: before().fish.map((f) => (f.id === 'a' ? { ...f, isFavorite: false } : f)) };
    const fixed = loadSave(withFrames(noStar, ['a', null, null, null, null, null]), LATER).save;
    expect(room(fixed)).toEqual(['a', 'b', 'c']);
  });

  it('saved fish that were not on display stay favorites', () => {
    const back = loadSave(withFrames(before(), [null, null, null, null, null, null]), LATER).save;
    expect(room(back)).toEqual(['a', 'b', 'c']);
    // a save from before any Trophy Room: the same
    expect(room(loadSave(JSON.stringify(before()), LATER).save)).toEqual(['a', 'b', 'c']);
  });

  it('every fish is in the room once, however it got there', () => {
    // on display and saved at the same time, which was the rule: one card, not two
    const back = loadSave(withFrames(before(), ['a', 'b', 'c', null, null, null]), LATER).save;
    expect(room(back)).toEqual(['a', 'b', 'c']);
    expect(back.fish).toHaveLength(5);
  });

  it('nothing else in the save moves, and the frames are retired', () => {
    const l = landFish(freshSave(NOW), { locationId: 0, totals: totals(rodById('willow')!, null, LOCATIONS[0]) }, { speciesId: 0, weight: 300, isSpecial: false }, 'A', NOW);
    const played: Save = { ...toggleFavorite(l.save, l.fish.id), pearl: 777, xp: 4321, claimed: ['x'], permanentUnlocks: [0, 1] };
    const back = loadSave(withFrames(played, [l.fish.id, null, null, null, null, null]), LATER);
    expect(back.status).toBe('ok'); // no reset, no "newer", no "corrupt"
    expect(back.save).toEqual(played); // PEARL, XP, tackle, achievements, unlocks, records, daily
    expect('showcase' in back.save).toBe(false);
    expect('showcase' in freshSave(NOW)).toBe(false);
    // and loading it again changes nothing
    expect(loadSave(JSON.stringify(back.save), LATER).save).toEqual(played);
  });

  it('a frame that held garbage, or a fish that is gone, harms nothing', () => {
    const back = loadSave(withFrames(before(), ['ghost', 7, null, 'd', 'd', { id: 'a' }, 'e', 'e']), LATER).save;
    expect(room(back)).toEqual(['a', 'b', 'c', 'd', 'e']); // d and e hung there; the ghost is nobody
    expect(back.fish).toHaveLength(5);
    expect(room(loadSave(withFrames(before(), 'nonsense'), LATER).save)).toEqual(['a', 'b', 'c']);
    expect(legacyShowcaseIds(['a', null, 'a', 3, ''])).toEqual(['a']);
    expect(legacyShowcaseIds(undefined)).toEqual([]);
  });

  it('on the contracts: stored frames become saved fish', () => {
    // version 1 of the preferences: saved ids and six frames
    const v1 = JSON.stringify({ v: 1, saved: ['1', '2'], showcase: ['2', null, '9', null, null, null] });
    expect(parsePrefs(v1)).toEqual({ saved: ['1', '2', '9'] });
    // written back in the new shape, without frames, and read the same
    const again = serializePrefs(parsePrefs(v1)!);
    expect(JSON.parse(again)).toEqual({ v: PREFS_VERSION, saved: ['1', '2', '9'] });
    expect(parsePrefs(again)).toEqual({ saved: ['1', '2', '9'] });
  });
});

describe('reload', () => {
  it('keeps the favorite status in the local save', () => {
    const s = save(keepnet('a', 'b', 'c'), 'b', 'c');
    const back = loadSave(JSON.stringify(s), LATER);
    expect(back.status).toBe('ok');
    expect(back.save).toEqual(s);
    expect(room(back.save)).toEqual(['b', 'c']);
    // removed, then reloaded: it stays removed
    expect(room(loadSave(JSON.stringify(toggleFavorite(s, 'b')), LATER).save)).toEqual(['c']);
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
    const p: Prefs = { saved: ['12', '40'] };
    expect(storePrefs(scope(ALICE), p, kv)).toBe(true);
    expect(loadPrefs(scope(ALICE), kv)).toEqual(p); // a new page reads the same thing
    expect(loadPrefs(scope(ALICE.toLowerCase()), kv)).toEqual(p); // however the address is written
  });

  it('belong to one account: switching the wallet shows the other one’s, and coming back restores the first', () => {
    const kv = memory();
    const alice: Prefs = { saved: ['1', '2'] };
    const bob: Prefs = { saved: ['7'] };
    storePrefs(scope(ALICE), alice, kv);
    expect(loadPrefs(scope(BOB), kv)).toEqual(emptyPrefs()); // Bob starts with nothing of Alice's
    storePrefs(scope(BOB), bob, kv);
    expect(loadPrefs(scope(ALICE), kv)).toEqual(alice);
    expect(loadPrefs(scope(BOB), kv)).toEqual(bob);
  });

  it('belong to one chain and one fish collection: the same id elsewhere is another fish', () => {
    const kv = memory();
    storePrefs(scope(ALICE), { saved: ['1'] }, kv);
    expect(loadPrefs(scope(ALICE, 1), kv)).toEqual(emptyPrefs());
    expect(loadPrefs(scope(ALICE, 20994, '0x0000000000000000000000000000000000000001'), kv)).toEqual(emptyPrefs());
    expect(prefsKey(scope(ALICE))).not.toBe(prefsKey(scope(ALICE, 1)));
    expect(prefsKey(scope(ALICE))).not.toBe(prefsKey(scope(BOB)));
    expect(prefsKey(scope(ALICE))).toContain('20994');
  });

  it('are found where the previous release left them: same key, frames and all', () => {
    const kv = memory({ [prefsKey(scope(ALICE))]: JSON.stringify({ v: 1, saved: ['5'], showcase: [null, '8', null, null, null, '5'] }) });
    expect(loadPrefs(scope(ALICE), kv)).toEqual({ saved: ['5', '8'] });
    expect(loadPrefs(scope(BOB), kv)).toEqual(emptyPrefs());
    // reading rewrites nothing: the entry changes when the player changes something
    expect(JSON.parse(kv.data.get(prefsKey(scope(ALICE)))!)).toMatchObject({ v: 1 });
  });

  it('take over the favourites kept before any Trophy Room', () => {
    const kv = memory({ [legacyFavsKey(ALICE)]: JSON.stringify(['5', '8']) });
    expect(loadPrefs(scope(ALICE), kv)).toEqual({ saved: ['5', '8'] });
    expect(loadPrefs(scope(BOB), kv)).toEqual(emptyPrefs());
    // once stored in the new place, the new place wins
    storePrefs(scope(ALICE), { saved: ['5'] }, kv);
    expect(loadPrefs(scope(ALICE), kv).saved).toEqual(['5']);
    expect(kv.data.get(legacyFavsKey(ALICE))).toBe(JSON.stringify(['5', '8'])); // the old entry is left alone
  });

  it('read garbage as nothing, and never throw', () => {
    expect(parsePrefs('{not json')).toBeNull();
    expect(parsePrefs('42')).toBeNull();
    expect(parsePrefs(null)).toBeNull();
    expect(parsePrefs(JSON.stringify({ saved: ['1', '1', 2, ''] }))).toEqual({ saved: ['1'] });
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
});

describe('a fish that is gone', () => {
  it('local game: a sold fish is in no room, and a saved id without its fish frames nothing', () => {
    const s = save(keepnet('a', 'b'), 'a', 'b');
    const sold = sellFish(toggleFavorite(s, 'a'), ['a'], LATER).save;
    expect(room(sold)).toEqual(['b']);
    // the old frames may still name it: there is no fish to hang
    expect(room(loadSave(withFrames(sold, ['a', 'b', null, null, null, null]), LATER).save)).toEqual(['b']);
  });

  it('on the contracts: a fish sold or transferred outside the game leaves the room after a read of the keepnet', () => {
    const p: Prefs = { saved: ['1', '2', '3', '9'] };
    const r = reconcile(p, ['1', '2', '3', '4']); // 9 is not in the wallet any more
    expect(r.prefs.saved).toEqual(['1', '2', '3']);
    expect(r.dropped).toEqual(['9']);
    expect(r.changed).toBe(true);
    expect(p.saved).toContain('9'); // the input is untouched
    // 4 is owned and not saved: owning a fish does not save it
    expect(r.prefs.saved).not.toContain('4');
  });

  it('on the contracts: nothing changes while every saved fish is still there', () => {
    const p: Prefs = { saved: ['1', '3'] };
    const r = reconcile(p, ['1', '2', '3']);
    expect(r.changed).toBe(false);
    expect(r.prefs).toBe(p);
    expect(r.dropped).toEqual([]);
  });

  it('on the contracts: only a keepnet that was really read empties the room', () => {
    const kv = memory();
    const p: Prefs = { saved: ['1', '2'] };
    storePrefs(scope(ALICE), p, kv);
    // a failed RPC read: reconcile is never called, and the stored stars are what they were
    expect(loadPrefs(scope(ALICE), kv)).toEqual(p);
    // an empty keepnet that was read is a fact
    expect(reconcile(p, []).prefs).toEqual(emptyPrefs());
  });
});

// ------------------------------------------------------------------ what must not change

describe('special fish', () => {
  const koi = SPECIALS[0];
  const ticket = (locationId: number): CastTicket => ({ locationId, totals: totals(rodById('willow')!, null, LOCATIONS[locationId]) });
  const landSpecial = (s: Save) => landFish(s, ticket(LOCATIONS.find((l) => l.special === koi.id)!.id), { speciesId: koi.speciesId, weight: Math.round(avgWeight(SPECIES[koi.speciesId])), isSpecial: true }, 'B', NOW);

  it('a special fish can be saved, and hangs with the ordinary ones', () => {
    const l = landSpecial(freshSave(NOW));
    const s = save({ ...l.save, fish: [...l.save.fish, fishOf({ id: 'plain' })] }, l.fish.id, 'plain');
    expect(room(s).sort()).toEqual([l.fish.id, 'plain'].sort());
    expect(trophiesOf(s).find((f) => f.id === l.fish.id)!.isSpecial).toBe(true);
  });

  it('saving or removing it changes neither its bonus, its unlock, its ownership nor what was discovered', () => {
    const l = landSpecial(freshSave(NOW));
    const before = l.save;
    expect(before.activeSpecial).toBe(koi.id);
    const on = toggleFavorite(before, l.fish.id);
    const off = toggleFavorite(on, l.fish.id);
    for (const s of [on, off]) {
      expect(s.activeSpecial).toBe(koi.id);
      expect(s.permanentUnlocks).toEqual(before.permanentUnlocks);
      expect(s.specialsFound).toEqual(before.specialsFound);
      expect(s.dry).toEqual(before.dry);
      expect(holdsSpecial(s, koi.id)).toBe(true);
      expect(isUnlocked(s, LOCATIONS[koi.unlocksLocation])).toBe(true);
    }
    expect(off).toEqual(before);
    // the bonus slot is still the player's to switch, saved or not
    expect(setActiveSpecial(on, null).activeSpecial).toBeNull();
    expect(setActiveSpecial(setActiveSpecial(on, null), koi.id).activeSpecial).toBe(koi.id);
  });

  it('is still never in a bulk sale, sold one at a time, and protected while saved', () => {
    const l = landSpecial(freshSave(NOW));
    const s: Save = { ...l.save, fish: [...l.save.fish, fishOf({ id: 'plain' })] };
    expect(ids(s.fish.filter(bulkSellable))).toEqual(['plain']);
    expect(() => sellFish(s, [l.fish.id, 'plain'], LATER)).toThrow(/one at a time/);
    expect(() => sellFish(toggleFavorite(s, l.fish.id), [l.fish.id], LATER)).toThrow(/protected/);
    // removing the star does not put it into "Sell all"
    expect(ids(toggleFavorite(toggleFavorite(s, l.fish.id), l.fish.id).fish.filter(bulkSellable))).toEqual(['plain']);
    // sold on its own: the bonus turns off, the unlock stays
    const sold = sellFish(s, [l.fish.id], LATER).save;
    expect(sold.activeSpecial).toBeNull();
    expect(isUnlocked(sold, LOCATIONS[koi.unlocksLocation])).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { FIGHT_GREEN, castFight, greenOf, resolveCast, type CastInput, type ChainCatalog } from './chainOutcome';
import { MAX_TICKS, U, botInputs, fightParams, packInputs, replayFight } from './fight';
import { greenWidth } from './minigame';
import { RODS } from '../tackle/catalog';
import { currentTotals } from './actions';
import { freshSave } from './save';
import { BLEND_PRIZE, LOCATIONS, SPECIALS, SPECIES } from './content';
import vectors from './fixtures/outcomes.json';

/** The catalog as the client knows it (play/chain.ts checks it against the contracts at start-up). */
function catalog(blendChancePpm: number): ChainCatalog {
  return {
    config: { blendChancePpm, blendMaxWins: 1, qualityPerCatch: 150, qualityPerRarity: 300 },
    locations: LOCATIONS.map((l) => ({
      special: l.special ? SPECIALS.findIndex((s) => s.id === l.special) + 1 : 0,
      speciesIds: l.pool.map(([id]) => id),
      weights: l.pool.map(([, w]) => w),
    })),
    species: SPECIES.map((s) => ({ rarity: s.rarity, minWeight: s.minWeight, maxWeight: s.maxWeight, hidden: !!s.hidden })),
    specials: SPECIALS.map((s) => ({ speciesId: s.speciesId, chancePpm: Math.round(s.chance * 1_000_000), pity: s.pity })),
    tiers: LOCATIONS.map((l) => l.tier),
  };
}

interface Vector extends Omit<CastInput, 'nonce' | 'blockHash' | 'player' | 'game' | 'bottleAmount'> {
  blockHash: string;
  player: string;
  game: string;
  nonce: number;
  blendChancePpm: number;
  expected: { kind: string; speciesId?: number; weight?: number; quality?: number; amountWei?: string; fight?: { seed: string; difficulty: number; green: number; ticks: number; landing: string } };
}

describe('predicting a cast outcome', () => {
  /** The vectors were written with the default prize; the amount is an input of the prediction, read from the pool. */
  const list = (vectors as Vector[]).map((v) => ({ ...v, bottleAmount: BLEND_PRIZE.amount }));

  it('has vectors for every branch', () => {
    const kinds = new Set(list.map((v) => v.expected.kind));
    expect(kinds).toEqual(new Set(['caught', 'missed', 'bottle']));
    expect(list.some((v) => v.expected.kind === 'caught' && SPECIES[v.expected.speciesId!].special)).toBe(true);
    expect(new Set(list.map((v) => v.locationId)).size).toBe(LOCATIONS.length);
    expect(list.some((v) => v.loadout.rodCatch < 0)).toBe(true);
    expect(list.some((v) => v.bottleOpen)).toBe(true);
  });

  it('never predicts a bottle while none is open for the player', () => {
    const open = list.find((v) => v.expected.kind === 'bottle')!;
    const input = { ...open, blockHash: open.blockHash as `0x${string}`, player: open.player as `0x${string}`, game: open.game as `0x${string}`, nonce: BigInt(open.nonce) };
    expect(resolveCast(catalog(open.blendChancePpm), input).kind).toBe('bottle');
    expect(resolveCast(catalog(open.blendChancePpm), { ...input, bottleOpen: false }).kind).toBe('caught');
    // and the vectors hold bites the roll would have made a bottle, landed as fish because none was open
    const shut = list.filter((v) => !v.bottleOpen && v.expected.kind === 'caught');
    const wouldBe = shut.filter((v) => resolveCast(catalog(v.blendChancePpm), { ...v, bottleOpen: true, blockHash: v.blockHash as `0x${string}`, player: v.player as `0x${string}`, game: v.game as `0x${string}`, nonce: BigInt(v.nonce) }).kind === 'bottle');
    expect(wouldBe.length).toBeGreaterThan(0);
  });

  it('matches every outcome the contract produced', () => {
    for (const v of list) {
      const got = resolveCast(catalog(v.blendChancePpm), {
        ...v,
        blockHash: v.blockHash as `0x${string}`,
        player: v.player as `0x${string}`,
        game: v.game as `0x${string}`,
        nonce: BigInt(v.nonce),
      });
      const e = v.expected;
      if (e.kind === 'caught') {
        expect(got, `nonce ${v.nonce}`).toEqual({
          kind: 'caught',
          speciesId: e.speciesId,
          weight: e.weight,
          quality: e.quality,
          special: !!SPECIES[e.speciesId!].special,
          // the fight the judge set for this fish (ReelJudge.fightOf, asked by the contracts' own test)
          fight: { seed: BigInt(e.fight!.seed), difficulty: e.fight!.difficulty, green: e.fight!.green },
        });
      } else if (e.kind === 'bottle') {
        expect(got, `nonce ${v.nonce}`).toEqual({ kind: 'bottle', amount: Number(BigInt(e.amountWei!) / 10n ** 18n) });
      } else {
        expect(got, `nonce ${v.nonce}`).toEqual({ kind: 'missed' });
      }
    }
  });

  it('replays the recording the game accepted for each fish, to the same end after as many ticks', () => {
    const fish = list.filter((v) => v.expected.kind === 'caught');
    expect(fish.length).toBeGreaterThan(100);
    for (const v of fish) {
      const f = v.expected.fight!;
      const landing = f.landing as `0x${string}`;
      const got = replayFight(BigInt(f.seed), f.difficulty, f.green, landing);
      expect(got.landed, `nonce ${v.nonce}`).toBe(true);
      expect(got.ticks, `nonce ${v.nonce}`).toBe(f.ticks);
      // and the same fight is lost the ways a fight can be lost: never played, let go, held to the end
      const lose = (bits: boolean[]): boolean => replayFight(BigInt(f.seed), f.difficulty, f.green, packInputs(bits)).landed;
      expect(replayFight(BigInt(f.seed), f.difficulty, f.green, '0x').landed).toBe(false);
      expect(lose(new Array(MAX_TICKS).fill(false))).toBe(false);
      expect(lose(new Array(MAX_TICKS).fill(true))).toBe(false);
      // stopped a moment before the pier: the recording without its last byte
      expect(replayFight(BigInt(f.seed), f.difficulty, f.green, landing.slice(0, -2) as `0x${string}`).landed).toBe(false);
    }
  });

  it('covers every difficulty and bands narrower and wider than the starter rod’s', () => {
    const fights = list.filter((v) => v.expected.kind === 'caught').map((v) => v.expected.fight!);
    expect(new Set(fights.map((f) => f.difficulty))).toEqual(new Set([0, 1, 2, 3, 4, 5]));
    expect(fights.some((f) => f.green < FIGHT_GREEN.base)).toBe(true);
    expect(fights.some((f) => f.green > FIGHT_GREEN.base)).toBe(true);
  });

  it('draws the green band the judge checks, for every rod at every water', () => {
    // the band the player sees comes from the rod's zone stat; the band the judge replays from the rod's catch
    for (const loc of LOCATIONS) {
      for (const rod of RODS) {
        const s = freshSave(0);
        s.rods[rod.id] = { durability: rod.wear };
        s.equipped = { rod: rod.id, lure: null };
        const t = currentTotals(s, loc.id);
        expect(Math.round(greenWidth(t.zone) * U), `${rod.name} at ${loc.name}`).toBe(greenOf(t.rod.catch));
      }
    }
    expect(greenOf(0)).toBe(25_000);
    expect(greenOf(1_000)).toBe(37_500);
    expect(greenOf(-1_000)).toBe(15_000);
    // and a better rod is a wider band: the tackle keeps what it gives
    expect(greenOf(6)).toBeGreaterThan(greenOf(0));
  });

  it('sets a fight by the fish and the water, capped, with the seed of the cast and nothing else', () => {
    expect(castFight(7n, 4, 2, 0).difficulty).toBe(5);
    expect(castFight(7n, 1, 1, 0).difficulty).toBe(2);
    expect(castFight(7n, 0, 0, 3).seed).toBe(castFight(7n, 5, 2, -4).seed);
    expect(castFight(7n, 0, 0, 0).seed).not.toBe(castFight(8n, 0, 0, 0).seed);
    // a stand-in player lands the easiest fight: the machine the page runs is the one the contract replays
    const f = castFight(7n, 0, 0, 0);
    const bits = botInputs(f.seed, f.difficulty, f.green);
    expect(replayFight(f.seed, f.difficulty, f.green, packInputs(bits)).landed).toBe(true);
    expect(fightParams(f.difficulty, f.green).hi - fightParams(f.difficulty, f.green).lo).toBe(25_000);
  });

  it('reports an unreadable block as expired', () => {
    const v = list[0];
    const base = { ...v, player: v.player as `0x${string}`, game: v.game as `0x${string}`, nonce: BigInt(v.nonce) };
    expect(resolveCast(catalog(1000), { ...base, blockHash: null })).toEqual({ kind: 'expired' });
    expect(resolveCast(catalog(1000), { ...base, blockHash: `0x${'0'.repeat(64)}` })).toEqual({ kind: 'expired' });
  });

  it('depends on the player and the nonce, so outcomes cannot be shared or replayed', () => {
    const v = list.find((x) => x.expected.kind === 'caught')!;
    const base = { ...v, blockHash: v.blockHash as `0x${string}`, player: v.player as `0x${string}`, game: v.game as `0x${string}`, nonce: BigInt(v.nonce) };
    const c = catalog(v.blendChancePpm);
    const same = resolveCast(c, base);
    const outcomes = new Set<string>();
    for (let k = 1; k <= 20; k++) outcomes.add(JSON.stringify(resolveCast(c, { ...base, nonce: base.nonce + BigInt(k) }), (_, x) => (typeof x === 'bigint' ? x.toString() : x)));
    expect(outcomes.size).toBeGreaterThan(5);
    expect(resolveCast(c, base)).toEqual(same);
  });
});

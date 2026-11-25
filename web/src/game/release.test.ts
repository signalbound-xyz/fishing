import { encodeFunctionResult, toFunctionSelector, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { gameLensAbi } from '../abi';
import { CAST_OF_SELECTOR, castNeedsFight, decodePlayerView, isRelease004, releaseOf, reelWindowOf } from './release';
import released from './fixtures/release003.json';
import released004 from './fixtures/release004.json';

const word = (n: number) => n.toString(16).padStart(64, '0');

describe('which release answered', () => {
  it('knows release 003 by the length of a cast, from the chain’s own answer', () => {
    expect(isRelease004(released.castOf as Hex)).toBe(false);
  });

  it('knows release 004 by the seventh word, from the chain’s own answer', () => {
    expect(isRelease004(released004.castOf as Hex)).toBe(true);
    expect(releaseOf(released004.castOf as Hex)).toBe(4);
    expect(releaseOf(released.castOf as Hex)).toBe(3);
  });

  it('knows release 005 by the eighth word, and a later one is read as it', () => {
    expect(releaseOf(`0x${word(0).repeat(8)}`)).toBe(5);
    expect(releaseOf(`0x${word(0).repeat(9)}`)).toBe(5);
    expect(isRelease004(`0x${word(0).repeat(8)}`)).toBe(true);
  });

  it('reads whether a cast has to be reeled in from the game’s own answer', () => {
    // target block, nonce, location, rod, lure, special, counted, fight
    const cast = (fight: number): Hex => `0x${[77, 3, 0, 1, 0, 0, 1, fight].map(word).join('')}`;
    expect(castNeedsFight(cast(1))).toBe(true);
    expect(castNeedsFight(cast(0))).toBe(false);
    // a release that checks no fights has no such word: its casts are landed the old way
    expect(castNeedsFight(released004.castOf as Hex)).toBe(false);
    expect(castNeedsFight(released.castOf as Hex)).toBe(false);
    expect(() => castNeedsFight('0x')).toThrow();
  });

  it('refuses an answer that is no cast, rather than guess', () => {
    expect(() => isRelease004(undefined)).toThrow();
    expect(() => isRelease004('0x')).toThrow();
    expect(() => isRelease004(`0x${word(0).repeat(2)}`)).toThrow();
    expect(() => isRelease004(`0x${word(0).repeat(6)}00`)).toThrow();
  });

  it('asks with the selector of castOf', () => {
    expect(CAST_OF_SELECTOR).toBe(toFunctionSelector('castOf(address)'));
  });

  it('gives the long window only to a release that has it on a chain that keeps the history', () => {
    expect(reelWindowOf(true, true)).toBe(8191n);
    expect(reelWindowOf(false, true)).toBe(256n); // Fluent Testnet before the upgrade: the history is there, the game does not ask it
    expect(reelWindowOf(true, false)).toBe(256n);
    expect(reelWindowOf(false, false)).toBe(256n);
  });
});

describe('a player’s view', () => {
  it('is read from release 003’s lens as the chain answered it', () => {
    const v = decodePlayerView(released.playerView as Hex, 3);
    // the same numbers the released ABI gives for this answer
    expect(v.p.casts).toBe(70);
    expect(v.p.catches).toBe(47);
    expect(v.p.xp).toBe(670n);
    expect(v.energyNow).toBe(17n);
    expect(v.week).toBe(2968n);
    expect(v.blockNumber).toBe(BigInt(released.block));
    expect(v.best).toEqual({ speciesId: 35, weight: 7512, at: 1795367563 });
    expect(v.lureCasts).toEqual([0, 0, 5, 0, 0, 0]);
    expect(v.dex).toHaveLength(36);
    expect(v.bestByLocation).toHaveLength(8);
    expect(v.weekEntries).toHaveLength(10);
    // what release 003 does not have reads as "off"
    expect(v.cast.counted).toBe(false);
    expect(v.cast.fight).toBe(false);
    expect(v.castingPaused).toBe(false);
  });

  it('is read from release 004’s lens as the chain answered it', () => {
    const v = decodePlayerView(released004.playerView as Hex, 4);
    expect(v.blockNumber).toBe(BigInt(released004.block));
    // the same player as in the release 003 answer, later: nothing a player has earned goes down
    const before = decodePlayerView(released.playerView as Hex, 3);
    expect(v.p.casts).toBeGreaterThanOrEqual(before.p.casts);
    expect(v.p.xp).toBeGreaterThanOrEqual(before.p.xp);
    expect(v.dex).toHaveLength(36);
    expect(v.bestByLocation).toHaveLength(8);
    expect(v.castingPaused).toBe(false);
    // release 004 checks no fights
    expect(v.cast.fight).toBe(false);
  });

  it('is read from the current lens with the fields each release added', () => {
    const before = decodePlayerView(released004.playerView as Hex, 4);
    const data = encodeFunctionResult({
      abi: gameLensAbi,
      functionName: 'playerView',
      result: { ...before, cast: { ...before.cast, targetBlock: 123n, counted: true, fight: true }, castingPaused: true },
    });
    const v = decodePlayerView(data, 5);
    expect(v.castingPaused).toBe(true);
    expect(v.cast).toMatchObject({ targetBlock: 123n, counted: true, fight: true });
    expect({ ...v, cast: before.cast, castingPaused: false }).toEqual(before);
  });

  it('does not take one release’s answer for another’s', () => {
    // the shapes differ by whole words: read with the wrong one, an answer either fails or says something else
    const read = (data: Hex, lens: 3 | 4 | 5): unknown => {
      try {
        return decodePlayerView(data, lens);
      } catch {
        return null;
      }
    };
    for (const wrong of [4, 5] as const) {
      const got = read(released.playerView as Hex, wrong);
      if (got) expect(got).not.toEqual(decodePlayerView(released.playerView as Hex, 3));
    }
    for (const wrong of [3, 5] as const) {
      const got = read(released004.playerView as Hex, wrong);
      if (got) expect(got).not.toEqual(decodePlayerView(released004.playerView as Hex, 4));
    }
  });
});

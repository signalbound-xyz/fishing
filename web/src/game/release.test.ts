import { encodeFunctionResult, toFunctionSelector, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { gameLensAbi } from '../abi';
import { CAST_OF_SELECTOR, decodePlayerView, isRelease004, reelWindowOf } from './release';
import released from './fixtures/release003.json';

const word = (n: number) => n.toString(16).padStart(64, '0');

describe('which release answered', () => {
  it('knows release 003 by the length of a cast, from the chain’s own answer', () => {
    expect(isRelease004(released.castOf as Hex)).toBe(false);
  });

  it('knows release 004 by the seventh word', () => {
    expect(isRelease004(`0x${word(0).repeat(7)}`)).toBe(true);
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
    const v = decodePlayerView(released.playerView as Hex, false);
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
    expect(v.castingPaused).toBe(false);
  });

  it('is read from release 004’s lens with the fields it added', () => {
    const before = decodePlayerView(released.playerView as Hex, false);
    const data = encodeFunctionResult({
      abi: gameLensAbi,
      functionName: 'playerView',
      result: { ...before, cast: { ...before.cast, targetBlock: 123n, counted: true }, castingPaused: true },
    });
    const v = decodePlayerView(data, true);
    expect(v.castingPaused).toBe(true);
    expect(v.cast).toMatchObject({ targetBlock: 123n, counted: true });
    expect({ ...v, cast: before.cast, castingPaused: false }).toEqual(before);
  });

  it('does not take one release’s answer for the other’s', () => {
    // the shapes differ by whole words: read with the wrong one, an answer either fails or says something else
    let wrong: unknown = null;
    try {
      wrong = decodePlayerView(released.playerView as Hex, true);
    } catch {
      wrong = null;
    }
    if (wrong) expect(wrong).not.toEqual(decodePlayerView(released.playerView as Hex, false));
  });
});

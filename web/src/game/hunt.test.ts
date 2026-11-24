import { describe, expect, it } from 'vitest';
import { CHANCE_UNIT, MAX_CHANCE, atLeastOnce, bestChance, bonusParts, chanceOf, countdown, drandRound, drandTime, idsOf, levelOfXp, oddsText, shareText, timesText, type HuntOdds } from './hunt';

// The season of contracts/test/SeasonHunt.t.sol (`_rules`), and the chances the contract gives for it there.
const ODDS: HuntOdds = {
  baseChance: 33_000_000,
  maxBonus: 200,
  rodBonus: [0, 30, 0, 60, 0, 80],
  lureBonus: [0, 30, 60, 0, 0, 80],
  waterBonus: [0, 30],
};

describe('the chance of an attempt', () => {
  it('is the contract’s: base chance plus the added, capped bonuses', () => {
    expect(chanceOf(ODDS, 0, null, 0)).toBe(33_000_000);
    expect(chanceOf(ODDS, 1, null, 0)).toBe(42_900_000);
    expect(chanceOf(ODDS, 1, 1, 0)).toBe(52_800_000);
    expect(chanceOf(ODDS, 3, 2, 1)).toBe(82_500_000);
    expect(chanceOf(ODDS, 0, 5, 0)).toBe(59_400_000);
    expect(chanceOf(ODDS, 5, 5, 1)).toBe(95_700_000);
  });

  it('caps the sum of the bonuses', () => {
    const capped = { ...ODDS, maxBonus: 100 };
    expect(chanceOf(capped, 5, 5, 1)).toBe(66_000_000);
    expect(bonusParts(capped, 5, 5, 1)).toEqual({ rod: 80, lure: 80, water: 30, total: 100, capped: true });
    expect(bonusParts(ODDS, 1, null, 0)).toEqual({ rod: 30, lure: 0, water: 0, total: 30, capped: false });
    expect(bestChance(capped)).toBe(66_000_000);
  });

  it('gives tackle the season does not know no bonus, and never less than the base chance', () => {
    expect(chanceOf(ODDS, 12, 9, 7)).toBe(ODDS.baseChance);
    for (let rod = 0; rod < 8; rod++) {
      for (let lure = -1; lure < 8; lure++) {
        for (let water = 0; water < 8; water++) {
          const c = chanceOf(ODDS, rod, lure < 0 ? null : lure, water);
          expect(c).toBeGreaterThanOrEqual(ODDS.baseChance);
          expect(c).toBeLessThanOrEqual(bestChance(ODDS));
          expect(c).toBeLessThanOrEqual(MAX_CHANCE);
        }
      }
    }
  });

  it('adds up over attempts without ever reaching certainty', () => {
    expect(atLeastOnce(0, 1000)).toBe(0);
    expect(atLeastOnce(CHANCE_UNIT / 10, 1)).toBeCloseTo(0.1, 12);
    expect(atLeastOnce(CHANCE_UNIT / 10, 20)).toBeCloseTo(1 - 0.9 ** 20, 12);
    expect(atLeastOnce(MAX_CHANCE, 140)).toBeLessThan(1);
  });
});

describe('how a chance is shown', () => {
  it('as odds, rounded to what a person can hold', () => {
    expect(oddsText(100_000_000)).toBe('1 in 10');
    expect(oddsText(33_000_000)).toBe('1 in 30');
    expect(oddsText(8_000_000)).toBe('1 in 125');
    expect(oddsText(3_300_000)).toBe('1 in 303');
    expect(oddsText(207_000)).toBe('1 in 4,830');
    expect(oddsText(23_348)).toBe('1 in 42,800');
    expect(oddsText(1)).toBe('1 in 1,000,000,000');
    expect(oddsText(0)).toBe('no chance');
  });

  it('as a multiple of the base chance', () => {
    expect(timesText(ODDS, 33_000_000)).toBe('×1');
    expect(timesText(ODDS, 52_800_000)).toBe('×1.6');
    expect(timesText(ODDS, 95_700_000)).toBe('×2.9');
  });

  it('as a share that does not pretend to precision', () => {
    expect(shareText(0)).toBe('0%');
    expect(shareText(0.0004)).toBe('under 0.1%');
    expect(shareText(0.0234)).toBe('2.3%');
    expect(shareText(0.4567)).toBe('46%');
  });
});

describe('small helpers', () => {
  it('reads a bit mask', () => {
    expect(idsOf(0)).toEqual([]);
    expect(idsOf(0b1011)).toEqual([0, 1, 3]);
    expect(idsOf(0x21)).toEqual([0, 5]);
  });

  it('knows the level of an amount of XP', () => {
    expect(levelOfXp(0)).toBe(1);
    expect(levelOfXp(99)).toBe(1);
    expect(levelOfXp(100)).toBe(2);
    expect(levelOfXp(300)).toBe(3);
    expect(levelOfXp(2799)).toBe(7);
    expect(levelOfXp(2800)).toBe(8);
  });

  it('counts down', () => {
    expect(countdown(-5)).toBe('0s');
    expect(countdown(45)).toBe('45s');
    expect(countdown(125)).toBe('2m 05s');
    expect(countdown(2 * 3600 + 5 * 60)).toBe('2h 05m');
    expect(countdown(4 * 86_400 + 3 * 3600 + 59)).toBe('4d 3h');
  });
});

describe('the drand round of an attempt', () => {
  // evmnet, with the margin the hunt is deployed with (contracts/script/SeasonHunt.s.sol)
  const net = { genesis: 1_727_521_075, period: 3, margin: 30 };

  it('is the first round made at least `margin` after the cast, as DrandBeacon.roundAt', () => {
    // contracts/test/SeasonHunt.t.sol: a cast `margin` before round 22,669,154 is bound to it, a second later to the next
    const round = 22_669_154;
    const castAt = drandTime(net, round) - net.margin;
    expect(drandRound(net, castAt)).toBe(round);
    expect(drandRound(net, castAt + 1)).toBe(round + 1);
    expect(drandRound(net, castAt - 2)).toBe(round);
    expect(drandRound(net, castAt - 3)).toBe(round - 1);
    expect(drandTime(net, drandRound(net, castAt + 1))).toBeGreaterThanOrEqual(castAt + 1 + net.margin);
  });

  it('never goes below round 1', () => {
    expect(drandRound(net, 0)).toBe(1);
    expect(drandTime(net, 1)).toBe(net.genesis);
  });
});

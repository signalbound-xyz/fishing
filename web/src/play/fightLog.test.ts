import { describe, expect, it } from 'vitest';
import { fightEnded, fightKey, fightOf, fightStarted, parseFightRecord, recordingOf, type FightScope } from './fightLog';
import type { KV } from './prefs';

function memory(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}
const scope = (address: string, chainId = 20994, game = '0xGaMe'): FightScope => ({ chainId, game, address });

describe('the fight a browser remembers', () => {
  it('knows of no fight until one starts', () => {
    expect(fightOf(scope('0xA1'), 5n, memory())).toBeNull();
  });

  it('remembers a fight from its first moment, so a page that comes back does not start it again', () => {
    const kv = memory();
    fightStarted(scope('0xA2'), 5n, kv);
    const rec = fightOf(scope('0xA2'), 5n, kv)!;
    expect(rec).toEqual({ nonce: '5' });
    // walked away from: what is sent is the empty recording, which lets the fish go
    expect(recordingOf(rec)).toBe('0x');
  });

  it('keeps the recording of a finished fight: a failed transaction resends that one', () => {
    const kv = memory();
    fightStarted(scope('0xA3'), 5n, kv);
    fightEnded(scope('0xA3'), 5n, '0xff01', true, kv);
    const rec = fightOf(scope('0xA3'), 5n, kv)!;
    expect(rec).toEqual({ nonce: '5', inputs: '0xff01', landed: true });
    expect(recordingOf(rec)).toBe('0xff01');
    fightEnded(scope('0xA3'), 5n, '0x00', false, kv);
    expect(fightOf(scope('0xA3'), 5n, kv)).toEqual({ nonce: '5', inputs: '0x00', landed: false });
  });

  it('is about one cast: the next cast starts clean', () => {
    const kv = memory();
    fightEnded(scope('0xA4'), 5n, '0xff', false, kv);
    expect(fightOf(scope('0xA4'), 6n, kv)).toBeNull();
    fightStarted(scope('0xA4'), 6n, kv);
    expect(fightOf(scope('0xA4'), 5n, kv)).toBeNull();
    expect(fightOf(scope('0xA4'), 6n, kv)).toEqual({ nonce: '6' });
  });

  it('is kept per chain, game and account, whatever the case of an address', () => {
    const kv = memory();
    fightStarted(scope('0xAbC5'), 1n, kv);
    expect(fightOf(scope('0xabc5'), 1n, kv)).not.toBeNull();
    expect(fightOf(scope('0xdef5'), 1n, kv)).toBeNull();
    expect(fightOf(scope('0xAbC5', 1), 1n, kv)).toBeNull();
    expect(fightOf(scope('0xAbC5', 20994, '0xother'), 1n, kv)).toBeNull();
    expect(fightKey(scope('0xAbC5'))).toBe('onchain-fishing:fight:20994:0xgame:0xabc5');
  });

  it('still holds the page to one fight when the browser stores nothing', () => {
    const broken: KV = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    fightStarted(scope('0xA6'), 9n, broken);
    expect(fightOf(scope('0xA6'), 9n, broken)).toEqual({ nonce: '9' });
    fightEnded(scope('0xA6'), 9n, '0x0f', true, null);
    expect(fightOf(scope('0xA6'), 9n, null)).toEqual({ nonce: '9', inputs: '0x0f', landed: true });
  });

  it('reads a damaged entry as no fight rather than as a landing', () => {
    expect(parseFightRecord(null)).toBeNull();
    expect(parseFightRecord('not json')).toBeNull();
    expect(parseFightRecord('{"nonce":5}')).toBeNull();
    expect(parseFightRecord('{"nonce":"5","inputs":"zz","landed":true}')).toEqual({ nonce: '5' });
    expect(parseFightRecord('{"nonce":"5","inputs":"0xff","landed":"yes"}')).toEqual({ nonce: '5', inputs: '0xff', landed: false });
    const kv = memory();
    kv.setItem(fightKey(scope('0xA7')), '{broken');
    expect(fightOf(scope('0xA7'), 5n, kv)).toBeNull();
  });
});

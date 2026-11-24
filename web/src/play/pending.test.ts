import { describe, expect, it } from 'vitest';
import { createPending, pendingKey } from './pending';

/** A task the test settles by hand, as a wallet and a block would. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
}

const KEY = pendingKey(20994, '0xAbC0000000000000000000000000000000000001', 'loc:0');

describe('an action on its way', () => {
  it('is pending as soon as it is asked for, before anything is awaited', () => {
    let changes = 0;
    const p = createPending(() => changes++);
    const tx = deferred<number>();
    void p.run(KEY, () => tx.promise);
    expect(p.has(KEY)).toBe(true);
    expect(changes).toBe(1);
    tx.resolve(1);
  });

  it('runs once however many times it is asked for while it waits', async () => {
    const p = createPending();
    const tx = deferred<number>();
    let sent = 0;
    const send = (): Promise<number> => {
      sent++;
      return tx.promise;
    };
    const first = p.run(KEY, send);
    const again = [p.run(KEY, send), p.run(KEY, send), p.run(KEY, send)];
    expect(sent).toBe(1);
    // a repeated click claims nothing and reports nothing
    expect(await Promise.all(again)).toEqual([undefined, undefined, undefined]);
    expect(p.has(KEY)).toBe(true);
    tx.resolve(150);
    expect(await first).toBe(150);
    expect(sent).toBe(1);
  });

  it('stays pending for whoever asks, until it is settled: a redraw finds it still waiting', async () => {
    const p = createPending();
    const tx = deferred<number>();
    const done = p.run(KEY, () => tx.promise);
    // every redraw asks again; nothing about the wait is kept in what was drawn
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
      expect(p.has(KEY)).toBe(true);
      expect(p.keys()).toEqual([KEY]);
    }
    tx.resolve(1);
    await done;
    expect(p.has(KEY)).toBe(false);
    expect(p.keys()).toEqual([]);
  });

  it('is over after a success, and says so', async () => {
    let changes = 0;
    const p = createPending(() => changes++);
    expect(await p.run(KEY, async () => 150)).toBe(150);
    expect(p.has(KEY)).toBe(false);
    // once when it started, once when it ended: two redraws
    expect(changes).toBe(2);
  });

  it('is over after a refusal that resolves to nothing (the wallet said no)', async () => {
    const p = createPending();
    expect(await p.run(KEY, async () => undefined)).toBeUndefined();
    expect(p.has(KEY)).toBe(false);
  });

  it('is over after a failure that throws, and the failure reaches the caller', async () => {
    let changes = 0;
    const p = createPending(() => changes++);
    const tx = deferred<number>();
    const done = p.run(KEY, () => tx.promise);
    tx.reject(new Error('Transaction reverted'));
    await expect(done).rejects.toThrow('Transaction reverted');
    expect(p.has(KEY)).toBe(false);
    expect(changes).toBe(2);
  });

  it('is over even when the task fails before it returns a promise', async () => {
    const p = createPending();
    await expect(
      p.run(KEY, () => {
        throw new Error('no wallet');
      }),
    ).rejects.toThrow('no wallet');
    expect(p.has(KEY)).toBe(false);
  });

  it('can be asked for again once it is over', async () => {
    const p = createPending();
    let sent = 0;
    const send = async (): Promise<undefined> => {
      sent++;
      return undefined;
    };
    await p.run(KEY, send);
    await p.run(KEY, send);
    expect(sent).toBe(2);
  });

  it('leaves every other action free', async () => {
    const p = createPending();
    const other = pendingKey(20994, '0xAbC0000000000000000000000000000000000001', 'loc:1');
    const slow = deferred<number>();
    const first = p.run(KEY, () => slow.promise);
    expect(p.has(other)).toBe(false);
    // the other reward is claimed while the first still waits
    expect(await p.run(other, async () => 80)).toBe(80);
    expect(p.has(KEY)).toBe(true);
    expect(p.has(other)).toBe(false);
    slow.resolve(150);
    expect(await first).toBe(150);
  });

  it('lists what is running in a stable order', () => {
    const p = createPending();
    const never = new Promise<number>(() => {});
    void p.run('b', () => never);
    void p.run('a', () => never);
    expect(p.keys()).toEqual(['a', 'b']);
  });
});

describe('whose action it is', () => {
  const A = '0xAbC0000000000000000000000000000000000001';
  const B = '0xDeF0000000000000000000000000000000000002';

  it('is the same key for the same account, however the address is written', () => {
    expect(pendingKey(20994, A, 'loc:0')).toBe(pendingKey(20994, A.toLowerCase(), 'loc:0'));
  });

  it('differs by account, by network and by achievement', () => {
    const keys = [pendingKey(20994, A, 'loc:0'), pendingKey(20994, B, 'loc:0'), pendingKey(1, A, 'loc:0'), pendingKey(20994, A, 'loc:1'), pendingKey(20994, null, 'loc:0')];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('one account waiting does not make the next account wait', () => {
    const p = createPending();
    void p.run(pendingKey(20994, A, 'loc:0'), () => new Promise<number>(() => {}));
    expect(p.has(pendingKey(20994, A, 'loc:0'))).toBe(true);
    expect(p.has(pendingKey(20994, B, 'loc:0'))).toBe(false);
  });

  it('has a key without an account: the local game', () => {
    expect(pendingKey(20994, undefined, 'loc:0')).toBe('20994:local:loc:0');
  });
});

/**
 * Actions that are on their way: a transaction waits for the wallet, then for its block, and its button must say
 * so the whole time. The page is redrawn from scratch on every change, so "this one is running" cannot live in
 * the button: it lives here, by key, and whatever draws the button asks `has`.
 *
 * `run` is also the guard against a second click: while a key is running, running it again does nothing.
 */
export interface Pending {
  has(key: string): boolean;
  /** The running keys, sorted: part of a render signature. */
  keys(): string[];
  /**
   * Runs `task` and resolves to its result. Resolves to undefined, without calling `task`, when that key is
   * already running. The key is released when the task is over, however it ends.
   */
  run<T>(key: string, task: () => Promise<T> | T): Promise<T | undefined>;
}

export function createPending(onChange: () => void = () => {}): Pending {
  const running = new Set<string>();
  return {
    has: (key) => running.has(key),
    keys: () => [...running].sort(),
    async run(key, task) {
      if (running.has(key)) return undefined;
      // before the first await: the key is taken by the time `run` returns its promise
      running.add(key);
      onChange();
      try {
        return await task();
      } finally {
        running.delete(key);
        onChange();
      }
    },
  };
}

/**
 * A key for something that belongs to one account on one network: what is on its way for one wallet is not on its
 * way for the next one that signs in. The local game has no account.
 */
export const pendingKey = (chainId: number, account: string | null | undefined, id: string): string => `${chainId}:${account ? account.toLowerCase() : 'local'}:${id}`;

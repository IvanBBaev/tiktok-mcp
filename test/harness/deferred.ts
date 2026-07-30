/**
 * Deferred promises and event-loop draining (TESTING.md § Extended harness).
 *
 * These exist to assert *in-flight* states, which is the only way to prove
 * single-flight behaviour: "two concurrent calls produce exactly one refresh
 * request" is not shown by counting requests at the end — a serial
 * implementation also ends at one. It is shown by holding the first request
 * open, observing the second caller join instead of starting its own, and only
 * then releasing.
 */

/** A promise with its settlement handles pulled out. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
  /** Whether `resolve` or `reject` has been called. */
  readonly settled: boolean;
}

/** A promise the test settles by hand. Defaults to `Deferred<void>`. */
export function deferred<T = void>(): Deferred<T> {
  let resolveFn: (value: T | PromiseLike<T>) => void;
  let rejectFn: (reason?: unknown) => void;
  let settled = false;

  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  return {
    promise,
    resolve: (value) => {
      settled = true;
      resolveFn(value);
    },
    reject: (reason) => {
      settled = true;
      // A deferred stands in for whatever the code under test would have
      // rejected with, which is not always an `Error` (an abort reason, an
      // upstream envelope). Narrowing it here would change what is tested.
      rejectFn(reason);
    },
    get settled() {
      return settled;
    },
  };
}

/**
 * Let the event loop turn `turns` times without waiting on wall-clock time.
 *
 * `setImmediate` is a macrotask, so each turn drains the whole microtask queue —
 * including chained `await`s in continuations released by the previous turn. One
 * turn is enough to see the effect of code that is only `await`-ing promises;
 * more turns are for chains that hop through I/O callbacks.
 *
 * This is not a sleep and must never be used as one: if a test needs *time* to
 * pass, that is `mockClock().advance(ms)` (determinism rule 1).
 */
export async function flush(turns = 1): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

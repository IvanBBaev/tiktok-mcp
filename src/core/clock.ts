/**
 * core/clock.ts — the injectable time seam.
 *
 * This is the ONLY module in `src/**` allowed to touch `Date.now`,
 * `setTimeout` or `setInterval`; `eslint.config.js` bans them everywhere else
 * and exempts this file by path. Every time-dependent behavior — refresh skew,
 * token buckets, poll loops, plan TTL, lock staleness and heartbeat — takes a
 * `Clock` parameter, which is what makes `mockClock(...).advance(ms)` able to
 * drive it with zero wall-clock delay (TESTING.md determinism rule 1 / CC-H4).
 *
 * Consumers must hold no other notion of time: no captured `Date.now`, no
 * `performance.now`, no timers of their own. A module that reads the wall clock
 * behind the seam is untestable by construction.
 *
 * Long waits are built from repeated bounded `sleep`s with the deadline
 * re-derived from `now()` on every wake — never from one long timer and never
 * from accumulated tick counts (CC-H1: the process may be suspended mid-sleep).
 * All comparisons are numeric epoch milliseconds; ISO-8601 strings are a
 * persistence format only (CC-H2).
 */

/**
 * Node's timer subsystem stores delays in a signed 32-bit integer: anything
 * larger overflows, fires immediately and prints a TimeoutOverflowWarning. A
 * request that big is a bug in the caller (roughly 24.8 days), so it is
 * rejected instead of silently becoming a zero-delay sleep.
 */
const MAX_TIMER_MS = 2_147_483_647;

export interface Clock {
  /**
   * Current time in epoch milliseconds (UTC). Monotonicity is not promised —
   * the system clock can step backwards — so deadline logic must tolerate a
   * non-increasing sequence.
   */
  now(): number;

  /**
   * Resolve after at least `ms` milliseconds have elapsed.
   *
   * Semantics every `Clock` implementation (including the test `mockClock`)
   * must mirror:
   * - always asynchronous — even `sleep(0)` resolves in a later turn;
   * - a negative delay is clamped to `0`, so `sleep(deadline - clock.now())`
   *   after a missed deadline is a no-op rather than a crash;
   * - `NaN`, `±Infinity` and delays above 2^31-1 ms reject with `RangeError`;
   * - with an already-aborted `signal` it rejects immediately, with
   *   `signal.reason`, and schedules no timer;
   * - an abort during the sleep cancels the timer and rejects with
   *   `signal.reason` (the same value `fetch` and `AbortSignal.timeout`
   *   surface — `AbortController.abort()` with no argument makes that a
   *   `DOMException` named `AbortError`);
   * - a pending sleep keeps the process alive (the timer is not `unref`ed): a
   *   scheduled retry must not be lost to an early exit.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

async function systemSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (typeof ms !== 'number' || Number.isNaN(ms)) {
    throw new RangeError(`clock.sleep: ms must be a number, got ${String(ms)}`);
  }
  if (!Number.isFinite(ms)) {
    throw new RangeError(`clock.sleep: ms must be finite, got ${String(ms)}`);
  }
  if (ms > MAX_TIMER_MS) {
    throw new RangeError(
      `clock.sleep: ms must be <= ${String(MAX_TIMER_MS)} (2^31-1), got ${String(ms)}; ` +
        'build longer waits from repeated bounded sleeps with a re-checked deadline',
    );
  }
  if (signal?.aborted === true) throw signal.reason;

  const delay = ms > 0 ? ms : 0;
  const aborted = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, delay);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  if (aborted) throw signal?.reason;
}

/** The production clock: real wall time, real timers. */
export const systemClock: Clock = Object.freeze({
  now: () => Date.now(),
  sleep: systemSleep,
});

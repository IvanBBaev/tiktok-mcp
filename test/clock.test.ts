/**
 * Tests for core/clock.ts — the injectable time seam.
 *
 * CC-H4 is the rule these tests obey and prove: no test here waits on wall-clock
 * time. Scheduled behavior is driven with node:test's mock timers (which replace
 * `setTimeout`/`Date` inside the seam), and the abort paths need no timer at
 * all. The only unmocked call is a single `sleep(0)`, which proves the real
 * timer path works without introducing an observable delay.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { systemClock } from '../src/core/clock.js';

/**
 * Drain the microtask queue so any already-resolved promise has run its
 * continuations. `setImmediate` is a macrotask boundary — it is not mocked here
 * and it does not wait on wall-clock time.
 */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

test('cc-h1 cc-h2 now returns epoch milliseconds', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_123 });
  assert.equal(systemClock.now(), 1_700_000_000_123);
  t.mock.timers.tick(877);
  assert.equal(systemClock.now(), 1_700_000_001_000);
});

test('cc-h1 cc-h2 now is a plain integer epoch reading, not a locale value', () => {
  const value = systemClock.now();
  assert.equal(typeof value, 'number');
  assert.ok(Number.isInteger(value), 'epoch ms is an integer');
  // Sanity band: after 2020-01-01 and before 2100-01-01.
  assert.ok(value > 1_577_836_800_000 && value < 4_102_444_800_000);
});

test('cc-h4 sleep resolves on the scheduled tick without wall-clock delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let settled = false;
  const pending = systemClock.sleep(600_001).then(() => {
    settled = true;
  });

  t.mock.timers.tick(600_000);
  await flush();
  assert.equal(settled, false, 'not resolved before the requested delay');

  t.mock.timers.tick(1);
  await pending;
  assert.equal(settled, true);
});

test('cc-h4 a negative delay is clamped to zero instead of throwing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let settled = false;
  const pending = systemClock.sleep(-5_000).then(() => {
    settled = true;
  });
  t.mock.timers.tick(0);
  await pending;
  assert.equal(settled, true);
});

test('cc-h4 sleep is always asynchronous', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const order: string[] = [];
  const pending = systemClock.sleep(0).then(() => order.push('sleep'));
  order.push('sync');
  t.mock.timers.tick(0);
  await pending;
  assert.deepEqual(order, ['sync', 'sleep']);
});

test('cc-h4 sleep rejects delays a timer cannot represent', async () => {
  await assert.rejects(() => systemClock.sleep(Number.NaN), RangeError);
  await assert.rejects(() => systemClock.sleep(Number.POSITIVE_INFINITY), RangeError);
  await assert.rejects(() => systemClock.sleep(2_147_483_648), {
    name: 'RangeError',
    message: /2\^31-1/,
  });
  await assert.rejects(() => systemClock.sleep('5' as unknown as number), RangeError);
});

test('cc-g4 sleep rejects with the abort reason when the signal aborts mid-sleep', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const controller = new AbortController();
  const reason = new Error('cancelled by the client');
  const pending = systemClock.sleep(30_000, controller.signal);

  t.mock.timers.tick(10);
  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);

  // The timer was cleared: ticking past the original deadline changes nothing.
  t.mock.timers.tick(60_000);
  await flush();
});

test('cc-g4 an already-aborted signal rejects immediately and schedules no timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(systemClock.sleep(60_000, controller.signal), {
    name: 'AbortError',
  });

  // No timer exists to run, so the deadline passing is a no-op.
  t.mock.timers.tick(120_000);
  await flush();
});

test('cc-g4 a signal that never aborts leaves the sleep on its own schedule', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const controller = new AbortController();
  const pending = systemClock.sleep(1_000, controller.signal);
  t.mock.timers.tick(1_000);
  await pending;
  assert.equal(controller.signal.aborted, false);
});

test('cc-h4 the real timer path resolves (single 0 ms sleep, no wall-clock wait)', async () => {
  await systemClock.sleep(0);
});

test('cc-h4 systemClock exposes exactly the Clock seam and is frozen', () => {
  assert.equal(typeof systemClock.now, 'function');
  assert.equal(typeof systemClock.sleep, 'function');
  assert.ok(Object.isFrozen(systemClock));
  assert.deepEqual(Object.keys(systemClock).sort(), ['now', 'sleep']);
});

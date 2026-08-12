/**
 * test/env-lock.test.ts — the cross-process mutex around the env file.
 *
 * Spec: CONTRACTS.md § core/env-lock, ARCHITECTURE.md § 7.2, TESTING.md
 * § Multi-process env-lock harness, CORNER-CASES.md CC-A2 (two processes
 * refreshing the same rotating refresh token), CC-F5 (writer collision; a stale
 * lock is broken after a bounded age, with a warning), CC-H1 (the deadline is
 * re-derived from the clock), CC-H3 (lock trouble never costs a valid token) and
 * CC-H4 (deterministic under the injected clock).
 *
 * Both layers are mandatory and neither can replace the other:
 *
 * - the **in-process** tests drive `fsSandbox` + `mockClock`, which is the only
 *   way to reach the branches (stale break, heartbeat, release-on-throw, a lock
 *   reclaimed under a live holder) in zero wall-clock time and without a race;
 * - the **multi-process** test is the only thing that shows the mutex actually
 *   holds across an OS boundary, which is the property the module exists for.
 *   It runs twice: a lock test that passes once has proved nothing.
 */

import assert from 'node:assert/strict';
import { mkdirSync, utimesSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import type { Clock } from '../src/core/clock.js';
import { envLockDir, withEnvLock } from '../src/core/env-lock.js';
import { isTikTokError, type TikTokError } from '../src/core/errors.js';
import type { Logger } from '../src/core/log.js';
import { deferred, flush } from './harness/deferred.js';
import { runContendingChildren } from './harness/multi-process.js';
import { BASELINE_NOW_MS, fsSandbox, mockClock, type MockClock } from './helpers.js';

// ---------------------------------------------------------------------------
// local fixtures
// ---------------------------------------------------------------------------

/** POSIX mode bits are meaningless on win32 (CC-F3). */
const posixOnly: { skip?: string } =
  process.platform === 'win32'
    ? { skip: 'POSIX mode bits: win32 has no st_mode permissions to assert (CC-F3)' }
    : {};

/** `chmod` denies nothing to root, and nothing at all on win32. */
const canDenyAccess: { skip?: string } =
  process.platform === 'win32'
    ? { skip: 'chmod-based access denial: win32 does not honour POSIX mode bits' }
    : process.getuid?.() === 0
      ? { skip: 'chmod-based access denial: root bypasses POSIX mode bits' }
      : {};

interface Recorded {
  readonly level: string;
  readonly msg: string;
  readonly fields?: Record<string, unknown>;
}

/** A `Logger` that records instead of writing, so warnings are assertable. */
function recordingLogger(): { logger: Logger; records: Recorded[] } {
  const records: Recorded[] = [];
  const at =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      records.push(fields === undefined ? { level, msg } : { level, msg, fields });
    };
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  return { logger, records };
}

interface Fixture {
  /** The sandbox directory; also the parent the lock is created in. */
  readonly dir: string;
  readonly envFile: string;
  readonly lockDir: string;
  readonly clock: MockClock;
  readonly logger: Logger;
  readonly records: Recorded[];
  cleanup(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const box = await fsSandbox();
  const envFile = path.join(box.dir, '.env');
  const { logger, records } = recordingLogger();
  return {
    dir: box.dir,
    envFile,
    lockDir: envLockDir(envFile),
    clock: mockClock(),
    logger,
    records,
    cleanup: async () => {
      // A test may have made the sandbox unwritable on purpose; put it back
      // before `rm`, or the cleanup fails instead of the assertion.
      await chmod(box.dir, 0o700).catch(() => undefined);
      await box.cleanup();
    },
  };
}

/** Every warning the code under test emitted, in order. */
function warnings(records: readonly Recorded[]): Recorded[] {
  return records.filter((r) => r.level === 'warn');
}

/** The first warning whose message contains `needle`, or `undefined`. */
function warningLike(records: readonly Recorded[], needle: string): Recorded | undefined {
  return warnings(records).find((r) => r.msg.includes(needle));
}

/** Narrow a caught value, with a readable failure when it is the wrong type. */
function ttError(err: unknown): TikTokError {
  assert.equal(
    isTikTokError(err),
    true,
    `expected a TikTokError, got ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  return err as TikTokError;
}

/** Await a promise that must reject, and hand back what it rejected with. */
async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

/** One real millisecond — what a pump waits in while real I/O is in flight. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 1);
  });
}

/**
 * Wait until `condition` holds, giving in-flight I/O (a `mkdir`/`stat` round
 * trip) time to land.
 *
 * A turn is a real millisecond, not a `setImmediate`: a `setImmediate` loop
 * spins its whole budget in well under a millisecond, so on a loaded CI runner
 * it gives up while the syscall it is waiting for has not returned yet. Virtual
 * time still never moves here — anything that needs *time* needs `advance`,
 * which is why a missing `advance` shows up as a loud timeout, not a hang.
 */
async function until(condition: () => boolean, what: string, turns = 500): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (condition()) return;
    await tick();
  }
  throw new Error(
    `timed out waiting for ${what} after ${String(turns)} ms of real time ` +
      '(no virtual time passed — the mock clock probably needs advancing)',
  );
}

/**
 * Advance virtual time in slices until `work` settles, then hand back its
 * outcome. Used for the retry ladder, where the number of sleeps depends on the
 * jitter and cannot be advanced for exactly.
 *
 * Each slice ends by racing the work against a real millisecond rather than by
 * flushing the event loop: a flush-only pump can burn every step before an
 * in-flight `mkdir` returns and then hand back a promise that never settles.
 */
async function driveClock<T>(
  clock: MockClock,
  work: Promise<T>,
  stepMs = 100,
  maxSteps = 400,
): Promise<T> {
  let settled = false;
  const tracked = work.then(
    (value) => {
      settled = true;
      return value;
    },
    (err: unknown) => {
      settled = true;
      throw err;
    },
  );
  // The caller decides what to do with a rejection; this only keeps an
  // in-flight failure from surfacing as an unhandled rejection first.
  const finished = tracked.then(
    () => undefined,
    () => undefined,
  );
  for (let step = 0; step < maxSteps && !settled; step += 1) {
    await clock.advance(stepMs);
    await Promise.race([finished, tick()]);
  }
  return tracked;
}

/** The lock's diagnostic record, as JSON. */
async function readHolder(lockDir: string): Promise<Record<string, unknown>> {
  const raw: unknown = JSON.parse(
    await readFile(path.join(lockDir, 'holder.json'), 'utf8'),
  );
  assert.equal(
    typeof raw === 'object' && raw !== null,
    true,
    'holder.json is not an object',
  );
  return raw as Record<string, unknown>;
}

/** Plant a lock directory whose mtime is `ageMs` old in *virtual* time. */
async function plantLock(lockDir: string, ageMs: number, holder?: string): Promise<void> {
  await mkdir(lockDir, { mode: 0o700 });
  if (holder !== undefined) await writeFile(path.join(lockDir, 'holder.json'), holder);
  const at = new Date(BASELINE_NOW_MS - ageMs);
  await utimes(lockDir, at, at);
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// naming
// ---------------------------------------------------------------------------

test('envLockDir puts the lock beside the env file it protects', () => {
  const envFile = path.join(path.sep, 'home', 'me', '.config', 'tiktok-mcp-ai', '.env');
  assert.equal(envLockDir(envFile), `${envFile}.lock`);
  // A sibling, so it shares the file system and the parent's permissions.
  assert.equal(path.dirname(envLockDir(envFile)), path.dirname(envFile));
});

// ---------------------------------------------------------------------------
// the happy path
// ---------------------------------------------------------------------------

test('cc-f5 withEnvLock holds the lock while fn runs and removes it afterwards', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    let heldDuringFn = false;
    let holder: Record<string, unknown> = {};

    const value = await withEnvLock(
      f.envFile,
      async () => {
        calls += 1;
        heldDuringFn = (await stat(f.lockDir)).isDirectory();
        holder = await readHolder(f.lockDir);
        return 'result';
      },
      { clock: f.clock, logger: f.logger },
    );

    assert.equal(value, 'result');
    assert.equal(calls, 1, 'fn must run exactly once');
    assert.equal(heldDuringFn, true, 'the lock directory must exist while fn runs');
    assert.equal(holder.pid, process.pid);
    assert.equal(typeof holder.hostname, 'string');
    // CC-H2: the record's timestamp comes from the injected clock, in ISO UTC.
    assert.equal(holder.createdAt, new Date(BASELINE_NOW_MS).toISOString());

    assert.equal(await exists(f.lockDir), false, 'the lock must be released');
    assert.equal(f.clock.pending(), 0, 'the heartbeat must stop with the lock');
    assert.deepEqual(warnings(f.records), []);
  } finally {
    await f.cleanup();
  }
});

test(
  'cc-f3 the lock directory and its holder record are owner-only',
  posixOnly,
  async () => {
    const f = await fixture();
    try {
      const modes = await withEnvLock(
        f.envFile,
        async () => ({
          dir: (await stat(f.lockDir)).mode & 0o777,
          holder: (await stat(path.join(f.lockDir, 'holder.json'))).mode & 0o777,
        }),
        { clock: f.clock, logger: f.logger },
      );
      assert.equal(modes.dir, 0o700);
      assert.equal(modes.holder, 0o600);
    } finally {
      await f.cleanup();
    }
  },
);

test('the lock directory is created on a first run, before the config dir exists', async () => {
  const f = await fixture();
  try {
    const nested = path.join(f.dir, 'fresh', 'machine', '.env');
    let ran = false;
    await withEnvLock(
      nested,
      async () => {
        ran = true;
        assert.equal((await stat(envLockDir(nested))).isDirectory(), true);
      },
      { clock: f.clock, logger: f.logger },
    );
    assert.equal(ran, true);
    assert.equal(await exists(path.dirname(nested)), true);
    assert.equal(await exists(envLockDir(nested)), false);
  } finally {
    await f.cleanup();
  }
});

test('cc-h3 the lock is released when fn throws, and fn’s failure is what surfaces', async () => {
  const f = await fixture();
  try {
    const boom = new Error('fn exploded');
    const err = await rejection(
      withEnvLock(f.envFile, () => Promise.reject(boom), {
        clock: f.clock,
        logger: f.logger,
      }),
    );
    assert.equal(err, boom, 'the release must not replace the caller’s error');
    assert.equal(await exists(f.lockDir), false);
    assert.equal(f.clock.pending(), 0);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// contention
// ---------------------------------------------------------------------------

test('cc-a2 two concurrent callers in one process serialize instead of overlapping', async () => {
  const f = await fixture();
  try {
    const order: string[] = [];
    const gate = deferred();

    const first = withEnvLock(
      f.envFile,
      async () => {
        order.push('first-in');
        await gate.promise;
        order.push('first-out');
      },
      { clock: f.clock, logger: f.logger },
    );
    await until(() => order.length === 1, 'the first caller to take the lock');

    const second = withEnvLock(
      f.envFile,
      () => {
        order.push('second-in');
        return Promise.resolve();
      },
      { waitMs: 30_000, clock: f.clock, logger: f.logger },
    );
    // Two sleeps pending: the holder's heartbeat and the loser's retry.
    await until(() => f.clock.pending() === 2, 'the second caller to start waiting');
    assert.deepEqual(order, ['first-in'], 'the second caller must not be inside fn');

    gate.resolve(undefined);
    await first;
    await driveClock(f.clock, second);

    assert.deepEqual(order, ['first-in', 'first-out', 'second-in']);
    assert.equal(await exists(f.lockDir), false);
  } finally {
    await f.cleanup();
  }
});

test('cc-f5 a held lock makes the next caller wait and then fail with env_file_busy', async () => {
  const f = await fixture();
  try {
    const gate = deferred();
    let entered = false;
    const holder = withEnvLock(
      f.envFile,
      async () => {
        entered = true;
        await gate.promise;
      },
      { clock: f.clock, logger: f.logger },
    );
    await until(() => entered, 'the holder to take the lock');

    let loserRan = false;
    const err = await rejection(
      driveClock(
        f.clock,
        withEnvLock(
          f.envFile,
          () => {
            loserRan = true;
            return Promise.resolve();
          },
          { waitMs: 1_000, staleMs: 15_000, clock: f.clock, logger: f.logger },
        ),
      ),
    );

    const busy = ttError(err);
    assert.equal(busy.kind, 'config');
    assert.equal(busy.code, 'env_file_busy');
    assert.equal(busy.retryable, true, 'the caller is expected to re-read and retry');
    assert.match(busy.message, /another tiktok-mcp-ai process/);
    assert.equal(busy.message.includes(f.envFile), true);
    assert.match(busy.remediation ?? '', /doctor/);
    assert.equal(loserRan, false, 'fn must not run without the lock');

    // The heartbeat kept the holder's mtime fresh, so the loser waited it out
    // rather than declaring a live holder dead (CC-F5).
    assert.equal(warningLike(f.records, 'removed a stale'), undefined);
    assert.equal(await exists(f.lockDir), true, 'the holder still owns the lock');

    gate.resolve(undefined);
    await holder;
    assert.equal(await exists(f.lockDir), false);
  } finally {
    await f.cleanup();
  }
});

test('cc-f5 waitMs 0 tries exactly once and never sleeps', async () => {
  const f = await fixture();
  try {
    await plantLock(f.lockDir, 1_000);
    let ran = false;
    const err = await rejection(
      withEnvLock(
        f.envFile,
        () => {
          ran = true;
          return Promise.resolve();
        },
        { waitMs: 0, staleMs: 15_000, clock: f.clock, logger: f.logger },
      ),
    );
    assert.equal(ttError(err).code, 'env_file_busy');
    assert.match((err as Error).message, /\(1 attempt\)/);
    assert.equal(ran, false);
    assert.equal(f.clock.pending(), 0, 'a zero budget must not schedule a retry');
    assert.equal(await exists(f.lockDir), true, 'a fresh lock must be left alone');
  } finally {
    await f.cleanup();
  }
});

test('cc-h1 the wait budget is re-derived from the clock, not accumulated from sleeps', async () => {
  const f = await fixture();
  try {
    // Nothing here is stale — `staleMs` is far larger than the jump — so the
    // only thing that can end the wait is the re-derived deadline.
    await plantLock(f.lockDir, 1_000);
    const busy = withEnvLock(f.envFile, () => Promise.resolve(), {
      waitMs: 30_000,
      staleMs: 300_000,
      clock: f.clock,
      logger: f.logger,
    });
    // Claim the rejection now: `advance` below drains microtasks, so a handler
    // attached afterwards would arrive one turn late and the expected failure
    // would surface as an unhandled rejection instead.
    const outcome = rejection(busy);
    await until(() => f.clock.pending() === 1, 'the first jittered retry');

    // The process was suspended: time moved 60 s while one 50–150 ms sleep was
    // outstanding. A budget counted in sleeps would still think it had 29.9 s.
    f.clock.setNow(BASELINE_NOW_MS + 60_000);
    await f.clock.advance(0);

    const err = ttError(await outcome);
    assert.equal(err.code, 'env_file_busy');
    assert.match(err.message, /within 60 s \(2 attempts\)/);
  } finally {
    await f.cleanup();
  }
});

test('cc-h4 the retry jitter comes from the injected seam and out-of-range values are clamped', async () => {
  const f = await fixture();
  try {
    await plantLock(f.lockDir, 1_000);

    // [source, expected delay] — 50 ms + the fraction of a 100 ms spread.
    const cases: readonly (readonly [() => number, number])[] = [
      [() => 0, 50],
      [() => 1, 150],
      [() => 2, 150], // above the range: clamped, never a 250 ms delay
      [() => Number.NaN, 100], // not a number at all: the midpoint, never a NaN sleep
    ];

    for (const [random, expected] of cases) {
      const seen: number[] = [];
      const base = mockClock();
      const clock: Clock = {
        now: () => base.now(),
        // Only the retry ladder sleeps without a signal; the heartbeat passes one.
        sleep: async (ms, signal) => {
          if (signal === undefined) seen.push(ms);
          await base.sleep(ms, signal);
        },
      };

      const busy = withEnvLock(f.envFile, () => Promise.resolve(), {
        waitMs: 10_000,
        staleMs: 300_000,
        clock,
        logger: f.logger,
        random,
      });
      const outcome = rejection(busy); // claimed before any advance, as above
      await until(
        () => seen.length === 1,
        `the first retry of the ${String(expected)} ms case`,
      );
      assert.deepEqual(seen, [expected]);
      await base.advance(expected);
      await until(
        () => seen.length === 2,
        `the second retry of the ${String(expected)} ms case`,
      );
      assert.deepEqual(seen, [expected, expected]);

      await driveClock(base, busy, 1_000).catch(() => undefined);
      assert.equal(ttError(await outcome).code, 'env_file_busy');
    }
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// staleness — mtime is the only liveness signal
// ---------------------------------------------------------------------------

test('cc-f5 a stale lock is removed with a warning and then re-acquired', async () => {
  const f = await fixture();
  try {
    await plantLock(
      f.lockDir,
      60_000,
      `${JSON.stringify({
        pid: 999_999,
        hostname: 'ci-runner-7',
        createdAt: '2025-12-31T23:59:00.000Z',
      })}\n`,
    );

    let ownPid: unknown;
    await withEnvLock(
      f.envFile,
      async () => {
        ownPid = (await readHolder(f.lockDir)).pid;
      },
      { staleMs: 15_000, clock: f.clock, logger: f.logger },
    );

    assert.equal(ownPid, process.pid, 'the winner must own the holder record');
    const warn = warningLike(f.records, 'removed a stale env-file lock');
    assert.notEqual(warn, undefined, 'breaking a lock must be visible to the operator');
    assert.match(warn?.msg ?? '', /60000 ms ago/);
    assert.match(warn?.msg ?? '', /15000 ms\s+stale threshold/);
    // The dead holder is reported so an operator knows who to look for.
    assert.equal(warn?.fields?.pid, 999_999);
    assert.equal(warn?.fields?.hostname, 'ci-runner-7');
    assert.equal(warn?.fields?.created_at, '2025-12-31T23:59:00.000Z');
    assert.equal(warn?.fields?.env_file, f.envFile);
    assert.equal(await exists(f.lockDir), false);
  } finally {
    await f.cleanup();
  }
});

test('cc-f5 liveness is mtime-only: a live pid does not save a stale lock', async () => {
  const f = await fixture();
  try {
    // This process is unquestionably alive, and its lock is still reclaimed: a
    // pid means nothing across a container boundary or a shared network home.
    await plantLock(
      f.lockDir,
      60_000,
      `${JSON.stringify({ pid: process.pid, hostname: 'somewhere-else' })}\n`,
    );
    let ran = false;
    await withEnvLock(
      f.envFile,
      () => {
        ran = true;
        return Promise.resolve();
      },
      { staleMs: 15_000, clock: f.clock, logger: f.logger },
    );
    assert.equal(ran, true);
    assert.notEqual(warningLike(f.records, 'removed a stale env-file lock'), undefined);
  } finally {
    await f.cleanup();
  }
});

test('cc-f5 liveness is mtime-only: a dead pid does not doom a fresh lock', async () => {
  const f = await fixture();
  try {
    await plantLock(f.lockDir, 1_000, `${JSON.stringify({ pid: 999_999 })}\n`);
    const err = await rejection(
      driveClock(
        f.clock,
        withEnvLock(f.envFile, () => Promise.resolve(), {
          waitMs: 500,
          staleMs: 15_000,
          clock: f.clock,
          logger: f.logger,
        }),
      ),
    );
    assert.equal(ttError(err).code, 'env_file_busy');
    assert.equal(warningLike(f.records, 'removed a stale'), undefined);
    assert.equal(await exists(f.lockDir), true, 'a fresh lock must survive');
  } finally {
    await f.cleanup();
  }
});

test('cc-f5 a damaged holder record does not stop a stale break', async () => {
  const f = await fixture();
  try {
    await plantLock(f.lockDir, 60_000, 'this is not JSON {');
    let ran = false;
    await withEnvLock(
      f.envFile,
      () => {
        ran = true;
        return Promise.resolve();
      },
      { staleMs: 15_000, clock: f.clock, logger: f.logger },
    );
    assert.equal(ran, true);
    const warn = warningLike(f.records, 'removed a stale env-file lock');
    assert.notEqual(warn, undefined);
    // Nothing could be read, so nothing is claimed about the dead holder.
    assert.equal(warn?.fields?.pid, undefined);
    assert.equal(warn?.fields?.hostname, undefined);
  } finally {
    await f.cleanup();
  }
});

test(
  'cc-f5 a stale lock that cannot be removed is reported and waited out',
  canDenyAccess,
  async () => {
    const f = await fixture();
    try {
      await plantLock(f.lockDir, 60_000);
      // Removing a subdirectory needs write permission on its parent, so the
      // lock is provably dead and provably unremovable at the same time.
      await chmod(f.dir, 0o500);

      let ran = false;
      const err = await rejection(
        driveClock(
          f.clock,
          withEnvLock(
            f.envFile,
            () => {
              ran = true;
              return Promise.resolve();
            },
            { waitMs: 500, staleMs: 15_000, clock: f.clock, logger: f.logger },
          ),
        ),
      );

      // Failing to break it is not permission to ignore it: the call waits out
      // its budget and reports busy rather than writing without the lock.
      assert.equal(ttError(err).code, 'env_file_busy');
      assert.equal(ran, false);
      const warn = warningLike(f.records, 'could not remove the stale env-file lock');
      assert.notEqual(warn, undefined, 'an unremovable stale lock must be reported');
      // The exact age depends on how far the retry ladder got; the point is
      // that it is reported and reads as long past the 15 s threshold.
      assert.match(warn?.msg ?? '', /last touched 6\d{4} ms ago/);
      assert.equal(typeof warn?.fields?.code, 'string');
    } finally {
      await f.cleanup();
    }
  },
);

test('cc-f5 a competitor that keeps re-planting a stale lock cannot spin one call forever', async () => {
  const f = await fixture();
  try {
    const { logger: base, records } = recordingLogger();
    let breaks = 0;
    const logger: Logger = {
      ...base,
      warn: (msg, fields) => {
        base.warn(msg, fields);
        if (!msg.startsWith('removed a stale env-file lock')) return;
        // The instant this call reclaims the lock, another process takes it —
        // and crashes again. Synchronous, so it lands before the next mkdir.
        breaks += 1;
        mkdirSync(f.lockDir, { mode: 0o700 });
        const old = new Date(BASELINE_NOW_MS - 60_000);
        utimesSync(f.lockDir, old, old);
      },
      child: () => logger,
    };

    await plantLock(f.lockDir, 60_000);
    let ran = false;
    const err = await rejection(
      driveClock(
        f.clock,
        withEnvLock(
          f.envFile,
          () => {
            ran = true;
            return Promise.resolve();
          },
          { waitMs: 500, staleMs: 15_000, clock: f.clock, logger },
        ),
      ),
    );

    assert.equal(ttError(err).code, 'env_file_busy');
    assert.equal(ran, false);
    // Breaking is progress and does not spend the wait budget, so it is bounded
    // separately: after three reclaims the call waits like everyone else.
    assert.equal(breaks, 3);
    assert.equal(warnings(records).length, 3);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// the heartbeat
// ---------------------------------------------------------------------------

test('cc-f5 the heartbeat keeps a slow holder’s lock alive', async () => {
  const f = await fixture();
  try {
    const gate = deferred();
    let entered = false;
    const held = withEnvLock(
      f.envFile,
      async () => {
        entered = true;
        await gate.promise;
      },
      { heartbeatMs: 2_000, staleMs: 15_000, clock: f.clock, logger: f.logger },
    );
    await until(() => entered, 'the holder to take the lock');

    for (let tick = 0; tick < 3; tick += 1) {
      await f.clock.advance(2_000);
      await flush(4);
    }

    // The mtime now comes from the injected clock, which is what proves the
    // heartbeat ran: `mkdir` had stamped it with real wall time.
    const touched = (await stat(f.lockDir)).mtimeMs;
    assert.equal(
      touched >= BASELINE_NOW_MS + 2_000 && touched <= BASELINE_NOW_MS + 6_000,
      true,
      `expected a heartbeat-stamped mtime, got ${new Date(touched).toISOString()}`,
    );
    assert.deepEqual(warnings(f.records), []);

    gate.resolve(undefined);
    await held;
    assert.equal(f.clock.pending(), 0, 'the heartbeat must stop on release');
  } finally {
    await f.cleanup();
  }
});

test('cc-f5 a lock that vanishes under a live holder is not deleted again on release', async () => {
  const f = await fixture();
  try {
    const gate = deferred();
    let entered = false;
    const held = withEnvLock(
      f.envFile,
      async () => {
        entered = true;
        await gate.promise;
        return 'kept';
      },
      { heartbeatMs: 2_000, clock: f.clock, logger: f.logger },
    );
    await until(() => entered, 'the holder to take the lock');

    // Someone reclaimed this lock while it was still held.
    await rm(f.lockDir, { recursive: true, force: true });
    await f.clock.advance(2_000);
    await until(
      () => warningLike(f.records, 'vanished') !== undefined,
      'the heartbeat to notice',
    );

    // …and a different process now owns the directory.
    await mkdir(f.lockDir, { mode: 0o700 });
    await writeFile(path.join(f.lockDir, 'marker'), 'a different holder\n');

    gate.resolve(undefined);
    assert.equal(await held, 'kept', 'the caller’s value must survive the loss');

    assert.equal(
      await exists(path.join(f.lockDir, 'marker')),
      true,
      'release must not delete a lock this process no longer owns',
    );
    assert.equal(
      f.clock.pending(),
      0,
      'the heartbeat must not keep ticking after the loss',
    );
  } finally {
    await f.cleanup();
  }
});

test('cc-h3 a heartbeat that dies warns and does not take the caller down', async () => {
  const f = await fixture();
  try {
    const base = mockClock();
    const clock: Clock = {
      now: () => base.now(),
      // The heartbeat is the only sleeper that passes a signal.
      sleep: async (ms, signal) => {
        if (signal !== undefined) throw new Error('the timer subsystem failed');
        await base.sleep(ms);
      },
    };

    const value = await withEnvLock(f.envFile, () => Promise.resolve('done'), {
      clock,
      logger: f.logger,
    });

    assert.equal(value, 'done');
    const warn = warningLike(f.records, 'stopped early');
    assert.notEqual(warn, undefined, 'a dead heartbeat must be reported');
    assert.match(warn?.msg ?? '', /declared stale after 15000 ms/);
    assert.equal(warn?.fields?.reason, 'the timer subsystem failed');
    assert.equal(await exists(f.lockDir), false, 'the lock is still released');
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// degraded configurations — a lock problem never costs a valid token (CC-H3)
// ---------------------------------------------------------------------------

test('cc-f5 a heartbeat that is not shorter than the stale threshold warns at setup', async () => {
  const f = await fixture();
  try {
    await withEnvLock(f.envFile, () => Promise.resolve(), {
      staleMs: 1_000,
      heartbeatMs: 2_000,
      clock: f.clock,
      logger: f.logger,
    });
    const warn = warningLike(f.records, 'is not shorter than the stale');
    assert.notEqual(warn, undefined);
    assert.equal(warn?.fields?.code, 'env_lock_heartbeat_too_slow');
    assert.equal(warn?.fields?.env_file, f.envFile);
  } finally {
    await f.cleanup();
  }
});

test('an unusable duration option falls back to the documented default with a warning', async () => {
  const f = await fixture();
  try {
    // Coercing silently would hide the caller's bug; throwing would fail a token
    // refresh over a configuration detail (CC-H3).
    await withEnvLock(f.envFile, () => Promise.resolve(), {
      waitMs: -1,
      staleMs: Number.NaN,
      heartbeatMs: 0,
      clock: f.clock,
      logger: f.logger,
    });

    const bad = warnings(f.records).filter(
      (r) => r.fields?.code === 'invalid_env_lock_duration',
    );
    assert.equal(bad.length, 3);
    assert.deepEqual(
      bad.map((r) => r.msg.replace(/^env lock (\w+) .*$/s, '$1')),
      ['staleMs', 'heartbeatMs', 'waitMs'],
    );
    assert.match(bad[0]?.msg ?? '', /using the default of 15000 ms/);
    assert.match(bad[1]?.msg ?? '', /using the default of 2000 ms/);
    assert.match(bad[2]?.msg ?? '', /using the default of 30000 ms/);
    // Defaults are coherent, so the heartbeat warning is not also triggered.
    assert.equal(warningLike(f.records, 'is not shorter than the stale'), undefined);
  } finally {
    await f.cleanup();
  }
});

test('cc-h3 an unusable lock location fails with env_lock_unusable and never runs fn', async () => {
  const f = await fixture();
  try {
    const blocker = path.join(f.dir, 'blocker');
    await writeFile(blocker, 'a regular file, not a directory\n');
    let ran = false;
    const err = await rejection(
      withEnvLock(
        path.join(blocker, '.env'),
        () => {
          ran = true;
          return Promise.resolve();
        },
        { clock: f.clock, logger: f.logger },
      ),
    );
    const unusable = ttError(err);
    assert.equal(unusable.kind, 'config');
    assert.equal(unusable.code, 'env_lock_unusable');
    assert.equal(unusable.retryable, false, 'retrying an unusable path changes nothing');
    assert.match(unusable.message, /concurrent credential writes cannot be made safe/);
    assert.match(unusable.remediation ?? '', /TT_ENV_FILE/);
    assert.notEqual(unusable.cause, undefined, 'the errno cause must be kept for doctor');
    assert.equal(ran, false);
  } finally {
    await f.cleanup();
  }
});

test(
  'cc-h3 a config directory that cannot be created fails with env_lock_unusable',
  canDenyAccess,
  async () => {
    const f = await fixture();
    try {
      // First run, but the parent is read-only: the lock's own recovery step
      // (create the config directory, then retry) is the thing that fails.
      const nested = path.join(f.dir, 'read-only-parent', '.env');
      await chmod(f.dir, 0o500);

      let ran = false;
      const err = await rejection(
        withEnvLock(
          nested,
          () => {
            ran = true;
            return Promise.resolve();
          },
          { clock: f.clock, logger: f.logger },
        ),
      );
      const unusable = ttError(err);
      assert.equal(unusable.code, 'env_lock_unusable');
      assert.equal(unusable.retryable, false);
      assert.notEqual(unusable.cause, undefined);
      assert.equal(ran, false);
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'cc-h3 a release that cannot remove the lock warns instead of failing the caller',
  canDenyAccess,
  async () => {
    const f = await fixture();
    try {
      const value = await withEnvLock(
        f.envFile,
        async () => {
          // Removing a subdirectory needs write permission on its parent.
          await chmod(f.dir, 0o500);
          return 'the refresh still happened';
        },
        { clock: f.clock, logger: f.logger },
      );
      assert.equal(value, 'the refresh still happened');

      const warn = warningLike(f.records, 'could not remove the env-file lock');
      assert.notEqual(warn, undefined, 'a leaked lock must be reported');
      assert.match(warn?.msg ?? '', /treat it as stale after 15000 ms/);
      assert.equal(typeof warn?.fields?.code, 'string');
    } finally {
      await f.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// the one real race (CC-A2 / CC-F5)
// ---------------------------------------------------------------------------

interface WorkerPayload {
  readonly index: number;
  readonly pid: number;
  /** The counter value this child read inside the critical section. */
  readonly seen: number;
  /** Whether `holder.json` named this child while it held the lock. */
  readonly ownsHolderRecord: boolean;
}

/**
 * Four real processes, released from one barrier, doing a read-modify-write of
 * the same env file through `withEnvLock`.
 *
 * The arithmetic alone would not prove much, so the assertions are sharper: the
 * values the children *observed* must be a permutation of 0…3 (two overlapping
 * children would have to see the same number), the shared trace must be a
 * strictly alternating enter/leave sequence, and every child must have seen its
 * own pid in the holder record while it was inside.
 */
async function contendForTheCounter(): Promise<void> {
  const box = await fsSandbox();
  try {
    const envFile = path.join(box.dir, '.env');
    const tracePath = path.join(box.dir, 'trace.jsonl');
    await writeFile(envFile, 'TT_TEST_COUNTER=0\n', { mode: 0o600 });

    const outcomes = await runContendingChildren({
      childModule: new URL('./harness/workers/env-lock-worker.js', import.meta.url),
      count: 4,
      args: { envFile, tracePath, holdMs: 40, waitMs: 10_000 },
      // A lock bug deadlocks; without the canary that hangs CI for the whole
      // job timeout and reports nothing.
      signal: AbortSignal.timeout(15_000),
    });

    assert.equal(outcomes.length, 4);
    for (const outcome of outcomes) {
      assert.equal(
        outcome.ok,
        true,
        `child ${String(outcome.index)}: ${outcome.error ?? ''}`,
      );
    }

    const payloads = outcomes.map((o) => o.payload as WorkerPayload);
    assert.deepEqual(
      payloads.map((p) => p.seen).sort((a, b) => a - b),
      [0, 1, 2, 3],
      'two children that overlap must read the same counter value',
    );
    assert.equal(new Set(payloads.map((p) => p.pid)).size, 4, 'four distinct processes');
    for (const payload of payloads) {
      assert.equal(
        payload.ownsHolderRecord,
        true,
        `child ${String(payload.index)} did not own the lock`,
      );
    }

    assert.equal(await readFile(envFile, 'utf8'), 'TT_TEST_COUNTER=4\n');

    // The trace is the direct evidence: critical sections never interleaved.
    const lines = (await readFile(tracePath, 'utf8')).split('\n').filter((l) => l !== '');
    assert.equal(lines.length, 8);
    let inside: number | undefined;
    for (const line of lines) {
      const event = JSON.parse(line) as { event: string; index: number };
      if (event.event === 'enter') {
        assert.equal(
          inside,
          undefined,
          `child ${String(event.index)} entered while child ${String(inside)} still held the lock`,
        );
        inside = event.index;
      } else {
        assert.equal(inside, event.index, 'a leave that does not match the open enter');
        inside = undefined;
      }
    }
    assert.equal(inside, undefined, 'a critical section was never left');

    assert.equal(
      await exists(envLockDir(envFile)),
      false,
      'the last holder must release',
    );
  } finally {
    await box.cleanup();
  }
}

test('cc-a2 four real processes serialize their env-file writes (run 1)', async () => {
  await contendForTheCounter();
});

// Run twice on purpose: a mutex test that passes once has proved nothing, and a
// scheduler-dependent failure shows up as an intermittent second run.
test('cc-a2 four real processes serialize their env-file writes (run 2)', async () => {
  await contendForTheCounter();
});

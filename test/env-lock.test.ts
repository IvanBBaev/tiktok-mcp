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
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import type { Clock } from '../src/core/clock.js';
import { canonicalPath, envLockDir, withEnvLock } from '../src/core/env-lock.js';
import { isTikTokError, type TikTokError } from '../src/core/errors.js';
import type { Logger } from '../src/core/log.js';
import { deferred } from './harness/deferred.js';
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

/** Creating a symlink is a privileged operation on win32 by default. */
const canSymlink: { skip?: string } =
  process.platform === 'win32'
    ? { skip: 'symlinks: win32 needs SeCreateSymbolicLinkPrivilege' }
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

/** `until` for a condition that has to read the filesystem to answer. */
async function untilAsync(
  condition: () => Promise<boolean>,
  what: string,
  turns = 500,
): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (await condition()) return;
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

/** The `.stale-*` tombstones a stale break left in `dir`, if any. */
async function tombstones(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.includes('.stale-'));
}

/**
 * A mock clock whose `now()` runs `hook` once, on call number `atCall`.
 *
 * `acquire` reads `now()` once for its start time, and `lockAge` reads it
 * right after the `stat` it measured the age with — call 2 is that point, so a
 * hook there changes the lock directory after its age and identity were taken
 * and before `breakStaleLock` moves it aside.
 */
function clockHookedAt(
  atCall: number,
  hook: () => void,
): MockClock & { fired(): boolean } {
  const base = mockClock();
  let calls = 0;
  return {
    ...base,
    now: () => {
      calls += 1;
      if (calls === atCall) hook();
      return base.now();
    },
    fired: () => calls >= atCall,
  };
}

/**
 * Synchronously plant a *fresh* lock with a `marker`, the way a successor that
 * re-took the path would — synchronous so it can run inside a clock or logger
 * hook, before the code under test's next syscall.
 */
function plantFreshSync(lockDir: string, marker: string): void {
  mkdirSync(lockDir, { mode: 0o700 });
  writeFileSync(path.join(lockDir, 'marker'), `${marker}\n`);
  const fresh = new Date(BASELINE_NOW_MS - 1_000);
  utimesSync(lockDir, fresh, fresh);
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
// canonicalPath — the one spelling the lock and the write agree on
// ---------------------------------------------------------------------------

test('canonicalPath resolves an existing file to its real path', async () => {
  const f = await fixture();
  try {
    await writeFile(f.envFile, 'X=1\n');
    assert.equal(await canonicalPath(f.envFile), await realpath(f.envFile));
  } finally {
    await f.cleanup();
  }
});

test('canonicalPath places a file that does not exist yet under its real parent', async () => {
  const f = await fixture();
  try {
    assert.equal(
      await canonicalPath(f.envFile),
      path.join(await realpath(f.dir), '.env'),
    );
  } finally {
    await f.cleanup();
  }
});

test('canonicalPath keeps the spelling when neither the file nor its parent exists', async () => {
  const f = await fixture();
  try {
    const nested = path.join(f.dir, 'fresh', 'machine', '.env');
    assert.equal(await canonicalPath(nested), nested);
  } finally {
    await f.cleanup();
  }
});

test('canonicalPath makes a relative path absolute', async () => {
  const relative = path.join('no-such-dir-canonical', '.env');
  assert.equal(await canonicalPath(relative), path.resolve(relative));
});

test('canonicalPath follows a symlink to the file it names', canSymlink, async () => {
  const f = await fixture();
  try {
    const target = path.join(f.dir, 'real.env');
    await writeFile(target, 'X=1\n');
    await symlink(target, f.envFile);
    assert.equal(await canonicalPath(f.envFile), await realpath(target));
  } finally {
    await f.cleanup();
  }
});

test(
  'canonicalPath follows a dangling symlink to where it points',
  canSymlink,
  async () => {
    const f = await fixture();
    try {
      // Target parent exists: it is resolved to its real spelling.
      await symlink(path.join(f.dir, 'later.env'), f.envFile);
      assert.equal(
        await canonicalPath(f.envFile),
        path.join(await realpath(f.dir), 'later.env'),
      );

      // Target parent does not exist either: the link's own spelling of it stands.
      const deep = path.join(f.dir, 'deep-link');
      const far = path.join(f.dir, 'not', 'yet', 'there.env');
      await symlink(far, deep);
      assert.equal(await canonicalPath(deep), far);
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'canonicalPath resolves a relative dangling symlink against the link directory',
  canSymlink,
  async () => {
    const f = await fixture();
    try {
      const confDir = path.join(f.dir, 'conf');
      await mkdir(confDir);
      await mkdir(path.join(f.dir, 'store'));
      const link = path.join(confDir, '.env');
      await symlink(path.join('..', 'store', 'tiktok.env'), link);
      assert.equal(
        await canonicalPath(link),
        path.join(await realpath(path.join(f.dir, 'store')), 'tiktok.env'),
      );
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'canonicalPath resolves a symlinked parent directory of a file not yet written',
  canSymlink,
  async () => {
    const f = await fixture();
    try {
      const realDir = path.join(f.dir, 'real-dir');
      await mkdir(realDir);
      const linkedDir = path.join(f.dir, 'linked-dir');
      await symlink(realDir, linkedDir);
      assert.equal(
        await canonicalPath(path.join(linkedDir, '.env')),
        path.join(await realpath(realDir), '.env'),
      );
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'canonicalPath follows a dangling chain hop by hop to the file at its end',
  canSymlink,
  async () => {
    const f = await fixture();
    try {
      // a -> b -> (missing) c: every link in the chain names the same file,
      // so every spelling must lock the same directory.
      const a = path.join(f.dir, 'a.env');
      const b = path.join(f.dir, 'b.env');
      const c = path.join(await realpath(f.dir), 'c.env');
      await symlink(b, a);
      await symlink(path.join(f.dir, 'c.env'), b);
      assert.equal(await canonicalPath(a), c);
      assert.equal(await canonicalPath(b), c);
      assert.equal(await canonicalPath(path.join(f.dir, 'c.env')), c);
      assert.equal(
        envLockDir(await canonicalPath(a)),
        envLockDir(await canonicalPath(b)),
      );
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'canonicalPath resolves each relative hop against its own link directory',
  canSymlink,
  async () => {
    const f = await fixture();
    try {
      // conf/.env -> ../mid/link (relative to conf), mid/link -> ../store/t.env
      // (relative to mid, not to conf).
      await mkdir(path.join(f.dir, 'conf'));
      await mkdir(path.join(f.dir, 'mid'));
      await mkdir(path.join(f.dir, 'store'));
      const first = path.join(f.dir, 'conf', '.env');
      await symlink(path.join('..', 'mid', 'link'), first);
      await symlink(path.join('..', 'store', 't.env'), path.join(f.dir, 'mid', 'link'));
      assert.equal(
        await canonicalPath(first),
        path.join(await realpath(path.join(f.dir, 'store')), 't.env'),
      );
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'canonicalPath resolves a relative hop against the real directory of a link reached through a symlinked directory',
  canSymlink,
  async () => {
    const f = await fixture();
    try {
      // `via` is a symlink to `deep/real`; the link inside it points one level
      // up. Resolved against the spelling `via/..` that is `f.dir`; resolved
      // against the link's real directory it is `deep` — the right answer.
      const realDir = path.join(f.dir, 'deep', 'real');
      await mkdir(realDir, { recursive: true });
      const via = path.join(f.dir, 'via');
      await symlink(realDir, via);
      await symlink(path.join('..', 'target.env'), path.join(realDir, '.env'));
      assert.equal(
        await canonicalPath(path.join(via, '.env')),
        path.join(await realpath(path.join(f.dir, 'deep')), 'target.env'),
      );
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'canonicalPath returns the path as given for a symlink loop',
  canSymlink,
  async () => {
    const f = await fixture();
    try {
      const x = path.join(f.dir, 'x.env');
      const y = path.join(f.dir, 'y.env');
      await symlink(y, x);
      await symlink(x, y);
      assert.equal(await canonicalPath(x), x);
      // A relative spelling comes back absolute, but otherwise unchanged.
      const relative = path.relative(process.cwd(), x);
      assert.equal(await canonicalPath(relative), path.resolve(relative));
      // A self-loop is a loop too.
      const self = path.join(f.dir, 'self.env');
      await symlink(self, self);
      assert.equal(await canonicalPath(self), self);
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'canonicalPath finds an existing file whose spelling is too long to resolve in one go',
  canSymlink,
  async () => {
    const f = await fixture();
    try {
      // `hop` links to its own directory, so `<real>/hop/hop/…/<name>` names a
      // file that exists. Spelled out through enough hops the path passes
      // PATH_MAX (macOS: 1024) and a whole-path realpath gives up with
      // ENAMETOOLONG, while its parent — still under the limit — resolves.
      // Where realpath copes with the long spelling (glibc) the first attempt
      // answers directly; the canonical path is the same either way.
      const real = await realpath(f.dir);
      const hop = 'h'.repeat(100);
      await symlink('.', path.join(real, hop));
      const name = `${'n'.repeat(200)}.env`;
      await writeFile(path.join(real, name), 'X=1\n');
      let spelled = real;
      while (spelled.length + hop.length + 1 < 1000) spelled = path.join(spelled, hop);
      const long = path.join(spelled, name);
      assert.ok(long.length > 1024, `the spelling is only ${long.length} characters`);

      assert.equal(await canonicalPath(long), path.join(real, name));
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'cc-f5 a symlink and its target take one lock, beside the target',
  canSymlink,
  async () => {
    const f = await fixture();
    try {
      const target = path.join(f.dir, 'real.env');
      await writeFile(target, 'X=1\n');
      await symlink(target, f.envFile);
      const targetLock = envLockDir(await realpath(target));

      let busy: unknown;
      let heldAtTarget = false;
      await withEnvLock(
        f.envFile,
        async () => {
          heldAtTarget = await exists(targetLock);
          // The target, spelled directly, is the same file: its lock is taken.
          busy = await rejection(
            withEnvLock(target, () => Promise.resolve(), {
              waitMs: 0,
              clock: f.clock,
              logger: f.logger,
            }),
          );
        },
        { clock: f.clock, logger: f.logger },
      );

      assert.equal(heldAtTarget, true, 'the lock sits beside the link target');
      assert.equal(ttError(busy).code, 'env_file_busy');
      assert.equal(
        await exists(f.lockDir),
        false,
        'no lock is ever made beside the link',
      );
      assert.equal(await exists(targetLock), false, 'the lock is released');
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'cc-f5 a dangling symlink is locked beside the file it will create',
  canSymlink,
  async () => {
    const f = await fixture();
    try {
      const target = path.join(f.dir, 'later.env');
      await symlink(target, f.envFile);
      const targetLock = envLockDir(path.join(await realpath(f.dir), 'later.env'));

      let heldAtTarget = false;
      await withEnvLock(
        f.envFile,
        async () => {
          heldAtTarget = await exists(targetLock);
        },
        { clock: f.clock, logger: f.logger },
      );
      assert.equal(heldAtTarget, true);
      assert.equal(await exists(f.lockDir), false);
    } finally {
      await f.cleanup();
    }
  },
);

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
    assert.match(
      busy.message,
      /another tiktok-mcp-ai process is updating the credential file /,
    );
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
    // The lock was moved aside before it was deleted, and the move is on record.
    const moved = f.records.find((r) => r.msg === 'moved the stale env-file lock aside');
    assert.equal(moved?.level, 'debug');
    assert.equal(moved?.fields?.dir, f.lockDir);
    assert.match(String(moved?.fields?.tombstone), /\.lock\.stale-[0-9a-f-]{36}$/);
    assert.deepEqual(await tombstones(f.dir), [], 'no tombstone outlives the break');
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

test(
  'cc-f5 a lock whose age cannot be read is waited out, never broken',
  canSymlink,
  async () => {
    const f = await fixture();
    try {
      // A dangling symlink where the lock directory belongs: `mkdir` still says
      // EEXIST, but the `stat` behind it says ENOENT, so the lock has no age.
      // The file system can produce this — a lock on a removed network mount, or
      // a directory deleted between the two syscalls — and an unknown age must
      // read as "someone else holds it", never as "old enough to steal".
      await symlink(path.join(f.dir, 'gone'), f.lockDir);

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

      assert.equal(ttError(err).code, 'env_file_busy');
      assert.equal(ran, false, 'an unreadable lock is not an absent one');
      assert.equal(warningLike(f.records, 'removed a stale'), undefined);
      assert.equal(warningLike(f.records, 'could not remove the stale'), undefined);
    } finally {
      await rm(f.lockDir, { force: true }).catch(() => undefined);
      await f.cleanup();
    }
  },
);

test('cc-f5 a holder record of the wrong shape is ignored, not trusted', async () => {
  const f = await fixture();
  try {
    // Valid JSON, but not an object: a truncated write, or a file some other
    // tool put there. Nothing may be claimed about the dead holder.
    await plantLock(f.lockDir, 60_000, 'null\n');
    await withEnvLock(f.envFile, () => Promise.resolve(), {
      staleMs: 15_000,
      clock: f.clock,
      logger: f.logger,
    });
    const first = warningLike(f.records, 'removed a stale env-file lock');
    assert.notEqual(first, undefined);
    assert.equal(first?.fields?.pid, undefined);
    assert.equal(first?.fields?.hostname, undefined);
    assert.equal(first?.fields?.created_at, undefined);

    // An object, but every field is of the wrong type — a record written by
    // something else that happens to use the same file name. Each field is
    // taken on its own merits, and none of these qualify.
    f.records.length = 0;
    await plantLock(
      f.lockDir,
      60_000,
      `${JSON.stringify({ pid: 'nine', hostname: 42, createdAt: 7 })}\n`,
    );
    await withEnvLock(f.envFile, () => Promise.resolve(), {
      staleMs: 15_000,
      clock: f.clock,
      logger: f.logger,
    });
    const second = warningLike(f.records, 'removed a stale env-file lock');
    assert.notEqual(second, undefined);
    assert.equal(second?.fields?.pid, undefined);
    assert.equal(second?.fields?.hostname, undefined);
    assert.equal(second?.fields?.created_at, undefined);
    assert.equal(second?.fields?.env_file, f.envFile);
  } finally {
    await f.cleanup();
  }
});

test(
  'cc-h3 a holder record that cannot be written costs a debug line, not the lock',
  canDenyAccess,
  async () => {
    const f = await fixture();
    // A umask this wide makes the lock directory itself mode 000, so the
    // diagnostic record cannot be created inside it — the shape of a restrictive
    // umask or a directory whose permissions an administrator tightened. The
    // mutex is the directory, and it was created: losing the record must not
    // lose the lock.
    const previousMask = process.umask(0o777);
    try {
      let ran = false;
      await withEnvLock(
        f.envFile,
        async () => {
          ran = true;
          // Give release its own permission back; the lock is already held, so
          // this proves nothing about the acquisition it followed.
          await chmod(f.lockDir, 0o700);
        },
        { clock: f.clock, logger: f.logger },
      );

      assert.equal(ran, true, 'the critical section still runs');
      assert.deepEqual(warnings(f.records), [], 'a diagnostic nicety is not a warning');
      const debug = f.records.find(
        (r) => r.msg === 'could not write the env-file lock holder record',
      );
      assert.notEqual(debug, undefined, 'the failure is still visible at debug level');
      assert.equal(debug?.level, 'debug');
      assert.equal(debug?.fields?.['code'], 'EACCES');
      assert.equal(await exists(f.lockDir), false, 'the lock is still released');
    } finally {
      process.umask(previousMask);
      await f.cleanup();
    }
  },
);

test('cc-h3 a holder record that cannot even be built costs the same debug line', async () => {
  const f = await fixture();
  try {
    // The record is *built* from two things that can fail — `hostname()`, and a
    // timestamp from the injected clock — before it is written. A clock that
    // cannot produce a time makes `toISOString` throw, which is the failure that
    // happens before the `writeFile` rather than inside it; it has to be caught
    // by the same guard. If it escaped, it would reach `acquire`'s catch, which
    // reads every error there as a `mkdir` verdict, and a lock this process
    // already holds would be reported as unusable and left behind.
    const base = mockClock();
    const clock: Clock = {
      now: () => Number.NaN,
      sleep: (ms, signal) => base.sleep(ms, signal),
    };

    const value = await withEnvLock(f.envFile, () => Promise.resolve('done'), {
      clock,
      logger: f.logger,
    });

    assert.equal(value, 'done');
    assert.deepEqual(warnings(f.records), []);
    const debug = f.records.find(
      (r) => r.msg === 'could not write the env-file lock holder record',
    );
    assert.notEqual(debug, undefined);
    // Not an errno: a failure with no `code` is still reported, as `unknown`.
    assert.equal(debug?.fields?.['code'], 'unknown');
    assert.equal(await exists(f.lockDir), false, 'the lock is taken and released');
  } finally {
    await f.cleanup();
  }
});

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

test('cc-f5 a stale lock re-taken after its age was measured is handed back, not deleted', async () => {
  const f = await fixture();
  try {
    await plantLock(f.lockDir, 60_000);
    // Breaker B measured a stale age; before it moves the path aside, another
    // process breaks the same lock and takes a fresh one of its own. B's rename
    // then grabs the successor's live lock — it must put it back.
    const clock = clockHookedAt(2, () => {
      rmSync(f.lockDir, { recursive: true, force: true });
      plantFreshSync(f.lockDir, 'successor');
    });

    let ran = false;
    const err = await rejection(
      driveClock(
        clock,
        withEnvLock(
          f.envFile,
          () => {
            ran = true;
            return Promise.resolve();
          },
          { waitMs: 500, staleMs: 15_000, clock, logger: f.logger },
        ),
      ),
    );

    assert.equal(clock.fired(), true, 'the successor must have been planted');
    assert.equal(ttError(err).code, 'env_file_busy');
    assert.equal(ran, false);
    assert.equal(
      await readFile(path.join(f.lockDir, 'marker'), 'utf8'),
      'successor\n',
      'the successor’s lock must survive the break',
    );
    assert.deepEqual(await tombstones(f.dir), [], 'the tombstone was renamed back');
    const retaken = f.records.find((r) =>
      r.msg.includes('was re-taken before it could be removed'),
    );
    assert.equal(retaken?.level, 'debug');
    assert.equal(
      retaken?.msg,
      `the stale env-file lock ${f.lockDir} was re-taken before it could be removed`,
    );
    assert.equal(retaken?.fields?.env_file, f.envFile);
    assert.deepEqual(
      warnings(f.records),
      [],
      'nothing was broken, so nothing is reported',
    );
  } finally {
    await f.cleanup();
  }
});

test('cc-f5 a re-taken lock whose path is taken yet again is not restored, and its tombstone is removed', async () => {
  const f = await fixture();
  try {
    await plantLock(f.lockDir, 60_000);
    const clock = clockHookedAt(2, () => {
      rmSync(f.lockDir, { recursive: true, force: true });
      plantFreshSync(f.lockDir, 'successor');
    });
    const { logger: base, records } = recordingLogger();
    let third = false;
    const logger: Logger = {
      ...base,
      debug: (msg, fields) => {
        base.debug(msg, fields);
        if (msg !== 'moved the stale env-file lock aside') return;
        // The instant the successor's lock is moved aside, a third process takes
        // the path. A non-empty directory there makes the restore `rename` fail.
        third = true;
        plantFreshSync(f.lockDir, 'third');
      },
      child: () => logger,
    };

    let ran = false;
    const err = await rejection(
      driveClock(
        clock,
        withEnvLock(
          f.envFile,
          () => {
            ran = true;
            return Promise.resolve();
          },
          { waitMs: 500, staleMs: 15_000, clock, logger },
        ),
      ),
    );

    assert.equal(third, true, 'the third holder must have been planted');
    assert.equal(ttError(err).code, 'env_file_busy');
    assert.equal(ran, false);
    assert.equal(
      await readFile(path.join(f.lockDir, 'marker'), 'utf8'),
      'third\n',
      'the lock now at the path is left alone',
    );
    assert.deepEqual(
      await tombstones(f.dir),
      [],
      'the tombstone must not outlive the race',
    );
    assert.equal(
      records.find((r) => r.msg.includes('was re-taken before it could be removed')),
      undefined,
    );
    assert.deepEqual(warnings(records), []);
  } finally {
    await f.cleanup();
  }
});

test('cc-f5 a re-taken lock is not restored over an empty directory, which survives', async () => {
  const f = await fixture();
  try {
    await plantLock(f.lockDir, 60_000);
    const clock = clockHookedAt(2, () => {
      rmSync(f.lockDir, { recursive: true, force: true });
      plantFreshSync(f.lockDir, 'successor');
    });
    const { logger: base, records } = recordingLogger();
    let third = false;
    const logger: Logger = {
      ...base,
      debug: (msg, fields) => {
        base.debug(msg, fields);
        if (msg !== 'moved the stale env-file lock aside') return;
        // A third process caught between its `mkdir` and its holder file: the
        // path holds an EMPTY directory. On POSIX a `rename` onto an empty
        // directory replaces it, so only the existence check keeps this lock.
        third = true;
        mkdirSync(f.lockDir, { mode: 0o700 });
        const fresh = new Date(BASELINE_NOW_MS - 1_000);
        utimesSync(f.lockDir, fresh, fresh);
      },
      child: () => logger,
    };

    let ran = false;
    const err = await rejection(
      driveClock(
        clock,
        withEnvLock(
          f.envFile,
          () => {
            ran = true;
            return Promise.resolve();
          },
          { waitMs: 500, staleMs: 15_000, clock, logger },
        ),
      ),
    );

    assert.equal(third, true, 'the empty third lock must have been planted');
    assert.equal(ttError(err).code, 'env_file_busy');
    assert.equal(ran, false);
    assert.equal(await exists(f.lockDir), true, 'the third lock must survive');
    assert.deepEqual(
      await readdir(f.lockDir),
      [],
      'the successor’s lock was not renamed over the empty directory',
    );
    assert.deepEqual(
      await tombstones(f.dir),
      [],
      'the tombstone must not outlive the race',
    );
    assert.equal(
      records.find((r) => r.msg.includes('was re-taken before it could be removed')),
      undefined,
    );
    assert.deepEqual(warnings(records), []);
  } finally {
    await f.cleanup();
  }
});

test('cc-f5 a stale lock another breaker already removed counts as broken', async () => {
  const f = await fixture();
  try {
    await plantLock(f.lockDir, 60_000);
    // Another breaker wins between the age check and the rename: the rename
    // fails with ENOENT, and the next mkdir decides.
    const clock = clockHookedAt(2, () => {
      rmSync(f.lockDir, { recursive: true, force: true });
    });

    let ran = false;
    await withEnvLock(
      f.envFile,
      () => {
        ran = true;
        return Promise.resolve();
      },
      { waitMs: 500, staleMs: 15_000, clock, logger: f.logger },
    );

    assert.equal(clock.fired(), true);
    assert.equal(ran, true, 'the path was clear, so the lock is taken at once');
    assert.equal(clock.pending(), 0, 'no retry sleep was spent');
    assert.deepEqual(warnings(f.records), [], 'this call broke nothing itself');
    assert.equal(
      f.records.find((r) => r.msg === 'moved the stale env-file lock aside'),
      undefined,
    );
    assert.deepEqual(await tombstones(f.dir), []);
    assert.equal(await exists(f.lockDir), false);
  } finally {
    await f.cleanup();
  }
});

test('cc-f5 a stale lock its holder stamped after the age was measured is handed back, not deleted', async () => {
  // Same directory, same inode, same birth time — only the mtime moved. That is
  // a live holder whose heartbeat landed between the breaker's age `stat` and
  // its rename, and it is also exactly what a successor reusing the inode looks
  // like on a file system that reports no birth time. The directory identity
  // alone cannot tell it apart from the dead lock; the stale mtime can.
  const f = await fixture();
  try {
    await plantLock(f.lockDir, 60_000);
    writeFileSync(path.join(f.lockDir, 'marker'), 'holder\n');
    // Writing the marker stamped the directory; put its stale age back.
    const old = new Date(BASELINE_NOW_MS - 60_000);
    await utimes(f.lockDir, old, old);
    let before: { ino: number; birthtimeMs: number; mtimeMs: number } | undefined;
    let after: { ino: number; birthtimeMs: number; mtimeMs: number } | undefined;
    const clock = clockHookedAt(2, () => {
      before = statSync(f.lockDir);
      const stamped = new Date(BASELINE_NOW_MS - 1_000);
      utimesSync(f.lockDir, stamped, stamped);
      after = statSync(f.lockDir);
    });

    let ran = false;
    const err = await rejection(
      driveClock(
        clock,
        withEnvLock(
          f.envFile,
          () => {
            ran = true;
            return Promise.resolve();
          },
          { waitMs: 500, staleMs: 15_000, clock, logger: f.logger },
        ),
      ),
    );

    assert.equal(clock.fired(), true, 'the heartbeat must have been stamped');
    assert.equal(after?.ino, before?.ino, 'the stamp keeps the inode');
    assert.equal(
      after?.birthtimeMs,
      before?.birthtimeMs,
      'the stamp keeps the birth time',
    );
    assert.notEqual(after?.mtimeMs, before?.mtimeMs, 'only the mtime moved');

    assert.equal(ttError(err).code, 'env_file_busy');
    assert.equal(ran, false);
    assert.equal(
      await readFile(path.join(f.lockDir, 'marker'), 'utf8'),
      'holder\n',
      'the live holder’s lock must survive the break',
    );
    assert.equal((await stat(f.lockDir)).ino, before?.ino, 'the very same directory');
    assert.deepEqual(await tombstones(f.dir), [], 'the tombstone was renamed back');
    assert.equal(
      f.records.find((r) => r.msg.includes('was re-taken before it could be removed'))
        ?.level,
      'debug',
    );
    assert.deepEqual(
      warnings(f.records),
      [],
      'nothing was broken, so nothing is reported',
    );
  } finally {
    await f.cleanup();
  }
});

test("cc-f5 a tombstone that cannot be stat'ed after the rename is not treated as ours", async () => {
  // The rename succeeded, but the tombstone is gone before its identity can be
  // checked. Nothing proves it was the directory whose age was measured, so the
  // breaker must not claim the break: no stale-lock warning, and the lock is
  // only taken on a later, ordinary attempt.
  const f = await fixture();
  try {
    await plantLock(f.lockDir, 60_000);
    const { logger: base, records } = recordingLogger();
    let removed = false;
    const logger: Logger = {
      ...base,
      debug: (msg, fields) => {
        base.debug(msg, fields);
        if (msg !== 'moved the stale env-file lock aside') return;
        removed = true;
        rmSync(String(fields?.tombstone), { recursive: true, force: true });
      },
      child: () => logger,
    };

    let ran = false;
    const held = withEnvLock(
      f.envFile,
      () => {
        ran = true;
        return Promise.resolve();
      },
      { waitMs: 500, staleMs: 15_000, clock: f.clock, logger },
    );
    // Virtual time must not move while the first attempt is still doing real
    // I/O: `driveClock` would advance it on every real millisecond, and on a
    // loaded machine the whole 500 ms budget is gone before the retry sleep is
    // even armed. Wait for that sleep, then let exactly it fire.
    await until(() => f.clock.pending() === 1, 'the retry after the unverified break');
    assert.equal(removed, true, 'the tombstone must have been removed under the breaker');
    assert.equal(ran, false, 'the break was not claimed, so the lock is not taken yet');
    await f.clock.advance(150); // the longest jittered retry
    await held;

    assert.equal(ran, true, 'the path is clear, so a later attempt takes the lock');
    assert.deepEqual(warnings(records), [], 'this call broke nothing it could verify');
    assert.equal(
      records.find((r) => r.msg.includes('was re-taken before it could be removed')),
      undefined,
      'there was nothing left to hand back',
    );
    assert.deepEqual(await tombstones(f.dir), []);
    assert.equal(await exists(f.lockDir), false);
  } finally {
    await f.cleanup();
  }
});

test(
  'cc-f5 remains of a stale lock that cannot be deleted are reported, and the lock is still taken',
  canDenyAccess,
  async () => {
    const f = await fixture();
    try {
      await plantLock(f.lockDir, 60_000, `${JSON.stringify({ pid: 999_999 })}\n`);
      // The rename only needs the parent to be writable; deleting holder.json
      // needs the lock directory itself to be, and it is not.
      await chmod(f.lockDir, 0o500);

      let ran = false;
      try {
        await withEnvLock(
          f.envFile,
          () => {
            ran = true;
            return Promise.resolve();
          },
          { waitMs: 500, staleMs: 15_000, clock: f.clock, logger: f.logger },
        );

        assert.equal(ran, true, 'the path is clear, so the lock is taken');
        const [tombstone, ...rest] = await tombstones(f.dir);
        assert.deepEqual(rest, []);
        assert.notEqual(tombstone, undefined, 'the undeletable remains are still there');
        const remains = path.join(f.dir, tombstone ?? '');
        const warn = warningLike(f.records, 'could not delete the remains');
        assert.equal(
          warn?.msg,
          `could not delete the remains of the stale env-file lock at ${remains}`,
        );
        assert.equal(warn?.fields?.dir, remains);
        assert.equal(warn?.fields?.env_file, f.envFile);
        assert.equal(warn?.fields?.code, 'EACCES');
        // The lock itself was broken, and that is still reported.
        assert.equal(
          warningLike(f.records, 'removed a stale env-file lock')?.fields?.pid,
          999_999,
        );
        assert.equal(await exists(f.lockDir), false);
      } finally {
        for (const name of await tombstones(f.dir)) {
          await chmod(path.join(f.dir, name), 0o700);
        }
      }
    } finally {
      await f.cleanup();
    }
  },
);

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

    for (let beat = 0; beat < 3; beat += 1) await f.clock.advance(2_000);

    // The timer firing is not the stamp landing: `utimes` is real I/O, and a
    // fixed number of event-loop turns is a fraction of a millisecond — less
    // than a loaded runner needs to return it. Wait for the stamp itself — and
    // bound it on both sides: `mkdir` stamps real wall time, which is already
    // past the mock baseline, so a lower bound alone is met before any beat.
    const stamped = (mtimeMs: number): boolean =>
      mtimeMs >= BASELINE_NOW_MS + 2_000 && mtimeMs <= BASELINE_NOW_MS + 6_000;
    await untilAsync(
      async () => stamped((await stat(f.lockDir)).mtimeMs),
      'the heartbeat to stamp the lock directory',
    );

    // The mtime now comes from the injected clock, which is what proves the
    // heartbeat ran: `mkdir` had stamped it with real wall time.
    const touched = (await stat(f.lockDir)).mtimeMs;
    assert.equal(
      stamped(touched),
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

test(
  'cc-f5 a heartbeat that cannot stamp the lock says so and stops',
  canDenyAccess,
  async () => {
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
        { heartbeatMs: 2_000, staleMs: 15_000, clock: f.clock, logger: f.logger },
      );
      await until(() => entered, 'the holder to take the lock');
      await until(() => f.clock.pending() > 0, 'the heartbeat to arm its first sleep');

      // Not ENOENT: the lock is still there, it just cannot be touched — the
      // parent directory lost its execute bit under the holder. That is the
      // dangerous case, because the stamp stops while the lock stays.
      await chmod(f.dir, 0o600);
      await f.clock.advance(2_000);
      await until(
        () => warningLike(f.records, 'could not refresh the mtime') !== undefined,
        'the heartbeat to report the failed stamp',
      );

      const warn = warningLike(f.records, 'could not refresh the mtime');
      assert.equal(warn?.fields?.code, 'EACCES');
      assert.match(warn?.msg ?? '', /may be declared stale while it is still held/);
      assert.equal(
        warningLike(f.records, 'vanished'),
        undefined,
        'a lock that cannot be touched has not been lost to anyone',
      );

      await chmod(f.dir, 0o700);
      gate.resolve(undefined);
      assert.equal(await held, 'kept', 'the caller’s value survives a dead heartbeat');
      assert.equal(await exists(f.lockDir), false, 'release still owns the lock');
      assert.equal(f.clock.pending(), 0, 'the heartbeat must not keep ticking');
    } finally {
      await f.cleanup();
    }
  },
);

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

test('cc-h3 a heartbeat that dies with a non-Error reason still names it', async () => {
  const f = await fixture();
  try {
    // A `Clock` rejects a signalled sleep with `signal.reason` verbatim
    // (core/clock.ts § sleep), and `abort(reason)` accepts any value — a host
    // that folds the heartbeat's signal into a shutdown signal aborted with a
    // plain string hands this catch something that is not an `Error` at all.
    // The reason still has to reach the operator: a lock that stopped beating
    // is the one thing this warning exists to say.
    const reason = 'the host clock was torn down';
    const base = mockClock();
    const clock: Clock = {
      now: () => base.now(),
      // The heartbeat is the only sleeper that passes a signal.
      sleep: async (ms, signal) => {
        if (signal === undefined) {
          await base.sleep(ms);
          return;
        }
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the value under test
        throw reason;
      },
    };

    const value = await withEnvLock(f.envFile, () => Promise.resolve('done'), {
      clock,
      logger: f.logger,
    });

    assert.equal(value, 'done');
    const warn = warningLike(f.records, 'stopped early');
    assert.notEqual(warn, undefined, 'a dead heartbeat must be reported');
    // Stringified, not dropped: `err.message` on a non-`Error` would be
    // `undefined` and the operator would be told nothing about why.
    assert.equal(warn?.fields?.reason, reason);
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
    assert.match(
      unusable.message,
      /^the env-file lock directory .+ could not be created \([A-Z]+\), so concurrent writes to the credential file cannot be made safe$/,
    );
    assert.match(unusable.remediation ?? '', /TT_ENV_FILE/);
    assert.notEqual(unusable.cause, undefined, 'the errno cause must be kept for doctor');
    assert.equal(ran, false);
  } finally {
    await f.cleanup();
  }
});

/** The wording the journal passes when it takes this mutex for rotation. */
const JOURNAL_LABEL = { lock: 'journal rotation', guards: 'the publish journal' };

test('a custom label names the lock and the file it guards in the busy error', async () => {
  const f = await fixture();
  try {
    await plantLock(f.lockDir, 1_000);
    const busy = ttError(
      await rejection(
        withEnvLock(f.envFile, () => Promise.resolve(), {
          waitMs: 0,
          staleMs: 15_000,
          clock: f.clock,
          logger: f.logger,
          label: JOURNAL_LABEL,
        }),
      ),
    );
    assert.equal(busy.code, 'env_file_busy');
    assert.match(
      busy.message,
      /^another tiktok-mcp-ai process is updating the publish journal /,
    );
    assert.equal(busy.message.includes('the credential file'), false);
  } finally {
    await f.cleanup();
  }
});

test('a custom label names the lock and the file it guards when the lock is unusable', async () => {
  const f = await fixture();
  try {
    const blocker = path.join(f.dir, 'blocker');
    await writeFile(blocker, 'a regular file, not a directory\n');
    const unusable = ttError(
      await rejection(
        withEnvLock(path.join(blocker, 'journal.ndjson'), () => Promise.resolve(), {
          clock: f.clock,
          logger: f.logger,
          label: JOURNAL_LABEL,
        }),
      ),
    );
    assert.equal(unusable.code, 'env_lock_unusable');
    assert.match(
      unusable.message,
      /^the journal rotation lock directory .+ could not be created \([A-Z]+\), so concurrent writes to the publish journal cannot be made safe$/,
    );
    assert.equal(unusable.message.includes('env-file'), false);
  } finally {
    await f.cleanup();
  }
});

test('a custom label names the lock in the stale-lock warning', async () => {
  const f = await fixture();
  try {
    await plantLock(f.lockDir, 60_000);
    await withEnvLock(f.envFile, () => Promise.resolve(), {
      staleMs: 15_000,
      clock: f.clock,
      logger: f.logger,
      label: JOURNAL_LABEL,
    });
    const warn = warningLike(f.records, 'removed a stale');
    assert.match(warn?.msg ?? '', /^removed a stale journal rotation lock: /);
    assert.equal(warningLike(f.records, 'env-file'), undefined);
    assert.equal(await exists(f.lockDir), false);
  } finally {
    await f.cleanup();
  }
});

test('cc-h3 a diagnostic sink that throws still fails as a typed lock error', async () => {
  const f = await fixture();
  try {
    // `acquire` reads everything that escapes its `try` as a `mkdir` verdict,
    // and the line that reports a successful acquisition writes to a caller
    // seam. A sink that throws must not surface as a raw `TypeError`: CC-H3 is
    // that lock trouble reaches the caller as a typed, actionable config error,
    // and a cause with no errno is named `unknown` rather than interpolated as
    // `undefined` into the operator's message.
    const { logger: base, records } = recordingLogger();
    const logger: Logger = {
      ...base,
      debug: (msg, fields) => {
        if (msg === 'env-file lock acquired') throw new TypeError('the log sink is gone');
        base.debug(msg, fields);
      },
      child: () => logger,
    };

    let ran = false;
    const err = await rejection(
      withEnvLock(
        f.envFile,
        () => {
          ran = true;
          return Promise.resolve();
        },
        { clock: f.clock, logger },
      ),
    );

    const unusable = ttError(err);
    assert.equal(unusable.kind, 'config');
    assert.equal(unusable.code, 'env_lock_unusable');
    assert.match(unusable.message, /could not be created \(unknown\)/);
    assert.equal(
      unusable.cause instanceof TypeError,
      true,
      'the original failure is kept for doctor',
    );
    assert.equal(ran, false, 'fn never runs on a failed acquisition');
    assert.deepEqual(warnings(records), []);
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
// ownership: a lock replaced under a stalled holder is never touched or deleted
// ---------------------------------------------------------------------------

/**
 * Replace the lock directory the way a competitor does after declaring it
 * stale: remove it, then take it with a record of its own. The new directory
 * carries a `marker` so a test can prove it survived, and an mtime pinned in
 * virtual time so a test can prove it was never stamped.
 */
async function replaceWithSuccessor(lockDir: string): Promise<number> {
  await rm(lockDir, { recursive: true, force: true });
  await mkdir(lockDir, { mode: 0o700 });
  await writeFile(
    path.join(lockDir, 'holder.json'),
    `${JSON.stringify({ pid: 424242, hostname: 'successor', token: 'not-yours' })}\n`,
  );
  await writeFile(path.join(lockDir, 'marker'), 'a different holder\n');
  const pinned = BASELINE_NOW_MS - 1_000;
  await utimes(lockDir, new Date(pinned), new Date(pinned));
  return pinned;
}

/**
 * A clock whose `now()` is `NaN` until the holder record has failed to be
 * built — the one seam that makes `writeHolder` fail on every platform, so the
 * `ino:birthtimeMs` fallback identity is the one in use — plus a logger that
 * flips it back and optionally runs `onRecordFailure` at that exact point
 * (after `mkdir`, before the fallback identity is captured).
 */
function withoutHolderRecord(onRecordFailure?: () => void): {
  clock: MockClock;
  logger: Logger;
  records: Recorded[];
} {
  const base = mockClock();
  const { logger: inner, records } = recordingLogger();
  let broken = true;
  const clock: MockClock = {
    ...base,
    now: () => (broken ? Number.NaN : base.now()),
  };
  const logger: Logger = {
    ...inner,
    debug: (msg, fields) => {
      inner.debug(msg, fields);
      if (msg !== 'could not write the env-file lock holder record') return;
      broken = false;
      onRecordFailure?.();
    },
    child: () => logger,
  };
  return { clock, logger, records };
}

test('the holder record carries a per-acquisition token', async () => {
  const f = await fixture();
  try {
    const tokens: unknown[] = [];
    for (let run = 0; run < 2; run += 1) {
      await withEnvLock(
        f.envFile,
        async () => {
          tokens.push((await readHolder(f.lockDir)).token);
        },
        { clock: f.clock, logger: f.logger },
      );
    }
    assert.equal(typeof tokens[0], 'string');
    assert.notEqual(tokens[0], tokens[1], 'two acquisitions never share an identity');
  } finally {
    await f.cleanup();
  }
});

test('cc-f5 a heartbeat after the lock was replaced marks it lost and does not touch it', async () => {
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
      { heartbeatMs: 2_000, staleMs: 15_000, clock: f.clock, logger: f.logger },
    );
    await until(() => entered, 'the holder to take the lock');
    await until(() => f.clock.pending() > 0, 'the heartbeat to arm its first sleep');

    // This holder stalled past staleMs; another process broke the lock and
    // took it. The directory exists again, so an unchecked `utimes` succeeds.
    const pinned = await replaceWithSuccessor(f.lockDir);
    await f.clock.advance(2_000);
    await until(
      () => warningLike(f.records, 'reclaimed by another holder') !== undefined,
      'the heartbeat to notice the replacement',
    );

    const warn = warningLike(f.records, 'reclaimed by another holder');
    assert.equal(warn?.fields?.code, 'env_lock_replaced');
    assert.match(warn?.msg ?? '', /another process may be writing/);
    assert.equal(
      (await stat(f.lockDir)).mtimeMs,
      pinned,
      'the heartbeat must not keep the successor’s lock fresh under our name',
    );
    assert.equal(f.clock.pending(), 0, 'the heartbeat stops at the loss');

    gate.resolve(undefined);
    assert.equal(await held, 'kept', 'the caller’s value survives the loss');
    assert.equal(
      await exists(path.join(f.lockDir, 'marker')),
      true,
      'release must not delete the successor’s lock',
    );
    assert.equal(warnings(f.records).length, 1, 'the loss is reported once');
  } finally {
    await f.cleanup();
  }
});

test('cc-f5 a release after the lock was replaced does not delete the new holder’s lock', async () => {
  const f = await fixture();
  try {
    // The replacement lands between two beats, so only release can catch it.
    const value = await withEnvLock(
      f.envFile,
      async () => {
        await replaceWithSuccessor(f.lockDir);
        return 'done';
      },
      { clock: f.clock, logger: f.logger },
    );

    assert.equal(value, 'done');
    assert.equal(
      await exists(path.join(f.lockDir, 'marker')),
      true,
      'release must not delete a lock this process no longer owns',
    );
    assert.equal((await readHolder(f.lockDir)).token, 'not-yours');
    const warn = warningLike(f.records, 'reclaimed by another holder');
    assert.notEqual(warn, undefined, 'the loss must be reported');
    assert.equal(warn?.fields?.code, 'env_lock_replaced');
    assert.equal(warn?.fields?.dir, f.lockDir);
  } finally {
    await f.cleanup();
  }
});

test('cc-f5 without a holder record, the directory identity still catches a replacement', async () => {
  const f = await fixture();
  try {
    const { clock, logger, records } = withoutHolderRecord();
    const value = await withEnvLock(
      f.envFile,
      async () => {
        await replaceWithSuccessor(f.lockDir);
        return 'done';
      },
      { clock, logger },
    );

    assert.equal(value, 'done');
    assert.notEqual(
      records.find((r) => r.msg === 'could not write the env-file lock holder record'),
      undefined,
      'precondition: the record really was not written',
    );
    assert.equal(await exists(path.join(f.lockDir, 'marker')), true);
    const warn = warningLike(records, 'reclaimed by another holder');
    assert.equal(warn?.fields?.code, 'env_lock_replaced');
  } finally {
    await f.cleanup();
  }
});

test('cc-f5 a lock that vanishes before its identity is captured is never deleted', async () => {
  const f = await fixture();
  try {
    // Gone between `mkdir` and the fallback `stat`: there is nothing to
    // recognise the directory by, so whatever is at the path later is not ours.
    const { clock, logger, records } = withoutHolderRecord(() => {
      rmSync(f.lockDir, { recursive: true, force: true });
    });
    const value = await withEnvLock(
      f.envFile,
      async () => {
        await replaceWithSuccessor(f.lockDir);
        return 'done';
      },
      { clock, logger },
    );

    assert.equal(value, 'done');
    assert.equal(await exists(path.join(f.lockDir, 'marker')), true);
    const warn = warningLike(records, 'vanished');
    assert.notEqual(warn, undefined);
    assert.equal(warn?.fields?.code, 'ENOENT');
  } finally {
    await f.cleanup();
  }
});

test('cc-f5 a lock that vanishes between the ownership check and the stamp is lost', async () => {
  const f = await fixture();
  try {
    const base = mockClock();
    let armed = false;
    // `now()` is read for the stamp right after the ownership check passed;
    // removing the directory there is the race the check cannot close.
    const clock: Clock = {
      now: () => {
        if (armed) {
          armed = false;
          rmSync(f.lockDir, { recursive: true, force: true });
        }
        return base.now();
      },
      sleep: (ms, signal) => base.sleep(ms, signal),
    };
    const gate = deferred();
    let entered = false;
    const held = withEnvLock(
      f.envFile,
      async () => {
        entered = true;
        await gate.promise;
        return 'kept';
      },
      { heartbeatMs: 2_000, staleMs: 15_000, clock, logger: f.logger },
    );
    await until(() => entered, 'the holder to take the lock');
    await until(() => base.pending() > 0, 'the heartbeat to arm its first sleep');

    armed = true;
    await base.advance(2_000);
    await until(
      () => warningLike(f.records, 'vanished') !== undefined,
      'the heartbeat to report the failed stamp',
    );
    assert.equal(warningLike(f.records, 'vanished')?.fields?.code, 'ENOENT');

    // A successor takes the path; the lost holder must leave it alone.
    await replaceWithSuccessor(f.lockDir);
    gate.resolve(undefined);
    assert.equal(await held, 'kept');
    assert.equal(await exists(path.join(f.lockDir, 'marker')), true);
    assert.equal(base.pending(), 0);
  } finally {
    await f.cleanup();
  }
});

test(
  'cc-h3 a release that cannot verify ownership leaves the lock and warns',
  canDenyAccess,
  async () => {
    const f = await fixture();
    try {
      const value = await withEnvLock(
        f.envFile,
        async () => {
          // The record exists but cannot be read back: ownership is unknown,
          // which is not proof of loss — and not licence to delete either.
          await chmod(path.join(f.lockDir, 'holder.json'), 0o000);
          return 'done';
        },
        { clock: f.clock, logger: f.logger },
      );

      assert.equal(value, 'done');
      assert.equal(await exists(f.lockDir), true, 'an unverified lock is not deleted');
      const warn = warningLike(f.records, 'could not remove the env-file lock');
      assert.notEqual(warn, undefined);
      assert.match(warn?.msg ?? '', /treat it as stale after 15000 ms/);
      assert.equal(warn?.fields?.code, 'EACCES');
      assert.equal(warningLike(f.records, 'reclaimed'), undefined);
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

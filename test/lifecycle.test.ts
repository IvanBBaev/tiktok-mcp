/**
 * test/lifecycle.test.ts — the credential-store watch behind
 * `notifications/tools/list_changed`.
 *
 * Spec: CONTRACTS.md § `mcp/lifecycle.ts`, TOOLS.md § 6.3, CORNER-CASES.md
 * CC-A7 (a re-login that grants a scope must reach a running client without a
 * restart), CC-F2 (presence-based process-env overlay), CC-H3 (a broken
 * credential store degrades, never throws) and CC-H4 (every wait is virtual).
 *
 * Two things carry most of the weight here. The first is the **negative**:
 * a token refresh rewrites the env file every couple of hours, and a watch that
 * notified on every write would spam every connected client forever — so
 * "the bytes changed but the scope picture did not" is asserted as hard as the
 * positive case. The second is that no test waits on wall-clock *time*: the
 * ticks come from `mockClock.advance`, and the only real-time pumping is
 * `settle()`, which turns the event loop while a file read that has already
 * started lands.
 */

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import type { Logger } from '../src/core/log.js';
import {
  DEFAULT_WATCH_INTERVAL_MS,
  MIN_WATCH_INTERVAL_MS,
  diffProfiles,
  profileSignature,
  readCredentialProfiles,
  startCredentialWatch,
  type CredentialChange,
} from '../src/mcp/lifecycle.js';
import type { ProfileInfo } from '../src/mcp/server.js';
import { deferred, flush } from './harness/deferred.js';
import { fsSandbox, mockClock, type MockClock } from './helpers.js';

// ---------------------------------------------------------------------------
// local fixtures
// ---------------------------------------------------------------------------

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

function atLevel(records: readonly Recorded[], level: string): Recorded[] {
  return records.filter((record) => record.level === level);
}

/** One complete DEFAULT profile; `scopes` is the only thing tests vary. */
function envFileText(scopes: string, accessToken = 'act.first'): string {
  return [
    'TT_CLIENT_KEY=client-key',
    'TT_CLIENT_SECRET=client-secret',
    `TT_ACCESS_TOKEN=${accessToken}`,
    `TT_SCOPES=${scopes}`,
    '',
  ].join('\n');
}

function profile(name: string, ...scopes: string[]): ProfileInfo {
  return { name, scopes };
}

/**
 * Turn the event loop until `condition` holds.
 *
 * Not a sleep and never a substitute for one: no *virtual* time passes here
 * (determinism rule 1 still owns time itself). This only gives a real file read
 * that the watch has **already started** the turns it needs to land, which a
 * `setImmediate` loop cannot promise on a loaded runner.
 */
async function settle(condition: () => boolean, why: string): Promise<void> {
  for (let turn = 0; turn < 500 && !condition(); turn += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
  }
  assert.equal(condition(), true, why);
}

/** Every `TT_*` key the ambient shell may have exported, removed and restored. */
async function withoutAmbientTtEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('TT_')) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface WatchFixture {
  readonly dir: string;
  readonly envFile: string;
  readonly clock: MockClock;
  readonly logger: Logger;
  readonly records: Recorded[];
  readonly changes: CredentialChange[];
  cleanup(): Promise<void>;
}

async function fixture(): Promise<WatchFixture> {
  const box = await fsSandbox();
  const { logger, records } = recordingLogger();
  return {
    dir: box.dir,
    envFile: path.join(box.dir, '.env'),
    clock: mockClock(),
    logger,
    records,
    changes: [],
    cleanup: () => box.cleanup(),
  };
}

// ---------------------------------------------------------------------------
// the derived signal
// ---------------------------------------------------------------------------

test('cc-a7: the signature ignores profile order, scope order and duplicates', () => {
  const one = profileSignature([
    profile('WORK', 'video.publish', 'video.list'),
    profile('DEFAULT', 'user.info.basic'),
  ]);
  const two = profileSignature([
    profile('DEFAULT', 'user.info.basic'),
    profile('WORK', 'video.list', 'video.publish', 'video.list'),
  ]);
  assert.equal(one, two);
  // Duplicate names are not deduplicated — the comparator must still be total.
  assert.equal(
    profileSignature([profile('A', 'x'), profile('A', 'y')]),
    profileSignature([profile('A', 'x'), profile('A', 'y')]),
  );
});

test('cc-a7: the signature moves when a scope is granted, revoked or renamed', () => {
  const before = profileSignature([profile('DEFAULT', 'video.list')]);
  assert.notEqual(
    before,
    profileSignature([profile('DEFAULT', 'video.list', 'video.publish')]),
  );
  assert.notEqual(before, profileSignature([profile('DEFAULT')]));
  assert.notEqual(before, profileSignature([profile('WORK', 'video.list')]));
  assert.equal(before, profileSignature([profile('DEFAULT', 'video.list')]));
});

test('diffProfiles names what was added, removed and rescoped', () => {
  const diff = diffProfiles(
    [profile('DEFAULT', 'video.list'), profile('OLD', 'video.list')],
    [profile('DEFAULT', 'video.list', 'video.publish'), profile('NEW', 'video.list')],
  );
  assert.deepEqual(diff.added, ['NEW']);
  assert.deepEqual(diff.removed, ['OLD']);
  assert.deepEqual(diff.rescoped, ['DEFAULT']);

  const still = diffProfiles(
    [profile('DEFAULT', 'video.list', 'video.publish')],
    [profile('DEFAULT', 'video.publish', 'video.list')],
  );
  assert.deepEqual(still, { added: [], removed: [], rescoped: [] });
});

// ---------------------------------------------------------------------------
// reading the store
// ---------------------------------------------------------------------------

test('readCredentialProfiles reports every profile with the scopes it holds', async () => {
  const box = await fsSandbox();
  try {
    const envFile = path.join(box.dir, '.env');
    // SPARE exists (a token declares it) but has no scopes recorded — a token
    // minted before `TT_*_SCOPES` was written. It is scopeless, not an error.
    await writeFile(
      envFile,
      `${envFileText('video.list')}TT_PROFILE_WORK_SCOPES=video.publish\n` +
        'TT_PROFILE_SPARE_ACCESS_TOKEN=act.spare\n',
      'utf8',
    );
    const profiles = await readCredentialProfiles({ envFilePath: envFile, env: {} });
    assert.deepEqual(
      profiles.map((entry) => [entry.name, [...entry.scopes]]),
      [
        ['DEFAULT', ['video.list']],
        ['SPARE', []],
        ['WORK', ['video.publish']],
      ],
    );
  } finally {
    await box.cleanup();
  }
});

test('cc-f2: a scope exported in the environment wins over the env file', async () => {
  const box = await fsSandbox();
  try {
    const envFile = path.join(box.dir, '.env');
    await writeFile(envFile, envFileText('video.list'), 'utf8');
    const profiles = await readCredentialProfiles({
      envFilePath: envFile,
      env: { TT_SCOPES: 'video.list,video.publish' },
    });
    assert.deepEqual([...(profiles[0]?.scopes ?? [])], ['video.list', 'video.publish']);
  } finally {
    await box.cleanup();
  }
});

test('readCredentialProfiles falls back to process.env when none is injected', async () => {
  const box = await fsSandbox();
  try {
    const envFile = path.join(box.dir, '.env');
    await writeFile(envFile, envFileText('video.list'), 'utf8');
    await withoutAmbientTtEnv(async () => {
      process.env['TT_SCOPES'] = 'video.publish';
      const profiles = await readCredentialProfiles({ envFilePath: envFile });
      assert.deepEqual([...(profiles[0]?.scopes ?? [])], ['video.publish']);
    });
  } finally {
    await box.cleanup();
  }
});

test('cc-f4: a profile that cannot be read is scopeless, not fatal for the rest', async () => {
  const box = await fsSandbox();
  try {
    const envFile = path.join(box.dir, '.env');
    // A hand-edited expiry that is not ISO-8601 makes `readProfile` throw for
    // WORK alone (CC-H2); DEFAULT must survive it intact.
    await writeFile(
      envFile,
      `${envFileText('video.list')}TT_PROFILE_WORK_TOKEN_EXPIRES_AT=yesterday\n`,
      'utf8',
    );
    const profiles = await readCredentialProfiles({ envFilePath: envFile, env: {} });
    assert.deepEqual(
      profiles.map((entry) => [entry.name, [...entry.scopes]]),
      [
        ['DEFAULT', ['video.list']],
        ['WORK', []],
      ],
    );
  } finally {
    await box.cleanup();
  }
});

test('readCredentialProfiles marks a profile authorized only when it holds a token', async () => {
  const box = await fsSandbox();
  try {
    const envFile = path.join(box.dir, '.env');
    // DEFAULT: an access token only. REFRESHONLY: a refresh token only.
    // SCOPED: scopes recorded but no token at all — listed, never logged in.
    // BROKEN: a token, but an expiry `readProfile` rejects (CC-H2).
    await writeFile(
      envFile,
      `${envFileText('video.list')}` +
        'TT_PROFILE_REFRESHONLY_REFRESH_TOKEN=rft.only\n' +
        'TT_PROFILE_SCOPED_SCOPES=video.publish\n' +
        'TT_PROFILE_BROKEN_ACCESS_TOKEN=act.broken\n' +
        'TT_PROFILE_BROKEN_TOKEN_EXPIRES_AT=yesterday\n',
      'utf8',
    );
    const profiles = await readCredentialProfiles({ envFilePath: envFile, env: {} });
    assert.deepEqual(
      profiles.map((entry) => [entry.name, entry.authorized, [...entry.scopes]]),
      [
        ['BROKEN', false, []],
        ['DEFAULT', true, ['video.list']],
        ['REFRESHONLY', true, []],
        ['SCOPED', false, ['video.publish']],
      ],
    );
  } finally {
    await box.cleanup();
  }
});

test('an env file that does not exist is a store with no scopes', async () => {
  const box = await fsSandbox();
  try {
    const profiles = await readCredentialProfiles({
      envFilePath: path.join(box.dir, 'nothing-here'),
      env: {},
    });
    assert.deepEqual(
      profiles.map((entry) => [entry.name, [...entry.scopes]]),
      [['DEFAULT', []]],
    );
  } finally {
    await box.cleanup();
  }
});

// ---------------------------------------------------------------------------
// the watch
// ---------------------------------------------------------------------------

test('cc-a7: a login that grants a scope is noticed by the tick', async () => {
  const f = await fixture();
  try {
    await writeFile(f.envFile, envFileText('video.list'), 'utf8');
    const watch = startCredentialWatch({
      envFilePath: f.envFile,
      clock: f.clock,
      logger: f.logger,
      env: {},
      onChange: (change) => {
        f.changes.push(change);
      },
    });

    assert.equal(await watch.poll(), false, 'the seeding poll must not notify');

    // What `login` does: same file, one more scope.
    await writeFile(
      f.envFile,
      envFileText('video.list,video.publish', 'act.second'),
      'utf8',
    );
    await f.clock.advance(DEFAULT_WATCH_INTERVAL_MS);
    await settle(() => f.changes.length === 1, 'the tick must report the new scope');

    const change = f.changes[0];
    assert.deepEqual(change?.rescoped, ['DEFAULT']);
    assert.deepEqual(change?.added, []);
    assert.deepEqual(change?.removed, []);
    assert.deepEqual([...(change?.previous[0]?.scopes ?? [])], ['video.list']);
    assert.deepEqual(
      [...(change?.profiles[0]?.scopes ?? [])],
      ['video.list', 'video.publish'],
    );

    const announced = atLevel(f.records, 'info')[0];
    assert.equal(announced?.msg.includes('rescoped [DEFAULT]'), true);
    assert.deepEqual(announced?.fields, { env_file: f.envFile, count: 1 });

    await watch.stop();
    assert.equal(f.clock.pending(), 0, 'the watch must leave no timer behind');
  } finally {
    await f.cleanup();
  }
});

test('cc-a7: a token refresh that leaves the scopes alone never notifies', async () => {
  const f = await fixture();
  try {
    await writeFile(f.envFile, envFileText('video.list,video.publish'), 'utf8');
    const watch = startCredentialWatch({
      envFilePath: f.envFile,
      clock: f.clock,
      logger: f.logger,
      env: {},
      onChange: (change) => {
        f.changes.push(change);
      },
    });
    await watch.poll();

    // A refresh rewrites the token and the expiry, and reorders nothing else.
    for (const token of ['act.second', 'act.third']) {
      await writeFile(
        f.envFile,
        `${envFileText('video.publish,video.list', token)}TT_TOKEN_EXPIRES_AT=2026-02-01T00:00:00.000Z\n`,
        'utf8',
      );
      assert.equal(await watch.poll(), false, `${token} must not look like a change`);
    }

    assert.deepEqual(f.changes, []);
    assert.deepEqual(atLevel(f.records, 'info'), []);
    await watch.stop();
  } finally {
    await f.cleanup();
  }
});

test('a profile that appears or disappears is a change, and the diff names it', async () => {
  const f = await fixture();
  try {
    await writeFile(f.envFile, envFileText('video.list'), 'utf8');
    const watch = startCredentialWatch({
      envFilePath: f.envFile,
      clock: f.clock,
      logger: f.logger,
      env: {},
      onChange: (change) => {
        f.changes.push(change);
      },
    });
    await watch.poll();

    await writeFile(
      f.envFile,
      `${envFileText('video.list')}TT_PROFILE_WORK_SCOPES=video.publish\n`,
      'utf8',
    );
    assert.equal(await watch.poll(), true);
    assert.deepEqual(f.changes[0]?.added, ['WORK']);

    await writeFile(f.envFile, envFileText('video.list'), 'utf8');
    assert.equal(await watch.poll(), true);
    assert.deepEqual(f.changes[1]?.removed, ['WORK']);

    await watch.stop();
  } finally {
    await f.cleanup();
  }
});

test('the first poll seeds the baseline instead of notifying', async () => {
  const clock = mockClock();
  const changes: CredentialChange[] = [];
  const watch = startCredentialWatch({
    envFilePath: '/nonexistent/.env',
    clock,
    profiles: () => Promise.resolve([profile('DEFAULT', 'video.publish')]),
    onChange: (change) => {
      changes.push(change);
    },
  });
  // Two ticks over an unchanging store: the first is the baseline, the second
  // has nothing to say. Neither may notify a client of a tool list it was
  // handed a moment ago.
  await clock.advance(DEFAULT_WATCH_INTERVAL_MS);
  await clock.advance(DEFAULT_WATCH_INTERVAL_MS);
  assert.deepEqual(changes, []);
  await watch.stop();
  assert.equal(clock.pending(), 0);
});

test('a caller-supplied baseline lets the very first poll notify', async () => {
  const clock = mockClock();
  const changes: CredentialChange[] = [];
  const watch = startCredentialWatch({
    envFilePath: '/nonexistent/.env',
    clock,
    baseline: [profile('DEFAULT', 'video.list')],
    profiles: () => Promise.resolve([profile('DEFAULT', 'video.list', 'video.publish')]),
    onChange: (change) => {
      changes.push(change);
    },
  });
  assert.equal(await watch.poll(), true);
  assert.deepEqual(changes[0]?.rescoped, ['DEFAULT']);
  assert.deepEqual([...(changes[0]?.previous[0]?.scopes ?? [])], ['video.list']);
  await watch.stop();
});

test('concurrent polls share one read, so a change is reported once', async () => {
  const clock = mockClock();
  const gate = deferred<readonly ProfileInfo[]>();
  const changes: CredentialChange[] = [];
  let reads = 0;
  const watch = startCredentialWatch({
    envFilePath: '/nonexistent/.env',
    clock,
    baseline: [],
    profiles: () => {
      reads += 1;
      return gate.promise;
    },
    onChange: (change) => {
      changes.push(change);
    },
  });

  const first = watch.poll();
  const second = watch.poll();
  await flush();
  assert.equal(reads, 1, 'the second caller must join the read already in flight');

  gate.resolve([profile('DEFAULT', 'video.publish')]);
  assert.deepEqual([await first, await second], [true, true]);
  assert.equal(changes.length, 1);

  await watch.stop();
  assert.equal(clock.pending(), 0);
});

test('cc-h4: the watch stops and leaves nothing pending or scheduled', async () => {
  const clock = mockClock();
  let reads = 0;
  const watch = startCredentialWatch({
    envFilePath: '/nonexistent/.env',
    clock,
    profiles: () => {
      reads += 1;
      return Promise.resolve([]);
    },
    onChange: () => undefined,
  });
  assert.equal(clock.pending(), 1, 'the loop must be waiting on the injected clock');

  await clock.advance(DEFAULT_WATCH_INTERVAL_MS);
  assert.equal(reads, 1);

  await watch.stop();
  assert.equal(clock.pending(), 0, 'stop must cancel the pending sleep');

  await clock.advance(DEFAULT_WATCH_INTERVAL_MS * 10);
  assert.equal(reads, 1, 'a stopped watch must never read again');
  await watch.stop(); // idempotent
});

test('stop waits for a poll already in flight', async () => {
  const clock = mockClock();
  const gate = deferred<readonly ProfileInfo[]>();
  const changes: CredentialChange[] = [];
  const watch = startCredentialWatch({
    envFilePath: '/nonexistent/.env',
    clock,
    baseline: [],
    profiles: () => gate.promise,
    onChange: (change) => {
      changes.push(change);
    },
  });

  await clock.advance(DEFAULT_WATCH_INTERVAL_MS);
  let stopped = false;
  const stopping = watch.stop().then(() => {
    stopped = true;
  });
  await flush(2);
  assert.equal(stopped, false, 'stop must not resolve while a read is outstanding');

  gate.resolve([profile('DEFAULT', 'video.publish')]);
  await stopping;
  assert.equal(changes.length, 1, 'the in-flight poll still finishes what it started');
  assert.equal(clock.pending(), 0);
});

test('cc-h3: a store that cannot be parsed degrades to no profiles and warns once', async () => {
  const f = await fixture();
  try {
    await writeFile(f.envFile, 'this line is not an assignment\n', 'utf8');
    const watch = startCredentialWatch({
      envFilePath: f.envFile,
      clock: f.clock,
      logger: f.logger,
      env: {},
      baseline: [profile('DEFAULT', 'video.publish')],
      onChange: (change) => {
        f.changes.push(change);
      },
    });

    assert.equal(await watch.poll(), true);
    assert.deepEqual(f.changes[0]?.removed, ['DEFAULT']);
    assert.deepEqual(f.changes[0]?.profiles, []);

    const warned = atLevel(f.records, 'warn');
    assert.equal(warned.length, 1);
    assert.equal(warned[0]?.fields?.['code'], 'env_file_malformed');
    assert.equal(warned[0]?.fields?.['env_file'], f.envFile);
    assert.equal(typeof warned[0]?.fields?.['reason'], 'string');

    // Still broken on the next tick: the transition is the news, the repetition
    // is noise, and nothing changed so nobody is notified again.
    assert.equal(await watch.poll(), false);
    assert.equal(atLevel(f.records, 'warn').length, 1, 'the warning must not repeat');
    assert.equal(atLevel(f.records, 'debug').length, 1);
    assert.equal(f.changes.length, 1);

    await watch.stop();
  } finally {
    await f.cleanup();
  }
});

test('cc-h3: a reader that throws a non-Error degrades, and recovery re-arms the warning', async () => {
  const clock = mockClock();
  const { logger, records } = recordingLogger();
  let scopes: string[] | undefined;
  // Typed `unknown` because that is how it arrives: a reader is caller-supplied
  // code and nothing promises it rejects with an `Error`.
  const explosion: unknown = 'the reader exploded';
  const watch = startCredentialWatch({
    envFilePath: '/nonexistent/.env',
    clock,
    logger,
    baseline: [],
    profiles: () => {
      if (scopes === undefined) throw explosion;
      return Promise.resolve([profile('DEFAULT', ...scopes)]);
    },
    onChange: () => undefined,
  });

  assert.equal(await watch.poll(), false, 'no profiles is still no profiles');
  const first = atLevel(records, 'warn')[0];
  assert.equal(first?.fields?.['code'], 'credential_store_unreadable');
  assert.equal(first?.fields?.['reason'], 'the reader exploded');

  scopes = ['video.publish'];
  assert.equal(await watch.poll(), true, 'a store that comes back is a change');

  scopes = undefined;
  assert.equal(await watch.poll(), true, 'losing the store is a change too');
  assert.equal(
    atLevel(records, 'warn').length,
    2,
    'a failure after a healthy read is news again',
  );

  await watch.stop();
});

test('cc-a7: a failing onChange is logged, and the next change still notifies', async () => {
  const clock = mockClock();
  const { logger, records } = recordingLogger();
  let scopes = ['video.list'];
  let calls = 0;
  const watch = startCredentialWatch({
    envFilePath: '/nonexistent/.env',
    clock,
    logger,
    baseline: [profile('DEFAULT')],
    profiles: () => Promise.resolve([profile('DEFAULT', ...scopes)]),
    onChange: () => {
      calls += 1;
      // What `notifyListChanged()` does on a transport that just went away.
      return Promise.reject(new Error('Not connected'));
    },
  });

  assert.equal(await watch.poll(), true);
  assert.equal(calls, 1);
  const warned = atLevel(records, 'warn')[0];
  assert.equal(warned?.msg.includes('tools/list_changed'), true);
  assert.equal(warned?.fields?.['reason'], 'Not connected');

  // The baseline advanced despite the failure: the same picture is not retried…
  assert.equal(await watch.poll(), false);
  assert.equal(calls, 1);
  // …but the next real change is still reported.
  scopes = ['video.list', 'video.publish'];
  assert.equal(await watch.poll(), true);
  assert.equal(calls, 2);

  await watch.stop();
});

test('an unusable interval falls back to the default with a warning', async () => {
  for (const bad of [MIN_WATCH_INTERVAL_MS - 1, Number.NaN, 2_147_483_648]) {
    const clock = mockClock();
    const { logger, records } = recordingLogger();
    let reads = 0;
    const watch = startCredentialWatch({
      envFilePath: '/nonexistent/.env',
      clock,
      logger,
      intervalMs: bad,
      profiles: () => {
        reads += 1;
        return Promise.resolve([]);
      },
      onChange: () => undefined,
    });

    const warned = atLevel(records, 'warn')[0];
    assert.equal(
      warned?.fields?.['code'],
      'invalid_watch_interval',
      `${String(bad)} must be rejected`,
    );

    await clock.advance(DEFAULT_WATCH_INTERVAL_MS - 1);
    assert.equal(reads, 0, `${String(bad)} must not shorten the poll period`);
    await clock.advance(1);
    assert.equal(reads, 1);

    await watch.stop();
    assert.equal(clock.pending(), 0);
  }
});

test('a custom interval is honoured exactly', async () => {
  const clock = mockClock();
  let reads = 0;
  const watch = startCredentialWatch({
    envFilePath: '/nonexistent/.env',
    clock,
    intervalMs: MIN_WATCH_INTERVAL_MS,
    profiles: () => {
      reads += 1;
      return Promise.resolve([]);
    },
    onChange: () => undefined,
  });

  await clock.advance(MIN_WATCH_INTERVAL_MS - 1);
  assert.equal(reads, 0);
  await clock.advance(1);
  assert.equal(reads, 1);
  await clock.advance(MIN_WATCH_INTERVAL_MS);
  assert.equal(reads, 2, 'the loop must re-arm after every poll');

  await watch.stop();
  assert.equal(clock.pending(), 0);
});

test('stop() waits for a manual poll already in flight, and a poll after stop is a no-op', async () => {
  const clock = mockClock();
  const gate = deferred<readonly ProfileInfo[]>();
  let reads = 0;
  const changes: unknown[] = [];
  const watch = startCredentialWatch({
    envFilePath: '/nonexistent/.env',
    clock,
    baseline: [],
    profiles: () => {
      reads += 1;
      return gate.promise;
    },
    onChange: (change) => {
      changes.push(change);
    },
  });

  const polling = watch.poll();
  let stopped = false;
  const stopping = watch.stop().then(() => {
    stopped = true;
  });
  await flush();
  // The read is still out, so stop() cannot have returned yet.
  assert.equal(stopped, false);

  gate.resolve([{ name: 'DEFAULT', scopes: ['video.list'], authorized: true }]);
  await stopping;
  // The poll that was already running finished its work, notification included.
  assert.equal(await polling, true);
  assert.equal(changes.length, 1);

  // After stop nothing reads the store and nothing notifies.
  assert.equal(await watch.poll(), false);
  assert.equal(reads, 1);
  assert.equal(changes.length, 1);
});

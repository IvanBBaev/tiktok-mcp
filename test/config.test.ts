import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CONFIG_SCHEMA_VERSION,
  envKeyFor,
  listProfiles,
  normalizeProfileName,
  persistProfilePatch,
  readEnvFile,
  readProfile,
  resolveEnvFilePath,
  type EnvFileSnapshot,
} from '../src/core/config.js';
import { isTikTokError, TikTokError } from '../src/core/errors.js';
import type { Logger } from '../src/core/log.js';
import { BASELINE_NOW_MS, fsSandbox, mockClock, type MockClock } from './helpers.js';

// ---------------------------------------------------------------------------
// local fixtures
// ---------------------------------------------------------------------------

/** POSIX mode bits are meaningless on win32 (CC-F3), so those asserts are skipped by name. */
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

/** Only `values` matters to `readProfile`/`listProfiles`; the document is irrelevant there. */
function snapshotOf(values: Record<string, string> = {}): EnvFileSnapshot {
  return {
    path: path.join(path.sep, 'nowhere', '.env'),
    exists: false,
    values: new Map(Object.entries(values)),
    schema: CONFIG_SCHEMA_VERSION,
    warnings: [],
    lines: [],
    eol: '\n',
  };
}

/**
 * Run a promise to completion under virtual time: fire any pending `sleep` one
 * virtual millisecond at a time (so the retry delays stay observable through
 * `clock.now()`), and otherwise just give the event loop a turn for real I/O.
 * Nothing here waits on wall-clock time (CC-H4).
 */
async function settle<T>(promise: Promise<T>, clock: MockClock): Promise<T> {
  let done = false;
  const tracked = promise.then(
    (value) => {
      done = true;
      return value;
    },
    (err: unknown) => {
      done = true;
      throw err;
    },
  );
  for (let turn = 0; turn < 20_000 && !done; turn += 1) {
    if (clock.pending() > 0) await clock.advance(1);
    else await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return tracked;
}

async function withSandbox(fn: (dir: string) => Promise<void>): Promise<void> {
  const sandbox = await fsSandbox();
  try {
    await fn(sandbox.dir);
  } finally {
    await sandbox.cleanup();
  }
}

function errnoError(code: string): Error {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

async function rejects(fn: () => Promise<unknown>): Promise<TikTokError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(isTikTokError(err), `expected a TikTokError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected the call to reject');
}

function throws(fn: () => unknown): TikTokError {
  try {
    fn();
  } catch (err) {
    assert.ok(isTikTokError(err), `expected a TikTokError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected the call to throw');
}

// ---------------------------------------------------------------------------
// location (TESTING.md § core/config — "platform injected")
// ---------------------------------------------------------------------------

test('TT_ENV_FILE wins over every platform default and is made absolute', () => {
  assert.equal(
    resolveEnvFilePath({ TT_ENV_FILE: '/etc/tt/.env' }, 'linux'),
    '/etc/tt/.env',
  );
  assert.equal(
    resolveEnvFilePath({ TT_ENV_FILE: '~/tt.env' }, 'darwin'),
    path.resolve(homedir(), 'tt.env'),
  );
  assert.equal(
    resolveEnvFilePath({ TT_ENV_FILE: ' relative/.env ' }, 'linux'),
    path.resolve('relative/.env'),
  );
  // Absent and empty both fall through to the platform default.
  assert.notEqual(resolveEnvFilePath({ TT_ENV_FILE: '' }, 'linux'), '');
});

test('on POSIX the file lives under $XDG_CONFIG_HOME, a relative value ignored', () => {
  assert.equal(
    resolveEnvFilePath({ XDG_CONFIG_HOME: '/xdg' }, 'linux'),
    path.join('/xdg', 'tiktok-mcp-ai', '.env'),
  );
  const fallback = path.join(homedir(), '.config', 'tiktok-mcp-ai', '.env');
  assert.equal(resolveEnvFilePath({}, 'linux'), fallback);
  // The XDG basedir spec says a relative $XDG_CONFIG_HOME must be ignored.
  assert.equal(resolveEnvFilePath({ XDG_CONFIG_HOME: 'relative' }, 'darwin'), fallback);
});

test('on win32 the file lives under %LOCALAPPDATA% — tokens must not roam', () => {
  assert.equal(
    resolveEnvFilePath({ LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' }, 'win32'),
    path.join('C:\\Users\\t\\AppData\\Local', 'tiktok-mcp-ai', '.env'),
  );
  assert.equal(
    resolveEnvFilePath({ APPDATA: 'C:\\roaming' }, 'win32'),
    path.join(homedir(), 'AppData', 'Local', 'tiktok-mcp-ai', '.env'),
  );
});

// ---------------------------------------------------------------------------
// CC-F1 — parsing
// ---------------------------------------------------------------------------

test('cc-f1 a missing env file is not an error — the process env may carry everything', async () => {
  await withSandbox(async (dir) => {
    const snapshot = await readEnvFile(path.join(dir, 'absent', '.env'));
    assert.equal(snapshot.exists, false);
    assert.equal(snapshot.values.size, 0);
    assert.equal(snapshot.schema, CONFIG_SCHEMA_VERSION);
    assert.deepEqual(snapshot.warnings, []);
    assert.equal(snapshot.mode, undefined);
  });
});

test('cc-f1 an unreadable env file is an error, not silence', canDenyAccess, async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    await writeFile(file, 'TT_CLIENT_KEY=abc\n', { mode: 0o600 });
    await chmod(file, 0o000);
    const err = await rejects(() => readEnvFile(file));
    assert.equal(err.kind, 'config');
    assert.equal(err.code, 'env_file_unreadable');
    assert.match(err.message, /EACCES/);
    assert.match(err.remediation ?? '', /0600/);
    await chmod(file, 0o600); // so the sandbox can be removed
  });
});

test('cc-f1 comments, blank lines and the export prefix all parse', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    await writeFile(
      file,
      [
        '# a comment',
        '',
        '   ',
        'TT_CLIENT_KEY=abc',
        'export TT_CLIENT_SECRET=shh',
        '',
      ].join('\n'),
    );
    const snapshot = await readEnvFile(file);
    assert.equal(snapshot.exists, true);
    assert.equal(snapshot.values.get('TT_CLIENT_KEY'), 'abc');
    assert.equal(snapshot.values.get('TT_CLIENT_SECRET'), 'shh');
    assert.deepEqual(snapshot.warnings, []);
    assert.equal(snapshot.lines.filter((line) => line.key !== undefined).length, 2);
    assert.equal(
      snapshot.lines.find((line) => line.key === 'TT_CLIENT_SECRET')?.prefix,
      'export ',
    );
  });
});

test('cc-f1 a malformed line is rejected and named by its line number', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    await writeFile(
      file,
      ['# fine', 'TT_CLIENT_KEY=abc', 'this is not an assignment', ''].join('\n'),
    );
    const err = await rejects(() => readEnvFile(file));
    assert.equal(err.code, 'env_file_malformed');
    assert.match(err.message, /line 3 is not a comment/);
  });
});

test('cc-f1 a duplicate key resolves last-wins and is reported as a warning', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    await writeFile(file, 'TT_ACCESS_TOKEN=first\nTT_ACCESS_TOKEN=second\n');
    const snapshot = await readEnvFile(file);
    assert.equal(snapshot.values.get('TT_ACCESS_TOKEN'), 'second');
    assert.equal(snapshot.warnings.length, 1);
    assert.match(
      snapshot.warnings[0] ?? '',
      /duplicate keys, last occurrence wins: TT_ACCESS_TOKEN/,
    );
  });
});

test('cc-f1 an unknown TT_ key warns once and is never dropped', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    await writeFile(file, 'TT_FROM_THE_FUTURE=1\nTT_FROM_THE_FUTURE=2\nNOT_OURS=x\n');
    const snapshot = await readEnvFile(file);
    // One duplicate warning plus one unknown-key warning, each listing the key once.
    assert.equal(snapshot.warnings.length, 2);
    assert.match(
      snapshot.warnings.join('\n'),
      /unknown TT_ keys ignored \(kept on rewrite\): TT_FROM_THE_FUTURE/,
    );
    assert.equal(
      snapshot.values.get('NOT_OURS'),
      'x',
      'a non-TT_ key is neither warned about nor dropped',
    );
  });
});

test('cc-f1 quotes are stripped once and a # is part of the value', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    await writeFile(
      file,
      [
        'TT_ACCESS_TOKEN="act.abc#def"',
        "TT_REFRESH_TOKEN='rft.xyz'",
        'TT_OPEN_ID=  padded  ',
        'TT_SCOPES=""',
      ].join('\n'),
    );
    const snapshot = await readEnvFile(file);
    assert.equal(snapshot.values.get('TT_ACCESS_TOKEN'), 'act.abc#def');
    assert.equal(snapshot.values.get('TT_REFRESH_TOKEN'), 'rft.xyz');
    assert.equal(snapshot.values.get('TT_OPEN_ID'), 'padded');
    assert.equal(snapshot.values.get('TT_SCOPES'), '');
  });
});

test('cc-f1 mixed line endings are recorded per line and the dominant one wins', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    await writeFile(
      file,
      'TT_CLIENT_KEY=abc\r\nTT_CLIENT_SECRET=shh\r\nTT_ACCESS_TOKEN=t',
    );
    const snapshot = await readEnvFile(file);
    assert.equal(snapshot.eol, '\r\n');
    assert.deepEqual(
      snapshot.lines.map((line) => line.eol),
      ['\r\n', '\r\n', ''],
    );

    const lf = path.join(dir, 'lf.env');
    await writeFile(lf, 'TT_CLIENT_KEY=abc\nTT_CLIENT_SECRET=shh\n');
    assert.equal((await readEnvFile(lf)).eol, '\n');
  });
});

test('cc-f1 a non-numeric TT_CONFIG_SCHEMA warns and reads as the current version', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    await writeFile(file, 'TT_CONFIG_SCHEMA=one\n');
    const snapshot = await readEnvFile(file);
    assert.equal(snapshot.declaredSchema, undefined);
    assert.equal(snapshot.schema, CONFIG_SCHEMA_VERSION);
    assert.match(snapshot.warnings.join('\n'), /TT_CONFIG_SCHEMA is not a number/);

    const declared = path.join(dir, 'v2.env');
    await writeFile(declared, 'TT_CONFIG_SCHEMA=2\n');
    const future = await readEnvFile(declared);
    assert.equal(future.declaredSchema, 2);
    assert.equal(future.schema, 2);
  });
});

// ---------------------------------------------------------------------------
// CC-F4 — profiles
// ---------------------------------------------------------------------------

test('cc-f4 a profile name is upper-cased and shape-checked', () => {
  assert.equal(normalizeProfileName('work'), 'WORK');
  assert.equal(normalizeProfileName(' alt_2 '), 'ALT_2');
  const err = throws(() => normalizeProfileName('my-account'));
  assert.equal(err.code, 'invalid_profile_name');
  assert.match(err.message, /\[A-Z0-9_\]\+/);
  assert.equal(throws(() => normalizeProfileName('')).code, 'invalid_profile_name');
});

test('cc-f4 the per-profile keys are exactly the token sextet — the app keys are global', () => {
  assert.equal(envKeyFor('DEFAULT', 'accessToken'), 'TT_ACCESS_TOKEN');
  assert.equal(envKeyFor('WORK', 'accessToken'), 'TT_PROFILE_WORK_ACCESS_TOKEN');
  assert.equal(envKeyFor('WORK', 'accessExpiresAt'), 'TT_PROFILE_WORK_TOKEN_EXPIRES_AT');
  assert.equal(
    envKeyFor('WORK', 'refreshExpiresAt'),
    'TT_PROFILE_WORK_REFRESH_EXPIRES_AT',
  );
  assert.equal(envKeyFor('WORK', 'openId'), 'TT_PROFILE_WORK_OPEN_ID');
  assert.equal(envKeyFor('WORK', 'scopes'), 'TT_PROFILE_WORK_SCOPES');
  assert.equal(envKeyFor('WORK', 'clientKey'), 'TT_CLIENT_KEY');
  assert.equal(envKeyFor('WORK', 'clientSecret'), 'TT_CLIENT_SECRET');
});

test('cc-f4 listProfiles unions the file and the process env, DEFAULT always present', () => {
  const snapshot = snapshotOf({
    TT_ACCESS_TOKEN: 't',
    TT_PROFILE_WORK_ACCESS_TOKEN: 'w',
    TT_PROFILE_alt_OPEN_ID: 'a',
  });
  assert.deepEqual(listProfiles(snapshot, { TT_PROFILE_PHONE_REFRESH_TOKEN: 'p' }), [
    'ALT',
    'DEFAULT',
    'PHONE',
    'WORK',
  ]);
  assert.deepEqual(listProfiles(snapshotOf(), {}), ['DEFAULT']);
});

test('cc-f4 a profile literally named DEFAULT is rejected, not silently merged', () => {
  const err = throws(() =>
    listProfiles(snapshotOf({ TT_PROFILE_DEFAULT_ACCESS_TOKEN: 'x' }), {}),
  );
  assert.equal(err.code, 'invalid_profile_name');
  assert.match(err.message, /collides with the implicit default profile/);
});

test('cc-f4 an unknown profile names the profiles that do exist', () => {
  const snapshot = snapshotOf({ TT_PROFILE_WORK_ACCESS_TOKEN: 'w' });
  const err = throws(() => readProfile('phone', snapshot, {}));
  assert.equal(err.code, 'unknown_profile');
  assert.match(err.message, /unknown profile PHONE; profiles that exist: DEFAULT, WORK/);
  assert.match(err.remediation ?? '', /account=PHONE/);
});

test('a profile with no app credentials is a config error naming both keys', () => {
  const err = throws(() =>
    readProfile('DEFAULT', snapshotOf({ TT_ACCESS_TOKEN: 't' }), {}),
  );
  assert.equal(err.code, 'missing_credentials');
  assert.match(err.message, /TT_CLIENT_KEY, TT_CLIENT_SECRET/);
  assert.match(err.remediation ?? '', /developers\.tiktok\.com/);
});

test('cc-f2 the process env overlays the file per key, presence-based', () => {
  const snapshot = snapshotOf({
    TT_CLIENT_KEY: 'file-key',
    TT_CLIENT_SECRET: 'file-secret',
    TT_ACCESS_TOKEN: 'file-access',
    TT_REFRESH_TOKEN: 'file-refresh',
  });
  const creds = readProfile('DEFAULT', snapshot, {
    TT_ACCESS_TOKEN: 'env-access',
    TT_REFRESH_TOKEN: '', // exported empty: deliberate, and there is no empty token
  });
  assert.equal(creds.clientKey, 'file-key', 'a key only in the file still resolves');
  assert.equal(creds.accessToken, 'env-access');
  assert.equal(creds.refreshToken, undefined);
});

test('a profile reads its own sextet and nothing from another profile', () => {
  const snapshot = snapshotOf({
    TT_CLIENT_KEY: 'k',
    TT_CLIENT_SECRET: 's',
    TT_ACCESS_TOKEN: 'default-access',
    TT_PROFILE_WORK_ACCESS_TOKEN: 'work-access',
    TT_PROFILE_WORK_SCOPES: 'video.list, video.upload ,',
    TT_PROFILE_WORK_OPEN_ID: 'work-open-id',
  });
  const work = readProfile('work', snapshot, {});
  assert.equal(work.accessToken, 'work-access');
  assert.equal(work.openId, 'work-open-id');
  assert.deepEqual(work.scopes, ['video.list', 'video.upload']);
  assert.equal(work.refreshToken, undefined);
  assert.equal(readProfile('DEFAULT', snapshot, {}).accessToken, 'default-access');
});

test('cc-h2 an expiry that is not a parseable timestamp is rejected on read', () => {
  const base = { TT_CLIENT_KEY: 'k', TT_CLIENT_SECRET: 's' };
  const good = readProfile(
    'DEFAULT',
    snapshotOf({ ...base, TT_TOKEN_EXPIRES_AT: '2026-01-02T00:00:00.000Z' }),
    {},
  );
  assert.equal(good.accessExpiresAt, '2026-01-02T00:00:00.000Z');

  const err = throws(() =>
    readProfile(
      'DEFAULT',
      snapshotOf({ ...base, TT_REFRESH_EXPIRES_AT: 'tomorrow' }),
      {},
    ),
  );
  assert.equal(err.code, 'invalid_timestamp');
  assert.match(err.message, /TT_REFRESH_EXPIRES_AT: expected an ISO-8601 UTC timestamp/);
});

// ---------------------------------------------------------------------------
// writing (CONFIGURATION.md § Writes, CC-F3, CC-H3)
// ---------------------------------------------------------------------------

test(
  'cc-f3 a new env file is created 0600 inside a 0700 directory',
  posixOnly,
  async () => {
    await withSandbox(async (dir) => {
      const file = path.join(dir, 'nested', '.env');
      const { logger, records } = recordingLogger();
      const result = await persistProfilePatch(
        file,
        'DEFAULT',
        { accessToken: 'act.new' },
        { logger },
      );

      assert.deepEqual(result, { persisted: true });
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
      assert.deepEqual(records, [], 'a successful write is silent');
      assert.equal(
        await readFile(file, 'utf8'),
        'TT_ACCESS_TOKEN=act.new\nTT_CONFIG_SCHEMA=1\n',
      );
      assert.equal((await readEnvFile(file)).mode, 0o600);
    });
  },
);

test('a rewrite preserves comments, unknown keys and the export prefix byte-for-byte', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    const before = [
      '# my tiktok config',
      '',
      'TT_CLIENT_KEY=abc',
      'export TT_REFRESH_TOKEN=old-refresh',
      'TT_ACCESS_TOKEN=old-access',
      '# a key this build does not know',
      'TT_FROM_THE_FUTURE=keep-me',
      'TT_CONFIG_SCHEMA=1',
      '',
    ].join('\n');
    await writeFile(file, before);

    await persistProfilePatch(file, 'DEFAULT', {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    });

    assert.equal(
      await readFile(file, 'utf8'),
      before.replace('old-access', 'new-access').replace('old-refresh', 'new-refresh'),
    );
  });
});

test('a rewritten key keeps only its last occurrence — no stale secret lingers', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    await writeFile(file, 'TT_ACCESS_TOKEN=first\n# between\nTT_ACCESS_TOKEN=second\n');
    await persistProfilePatch(file, 'DEFAULT', { accessToken: 'third' });
    assert.equal(
      await readFile(file, 'utf8'),
      '# between\nTT_ACCESS_TOKEN=third\nTT_CONFIG_SCHEMA=1\n',
    );
  });
});

test('an appended key terminates the previous last line and adopts the file’s eol', async () => {
  await withSandbox(async (dir) => {
    const crlf = path.join(dir, 'crlf.env');
    await writeFile(crlf, 'TT_CLIENT_KEY=abc\r\nTT_CLIENT_SECRET=shh');
    await persistProfilePatch(crlf, 'WORK', { accessToken: 'w' });
    assert.equal(
      await readFile(crlf, 'utf8'),
      'TT_CLIENT_KEY=abc\r\nTT_CLIENT_SECRET=shh\r\nTT_PROFILE_WORK_ACCESS_TOKEN=w\r\nTT_CONFIG_SCHEMA=1\r\n',
    );
  });
});

test('a value that needs quoting round-trips through a rewrite', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    await persistProfilePatch(file, 'DEFAULT', {
      openId: ' padded ',
      accessToken: '"already-quoted"',
      scopes: ['video.list', 'video.upload'],
    });
    const snapshot = await readEnvFile(file);
    assert.equal(snapshot.values.get('TT_OPEN_ID'), ' padded ');
    assert.equal(snapshot.values.get('TT_ACCESS_TOKEN'), '"already-quoted"');
    assert.equal(snapshot.values.get('TT_SCOPES'), 'video.list,video.upload');
  });
});

test('a value containing a line break is refused before anything is written', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    const err = await rejects(() =>
      persistProfilePatch(file, 'DEFAULT', {
        accessToken: 'act\nTT_CLIENT_SECRET=stolen',
      }),
    );
    assert.equal(err.kind, 'internal');
    assert.equal(err.code, 'invalid_env_value');
    await assert.rejects(() => stat(file), /ENOENT/, 'nothing may have been written');
  });
});

test('an empty patch is a no-op and does not create the file', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    assert.deepEqual(await persistProfilePatch(file, 'DEFAULT', {}), { persisted: true });
    await assert.rejects(() => stat(file), /ENOENT/);
  });
});

test('only the fields present in the patch are written — a patch never deletes', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    await writeFile(file, 'TT_ACCESS_TOKEN=a\nTT_REFRESH_TOKEN=r\nTT_OPEN_ID=o\n');
    await persistProfilePatch(file, 'DEFAULT', { accessToken: 'a2' });
    const snapshot = await readEnvFile(file);
    assert.equal(snapshot.values.get('TT_ACCESS_TOKEN'), 'a2');
    assert.equal(snapshot.values.get('TT_REFRESH_TOKEN'), 'r');
    assert.equal(snapshot.values.get('TT_OPEN_ID'), 'o');
  });
});

test('the app credentials can be persisted too, under their global names', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    await persistProfilePatch(file, 'WORK', { clientKey: 'ck', clientSecret: 'cs' });
    const snapshot = await readEnvFile(file);
    assert.equal(snapshot.values.get('TT_CLIENT_KEY'), 'ck');
    assert.equal(snapshot.values.get('TT_CLIENT_SECRET'), 'cs');
  });
});

test('a patch for an invalid profile name is refused before any I/O', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    const err = await rejects(() =>
      persistProfilePatch(file, 'bad-name', { accessToken: 't' }),
    );
    assert.equal(err.code, 'invalid_profile_name');
    await assert.rejects(() => stat(file), /ENOENT/);
  });
});

// ---------------------------------------------------------------------------
// schema versioning
// ---------------------------------------------------------------------------

test('a schema marker from the future is a refusal to write, not a silent failure', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    const before = 'TT_CONFIG_SCHEMA=99\nTT_ACCESS_TOKEN=keep\n';
    await writeFile(file, before);
    const err = await rejects(() =>
      persistProfilePatch(file, 'DEFAULT', { accessToken: 'new' }),
    );
    assert.equal(err.code, 'config_schema_too_new');
    assert.match(err.message, /refusing to write/);
    assert.match(err.remediation ?? '', /tiktok-mcp-ai@latest/);
    assert.equal(await readFile(file, 'utf8'), before, 'the file is untouched');
  });
});

test('the first save that moves the schema marker keeps one pre-upgrade copy', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    const before = 'TT_CONFIG_SCHEMA=0\nTT_ACCESS_TOKEN=old\n';
    await writeFile(file, before, { mode: 0o600 });

    await persistProfilePatch(file, 'DEFAULT', { accessToken: 'new' });
    assert.equal(await readFile(`${file}.pre-schema0`, 'utf8'), before);
    assert.equal((await readEnvFile(file)).declaredSchema, CONFIG_SCHEMA_VERSION);

    // The marker has moved, so a second save keeps no further copies.
    await persistProfilePatch(file, 'DEFAULT', { accessToken: 'newer' });
    await assert.rejects(() => stat(`${file}.pre-schema1`), /ENOENT/);
  });
});

test('an existing pre-upgrade copy is never overwritten', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    await writeFile(file, 'TT_CONFIG_SCHEMA=0\nTT_ACCESS_TOKEN=old\n');
    await writeFile(`${file}.pre-schema0`, 'the original\n');

    const { logger, records } = recordingLogger();
    const result = await persistProfilePatch(
      file,
      'DEFAULT',
      { accessToken: 'new' },
      { logger },
    );

    assert.deepEqual(result, { persisted: true });
    assert.equal(await readFile(`${file}.pre-schema0`, 'utf8'), 'the original\n');
    assert.deepEqual(
      records,
      [],
      'an existing copy is expected, not a problem worth warning about',
    );
  });
});

// ---------------------------------------------------------------------------
// CC-H3 — a failed write never fails a tool call
// ---------------------------------------------------------------------------

/**
 * Advisory on every leg (TESTING.md § CI legs): the `rename` failure is injected
 * rather than provoked, so this asserts the ladder's shape, not the OS behaviour
 * that motivates it.
 */
test('cc-h3 advisory — a held file is retried three times, then the write degrades', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    const clock = mockClock();
    const { logger, records } = recordingLogger();
    const attempts: number[] = [];

    const result = await settle(
      persistProfilePatch(
        file,
        'DEFAULT',
        { accessToken: 'act.new' },
        {
          clock,
          logger,
          rename: () => {
            attempts.push(clock.now() - BASELINE_NOW_MS);
            return Promise.reject(errnoError('EPERM'));
          },
        },
      ),
      clock,
    );

    assert.deepEqual(result, { persisted: false });
    assert.deepEqual(
      attempts,
      [0, 50, 150, 350],
      'one attempt, then the 50/100/200 ms ladder',
    );
    assert.equal(records.length, 1);
    assert.equal(records[0]?.level, 'warn');
    assert.match(records[0]?.msg ?? '', /rename failed, keeping state in memory only/);
    assert.deepEqual(records[0]?.fields, { path: file, code: 'EPERM', attempts: 4 });
    assert.equal(clock.pending(), 0, 'no sleep is left dangling');

    // The temp file is cleaned up and the target is left exactly as it was.
    await assert.rejects(() => stat(file), /ENOENT/);
    assert.deepEqual(await readdir(dir), [], 'the temp file is cleaned up');
  });
});

test('cc-h3 advisory — a rename that succeeds on the last retry still persists', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    const clock = mockClock();
    const { logger, records } = recordingLogger();
    let calls = 0;

    const result = await settle(
      persistProfilePatch(
        file,
        'DEFAULT',
        { accessToken: 'act.new' },
        {
          clock,
          logger,
          rename: async (from, to) => {
            calls += 1;
            if (calls <= 3) throw errnoError('EBUSY');
            await rename(from, to);
          },
        },
      ),
      clock,
    );

    assert.deepEqual(result, { persisted: true });
    assert.equal(calls, 4);
    assert.deepEqual(records, [], 'a write that eventually succeeded is not a warning');
    assert.equal(
      await readFile(file, 'utf8'),
      'TT_ACCESS_TOKEN=act.new\nTT_CONFIG_SCHEMA=1\n',
    );
  });
});

test('cc-h3 an error the ladder cannot help with degrades immediately', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    const clock = mockClock();
    const { logger, records } = recordingLogger();
    let calls = 0;

    const result = await settle(
      persistProfilePatch(
        file,
        'DEFAULT',
        { accessToken: 'act.new' },
        {
          clock,
          logger,
          rename: () => {
            calls += 1;
            return Promise.reject(errnoError('EXDEV'));
          },
        },
      ),
      clock,
    );

    assert.deepEqual(result, { persisted: false });
    assert.equal(calls, 1, 'EXDEV is not a transient hold');
    assert.deepEqual(records[0]?.fields, { path: file, code: 'EXDEV', attempts: 1 });
  });
});

test('cc-h3 a read that fails during a write degrades rather than throwing', async () => {
  await withSandbox(async (dir) => {
    // A regular file where a directory is expected: the read fails with ENOTDIR,
    // not ENOENT, so it is a genuine failure rather than "no file yet".
    const blocker = path.join(dir, 'blocker');
    await writeFile(blocker, 'not a directory\n');
    const { logger, records } = recordingLogger();

    const result = await persistProfilePatch(
      path.join(blocker, '.env'),
      'DEFAULT',
      { accessToken: 'act.new' },
      { logger },
    );

    assert.deepEqual(result, { persisted: false });
    assert.equal(records.length, 1);
    assert.match(
      records[0]?.msg ?? '',
      /could not be read, keeping state in memory only/,
    );
    assert.equal(records[0]?.fields?.['code'], 'ENOTDIR');
    assert.equal(await readFile(blocker, 'utf8'), 'not a directory\n');
  });
});

test(
  'cc-h3 a write into a read-only directory warns and degrades',
  canDenyAccess,
  async () => {
    await withSandbox(async (dir) => {
      const nested = path.join(dir, 'cfg');
      await mkdir(nested);
      const file = path.join(nested, '.env');
      await writeFile(file, 'TT_ACCESS_TOKEN=old\n');
      // r-x: the file is still readable, so the read half succeeds and the temp file
      // creation is what fails — the write-side degrade, distinct from the read one.
      await chmod(nested, 0o500);
      const { logger, records } = recordingLogger();

      try {
        const result = await persistProfilePatch(
          file,
          'DEFAULT',
          { accessToken: 'act.new' },
          { logger },
        );

        assert.deepEqual(result, { persisted: false });
        assert.equal(records.length, 1);
        assert.match(records[0]?.msg ?? '', /write failed, keeping state in memory only/);
        assert.equal(await readFile(file, 'utf8'), 'TT_ACCESS_TOKEN=old\n');
      } finally {
        await chmod(nested, 0o700);
      }
    });
  },
);

// ---------------------------------------------------------------------------
// snapshot semantics
// ---------------------------------------------------------------------------

test('cc-f1 a snapshot is a fixed instant — a later write cannot change it', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    await writeFile(file, 'TT_CLIENT_KEY=abc\nTT_ACCESS_TOKEN=old-access\n');
    const snapshot = await readEnvFile(file);

    await persistProfilePatch(file, 'DEFAULT', { accessToken: 'new-access' });

    assert.equal(snapshot.values.get('TT_ACCESS_TOKEN'), 'old-access');
    assert.equal((await readEnvFile(file)).values.get('TT_ACCESS_TOKEN'), 'new-access');
  });
});

test('cc-f1 a read concurrent with a write sees one whole document, never a torn one', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    await writeFile(
      file,
      'TT_CLIENT_KEY=abc\nTT_ACCESS_TOKEN=old-access\nTT_CONFIG_SCHEMA=1\n',
    );

    const readers = Array.from({ length: 16 }, () => readEnvFile(file));
    const [snapshots] = await Promise.all([
      Promise.all(readers),
      persistProfilePatch(file, 'DEFAULT', { accessToken: 'new-access' }),
    ]);

    for (const snapshot of snapshots) {
      assert.equal(snapshot.values.get('TT_CLIENT_KEY'), 'abc');
      const token = snapshot.values.get('TT_ACCESS_TOKEN');
      assert.ok(
        token === 'old-access' || token === 'new-access',
        `a partial document was observed: ${String(token)}`,
      );
    }
  });
});

import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CONFIG_SCHEMA_VERSION,
  envKeyFor,
  listProfiles,
  canonicalProfileName,
  normalizeProfileName,
  persistProfilePatch,
  readEnvFile,
  readProfile,
  resolveEnvFilePath,
  type EnvFileSnapshot,
} from '../src/core/config.js';
import { isTikTokError, TikTokError } from '../src/core/errors.js';
import type { Logger } from '../src/core/log.js';
import { redactText } from '../src/core/redact.js';
import { knownSettingVars, loadSettings } from '../src/core/settings.js';
import { BASELINE_NOW_MS, fsSandbox, mockClock, type MockClock } from './helpers.js';

// ---------------------------------------------------------------------------
// local fixtures
// ---------------------------------------------------------------------------

/** POSIX mode bits are meaningless on win32 (CC-F3), so those asserts are skipped by name. */
const posixOnly: { skip?: string } =
  process.platform === 'win32'
    ? { skip: 'POSIX mode bits: win32 has no st_mode permissions to assert (CC-F3)' }
    : {};

/**
 * A regular file standing where a directory belongs is the only way to make the
 * *read* half fail without touching permissions — and win32 reports that as
 * ENOENT, which is the tolerated "no file yet", not a failure.
 */
const canFailRead: { skip?: string } =
  process.platform === 'win32'
    ? { skip: 'ENOTDIR: win32 reports ENOENT for a file used as a directory' }
    : {};

/**
 * A file name long enough that `${name}.pre-schema0` overflows NAME_MAX (255)
 * while the file itself still fits — the only way to make the pre-upgrade copy
 * fail with something other than EEXIST without also breaking the write it
 * guards. Windows caps the whole path at 260 characters by default, so the env
 * file would not fit there in the first place.
 */
const canOverflowName: { skip?: string } =
  process.platform === 'win32'
    ? { skip: 'long file names: win32 caps a path at 260 characters by default' }
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
 * `clock.now()`), and otherwise wait for the real I/O that is in flight.
 *
 * The idle turn is deliberately *not* a bare `setImmediate`: that spins the
 * whole turn budget in a couple of milliseconds, so on a loaded CI runner the
 * pump outran a real `fs` round trip, gave up, and handed back a promise that
 * never settled — a hang rather than a failure. Racing the work against a real
 * one-millisecond tick spends the budget on waiting instead of on empty turns,
 * and returns the instant the work is done.
 *
 * Virtual time still only moves for a waiter that exists, so a delay the code
 * under test forgot to take is still visible in `clock.now()` (CC-H4).
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
  // The caller owns the outcome; this only keeps an in-flight rejection from
  // surfacing as an unhandled one while the pump is still running.
  const finished = tracked.then(
    () => undefined,
    () => undefined,
  );
  // 5_000 turns is ~14x the 350 virtual milliseconds the rename ladder needs,
  // and bounds a genuine hang at ~5 real seconds instead of forever.
  for (let turn = 0; turn < 5_000 && !done; turn += 1) {
    if (clock.pending() > 0) await clock.advance(1);
    else await Promise.race([finished, tick()]);
  }
  if (!done) {
    throw new Error(
      'settle: the call had not finished after 5000 turns — either it is waiting ' +
        'on something the mock clock does not own, or an injected seam never answered',
    );
  }
  return tracked;
}

/** One real millisecond — the unit the pump waits in when nothing is virtual. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 1);
  });
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
  // `platform` selects which *default location* rule applies; absolutisation is
  // always the host's, so the expectation is resolved the same way rather than
  // spelled out POSIX-style (on win32 "/etc/tt/.env" resolves onto the cwd drive).
  assert.equal(
    resolveEnvFilePath({ TT_ENV_FILE: '/etc/tt/.env' }, 'linux'),
    path.resolve('/etc/tt/.env'),
  );
  assert.equal(
    resolveEnvFilePath({ TT_ENV_FILE: '~/tt.env' }, 'darwin'),
    path.resolve(homedir(), 'tt.env'),
  );
  // A bare `~` is the home directory itself, not a file named `~` inside it.
  assert.equal(
    resolveEnvFilePath({ TT_ENV_FILE: '~' }, 'darwin'),
    path.resolve(homedir()),
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
    // Not `mode === undefined`: the missing-file arm of `EnvFileSnapshot` does
    // not declare a mode at all, and "absent" is the stronger claim.
    assert.ok(!('mode' in snapshot), 'a file that is not there has no mode');
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

test('cc-f4 the canonical spelling trims and upper-cases without validating', () => {
  assert.equal(canonicalProfileName('work'), 'WORK');
  assert.equal(canonicalProfileName(' Work '), 'WORK');
  assert.equal(canonicalProfileName('WORK'), 'WORK');
  // Unvalidated: a name no profile could have still canonicalizes, and simply
  // matches nothing where it is compared.
  assert.equal(canonicalProfileName('my-account'), 'MY-ACCOUNT');
  assert.equal(canonicalProfileName('   '), '');
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
  // The remediation names the command that creates the missing profile.
  assert.equal(
    err.remediation,
    'Set TT_ACTIVE_PROFILE to one of those, or run "tiktok-mcp-ai login --profile PHONE" to create it.',
  );
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

test('cc-f4 a per-profile key in a non-canonical case is read, not just listed', () => {
  const snapshot = snapshotOf({
    TT_CLIENT_KEY: 'k',
    TT_CLIENT_SECRET: 's',
    tt_profile_work_ACCESS_TOKEN: 'file-access',
    TT_PROFILE_Work_Refresh_Token: 'file-refresh',
    TT_PROFILE_WORK_OPEN_ID: 'file-open-id',
  });
  const work = readProfile('work', snapshot, {
    Tt_Profile_Work_Open_Id: 'env-open-id',
  });
  assert.equal(work.accessToken, 'file-access', 'a lower-case file key resolves');
  assert.equal(work.refreshToken, 'file-refresh', 'a mixed-case file key resolves');
  assert.equal(
    work.openId,
    'env-open-id',
    'a mixed-case env key still wins over the file',
  );
  assert.equal(work.scopes, undefined, 'a key no source spells in any case stays absent');
});

test('cc-f4 the exact spelling wins over a differently cased duplicate', () => {
  const snapshot = snapshotOf({
    TT_CLIENT_KEY: 'k',
    TT_CLIENT_SECRET: 's',
    tt_profile_work_access_token: 'lower',
    TT_PROFILE_WORK_ACCESS_TOKEN: 'exact',
  });
  assert.equal(readProfile('WORK', snapshot, {}).accessToken, 'exact');
  const env = {
    tt_profile_work_access_token: 'env-lower',
    TT_PROFILE_WORK_ACCESS_TOKEN: 'env-exact',
  };
  assert.equal(readProfile('WORK', snapshot, env).accessToken, 'env-exact');
});

test('the shared app keys are matched exactly, never case-insensitively', () => {
  const err = throws(() =>
    readProfile('DEFAULT', snapshotOf({ tt_client_key: 'k', TT_CLIENT_SECRET: 's' }), {
      Tt_Client_Key: 'k',
    }),
  );
  assert.equal(err.code, 'missing_credentials');
  assert.match(err.message, /missing TikTok app credentials: TT_CLIENT_KEY$/);
});

test('the app secret is registered for redaction as soon as a profile is read', () => {
  // Distinct from every other test's value: the registry is process-global.
  const secret = 'config-read-client-secret-0001';
  assert.equal(redactText(`secret ${secret} here`), `secret ${secret} here`);
  readProfile(
    'DEFAULT',
    snapshotOf({ TT_CLIENT_KEY: 'k', TT_CLIENT_SECRET: secret }),
    {},
  );
  assert.equal(redactText(`secret ${secret} here`), 'secret [REDACTED] here');
});

test('an app secret that only the process env carries is registered too', () => {
  const secret = 'config-env-client-secret-0002';
  readProfile('DEFAULT', snapshotOf({ TT_CLIENT_KEY: 'k' }), {
    TT_CLIENT_SECRET: ` ${secret} `,
  });
  // The trimmed value is what the code sends, so that is what must be masked.
  assert.equal(redactText(`the form said ${secret}.`), 'the form said [REDACTED].');
});

test('cc-h2 an expiry that is not a parseable timestamp is rejected on read', () => {
  const base = { TT_CLIENT_KEY: 'k', TT_CLIENT_SECRET: 's' };
  const good = readProfile(
    'DEFAULT',
    snapshotOf({
      ...base,
      TT_REFRESH_TOKEN: 'rft.value',
      TT_TOKEN_EXPIRES_AT: '2026-01-02T00:00:00.000Z',
      TT_REFRESH_EXPIRES_AT: '2026-03-02T00:00:00.000Z',
    }),
    {},
  );
  assert.equal(good.accessExpiresAt, '2026-01-02T00:00:00.000Z');
  assert.equal(good.refreshExpiresAt, '2026-03-02T00:00:00.000Z');
  assert.equal(good.refreshToken, 'rft.value');

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
      const written = await readEnvFile(file);
      assert.ok(written.exists, 'the file it just wrote should read back');
      assert.equal(written.mode, 0o600);
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

test('cc-f4 a canonical write rewrites a differently cased profile key in place', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    await writeFile(
      file,
      [
        'TT_CLIENT_KEY=abc',
        'tt_profile_work_access_token=old-access',
        'export TT_PROFILE_Work_Refresh_Token=old-refresh',
        '# trailing comment',
        '',
      ].join('\n'),
    );
    await persistProfilePatch(file, 'work', {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    });
    // Same positions, the export prefix kept, the key now spelled canonically —
    // and no second, upper-case copy appended after the comment.
    assert.equal(
      await readFile(file, 'utf8'),
      [
        'TT_CLIENT_KEY=abc',
        'TT_PROFILE_WORK_ACCESS_TOKEN=new-access',
        'export TT_PROFILE_WORK_REFRESH_TOKEN=new-refresh',
        '# trailing comment',
        'TT_CONFIG_SCHEMA=1',
        '',
      ].join('\n'),
    );
  });
});

test('cc-f4 a revoke-style clear leaves no case variant of a profile key behind', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    await writeFile(
      file,
      [
        'TT_PROFILE_WORK_REFRESH_TOKEN=first',
        'tt_profile_work_refresh_token=second',
        '# between',
        'Tt_Profile_Work_Refresh_Token=last',
        'TT_PROFILE_WORK_OPEN_ID=kept',
        '',
      ].join('\n'),
    );
    await persistProfilePatch(file, 'WORK', { refreshToken: '' });

    // The last variant is rewritten where it stood; every earlier one, in any
    // case, is dropped — otherwise the read (which matches any case) would
    // resurrect the token the clear was meant to remove.
    assert.equal(
      await readFile(file, 'utf8'),
      [
        '# between',
        'TT_PROFILE_WORK_REFRESH_TOKEN=',
        'TT_PROFILE_WORK_OPEN_ID=kept',
        'TT_CONFIG_SCHEMA=1',
        '',
      ].join('\n'),
    );
    const creds = readProfile('WORK', await readEnvFile(file), {
      TT_CLIENT_KEY: 'k',
      TT_CLIENT_SECRET: 's-for-the-clear-test',
    });
    assert.equal(creds.refreshToken, undefined);
    assert.equal(creds.openId, 'kept');
  });
});

test('a non-profile key is rewritten only under its exact spelling', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    // Neither the shared app keys nor the DEFAULT profile's bare keys are read
    // case-insensitively, so a differently cased line is somebody else's key
    // and must be left exactly as it is.
    await writeFile(
      file,
      'tt_client_secret=lower-secret\ntt_access_token=lower-access\n',
    );
    await persistProfilePatch(file, 'DEFAULT', {
      accessToken: 'new-access',
      clientSecret: 'new-secret',
    });
    assert.equal(
      await readFile(file, 'utf8'),
      [
        'tt_client_secret=lower-secret',
        'tt_access_token=lower-access',
        'TT_ACCESS_TOKEN=new-access',
        'TT_CLIENT_SECRET=new-secret',
        'TT_CONFIG_SCHEMA=1',
        '',
      ].join('\n'),
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

test('a rewritten last line with no terminator gains the file’s eol', async () => {
  await withSandbox(async (dir) => {
    const crlf = path.join(dir, 'crlf.env');
    // The key being rewritten *is* the unterminated last line, so the rewrite has
    // no terminator of its own to keep and has to adopt the document's.
    await writeFile(crlf, 'TT_CLIENT_KEY=abc\r\nTT_ACCESS_TOKEN=old');
    await persistProfilePatch(crlf, 'DEFAULT', { accessToken: 'new' });
    assert.equal(
      await readFile(crlf, 'utf8'),
      'TT_CLIENT_KEY=abc\r\nTT_ACCESS_TOKEN=new\r\nTT_CONFIG_SCHEMA=1\r\n',
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

test(
  'the pre-upgrade copy is created owner-only, not copied and then tightened',
  posixOnly,
  async () => {
    await withSandbox(async (dir) => {
      // A world-readable source and a `platform` that skips the follow-up chmod:
      // the only thing left that can make the copy 0600 is the mode it was
      // created with. A `copyFile` would have carried the source's 0644 over, and
      // the copy would have sat readable by other accounts until the chmod ran.
      const file = path.join(dir, '.env');
      const before = 'TT_CONFIG_SCHEMA=0\nTT_ACCESS_TOKEN=old\n';
      await writeFile(file, before);
      await chmod(file, 0o644);

      await persistProfilePatch(
        file,
        'DEFAULT',
        { accessToken: 'new' },
        { platform: 'win32' },
      );

      const backup = `${file}.pre-schema0`;
      assert.equal(await readFile(backup, 'utf8'), before);
      assert.equal((await stat(backup)).mode & 0o077, 0, 'no group or other bits, ever');
    });
  },
);

test('the pre-upgrade copy ends at exactly 0600 on posix', posixOnly, async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    await writeFile(file, 'TT_CONFIG_SCHEMA=0\nTT_ACCESS_TOKEN=old\n');
    await chmod(file, 0o644);

    await persistProfilePatch(file, 'DEFAULT', { accessToken: 'new' });

    assert.equal((await stat(`${file}.pre-schema0`)).mode & 0o777, 0o600);
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

test(
  'a pre-upgrade copy that cannot be made warns, and the save still lands',
  canOverflowName,
  async () => {
    await withSandbox(async (dir) => {
      // The env file fits inside NAME_MAX, `${path}.pre-schema0` does not, so the
      // copy fails with something other than EEXIST while the write it guards is
      // still perfectly possible. Keeping a copy is best-effort: losing it must
      // not cost the caller the token it just refreshed.
      const file = path.join(dir, `${'e'.repeat(250)}.env`);
      await writeFile(file, 'TT_CONFIG_SCHEMA=0\nTT_ACCESS_TOKEN=old\n');
      const { logger, records } = recordingLogger();

      const result = await persistProfilePatch(
        file,
        'DEFAULT',
        { accessToken: 'new' },
        { logger },
      );

      assert.deepEqual(result, { persisted: true });
      assert.equal((await readEnvFile(file)).values.get('TT_ACCESS_TOKEN'), 'new');
      assert.equal(records.length, 1);
      assert.match(records[0]?.msg ?? '', /could not keep a pre-upgrade copy/);
      const code = records[0]?.fields?.['code'];
      assert.equal(typeof code, 'string');
      assert.notEqual(code, 'EEXIST', 'an existing copy is the one silent case');
    });
  },
);

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

// The `rename` seam is injected, so what it rejects with is a caller's choice
// rather than Node's: it need not be a `SystemError`, need not carry a `code`,
// and need not be an `Error` at all. The warning still has to name a code, and
// the code path that supplies one is shared with every other warning site in
// the module — so this is the test that drives its last two arms.
test('cc-h3 a rejection with no errno at all still warns with a code', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    const clock = mockClock();
    const { logger, records } = recordingLogger();

    const result = await settle(
      persistProfilePatch(
        file,
        'DEFAULT',
        { accessToken: 'act.new' },
        {
          clock,
          logger,
          // Not an `Error`: the seam's contract is "a rejected promise", and a
          // rejected promise carries whatever the rejecting code handed it.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the value under test
          rename: () => Promise.reject('the volume went away'),
        },
      ),
      clock,
    );

    assert.deepEqual(result, { persisted: false });
    assert.deepEqual(records[0]?.fields, { path: file, code: 'unknown', attempts: 1 });
    assert.deepEqual(await readdir(dir), [], 'the temp file is still cleaned up');
  });
});

test(
  'cc-h3 a read that fails during a write degrades rather than throwing',
  canFailRead,
  async () => {
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
  },
);

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

test('cc-h3 a malformed env file degrades the write and names the parse failure', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    // Not an I/O failure: the read succeeded and the document is the problem. The
    // warning still has to carry a code, and the only one available is the
    // error's own — a `TikTokError` thrown by the parser has no errno `cause`.
    const before = 'TT_ACCESS_TOKEN=keep\nthis is not an assignment\n';
    await writeFile(file, before);
    const { logger, records } = recordingLogger();

    const result = await persistProfilePatch(
      file,
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
    assert.equal(records[0]?.fields?.['code'], 'env_file_malformed');
    assert.equal(
      await readFile(file, 'utf8'),
      before,
      'a file we cannot read is not rewritten',
    );
  });
});

test('cc-h3 a mode fix-up that fails after the rename warns without failing the save', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    const { logger, records } = recordingLogger();

    const result = await persistProfilePatch(
      file,
      'DEFAULT',
      { accessToken: 'act.new' },
      {
        logger,
        // The rename lands and the file is then gone — the shape of losing a race
        // with a concurrent writer that replaced the file we had just put there.
        // The hardening is best-effort; the write it follows already succeeded.
        rename: async (from, to) => {
          await rename(from, to);
          await rm(to);
        },
      },
    );

    assert.deepEqual(result, { persisted: true });
    assert.equal(records.length, 1);
    assert.match(records[0]?.msg ?? '', /could not set env file mode/);
    assert.equal(records[0]?.fields?.['code'], 'ENOENT');
  });
});

/** Symlinks need a privilege (or developer mode) on win32; POSIX always has them. */
const canSymlink: { skip?: string } =
  process.platform === 'win32'
    ? { skip: 'symlinks: win32 needs a privilege or developer mode to create one' }
    : {};

test(
  'a symlinked env file is written through to its target, the link kept',
  canSymlink,
  async () => {
    await withSandbox(async (dir) => {
      const realDir = path.join(dir, 'dotfiles');
      await mkdir(realDir);
      const real = path.join(realDir, 'tiktok.env');
      await writeFile(real, 'TT_ACCESS_TOKEN=old\n');
      const link = path.join(dir, '.env');
      await symlink(real, link);
      const { logger, records } = recordingLogger();

      const result = await persistProfilePatch(
        link,
        'DEFAULT',
        { accessToken: 'new' },
        { logger },
      );

      assert.deepEqual(result, { persisted: true });
      assert.deepEqual(records, []);
      assert.ok((await lstat(link)).isSymbolicLink(), 'the link is still a link');
      assert.equal(await readlink(link), real);
      assert.equal(
        await readFile(real, 'utf8'),
        'TT_ACCESS_TOKEN=new\nTT_CONFIG_SCHEMA=1\n',
      );
      assert.deepEqual(
        await readdir(realDir),
        ['tiktok.env'],
        'no temp file is left behind',
      );
    });
  },
);

test(
  'a dangling env-file symlink is written to its target, its parent created and the link kept',
  canSymlink,
  async () => {
    await withSandbox(async (dir) => {
      // The dotfiles checkout exists only as a link so far — the first login
      // must land in the file the link names, not replace the link.
      const realDir = path.join(dir, 'dotfiles', 'tiktok');
      const real = path.join(realDir, 'tiktok.env');
      const link = path.join(dir, '.env');
      await symlink(real, link);
      const { logger, records } = recordingLogger();

      const result = await persistProfilePatch(
        link,
        'DEFAULT',
        { accessToken: 'first' },
        { logger },
      );

      assert.deepEqual(result, { persisted: true });
      assert.deepEqual(records, []);
      assert.ok((await lstat(link)).isSymbolicLink(), 'the link is still a link');
      assert.equal(await readlink(link), real);
      assert.equal(
        await readFile(real, 'utf8'),
        'TT_ACCESS_TOKEN=first\nTT_CONFIG_SCHEMA=1\n',
      );
      assert.deepEqual(await readdir(realDir), ['tiktok.env']);
    });
  },
);

test(
  'a two-hop dangling symlink chain is written to the file at its end, both links kept',
  canSymlink,
  async () => {
    await withSandbox(async (dir) => {
      // .env -> mid.env -> (missing) store/tiktok.env: renaming onto either
      // link would replace it with a regular file and fork the credentials.
      const real = path.join(dir, 'store', 'tiktok.env');
      const mid = path.join(dir, 'mid.env');
      const link = path.join(dir, '.env');
      await symlink(real, mid);
      await symlink(mid, link);
      const { logger, records } = recordingLogger();

      const result = await persistProfilePatch(
        link,
        'DEFAULT',
        { accessToken: 'chained' },
        { logger },
      );

      assert.deepEqual(result, { persisted: true });
      assert.deepEqual(records, []);
      assert.ok((await lstat(link)).isSymbolicLink(), 'the first link is still a link');
      assert.equal(await readlink(link), mid);
      assert.ok((await lstat(mid)).isSymbolicLink(), 'the second link is still a link');
      assert.equal(await readlink(mid), real);
      assert.equal(
        await readFile(real, 'utf8'),
        'TT_ACCESS_TOKEN=chained\nTT_CONFIG_SCHEMA=1\n',
      );
      assert.deepEqual(await readdir(path.join(dir, 'store')), ['tiktok.env']);
    });
  },
);

test(
  'a relative dangling symlink is resolved against the directory of the link',
  canSymlink,
  async () => {
    await withSandbox(async (dir) => {
      const link = path.join(dir, 'conf', '.env');
      await mkdir(path.dirname(link));
      await symlink(path.join('..', 'store', 'tiktok.env'), link);

      const result = await persistProfilePatch(link, 'DEFAULT', { accessToken: 'rel' });

      assert.deepEqual(result, { persisted: true });
      assert.ok((await lstat(link)).isSymbolicLink());
      assert.match(
        await readFile(path.join(dir, 'store', 'tiktok.env'), 'utf8'),
        /TT_ACCESS_TOKEN=rel/,
      );
    });
  },
);

test('cc-h3 a file already sitting at the temp name degrades the write, never reuses it', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    // Learn the counter the next temp name will carry from one real write.
    let used = '';
    await persistProfilePatch(
      file,
      'DEFAULT',
      { accessToken: 'first' },
      {
        rename: async (from, to) => {
          used = from;
          await rename(from, to);
        },
      },
    );
    const match = /^\.env\.tmp-(\d+)-(\d+)$/.exec(path.basename(used));
    assert.ok(match !== null, `unexpected temp name ${used}`);
    const next = path.join(
      dir,
      `.env.tmp-${match[1] ?? ''}-${String(Number(match[2]) + 1)}`,
    );
    await writeFile(next, 'planted');
    const { logger, records } = recordingLogger();

    const result = await persistProfilePatch(
      file,
      'DEFAULT',
      { accessToken: 'second' },
      { logger },
    );

    assert.deepEqual(result, { persisted: false });
    assert.equal(records.length, 1);
    assert.match(records[0]?.msg ?? '', /env file write failed/);
    assert.equal(records[0]?.fields?.['code'], 'EEXIST');
    assert.match(await readFile(file, 'utf8'), /TT_ACCESS_TOKEN=first/);
  });
});

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

// ---------------------------------------------------------------------------
// removing a variable — the unknown-key path *is* the upgrade path (CC-F1)
// ---------------------------------------------------------------------------

/**
 * Deleting a `TT_` variable from `Settings` is only non-breaking because an
 * unknown `TT_` key is a warning that survives the document. An operator who
 * installed 0.7.0 still has `TT_MAX_CONCURRENT=4` — a knob that was parsed,
 * defaulted and documented, and read by no line of the server — sitting in their
 * env file today, and the release notes promise that nothing which worked stops
 * working.
 *
 * These tests are what that promise rests on. They are written about *a removed
 * variable*, not about this one: if unknown `TT_` keys are ever made fatal, or a
 * rewrite starts dropping them, or the known-variable set stops being derived
 * from `Settings`, this is the file that says which existing installations just
 * broke. The generic halves are already pinned above — "an unknown TT_ key warns
 * once and is never dropped" and "a rewrite preserves comments, unknown keys and
 * the export prefix byte-for-byte"; what is pinned here is that a variable this
 * build *used to* know lands on exactly that path.
 */

test('cc-f1 a variable this build no longer knows loads and warns, it does not refuse', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    await writeFile(
      file,
      [
        '# written by 0.7.0',
        'TT_CLIENT_KEY=abc',
        'TT_CLIENT_SECRET=shh',
        'TT_MAX_CONCURRENT=4',
        'TT_PUBLISH_RPM=6',
        'TT_CONFIG_SCHEMA=1',
        '',
      ].join('\n'),
    );

    const snapshot = await readEnvFile(file);
    assert.equal(snapshot.exists, true);
    assert.equal(snapshot.values.get('TT_MAX_CONCURRENT'), '4');
    assert.deepEqual(snapshot.warnings, [
      `${file}: unknown TT_ keys ignored (kept on rewrite): TT_MAX_CONCURRENT`,
    ]);
    // The startup path still gets its credentials out of that same snapshot —
    // a stale knob may not cost the operator their login.
    assert.equal(readProfile('DEFAULT', snapshot, {}).clientKey, 'abc');

    // Parsing is only half of "the server still starts": `src/index.ts` overlays
    // these very keys onto the process env and hands them to `loadSettings`,
    // which must ignore the names it does not carry rather than reject the whole
    // configuration.
    assert.equal(loadSettings(Object.fromEntries(snapshot.values)).publishRpm, 6);
  });
});

test('cc-f1 a removed variable survives the rewrite a token refresh performs', async () => {
  await withSandbox(async (dir) => {
    const file = path.join(dir, '.env');
    const before = [
      '# written by 0.7.0',
      'TT_CLIENT_KEY=abc',
      'TT_ACCESS_TOKEN=old-access',
      '# how many requests may be in flight per host',
      'TT_MAX_CONCURRENT=4',
      'TT_CONFIG_SCHEMA=1',
      '',
    ].join('\n');
    await writeFile(file, before);

    // The real write path, reached in production by a refresh rather than by a
    // migration: nothing in the server ever rewrites the file to prune it.
    assert.deepEqual(
      await persistProfilePatch(file, 'DEFAULT', { accessToken: 'new-access' }),
      { persisted: true },
    );

    const after = await readFile(file, 'utf8');
    assert.ok(
      after.split('\n').includes('TT_MAX_CONCURRENT=4'),
      `the operator's own line was rewritten or dropped:\n${after}`,
    );
    assert.equal(
      after,
      before.replace('old-access', 'new-access'),
      'only the patched key may differ — the comment above it is theirs too',
    );
  });
});

test('cc-f1 a removed variable leaves the known set, and the live ones stay in it', () => {
  const known = knownSettingVars();
  // `knownSettingVars` is `Object.keys(loadSettings({}))`, so dropping the field
  // from `Settings` is what makes `isKnownKey` say no — there is no second,
  // hand-kept list that could still claim the variable. The live anchors are
  // here so that a derivation which broke outright (an empty set, a renaming
  // rule that stopped matching) cannot make the first assertion pass for free.
  assert.equal(
    known.has('TT_MAX_CONCURRENT'),
    false,
    'the removed knob must be unknown again, not merely undocumented',
  );
  assert.ok(known.has('TT_PUBLISH_RPM'), 'a live variable must still be known');
  assert.ok(known.has('TT_CHUNK_RETRIES'), 'a live variable must still be known');
});

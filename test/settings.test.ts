import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isTikTokError, TikTokError } from '../src/core/errors.js';
import {
  DEFAULT_PROFILE,
  knownSettingVars,
  loadSettings,
  settingVarName,
  type Settings,
} from '../src/core/settings.js';

/**
 * Every case builds its own `NodeJS.ProcessEnv`, so nothing here depends on the
 * ambient environment (and `withEnv` is unnecessary — `loadSettings` takes the
 * env as a parameter precisely so tests never have to mutate `process.env`).
 */
function load(vars: Record<string, string> = {}): Settings {
  return loadSettings({ ...vars });
}

/** The aggregated startup error, or a failure if the load unexpectedly succeeded. */
function loadError(vars: Record<string, string>): TikTokError {
  try {
    loadSettings({ ...vars });
  } catch (err) {
    assert.ok(isTikTokError(err), `expected a TikTokError, got ${String(err)}`);
    return err;
  }
  assert.fail(`expected loadSettings to reject ${JSON.stringify(vars)}`);
}

/** A token of the shape the HTTP transport demands: printable, no spaces, 16+. */
const HTTP_TOKEN = 'PkYq2m8Zt4Lw9Rb6Nc3Vd1Xs';

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------

test('an empty environment yields exactly the documented defaults', () => {
  assert.deepEqual(load(), {
    envFile: undefined,
    configSchema: 1,
    activeProfile: 'DEFAULT',
    lockProfile: undefined,
    redirectPort: undefined,
    loginScopes: undefined,
    tokenRefreshSkewS: 1_800,
    toolPackages: ['core'],
    packagesDeny: [],
    packagesReadonly: false,
    writeMode: 'plan',
    planTtlS: 600,
    planMaxOutstanding: 32,
    defaultAigcLabel: true,
    mediaRoot: undefined,
    verifiedUrlPrefixes: [],
    journalMaxBytes: 5_242_880,
    envLockHeartbeatMs: 2_000,
    envLockStaleMs: 15_000,
    envLockWaitMs: 30_000,
    timeoutMs: 30_000,
    uploadTimeoutMs: 120_000,
    maxRetries: 3,
    chunkRetries: 3,
    maxConcurrent: 4,
    publishRpm: 6,
    fetchAllCap: 200,
    resultCharBudget: 25_000,
    prettyJson: false,
    statusPollIntervalMs: 5_000,
    statusPollTimeoutMs: 60_000,
    logLevel: 'info',
    transport: 'stdio',
    httpHost: '127.0.0.1',
    port: 3_000,
    httpToken: undefined,
    httpInsecure: false,
    oauthBaseUrl: undefined,
  });
});

test('the default write mode is plan — no accidental publishing (CC-C1)', () => {
  assert.equal(load().writeMode, 'plan');
  assert.equal(DEFAULT_PROFILE, 'DEFAULT');
});

test('loadSettings defaults to process.env when called with no argument', () => {
  // Ambient TT_ vars are stripped by test/helpers.js, but this suite does not
  // import it, so assert only what cannot depend on the environment.
  assert.equal(typeof loadSettings().writeMode, 'string');
});

// ---------------------------------------------------------------------------
// CC-F6 — one aggregated startup error
// ---------------------------------------------------------------------------

test('cc-f6 every invalid variable is reported in one aggregated error', () => {
  const err = loadError({
    TT_TIMEOUT_MS: 'soon',
    TT_PLAN_TTL_S: '-5',
    TT_WRITE_MODE: 'yolo',
    TT_MAX_CONCURRENT: '0',
  });

  assert.equal(err.kind, 'config');
  assert.equal(err.code, 'invalid_configuration');
  assert.match(err.message, /4 problems/);
  for (const name of [
    'TT_TIMEOUT_MS',
    'TT_PLAN_TTL_S',
    'TT_WRITE_MODE',
    'TT_MAX_CONCURRENT',
  ]) {
    assert.match(err.message, new RegExp(name), `${name} is missing from the aggregate`);
  }
  assert.match(err.remediation ?? '', /CONFIGURATION\.md/);
});

test('cc-f6 a single problem is reported in the singular and names the value', () => {
  const err = loadError({ TT_FETCH_ALL_CAP: 'lots' });
  assert.match(err.message, /\(1 problem\)/);
  assert.match(err.message, /TT_FETCH_ALL_CAP: .*decimal digits \(got "lots"\)/);
});

test('cc-f6 garbage numbers never become NaN behaviour at call time', () => {
  for (const bad of [
    'NaN',
    'Infinity',
    '1e3',
    '0x10',
    '12.5',
    '-1',
    '1_000',
    '12abc',
    ' ',
  ]) {
    const err = loadError({ TT_TIMEOUT_MS: bad });
    assert.match(err.message, /TT_TIMEOUT_MS/, `${JSON.stringify(bad)} was accepted`);
  }
});

test('cc-f6 a number too large to be exact is rejected rather than rounded', () => {
  const err = loadError({ TT_JOURNAL_MAX_BYTES: '9007199254740993' });
  assert.match(err.message, /too large to represent exactly/);
});

test('a secret variable is never echoed back in a problem line', () => {
  const err = loadError({ TT_TRANSPORT: 'http', TT_HTTP_TOKEN: 'hunter2 with spaces' });
  assert.match(err.message, /TT_HTTP_TOKEN/);
  assert.doesNotMatch(err.message, /hunter2/);
  assert.match(err.message, /<redacted>/);
});

// ---------------------------------------------------------------------------
// CC-F2 — presence-based resolution
// ---------------------------------------------------------------------------

test('cc-f2 an empty value is *set*, so a variable that needs a value is rejected', () => {
  assert.match(loadError({ TT_TIMEOUT_MS: '' }).message, /TT_TIMEOUT_MS/);
  assert.match(loadError({ TT_WRITE_MODE: '' }).message, /TT_WRITE_MODE/);
  assert.match(loadError({ TT_TOOL_PACKAGES: '' }).message, /at least one package/);
  assert.match(loadError({ TT_ACTIVE_PROFILE: '' }).message, /TT_ACTIVE_PROFILE/);
});

test('cc-f2 an empty value reads as absent for the optional string variables', () => {
  const settings = load({
    TT_ENV_FILE: '',
    TT_MEDIA_ROOT: '',
    TT_LOCK_PROFILE: '',
    TT_HTTP_TOKEN: '',
    TT_REDIRECT_PORT: '',
  });
  assert.equal(settings.envFile, undefined);
  assert.equal(settings.mediaRoot, undefined);
  assert.equal(settings.lockProfile, undefined);
  assert.equal(settings.httpToken, undefined);
  assert.equal(settings.redirectPort, undefined);
});

test('values are trimmed — a stray space in a hand-edited client config is a typo', () => {
  assert.equal(load({ TT_TIMEOUT_MS: ' 45000 ' }).timeoutMs, 45_000);
  assert.equal(load({ TT_WRITE_MODE: 'apply\t' }).writeMode, 'apply');
});

// ---------------------------------------------------------------------------
// individual variable shapes
// ---------------------------------------------------------------------------

test('booleans accept 0/1 and the true/false superset, case-insensitively', () => {
  for (const raw of ['1', 'true', 'TRUE', 'True']) {
    assert.equal(load({ TT_PRETTY_JSON: raw }).prettyJson, true, raw);
  }
  for (const raw of ['0', 'false', 'FALSE']) {
    assert.equal(load({ TT_DEFAULT_AIGC_LABEL: raw }).defaultAigcLabel, false, raw);
  }
  assert.match(loadError({ TT_PRETTY_JSON: 'yes' }).message, /expected 0 or 1/);
});

test('enums list the accepted values when they are wrong', () => {
  assert.equal(load({ TT_WRITE_MODE: 'deny' }).writeMode, 'deny');
  assert.equal(load({ TT_LOG_LEVEL: 'debug' }).logLevel, 'debug');
  assert.equal(
    load({ TT_TRANSPORT: 'http', TT_HTTP_TOKEN: HTTP_TOKEN }).transport,
    'http',
  );
  assert.match(
    loadError({ TT_LOG_LEVEL: 'verbose' }).message,
    /debug.*info.*warn.*error/s,
  );
});

test('package lists are validated against the five packages plus core/all', () => {
  assert.deepEqual(load({ TT_TOOL_PACKAGES: 'auth, user ,video' }).toolPackages, [
    'auth',
    'user',
    'video',
  ]);
  assert.deepEqual(load({ TT_TOOL_PACKAGES: 'all' }).toolPackages, ['all']);
  assert.deepEqual(load({ TT_PACKAGES_DENY: 'publish-write' }).packagesDeny, [
    'publish-write',
  ]);

  // A profile name is meaningless in a deny list: only real packages can be denied.
  assert.match(loadError({ TT_PACKAGES_DENY: 'core' }).message, /TT_PACKAGES_DENY\[0\]/);
  assert.match(
    loadError({ TT_TOOL_PACKAGES: 'auth,typo' }).message,
    /TT_TOOL_PACKAGES\[1\]/,
  );
});

test('a trailing comma in a list is tolerated, an all-comma list is not', () => {
  assert.deepEqual(load({ TT_TOOL_PACKAGES: 'core,' }).toolPackages, ['core']);
  assert.match(loadError({ TT_TOOL_PACKAGES: ',,' }).message, /at least one package/);
});

test('cc-f4 the active profile is upper-cased and shape-checked', () => {
  assert.equal(load({ TT_ACTIVE_PROFILE: 'work' }).activeProfile, 'WORK');
  assert.equal(load({ TT_LOCK_PROFILE: 'work_2' }).lockProfile, 'WORK_2');
  assert.match(loadError({ TT_ACTIVE_PROFILE: 'my-profile' }).message, /\[A-Z0-9_\]\+/);
});

test('ports are bounded by the 16-bit range', () => {
  assert.equal(load({ TT_PORT: '65535' }).port, 65_535);
  assert.equal(load({ TT_REDIRECT_PORT: '1' }).redirectPort, 1);
  assert.match(loadError({ TT_PORT: '65536' }).message, /1–65535/);
  assert.match(loadError({ TT_PORT: '0' }).message, /1–65535/);
});

test('TT_MEDIA_ROOT must be absolute and expands a leading ~ itself', () => {
  assert.equal(load({ TT_MEDIA_ROOT: '/srv/media' }).mediaRoot, '/srv/media');
  assert.equal(load({ TT_MEDIA_ROOT: '~' }).mediaRoot, homedir());
  assert.equal(
    load({ TT_MEDIA_ROOT: '~/Movies' }).mediaRoot,
    path.resolve(homedir(), 'Movies'),
  );
  assert.match(loadError({ TT_MEDIA_ROOT: 'media' }).message, /absolute path/);
});

test('TT_ENV_FILE is made absolute so it never depends on the client’s cwd', () => {
  assert.equal(load({ TT_ENV_FILE: '/etc/tt/.env' }).envFile, '/etc/tt/.env');
  assert.equal(load({ TT_ENV_FILE: '~/.env' }).envFile, path.resolve(homedir(), '.env'));
  assert.equal(path.isAbsolute(load({ TT_ENV_FILE: 'rel/.env' }).envFile ?? ''), true);
});

test('verified URL prefixes must be https', () => {
  assert.deepEqual(
    load({ TT_VERIFIED_URL_PREFIXES: 'https://cdn.example.com/,https://b.example/' })
      .verifiedUrlPrefixes,
    ['https://cdn.example.com/', 'https://b.example/'],
  );
  assert.match(
    loadError({ TT_VERIFIED_URL_PREFIXES: 'http://cdn.example.com/' }).message,
    /https:\/\/ URL prefix/,
  );
  assert.match(
    loadError({ TT_VERIFIED_URL_PREFIXES: 'not a url' }).message,
    /URL prefix/,
  );
});

test('zero is accepted where zero is meaningful and rejected where it is not', () => {
  assert.equal(load({ TT_MAX_RETRIES: '0' }).maxRetries, 0);
  assert.equal(load({ TT_CHUNK_RETRIES: '0' }).chunkRetries, 0);
  assert.equal(load({ TT_TOKEN_REFRESH_SKEW_S: '0' }).tokenRefreshSkewS, 0);
  assert.equal(load({ TT_ENV_LOCK_WAIT_MS: '0' }).envLockWaitMs, 0);
  assert.match(loadError({ TT_TIMEOUT_MS: '0' }).message, />= 1/);
  assert.match(loadError({ TT_PLAN_MAX_OUTSTANDING: '0' }).message, />= 1/);
});

// ---------------------------------------------------------------------------
// CC-G6 — the HTTP transport is never unauthenticated
// ---------------------------------------------------------------------------

test('cc-g6 TT_HTTP_TOKEN is required whenever the transport is http, loopback included', () => {
  const err = loadError({ TT_TRANSPORT: 'http' });
  assert.match(err.message, /TT_HTTP_TOKEN: required whenever TT_TRANSPORT=http/);
  assert.doesNotThrow(() => load({ TT_TRANSPORT: 'http', TT_HTTP_TOKEN: HTTP_TOKEN }));
});

test('cc-g6 a token that cannot be sent, or is trivially guessable, is refused', () => {
  assert.match(
    loadError({ TT_TRANSPORT: 'http', TT_HTTP_TOKEN: 'short' }).message,
    /at least 16 characters/,
  );
  assert.match(
    loadError({ TT_TRANSPORT: 'http', TT_HTTP_TOKEN: 'sixteen chars ok!' }).message,
    /printable ASCII with no spaces/,
  );
  // A value that trims to nothing is *absent* (CC-F2), so the aggregate names the
  // missing token rather than its shape: one variable, one problem.
  const blank = loadError({ TT_TRANSPORT: 'http', TT_HTTP_TOKEN: '   ' });
  assert.match(blank.message, /required whenever TT_TRANSPORT=http/);
  assert.doesNotMatch(blank.message, /at least 16 characters/);
});

test('cc-g6 the token is not demanded for the stdio transport', () => {
  assert.equal(load({ TT_HTTP_HOST: '0.0.0.0' }).transport, 'stdio');
});

test('cc-g6 binding beyond loopback requires an explicit TT_HTTP_INSECURE acknowledgement', () => {
  const base = { TT_TRANSPORT: 'http', TT_HTTP_TOKEN: HTTP_TOKEN };
  for (const host of [
    '127.0.0.1',
    '127.7.7.7',
    'localhost',
    '::1',
    '[::1]',
    'LocalHost',
  ]) {
    assert.doesNotThrow(() => load({ ...base, TT_HTTP_HOST: host }), host);
  }
  const err = loadError({ ...base, TT_HTTP_HOST: '0.0.0.0' });
  assert.match(err.message, /TT_HTTP_HOST: binding 0\.0\.0\.0 exposes the server/);
  assert.doesNotThrow(() =>
    load({ ...base, TT_HTTP_HOST: '0.0.0.0', TT_HTTP_INSECURE: '1' }),
  );
});

test('cc-f5 a heartbeat slower than the stale threshold is a startup error', () => {
  const err = loadError({ TT_ENV_LOCK_HEARTBEAT_MS: '20000' });
  assert.match(err.message, /must be smaller than TT_ENV_LOCK_STALE_MS \(15000\)/);
  assert.doesNotThrow(() =>
    load({ TT_ENV_LOCK_HEARTBEAT_MS: '20000', TT_ENV_LOCK_STALE_MS: '60000' }),
  );
});

test('a variable that failed validation cannot fabricate a second problem', () => {
  // TT_TRANSPORT is garbage, so it falls back to stdio and the CC-G6 check must
  // stay quiet: the aggregate reports exactly the one real problem.
  const err = loadError({ TT_TRANSPORT: 'grpc' });
  assert.match(err.message, /\(1 problem\)/);
  assert.doesNotMatch(err.message, /TT_HTTP_TOKEN/);
});

// ---------------------------------------------------------------------------
// the documentation is the specification
// ---------------------------------------------------------------------------

test('settingVarName inverts the documented naming rule', () => {
  assert.equal(settingVarName('planTtlS'), 'TT_PLAN_TTL_S');
  assert.equal(settingVarName('port'), 'TT_PORT');
  assert.equal(settingVarName('envLockHeartbeatMs'), 'TT_ENV_LOCK_HEARTBEAT_MS');
  assert.equal(settingVarName('oauthBaseUrl'), 'TT_OAUTH_BASE_URL');
});

test('knownSettingVars covers the whole settings surface and is cached', () => {
  const known = knownSettingVars();
  assert.ok(known.has('TT_WRITE_MODE'));
  assert.ok(known.has('TT_OAUTH_BASE_URL'));
  assert.equal(known.has('TT_ACCESS_TOKEN'), false, 'credentials are not settings');
  assert.equal(knownSettingVars(), known, 'the set is memoized');
});

/**
 * env-docs-sync (CONFIGURATION.md § Variables): the tables are authoritative, so
 * `Settings` must carry exactly one field per row. The credential keys are the
 * documented exception — they are read through `core/config`'s
 * `ProfileCredentials`, so the whole "App & tokens" section is excluded.
 */
test('env-docs-sync Settings has exactly one field per documented variable', async () => {
  const doc = await readFile(
    new URL('../../docs/CONFIGURATION.md', import.meta.url),
    'utf8',
  );

  const documented = new Set<string>();
  let section = '';
  for (const line of doc.split('\n')) {
    const heading = /^#{2,3}\s+(.*)$/.exec(line);
    if (heading !== null) {
      section = heading[1] ?? '';
      continue;
    }
    const row = /^\|\s*`(TT_[A-Z0-9_<>*]+)`\s*\|/.exec(line);
    if (row === null) continue;
    const name = row[1];
    if (name === undefined) continue;
    if (section === 'App & tokens') continue; // credentials — see the docstring
    documented.add(name);
  }

  assert.ok(
    documented.size > 30,
    `parsed only ${String(documented.size)} rows — did the tables move?`,
  );

  const fields = new Set(Object.keys(load()).map(settingVarName));
  const missing = [...documented].filter((name) => !fields.has(name)).sort();
  const extra = [...fields].filter((name) => !documented.has(name)).sort();

  assert.deepEqual(missing, [], 'documented variables with no Settings field');
  assert.deepEqual(extra, [], 'Settings fields with no documented variable');
});

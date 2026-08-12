/**
 * test/oauth.test.ts — TC-1, the OAuth layer (TESTING.md § core/oauth).
 *
 * Three things here are load-bearing rather than merely covered:
 *
 * 1. **The PKCE hex deviation (CC-A13).** TikTok's `code_challenge` is the
 *    *lowercase hex* SHA-256 of the verifier, not the base64url of RFC 7636.
 *    The pinned vector below is the regression guard, and the base64url form is
 *    asserted as a **negative**: a well-meaning "fix" to the spec-compliant
 *    encoding must fail here rather than in a user's browser.
 * 2. **Single flight (CC-A2).** Counting requests after the fact proves nothing
 *    — a serial implementation also ends at one. It is proven by holding the
 *    first request open with a `deferred`, observing the second caller join,
 *    and only then releasing.
 * 3. **Rotation before use (CC-A1) and degradation without data loss (CC-H3).**
 *    The rotated refresh token is on disk by the time the new access token is
 *    handed out; and when the write fails, the session keeps the token it just
 *    obtained instead of discarding it.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import fc from 'fast-check';

import { readEnvFile, readProfile } from '../src/core/config.js';
import { isTikTokError } from '../src/core/errors.js';
import type { LookupFn } from '../src/core/http.js';
import type { Logger } from '../src/core/log.js';
import {
  buildAuthUrl,
  ensureFreshAccessToken,
  exchangeCode,
  pkceChallenge,
  resetTokenCache,
  revokeToken,
} from '../src/core/oauth.js';
import { redactText } from '../src/core/redact.js';
import { loadSettings, type Settings } from '../src/core/settings.js';
import { deferred, flush } from './harness/deferred.js';
import {
  BASELINE_REFRESH_EXPIRES_AT,
  BASELINE_SCOPES,
  BASELINE_TOKEN_EXPIRES_AT,
  fsSandbox,
  mockClock,
  type FetchStub,
  type MockClock,
  type RecordedCall,
  scriptFetch,
  withFetch,
} from './helpers.js';

const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const REVOKE_URL = 'https://open.tiktokapis.com/v2/oauth/revoke/';

/**
 * `BASELINE_NOW_MS` + 10 min — inside the 30-minute `TT_TOKEN_REFRESH_SKEW_S`
 * window, so a token stamped with it is due for a proactive refresh.
 */
const INSIDE_SKEW_EXPIRES_AT = '2026-01-01T00:10:00.000Z';

// ---------------------------------------------------------------------------
// fixtures
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

/** Every warning message recorded so far, joined — for `assert.match`. */
function warnings(records: readonly Recorded[]): string {
  return records
    .filter((r) => r.level === 'warn')
    .map((r) => r.msg)
    .join('\n');
}

interface Fixture {
  readonly dir: string;
  readonly envFile: string;
  readonly clock: MockClock;
  readonly logger: Logger;
  readonly records: Recorded[];
  /**
   * The *process* environment handed to the code under test. It deliberately
   * carries only the app credentials and `TT_ENV_FILE`: tokens live in the file,
   * because a token in this object would win over the file (CC-F2) and mask
   * every rotation the tests are here to observe.
   */
  readonly env: NodeJS.ProcessEnv;
  readonly settings: Settings;
  /** Rewrite the whole env file from a key/value map. */
  write(vars: Record<string, string>): Promise<void>;
  /** The env file's current contents, parsed back into a key/value map. */
  read(): Promise<Record<string, string>>;
  cleanup(): Promise<void>;
}

/** The token sextet a healthy DEFAULT profile has on disk. */
function storedTokens(over: Record<string, string> = {}): Record<string, string> {
  return {
    TT_ACCESS_TOKEN: 'act.stored',
    TT_TOKEN_EXPIRES_AT: BASELINE_TOKEN_EXPIRES_AT,
    TT_REFRESH_TOKEN: 'rft.stored',
    TT_REFRESH_EXPIRES_AT: BASELINE_REFRESH_EXPIRES_AT,
    TT_OPEN_ID: 'open-id-stored',
    TT_SCOPES: BASELINE_SCOPES,
    ...over,
  };
}

async function fixture(settingsOver: Partial<Settings> = {}): Promise<Fixture> {
  // Module state is global by design (one process, one credential cache), so a
  // test that inherited another test's adopted token would be testing nothing.
  resetTokenCache();

  const box = await fsSandbox();
  const envFile = path.join(box.dir, '.env');
  const { logger, records } = recordingLogger();
  const env: NodeJS.ProcessEnv = {
    TT_CLIENT_KEY: 'test-client-key',
    TT_CLIENT_SECRET: 'test-client-secret',
    TT_ENV_FILE: envFile,
  };

  const write = async (vars: Record<string, string>): Promise<void> => {
    const body = Object.entries(vars)
      .map(([key, value]) => `${key}=${value}\n`)
      .join('');
    await writeFile(envFile, body, { encoding: 'utf8', mode: 0o600 });
  };
  await write(storedTokens());

  return {
    dir: box.dir,
    envFile,
    clock: mockClock(),
    logger,
    records,
    env,
    settings: { ...loadSettings(env), ...settingsOver },
    write,
    read: async (): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const line of (await readFile(envFile, 'utf8')).split('\n')) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (match?.[1] !== undefined) out[match[1]] = match[2] ?? '';
      }
      return out;
    },
    cleanup: async (): Promise<void> => {
      await box.cleanup();
    },
  };
}

/** A well-formed token-endpoint response (the flat OAuth shape, not `{data}`). */
function tokenResponse(over: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      access_token: 'act.new',
      expires_in: 86_400,
      open_id: 'open-id-new',
      refresh_expires_in: 31_536_000,
      refresh_token: 'rft.new',
      scope: 'user.info.basic,video.publish',
      token_type: 'Bearer',
      ...over,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** The flat OAuth failure shape TikTok answers with (CC-A12). */
function oauthErrorResponse(error: string, status = 400): Response {
  return new Response(
    JSON.stringify({
      error,
      error_description: `the ${error} case, as TikTok words it`,
      log_id: '2026010100000000000000000000000000',
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

/** A recorded request body, decoded from `application/x-www-form-urlencoded`. */
function form(call: RecordedCall): URLSearchParams {
  return new URLSearchParams(call.text());
}

/** The single request a stub recorded, or a test failure. */
function only(calls: readonly RecordedCall[]): RecordedCall {
  assert.equal(
    calls.length,
    1,
    `expected exactly one request, saw ${String(calls.length)}`,
  );
  return calls[0] as RecordedCall;
}

/**
 * Turn the event loop until `predicate` holds. This is not a sleep: the code
 * being waited for is `await`-ing file-system callbacks, not wall-clock time,
 * and a fixed number of turns would make the wait a race on I/O latency.
 */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  // The budget is wall-clock, not a turn count: 500 turns of `setImmediate` are
  // a few real milliseconds, which is less than a loaded CI runner needs to
  // return one file read — the test would then fail for someone else's I/O
  // contention. Past the first 500 turns the wait stops spinning hot and yields
  // real time instead, so it does not compete with the work it is waiting for.
  const giveUpAt = Date.now() + 10_000;
  for (let turn = 0; !predicate(); turn += 1) {
    if (Date.now() > giveUpAt) assert.fail(`timed out waiting for ${label}`);
    await (turn < 500
      ? flush(1)
      : new Promise<void>((resolve) => {
          setTimeout(resolve, 1);
        }));
  }
}

// ---------------------------------------------------------------------------
// PKCE (CC-A13) — the pinned vector is the whole point of this section
// ---------------------------------------------------------------------------

/** docs/AUTH.md § 1.1: the vector this implementation is pinned to. */
const PINNED_VERIFIER =
  'tiktok-mcp-ai_pinned-pkce-vector_0123456789abcdefghijklmnopqrstuvwxyz';
const PINNED_CHALLENGE =
  '6d737a2ebee1e9712ca50681cb2cb3ae5315985849a85cf11400a06b2fcbd91f';
/** The RFC 7636 encoding of the same digest — what this must **not** produce. */
const PINNED_BASE64URL = 'bXN6Lr7h6XEspQaByyyzrlMVmFhJqFzxFACgay_L2R8';

test('cc-a13: the pinned verifier hashes to the pinned lowercase-hex challenge', () => {
  assert.equal(pkceChallenge(PINNED_VERIFIER), PINNED_CHALLENGE);
});

test('cc-a13: the challenge is hex, never the base64url of rfc 7636', () => {
  // Both encode the same digest; TikTok accepts only the first. If this ever
  // starts passing with the base64url form, consent will fail with an opaque
  // browser error and no test will point at the cause.
  const base64url = createHash('sha256')
    .update(PINNED_VERIFIER, 'utf8')
    .digest('base64url');
  assert.equal(base64url, PINNED_BASE64URL);
  assert.notEqual(pkceChallenge(PINNED_VERIFIER), PINNED_BASE64URL);
});

test('property: any legal verifier yields 64 lowercase hex characters', () => {
  const legal = fc
    .array(
      fc.constantFrom(
        ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'.split(''),
      ),
      { minLength: 43, maxLength: 128 },
    )
    .map((chars) => chars.join(''));

  fc.assert(
    fc.property(legal, (verifier) => {
      assert.match(pkceChallenge(verifier), /^[0-9a-f]{64}$/);
    }),
    { numRuns: 200 },
  );
});

test('a verifier outside the rfc 7636 charset or length is rejected', () => {
  for (const bad of ['', 'too-short', 'a'.repeat(129), `${'a'.repeat(43)}+`]) {
    assert.throws(
      () => pkceChallenge(bad),
      (err: unknown) => isTikTokError(err) && err.code === 'invalid_pkce_verifier',
      `expected ${JSON.stringify(bad.slice(0, 20))} to be rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// buildAuthUrl (AUTH.md § 1.1)
// ---------------------------------------------------------------------------

const AUTH_OPTS = {
  clientKey: 'test-client-key',
  scopes: ['user.info.basic', 'video.publish'],
  redirectUri: 'http://127.0.0.1:8000/callback/',
};

/** A deterministic entropy seam: byte `i` is `seed + i`. */
function seededBytes(seed: number): (size: number) => Uint8Array {
  let call = 0;
  return (size: number) => {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) out[i] = (seed + call * 7 + i) % 256;
    call += 1;
    return out;
  };
}

test('the authorize url carries every parameter tiktok requires', () => {
  const { url, state, verifier } = buildAuthUrl({
    ...AUTH_OPTS,
    randomBytes: seededBytes(1),
  });
  const parsed = new URL(url);

  assert.equal(parsed.origin, 'https://www.tiktok.com');
  assert.equal(parsed.pathname, '/v2/auth/authorize/');
  assert.equal(parsed.searchParams.get('client_key'), 'test-client-key');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('scope'), 'user.info.basic,video.publish');
  assert.equal(parsed.searchParams.get('state'), state);
  assert.equal(parsed.searchParams.get('code_challenge'), pkceChallenge(verifier));
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
});

test('the redirect uri round-trips verbatim, trailing slash included', () => {
  // AUTH.md § 1.1: the exchange must send back a byte-identical value, so this
  // must not be normalized on the way out.
  const { url } = buildAuthUrl({ ...AUTH_OPTS, randomBytes: seededBytes(2) });
  assert.equal(
    new URL(url).searchParams.get('redirect_uri'),
    'http://127.0.0.1:8000/callback/',
  );
});

test('state and verifier are freshly drawn on every call', () => {
  const first = buildAuthUrl(AUTH_OPTS);
  const second = buildAuthUrl(AUTH_OPTS);
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.verifier, second.verifier);
  assert.match(first.verifier, /^[A-Za-z0-9\-._~]{43,128}$/);
});

test('the entropy seam makes the whole url reproducible', () => {
  const first = buildAuthUrl({ ...AUTH_OPTS, randomBytes: seededBytes(3) });
  const second = buildAuthUrl({ ...AUTH_OPTS, randomBytes: seededBytes(3) });
  assert.deepEqual(first, second);
});

test('the verifier is registered as a secret before it is returned', () => {
  const { verifier } = buildAuthUrl(AUTH_OPTS);
  assert.equal(redactText(`verifier=${verifier}`), 'verifier=[REDACTED]');
});

test('an empty client key is refused before any url is built', () => {
  assert.throws(
    () => buildAuthUrl({ ...AUTH_OPTS, clientKey: '  ' }),
    (err: unknown) => isTikTokError(err) && err.code === 'missing_client_key',
  );
});

test('an empty scope list and a non-http redirect are invalid_params', () => {
  for (const opts of [
    { ...AUTH_OPTS, scopes: [] },
    { ...AUTH_OPTS, redirectUri: 'not-a-url' },
    { ...AUTH_OPTS, redirectUri: 'ftp://127.0.0.1/callback' },
  ]) {
    assert.throws(
      () => buildAuthUrl(opts),
      (err: unknown) => isTikTokError(err) && err.code === 'invalid_params',
    );
  }
});

// ---------------------------------------------------------------------------
// exchangeCode (AUTH.md § 1.2 step 3)
// ---------------------------------------------------------------------------

const EXCHANGE_OPTS = {
  clientKey: 'test-client-key',
  clientSecret: 'test-client-secret',
  code: 'authorization-code-from-the-browser',
  verifier: PINNED_VERIFIER,
  redirectUri: 'http://127.0.0.1:8000/callback/',
};

test('the exchange posts a form body with every oauth field', async () => {
  const clock = mockClock();
  const stub = scriptFetch([tokenResponse()]);
  const set = await withFetch(stub, () => exchangeCode({ ...EXCHANGE_OPTS, clock }));

  const call = only(stub.calls);
  assert.equal(call.method, 'POST');
  assert.equal(call.url, TOKEN_URL);
  assert.match(call.headers['content-type'] ?? '', /application\/x-www-form-urlencoded/);

  const body = form(call);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('client_key'), 'test-client-key');
  assert.equal(body.get('client_secret'), 'test-client-secret');
  assert.equal(body.get('code'), EXCHANGE_OPTS.code);
  assert.equal(body.get('code_verifier'), PINNED_VERIFIER);
  assert.equal(body.get('redirect_uri'), 'http://127.0.0.1:8000/callback/');

  assert.equal(set.accessToken, 'act.new');
  assert.equal(set.refreshToken, 'rft.new');
  assert.equal(set.openId, 'open-id-new');
  assert.deepEqual(set.scopes, ['user.info.basic', 'video.publish']);
});

test('cc-h2: expiries are stored as absolute iso-8601 utc, not as durations', async () => {
  const clock = mockClock();
  const set = await withFetch(scriptFetch([tokenResponse()]), () =>
    exchangeCode({ ...EXCHANGE_OPTS, clock }),
  );
  // BASELINE_NOW_MS + 86 400 s and + 31 536 000 s.
  assert.equal(set.accessExpiresAt, '2026-01-02T00:00:00.000Z');
  assert.equal(set.refreshExpiresAt, '2027-01-01T00:00:00.000Z');
});

test('cc-a12: a flat oauth error is decoded, not read as an envelope', async () => {
  const clock = mockClock();
  await assert.rejects(
    withFetch(scriptFetch([oauthErrorResponse('invalid_grant')]), () =>
      exchangeCode({ ...EXCHANGE_OPTS, clock }),
    ),
    (err: unknown) => {
      assert.ok(isTikTokError(err));
      assert.equal(err.code, 'oauth_error');
      assert.equal(err.apiCode, 'invalid_grant');
      assert.equal(err.logId, '2026010100000000000000000000000000');
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test('a token response missing a field names the field and stores nothing', async () => {
  const clock = mockClock();
  await assert.rejects(
    withFetch(scriptFetch([tokenResponse({ refresh_token: undefined })]), () =>
      exchangeCode({ ...EXCHANGE_OPTS, clock }),
    ),
    (err: unknown) => {
      assert.ok(isTikTokError(err));
      assert.equal(err.code, 'oauth_error');
      assert.match(err.message, /refresh_token/);
      assert.match(err.message, /Nothing was stored/);
      return true;
    },
  );
});

test('every required field is checked on its own, not only the first one', async () => {
  // The five checks are independent; asserting through one response would leave
  // four of them unproven, and a silently-undefined field is how a profile gets
  // half-written.
  for (const field of [
    'access_token',
    'refresh_token',
    'open_id',
    'expires_in',
    'refresh_expires_in',
  ]) {
    const clock = mockClock();
    await assert.rejects(
      withFetch(scriptFetch([tokenResponse({ [field]: undefined })]), () =>
        exchangeCode({ ...EXCHANGE_OPTS, clock }),
      ),
      (err: unknown) => {
        assert.ok(isTikTokError(err));
        assert.match(err.message, new RegExp(field));
        return true;
      },
      `a response without ${field} was accepted`,
    );
  }
});

test('a lifetime is coerced from a string, but zero is refused', async () => {
  // TikTok documents the lifetimes as numbers. Coercing a numeric string costs
  // nothing; accepting zero would store a token that is already expired.
  const set = await withFetch(scriptFetch([tokenResponse({ expires_in: '86400' })]), () =>
    exchangeCode({ ...EXCHANGE_OPTS, clock: mockClock() }),
  );
  assert.equal(set.accessExpiresAt, '2026-01-02T00:00:00.000Z');

  await assert.rejects(
    withFetch(scriptFetch([tokenResponse({ refresh_expires_in: 0 })]), () =>
      exchangeCode({ ...EXCHANGE_OPTS, clock: mockClock() }),
    ),
    (err: unknown) => isTikTokError(err) && /refresh_expires_in/.test(err.message),
  );
});

test('cc-a7: a response with no scope at all yields an empty grant, not a crash', async () => {
  const set = await withFetch(scriptFetch([tokenResponse({ scope: undefined })]), () =>
    exchangeCode({ ...EXCHANGE_OPTS, clock: mockClock() }),
  );
  assert.deepEqual(set.scopes, []);
});

test('both tokens are registered as secrets on arrival', async () => {
  const clock = mockClock();
  await withFetch(
    scriptFetch([tokenResponse({ access_token: 'act.exchange-secret' })]),
    () => exchangeCode({ ...EXCHANGE_OPTS, clock }),
  );
  assert.equal(redactText('token act.exchange-secret here'), 'token [REDACTED] here');
});

test('the authorization code is registered as a secret before it is sent', async () => {
  const clock = mockClock();
  const code = 'authorization-code-worth-redacting-0001';
  await withFetch(scriptFetch([tokenResponse()]), () =>
    exchangeCode({ ...EXCHANGE_OPTS, code, clock }),
  );
  // Phrased as prose rather than `code=…`: the query-parameter rule would
  // redact that shape on its own, which would prove nothing about the value.
  assert.equal(redactText(`the code ${code} arrived`), 'the code [REDACTED] arrived');
});

// ---------------------------------------------------------------------------
// ensureFreshAccessToken — the happy paths
// ---------------------------------------------------------------------------

test('a token outside the skew window is used as is, with no request at all', async () => {
  const fx = await fixture();
  try {
    // An empty script: any request would throw ScriptFetchExhaustedError.
    const stub = scriptFetch([]);
    const token = await withFetch(stub, () =>
      ensureFreshAccessToken('DEFAULT', {
        env: fx.env,
        settings: fx.settings,
        clock: fx.clock,
        logger: fx.logger,
      }),
    );
    assert.equal(token, 'act.stored');
    assert.equal(stub.calls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

test('a token inside the skew window is refreshed proactively', async () => {
  const fx = await fixture();
  try {
    await fx.write(storedTokens({ TT_TOKEN_EXPIRES_AT: INSIDE_SKEW_EXPIRES_AT }));
    const stub = scriptFetch([tokenResponse()]);
    const token = await withFetch(stub, () =>
      ensureFreshAccessToken('DEFAULT', {
        env: fx.env,
        settings: fx.settings,
        clock: fx.clock,
        logger: fx.logger,
      }),
    );

    assert.equal(token, 'act.new');
    const body = form(only(stub.calls));
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'rft.stored');
  } finally {
    await fx.cleanup();
  }
});

test('cc-a1: the rotated refresh token is on disk before the new access token is returned', async () => {
  const fx = await fixture();
  try {
    await fx.write(storedTokens({ TT_TOKEN_EXPIRES_AT: INSIDE_SKEW_EXPIRES_AT }));
    const token = await withFetch(scriptFetch([tokenResponse()]), () =>
      ensureFreshAccessToken('DEFAULT', {
        env: fx.env,
        settings: fx.settings,
        clock: fx.clock,
        logger: fx.logger,
      }),
    );

    // Read *after* the call resolved: the whole sextet must already be there.
    const stored = await fx.read();
    assert.equal(token, 'act.new');
    assert.equal(stored['TT_REFRESH_TOKEN'], 'rft.new');
    assert.equal(stored['TT_ACCESS_TOKEN'], 'act.new');
    assert.equal(stored['TT_TOKEN_EXPIRES_AT'], '2026-01-02T00:00:00.000Z');
    assert.equal(stored['TT_REFRESH_EXPIRES_AT'], '2027-01-01T00:00:00.000Z');
    assert.equal(stored['TT_OPEN_ID'], 'open-id-new');
    assert.equal(stored['TT_SCOPES'], 'user.info.basic,video.publish');
    assert.equal(stored['TT_CONFIG_SCHEMA'], '1');
  } finally {
    await fx.cleanup();
  }
});

test('the refreshed token is cached: a second call issues no request', async () => {
  const fx = await fixture();
  try {
    await fx.write(storedTokens({ TT_TOKEN_EXPIRES_AT: INSIDE_SKEW_EXPIRES_AT }));
    const stub = scriptFetch([tokenResponse()]);
    const deps = {
      env: fx.env,
      settings: fx.settings,
      clock: fx.clock,
      logger: fx.logger,
    };
    await withFetch(stub, async () => {
      assert.equal(await ensureFreshAccessToken('DEFAULT', deps), 'act.new');
      assert.equal(await ensureFreshAccessToken('DEFAULT', deps), 'act.new');
    });
    assert.equal(stub.calls.length, 1);
  } finally {
    await fx.cleanup();
  }
});

test('force refreshes a token that is still perfectly fresh', async () => {
  const fx = await fixture();
  try {
    const stub = scriptFetch([tokenResponse()]);
    const token = await withFetch(stub, () =>
      ensureFreshAccessToken('DEFAULT', {
        env: fx.env,
        settings: fx.settings,
        clock: fx.clock,
        logger: fx.logger,
        force: true,
      }),
    );
    assert.equal(token, 'act.new');
    assert.equal(stub.calls.length, 1);
  } finally {
    await fx.cleanup();
  }
});

test('a non-default profile refreshes its own TT_PROFILE_<NAME>_* keys', async () => {
  const fx = await fixture();
  try {
    await fx.write({
      ...storedTokens(),
      TT_PROFILE_WORK_ACCESS_TOKEN: 'act.work',
      TT_PROFILE_WORK_TOKEN_EXPIRES_AT: INSIDE_SKEW_EXPIRES_AT,
      TT_PROFILE_WORK_REFRESH_TOKEN: 'rft.work',
      TT_PROFILE_WORK_REFRESH_EXPIRES_AT: BASELINE_REFRESH_EXPIRES_AT,
      TT_PROFILE_WORK_OPEN_ID: 'open-id-work',
      TT_PROFILE_WORK_SCOPES: BASELINE_SCOPES,
    });
    const stub = scriptFetch([tokenResponse()]);
    const token = await withFetch(stub, () =>
      ensureFreshAccessToken('work', {
        env: fx.env,
        settings: fx.settings,
        clock: fx.clock,
        logger: fx.logger,
      }),
    );

    assert.equal(token, 'act.new');
    assert.equal(form(only(stub.calls)).get('refresh_token'), 'rft.work');
    const stored = await fx.read();
    assert.equal(stored['TT_PROFILE_WORK_REFRESH_TOKEN'], 'rft.new');
    // The DEFAULT profile is a bystander and must not be touched.
    assert.equal(stored['TT_ACCESS_TOKEN'], 'act.stored');
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// ensureFreshAccessToken — single flight (CC-A2)
// ---------------------------------------------------------------------------

test('cc-a2: two concurrent callers produce exactly one refresh request', async () => {
  const fx = await fixture();
  try {
    await fx.write(storedTokens({ TT_TOKEN_EXPIRES_AT: INSIDE_SKEW_EXPIRES_AT }));

    const gate = deferred<Response>();
    const calls: string[] = [];
    const stub: FetchStub = (input) => {
      calls.push(String(input));
      return gate.promise;
    };
    const deps = {
      env: fx.env,
      settings: fx.settings,
      clock: fx.clock,
      logger: fx.logger,
    };

    await withFetch(stub, async () => {
      const first = ensureFreshAccessToken('DEFAULT', deps);
      const second = ensureFreshAccessToken('DEFAULT', deps);
      await waitUntil(() => calls.length > 0, 'the first refresh request');
      // A second refresh, if the second caller started one, would be issued in
      // these turns — the first request is pinned open, so nothing else can be
      // waiting on it.
      await flush(20);

      // The assertion that matters — made while the request is still open.
      assert.equal(calls.length, 1, 'the second caller started its own refresh');

      gate.resolve(tokenResponse());
      assert.deepEqual(await Promise.all([first, second]), ['act.new', 'act.new']);
    });

    assert.equal(calls.length, 1);
  } finally {
    await fx.cleanup();
  }
});

test('a failed refresh is not cached: the next caller may try again', async () => {
  const fx = await fixture();
  try {
    await fx.write(storedTokens({ TT_TOKEN_EXPIRES_AT: INSIDE_SKEW_EXPIRES_AT }));
    const stub = scriptFetch([oauthErrorResponse('server_error', 500), tokenResponse()]);
    const deps = {
      env: fx.env,
      settings: fx.settings,
      clock: fx.clock,
      logger: fx.logger,
    };
    await withFetch(stub, async () => {
      await assert.rejects(ensureFreshAccessToken('DEFAULT', deps));
      assert.equal(await ensureFreshAccessToken('DEFAULT', deps), 'act.new');
    });
    assert.equal(stub.calls.length, 2);
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// ensureFreshAccessToken — invalid_grant (CC-A5, CC-A6)
// ---------------------------------------------------------------------------

/**
 * A stub that fails the first request with `invalid_grant` and — as a sibling
 * process would — rewrites the env file with a rotated refresh token before the
 * caller re-reads it.
 */
function rotatingStub(
  fx: Fixture,
  rewritten: Record<string, string>,
  second: Response,
): { stub: FetchStub; bodies: string[] } {
  const bodies: string[] = [];
  let call = 0;
  const stub: FetchStub = async (_input, init) => {
    // `oauthRequest` always sends an encoded form body, so this is a string.
    bodies.push(typeof init?.body === 'string' ? init.body : '');
    call += 1;
    if (call > 1) return second;
    await fx.write(rewritten);
    return oauthErrorResponse('invalid_grant');
  };
  return { stub, bodies };
}

test('cc-a5: invalid_grant re-reads once and retries with the token a sibling rotated', async () => {
  const fx = await fixture();
  try {
    await fx.write(storedTokens({ TT_TOKEN_EXPIRES_AT: INSIDE_SKEW_EXPIRES_AT }));
    const { stub, bodies } = rotatingStub(
      fx,
      storedTokens({
        TT_TOKEN_EXPIRES_AT: INSIDE_SKEW_EXPIRES_AT,
        TT_REFRESH_TOKEN: 'rft.rotated-by-sibling',
      }),
      tokenResponse(),
    );

    const token = await withFetch(stub, () =>
      ensureFreshAccessToken('DEFAULT', {
        env: fx.env,
        settings: fx.settings,
        clock: fx.clock,
        logger: fx.logger,
      }),
    );

    assert.equal(token, 'act.new');
    assert.equal(bodies.length, 2, 'expected exactly one retry');
    assert.equal(new URLSearchParams(bodies[0]).get('refresh_token'), 'rft.stored');
    assert.equal(
      new URLSearchParams(bodies[1]).get('refresh_token'),
      'rft.rotated-by-sibling',
    );
    assert.match(warnings(fx.records), /retrying once with the token another process/);
  } finally {
    await fx.cleanup();
  }
});

test('cc-a6: invalid_grant with nothing newer on disk is terminal and names the login command', async () => {
  const fx = await fixture();
  try {
    await fx.write(storedTokens({ TT_TOKEN_EXPIRES_AT: INSIDE_SKEW_EXPIRES_AT }));
    const stub = scriptFetch([oauthErrorResponse('invalid_grant')]);

    await assert.rejects(
      withFetch(stub, () =>
        ensureFreshAccessToken('DEFAULT', {
          env: fx.env,
          settings: fx.settings,
          clock: fx.clock,
          logger: fx.logger,
        }),
      ),
      (err: unknown) => {
        assert.ok(isTikTokError(err));
        assert.equal(err.code, 'auth_expired');
        assert.equal(err.retryable, false);
        assert.match(err.message, /npx tiktok-mcp-ai login --profile DEFAULT/);
        assert.match(err.message, /Do not retry this call until re-login completes/);
        return true;
      },
    );
    // Exactly one attempt: no retry loop against a dead token (CC-A6).
    assert.equal(stub.calls.length, 1);
  } finally {
    await fx.cleanup();
  }
});

test('cc-a6: a rotated token that is also rejected ends terminally, not in a loop', async () => {
  const fx = await fixture();
  try {
    await fx.write(storedTokens({ TT_TOKEN_EXPIRES_AT: INSIDE_SKEW_EXPIRES_AT }));
    const { stub, bodies } = rotatingStub(
      fx,
      storedTokens({
        TT_TOKEN_EXPIRES_AT: INSIDE_SKEW_EXPIRES_AT,
        TT_REFRESH_TOKEN: 'rft.also-dead',
      }),
      oauthErrorResponse('invalid_grant'),
    );

    await assert.rejects(
      withFetch(stub, () =>
        ensureFreshAccessToken('DEFAULT', {
          env: fx.env,
          settings: fx.settings,
          clock: fx.clock,
          logger: fx.logger,
        }),
      ),
      (err: unknown) => isTikTokError(err) && err.code === 'auth_expired',
    );
    assert.equal(bodies.length, 2);
  } finally {
    await fx.cleanup();
  }
});

test('a profile with no refresh token fails terminally without a request', async () => {
  const fx = await fixture();
  try {
    await fx.write({
      TT_ACCESS_TOKEN: 'act.stored',
      TT_TOKEN_EXPIRES_AT: INSIDE_SKEW_EXPIRES_AT,
    });
    const stub = scriptFetch([]);
    await assert.rejects(
      withFetch(stub, () =>
        ensureFreshAccessToken('DEFAULT', {
          env: fx.env,
          settings: fx.settings,
          clock: fx.clock,
          logger: fx.logger,
        }),
      ),
      (err: unknown) => {
        assert.ok(isTikTokError(err));
        assert.equal(err.code, 'auth_expired');
        assert.match(err.message, /has no refresh token/);
        return true;
      },
    );
    assert.equal(stub.calls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

test('a refresh token pinned in the process environment is not spent twice', async () => {
  // CC-F2 makes the process env win over the file, so a client config that
  // inlines TT_REFRESH_TOKEN keeps handing back the original value however many
  // times this process rotates it. The second refresh must spend the token it
  // received, not the dead one the environment keeps replaying.
  const fx = await fixture();
  try {
    const env = { ...fx.env, TT_REFRESH_TOKEN: 'rft.pinned-in-client-config' };
    const stub = scriptFetch([
      tokenResponse({ access_token: 'act.first', refresh_token: 'rft.second' }),
      tokenResponse({ access_token: 'act.second', refresh_token: 'rft.third' }),
    ]);
    const deps = {
      env,
      settings: fx.settings,
      clock: fx.clock,
      logger: fx.logger,
      force: true,
    };

    await withFetch(stub, async () => {
      assert.equal(await ensureFreshAccessToken('DEFAULT', deps), 'act.first');
      assert.equal(await ensureFreshAccessToken('DEFAULT', deps), 'act.second');
    });

    assert.equal(stub.calls.length, 2);
    const [first, second] = stub.calls;
    assert.equal(
      form(first as RecordedCall).get('refresh_token'),
      'rft.pinned-in-client-config',
    );
    assert.equal(form(second as RecordedCall).get('refresh_token'), 'rft.second');
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// ensureFreshAccessToken — degradation (CC-H3) and the env lock
// ---------------------------------------------------------------------------

test('cc-h3: a failed write keeps the new token in memory instead of discarding it', async () => {
  const fx = await fixture();
  try {
    await fx.write(storedTokens({ TT_TOKEN_EXPIRES_AT: INSIDE_SKEW_EXPIRES_AT }));
    const stub = scriptFetch([tokenResponse()]);
    const deps = {
      env: fx.env,
      settings: fx.settings,
      clock: fx.clock,
      logger: fx.logger,
      // The `rename` seam is the one cross-platform way to fail the atomic
      // write: a read-only directory would fail the lock first, and a chmod'd
      // file would fail the read. ENOSPC is outside the retryable set, so the
      // degradation is immediate and no sleeps are involved.
      rename: (): Promise<void> =>
        Promise.reject(Object.assign(new Error('no space left'), { code: 'ENOSPC' })),
    };

    await withFetch(stub, async () => {
      assert.equal(await ensureFreshAccessToken('DEFAULT', deps), 'act.new');
      // The session continues on the in-memory token: no second request.
      assert.equal(await ensureFreshAccessToken('DEFAULT', deps), 'act.new');
    });

    assert.equal(stub.calls.length, 1);
    assert.match(warnings(fx.records), /could not be written to the env file/);
    // The old file is intact — a half-written credential set is worse than none.
    assert.equal((await fx.read())['TT_REFRESH_TOKEN'], 'rft.stored');
  } finally {
    await fx.cleanup();
  }
});

test('a config written by a newer build is refused, and the session still gets its token', async () => {
  const fx = await fixture();
  try {
    await fx.write({
      ...storedTokens({ TT_TOKEN_EXPIRES_AT: INSIDE_SKEW_EXPIRES_AT }),
      TT_CONFIG_SCHEMA: '99',
    });
    const token = await withFetch(scriptFetch([tokenResponse()]), () =>
      ensureFreshAccessToken('DEFAULT', {
        env: fx.env,
        settings: fx.settings,
        clock: fx.clock,
        logger: fx.logger,
      }),
    );
    assert.equal(token, 'act.new');
    assert.match(warnings(fx.records), /could not be written to the env file/);
    assert.equal((await fx.read())['TT_CONFIG_SCHEMA'], '99');
  } finally {
    await fx.cleanup();
  }
});

test('a lock held by another process surfaces env_file_busy as retryable', async () => {
  // waitMs 0 makes the wait deterministic: one attempt, no sleeps, no advance.
  const fx = await fixture({ envLockWaitMs: 0 });
  try {
    await fx.write(storedTokens({ TT_TOKEN_EXPIRES_AT: INSIDE_SKEW_EXPIRES_AT }));
    await mkdir(`${fx.envFile}.lock`);

    const stub = scriptFetch([]);
    await assert.rejects(
      withFetch(stub, () =>
        ensureFreshAccessToken('DEFAULT', {
          env: fx.env,
          settings: fx.settings,
          clock: fx.clock,
          logger: fx.logger,
        }),
      ),
      (err: unknown) => {
        assert.ok(isTikTokError(err));
        assert.equal(err.code, 'env_file_busy');
        assert.equal(err.retryable, true);
        return true;
      },
    );
    assert.equal(stub.calls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

test('a busy lock over a file a sibling has already refreshed is adopted, not surfaced', async () => {
  const fx = await fixture({ envLockWaitMs: 0 });
  try {
    const deps = {
      env: fx.env,
      settings: fx.settings,
      clock: fx.clock,
      logger: fx.logger,
    };
    const stub = scriptFetch([]);
    await withFetch(stub, async () => {
      // Adopt the stored token, then let a sibling replace it and take the lock.
      assert.equal(await ensureFreshAccessToken('DEFAULT', deps), 'act.stored');
      await fx.write(storedTokens({ TT_ACCESS_TOKEN: 'act.from-sibling' }));
      await mkdir(`${fx.envFile}.lock`);

      // `force` is the 401 replay (ARCHITECTURE § 6) arriving while the sibling
      // still holds the lock: its token is right there, and costs nothing.
      assert.equal(
        await ensureFreshAccessToken('DEFAULT', { ...deps, force: true }),
        'act.from-sibling',
      );
    });

    assert.equal(stub.calls.length, 0);
    assert.match(
      warnings(fx.records),
      /already held a token another process had refreshed/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('a forced refresh blocked by the lock surfaces env_file_busy rather than replaying', async () => {
  // The file holds exactly the token TikTok just rejected, and the lock that
  // would allow a refresh is held elsewhere. Handing the same token back would
  // turn a retryable situation into a second 401.
  const fx = await fixture({ envLockWaitMs: 0 });
  try {
    await mkdir(`${fx.envFile}.lock`);
    const stub = scriptFetch([]);
    await assert.rejects(
      withFetch(stub, () =>
        ensureFreshAccessToken('DEFAULT', {
          env: fx.env,
          settings: fx.settings,
          clock: fx.clock,
          logger: fx.logger,
          force: true,
        }),
      ),
      (err: unknown) => {
        assert.ok(isTikTokError(err));
        assert.equal(err.code, 'env_file_busy');
        assert.equal(err.retryable, true);
        return true;
      },
    );
    assert.equal(stub.calls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

test('a token another process wrote while we waited is adopted without a request', async () => {
  const fx = await fixture();
  try {
    // Stale in memory (adopted at startup), fresh on disk by the time the lock
    // is taken — step 1 of the refresh protocol, which costs no token use.
    await fx.write(storedTokens({ TT_TOKEN_EXPIRES_AT: INSIDE_SKEW_EXPIRES_AT }));
    const deps = {
      env: fx.env,
      settings: fx.settings,
      clock: fx.clock,
      logger: fx.logger,
    };
    const stub = scriptFetch([tokenResponse()]);

    await withFetch(stub, async () => {
      // First call adopts the stale set and refreshes it.
      await ensureFreshAccessToken('DEFAULT', deps);
      // A sibling now writes a different, fresher set.
      await fx.write(
        storedTokens({
          TT_ACCESS_TOKEN: 'act.from-sibling',
          TT_REFRESH_TOKEN: 'rft.sibling',
        }),
      );
      assert.equal(
        await ensureFreshAccessToken('DEFAULT', { ...deps, force: true }),
        'act.from-sibling',
      );
    });

    assert.equal(stub.calls.length, 1, 'the sibling’s token should have cost no request');
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// the TT_OAUTH_BASE_URL escape hatch (test-only, loopback-only)
// ---------------------------------------------------------------------------

test('a loopback oauth base url is honoured', async () => {
  const fx = await fixture({ oauthBaseUrl: 'https://127.0.0.1:8443' });
  try {
    await fx.write(storedTokens({ TT_TOKEN_EXPIRES_AT: INSIDE_SKEW_EXPIRES_AT }));
    const stub = scriptFetch([tokenResponse()]);
    await withFetch(stub, () =>
      ensureFreshAccessToken('DEFAULT', {
        env: fx.env,
        settings: fx.settings,
        clock: fx.clock,
        logger: fx.logger,
      }),
    );
    assert.equal(only(stub.calls).url, 'https://127.0.0.1:8443/v2/oauth/token/');
  } finally {
    await fx.cleanup();
  }
});

test('a non-loopback oauth base url is ignored, never followed', async () => {
  // The knob exists so a test can point at a local stub. Honouring an arbitrary
  // host would turn it into an exfiltration channel for the client secret.
  const fx = await fixture({ oauthBaseUrl: 'https://attacker.example.com' });
  try {
    await fx.write(storedTokens({ TT_TOKEN_EXPIRES_AT: INSIDE_SKEW_EXPIRES_AT }));
    const stub = scriptFetch([tokenResponse()]);
    await withFetch(stub, () =>
      ensureFreshAccessToken('DEFAULT', {
        env: fx.env,
        settings: fx.settings,
        clock: fx.clock,
        logger: fx.logger,
      }),
    );
    assert.equal(only(stub.calls).url, TOKEN_URL);
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// revokeToken (AUTH.md § 4)
// ---------------------------------------------------------------------------

test('revoke posts the access token and clears the local sextet', async () => {
  const fx = await fixture();
  try {
    await fx.write({ ...storedTokens(), UNRELATED_KEY: 'left-alone' });
    const stub = scriptFetch([new Response('{}', { status: 200 })]);
    await withFetch(stub, () =>
      revokeToken('DEFAULT', {
        env: fx.env,
        settings: fx.settings,
        clock: fx.clock,
        logger: fx.logger,
      }),
    );

    const call = only(stub.calls);
    assert.equal(call.url, REVOKE_URL);
    const body = form(call);
    assert.equal(body.get('token'), 'act.stored');
    assert.equal(body.get('client_key'), 'test-client-key');
    assert.equal(body.get('client_secret'), 'test-client-secret');

    const stored = await fx.read();
    for (const key of [
      'TT_ACCESS_TOKEN',
      'TT_TOKEN_EXPIRES_AT',
      'TT_REFRESH_TOKEN',
      'TT_REFRESH_EXPIRES_AT',
      'TT_OPEN_ID',
      'TT_SCOPES',
    ]) {
      assert.equal(stored[key], '', `${key} should have been cleared`);
    }
    // Everything the caller did not ask to clear survives untouched.
    assert.equal(stored['UNRELATED_KEY'], 'left-alone');
  } finally {
    await fx.cleanup();
  }
});

test('revoke clears the local credentials even when tiktok rejects the call', async () => {
  const fx = await fixture();
  try {
    const stub = scriptFetch([oauthErrorResponse('invalid_request', 400)]);
    await withFetch(stub, () =>
      revokeToken('DEFAULT', {
        env: fx.env,
        settings: fx.settings,
        clock: fx.clock,
        logger: fx.logger,
      }),
    );

    assert.equal(stub.calls.length, 1);
    assert.match(warnings(fx.records), /did not confirm the revocation/);
    assert.equal((await fx.read())['TT_ACCESS_TOKEN'], '');
  } finally {
    await fx.cleanup();
  }
});

test('revoke with nothing stored sends no request and still clears', async () => {
  const fx = await fixture();
  try {
    await fx.write({ TT_OPEN_ID: 'open-id-orphan' });
    const stub = scriptFetch([]);
    await withFetch(stub, () =>
      revokeToken('DEFAULT', {
        env: fx.env,
        settings: fx.settings,
        clock: fx.clock,
        logger: fx.logger,
      }),
    );
    assert.equal(stub.calls.length, 0);
    assert.equal((await fx.read())['TT_OPEN_ID'], '');
  } finally {
    await fx.cleanup();
  }
});

test('a revoked profile is re-read from the file rather than served from memory', async () => {
  const fx = await fixture();
  try {
    const deps = {
      env: fx.env,
      settings: fx.settings,
      clock: fx.clock,
      logger: fx.logger,
    };
    await withFetch(scriptFetch([]), () => ensureFreshAccessToken('DEFAULT', deps));
    await withFetch(scriptFetch([new Response('{}', { status: 200 })]), () =>
      revokeToken('DEFAULT', deps),
    );

    // The cleared file reads back as a profile with no tokens at all.
    const creds = readProfile('DEFAULT', await readEnvFile(fx.envFile), fx.env);
    assert.equal(creds.accessToken, undefined);
    assert.equal(creds.refreshToken, undefined);

    const stub = scriptFetch([]);
    await assert.rejects(
      withFetch(stub, () => ensureFreshAccessToken('DEFAULT', deps)),
      (err: unknown) => isTikTokError(err) && err.code === 'auth_expired',
    );
    assert.equal(stub.calls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// seams and defaults
//
// Every test above injects the full dependency bag, which is exactly what makes
// these worth writing: the defaults — `process.env`, `loadSettings`, the system
// clock, a real logger — are the code path every production caller takes, and
// nothing else in this file exercises them.
// ---------------------------------------------------------------------------

/** A DNS seam that answers with fixed addresses (mirrors the one in http.test). */
function fakeLookup(address: string): { lookup: LookupFn; calls: string[] } {
  const calls: string[] = [];
  const impl = (
    hostname: string,
    _options: unknown,
    callback: (
      error: NodeJS.ErrnoException | null,
      addresses: readonly { address: string; family: number }[],
    ) => void,
  ): void => {
    calls.push(hostname);
    callback(null, [{ address, family: 4 }]);
  };
  // `LookupFn` is `node:dns`'s heavily overloaded `lookup`; a stub can only
  // implement the one overload `core/http` calls (`{ all: true }` + callback).
  return { lookup: impl as unknown as LookupFn, calls };
}

/**
 * Run `body` with `vars` in the **real** `process.env`, so the code under test
 * takes its `process.env` / `loadSettings` / `systemClock` / `createLogger`
 * defaults. The `withEnv` helper is deliberately synchronous; these calls are
 * not, so the save/restore is done here around an `await`.
 */
async function withProcessEnv(
  vars: Record<string, string>,
  body: () => Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>(
    Object.keys(vars).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, vars);
  try {
    await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('an already-aborted caller signal is honoured before any request is sent', async () => {
  const reason = new Error('the login was cancelled');
  const stub = scriptFetch([tokenResponse()]);
  await assert.rejects(
    withFetch(stub, () =>
      exchangeCode({
        ...EXCHANGE_OPTS,
        clock: mockClock(),
        signal: AbortSignal.abort(reason),
        timeoutMs: 5_000,
      }),
    ),
    (err: unknown) => err === reason,
  );
  assert.equal(stub.calls.length, 0);
});

test('the dns seam, when injected, is consulted for the token host', async () => {
  const { lookup, calls } = fakeLookup('93.184.216.34');
  const set = await withFetch(scriptFetch([tokenResponse()]), () =>
    exchangeCode({ ...EXCHANGE_OPTS, clock: mockClock(), lookup, timeoutMs: 5_000 }),
  );
  assert.equal(set.accessToken, 'act.new');
  assert.deepEqual(calls, ['open.tiktokapis.com']);
});

test('with no clock seam the expiries are measured against the real one', async () => {
  const before = Date.now();
  const set = await withFetch(scriptFetch([tokenResponse()]), () =>
    exchangeCode(EXCHANGE_OPTS),
  );
  const expires = Date.parse(set.accessExpiresAt);
  assert.ok(
    expires >= before + 86_400_000 && expires <= Date.now() + 86_400_000,
    `${set.accessExpiresAt} is not "now + expires_in"`,
  );
});

test('with no dependency bag the refresh reads the process environment', async () => {
  const fx = await fixture();
  try {
    // The stored expiry is 2026-01-02, long behind the system clock this call
    // has no seam to replace — so the default path decides on its own that the
    // token needs refreshing, and writes the rotation back through the default
    // env-file path.
    const stub = scriptFetch([tokenResponse()]);
    await withProcessEnv(
      {
        TT_CLIENT_KEY: 'test-client-key',
        TT_CLIENT_SECRET: 'test-client-secret',
        TT_ENV_FILE: fx.envFile,
        TT_LOG_LEVEL: 'error',
      },
      async () => {
        await withFetch(stub, async () => {
          assert.equal(await ensureFreshAccessToken('DEFAULT'), 'act.new');
        });
      },
    );
    assert.equal(only(stub.calls).url, TOKEN_URL);
    assert.equal((await fx.read())['TT_REFRESH_TOKEN'], 'rft.new');
  } finally {
    await fx.cleanup();
  }
});

test('with no dependency bag the revoke reads the process environment too', async () => {
  const fx = await fixture();
  try {
    const stub = scriptFetch([new Response('{}', { status: 200 })]);
    await withProcessEnv(
      {
        TT_CLIENT_KEY: 'test-client-key',
        TT_CLIENT_SECRET: 'test-client-secret',
        TT_ENV_FILE: fx.envFile,
        TT_LOG_LEVEL: 'error',
      },
      async () => {
        await withFetch(stub, () => revokeToken('DEFAULT'));
      },
    );
    assert.equal(only(stub.calls).url, REVOKE_URL);
    assert.equal((await fx.read())['TT_ACCESS_TOKEN'], '');
  } finally {
    await fx.cleanup();
  }
});

test('revoke posts the in-memory token when the file no longer names one', async () => {
  // A refresh that could not be written (CC-H3) leaves this process holding a
  // live token the file knows nothing about. Revoking must still kill it
  // upstream, or it stays valid until it expires on its own.
  const fx = await fixture();
  try {
    const deps = {
      env: fx.env,
      settings: fx.settings,
      clock: fx.clock,
      logger: fx.logger,
    };
    await withFetch(scriptFetch([]), () => ensureFreshAccessToken('DEFAULT', deps));
    await fx.write({ TT_REFRESH_TOKEN: 'rft.stored' });

    const stub = scriptFetch([new Response('{}', { status: 200 })]);
    await withFetch(stub, () => revokeToken('DEFAULT', deps));
    assert.equal(form(only(stub.calls)).get('token'), 'act.stored');
  } finally {
    await fx.cleanup();
  }
});

test('a revoke whose local clear fails says which key to remove by hand', async () => {
  const fx = await fixture();
  try {
    const stub = scriptFetch([new Response('{}', { status: 200 })]);
    await withFetch(stub, () =>
      revokeToken('DEFAULT', {
        env: fx.env,
        settings: fx.settings,
        clock: fx.clock,
        logger: fx.logger,
        rename: (): Promise<void> =>
          Promise.reject(Object.assign(new Error('no space left'), { code: 'ENOSPC' })),
      }),
    );

    // Upstream revocation happened; only the local clear failed, and the user is
    // told exactly which key is still on disk.
    assert.equal(stub.calls.length, 1);
    assert.match(warnings(fx.records), /remove them by hand/);
    const warned = fx.records.find((r) => r.msg.includes('remove them by hand'));
    assert.equal(warned?.fields?.['key'], 'TT_ACCESS_TOKEN');
    assert.equal((await fx.read())['TT_ACCESS_TOKEN'], 'act.stored');
  } finally {
    await fx.cleanup();
  }
});

test('an oauth base url that is not a url at all is ignored, never fatal', async () => {
  // `loadSettings` validates the variable, so this shape can only arrive from a
  // hand-built `Settings`. Ignoring it keeps the failure mode "the override did
  // nothing" rather than "every token exchange throws".
  const fx = await fixture({ oauthBaseUrl: 'not-a-url' });
  try {
    await fx.write(storedTokens({ TT_TOKEN_EXPIRES_AT: INSIDE_SKEW_EXPIRES_AT }));
    const stub = scriptFetch([tokenResponse()]);
    await withFetch(stub, () =>
      ensureFreshAccessToken('DEFAULT', {
        env: fx.env,
        settings: fx.settings,
        clock: fx.clock,
        logger: fx.logger,
      }),
    );
    assert.equal(only(stub.calls).url, TOKEN_URL);
  } finally {
    await fx.cleanup();
  }
});

test('a credential file with no open id or scopes still yields a usable token', async () => {
  // Both fields are optional on disk: a partial grant (CC-A7) or a file written
  // by hand may carry neither, and neither is needed to spend the token.
  const fx = await fixture();
  try {
    await fx.write({
      TT_ACCESS_TOKEN: 'act.stored',
      TT_TOKEN_EXPIRES_AT: BASELINE_TOKEN_EXPIRES_AT,
      TT_REFRESH_TOKEN: 'rft.stored',
      TT_REFRESH_EXPIRES_AT: BASELINE_REFRESH_EXPIRES_AT,
    });
    const stub = scriptFetch([]);
    const token = await withFetch(stub, () =>
      ensureFreshAccessToken('DEFAULT', {
        env: fx.env,
        settings: fx.settings,
        clock: fx.clock,
        logger: fx.logger,
      }),
    );
    assert.equal(token, 'act.stored');
    assert.equal(stub.calls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

test('a busy lock over a file that cannot be re-read surfaces the busy error', async () => {
  const fx = await fixture({ envLockWaitMs: 0 });
  try {
    const deps = {
      env: fx.env,
      settings: fx.settings,
      clock: fx.clock,
      logger: fx.logger,
    };
    const stub = scriptFetch([]);
    await withFetch(stub, async () => {
      assert.equal(await ensureFreshAccessToken('DEFAULT', deps), 'act.stored');

      // The last-chance re-read is best-effort: if the file itself has become
      // unreadable, the caller gets the retryable busy error rather than the
      // read's error, because retrying is still the right next move.
      await rm(fx.envFile);
      await mkdir(fx.envFile);
      await mkdir(`${fx.envFile}.lock`);

      await assert.rejects(
        ensureFreshAccessToken('DEFAULT', { ...deps, force: true }),
        (err: unknown) => {
          assert.ok(isTikTokError(err));
          assert.equal(err.code, 'env_file_busy');
          assert.equal(err.retryable, true);
          return true;
        },
      );
    });
    assert.equal(stub.calls.length, 0);
  } finally {
    await fx.cleanup();
  }
});

test('a retry that fails for another reason surfaces that reason, not auth_expired', async () => {
  // CC-A5 buys exactly one retry. If the retry fails with something that is not
  // `invalid_grant`, re-labelling it "re-run login" would send the user after
  // the wrong problem.
  const fx = await fixture();
  try {
    await fx.write(storedTokens({ TT_TOKEN_EXPIRES_AT: INSIDE_SKEW_EXPIRES_AT }));
    const { stub, bodies } = rotatingStub(
      fx,
      storedTokens({
        TT_TOKEN_EXPIRES_AT: INSIDE_SKEW_EXPIRES_AT,
        TT_REFRESH_TOKEN: 'rft.rotated-by-sibling',
      }),
      oauthErrorResponse('invalid_request'),
    );

    await assert.rejects(
      withFetch(stub, () =>
        ensureFreshAccessToken('DEFAULT', {
          env: fx.env,
          settings: fx.settings,
          clock: fx.clock,
          logger: fx.logger,
        }),
      ),
      (err: unknown) => {
        assert.ok(isTikTokError(err));
        assert.equal(err.code, 'oauth_error');
        assert.equal(err.apiCode, 'invalid_request');
        return true;
      },
    );
    assert.equal(bodies.length, 2);
  } finally {
    await fx.cleanup();
  }
});

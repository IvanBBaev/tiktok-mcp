/**
 * `src/api/context.ts` — the shared api-layer context.
 *
 * Three responsibilities, tested separately: the token seam (`getAccessToken`
 * is the only door to a bearer, and `force` reaches the refresher), the request
 * rule of ARCHITECTURE § 6 (exactly one forced refresh and one replay on a
 * rejected token, never two), and the per-call credential re-read TOOLS.md
 * § 6.2 makes authoritative over any cached description marker.
 */

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  apiRequest,
  createApiContext,
  grantedScopes,
  malformedPayload,
  maskOpenId,
  readCredentialSnapshot,
  type ApiContext,
} from '../src/api/context.js';
import { isTikTokError } from '../src/core/errors.js';
import { createLogger } from '../src/core/log.js';
import { loadSettings, type Settings } from '../src/core/settings.js';
import type { RefreshDeps } from '../src/core/oauth.js';
import {
  BASELINE_REFRESH_EXPIRES_AT,
  BASELINE_SCOPES,
  BASELINE_TOKEN_EXPIRES_AT,
  baselineEnv,
  fsSandbox,
  mockClock,
  scriptFetch,
  ttEnvelope,
  withFetch,
} from './helpers.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const NOOP_LOGGER = createLogger({ level: 'error' });

/** Settings from the real loader, so the fixtures cannot drift from the schema. */
function settings(overrides: Record<string, string> = {}): Settings {
  return loadSettings({ ...baselineEnv(), ...overrides });
}

interface CtxOptions {
  profile?: string;
  settings?: Settings;
  refresh?: (profile: string, deps: RefreshDeps) => Promise<string>;
  env?: NodeJS.ProcessEnv;
}

function apiCtx(opts: CtxOptions = {}): ApiContext {
  return createApiContext({
    profile: opts.profile ?? 'DEFAULT',
    settings: opts.settings ?? settings(),
    log: NOOP_LOGGER,
    clock: mockClock(),
    refresh: opts.refresh ?? (() => Promise.resolve('test-access-token-DEFAULT')),
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });
}

/** An env file holding a default profile, a second profile, and a broken one. */
async function envFile(dir: string): Promise<string> {
  const path = join(dir, '.tiktok-mcp.env');
  await writeFile(
    path,
    [
      'TT_CLIENT_KEY=test-client-key',
      'TT_CLIENT_SECRET=test-client-secret',
      'TT_ACCESS_TOKEN=test-access-token-DEFAULT',
      'TT_REFRESH_TOKEN=test-refresh-token-DEFAULT',
      'TT_OPEN_ID=test-open-id-DEFAULT',
      `TT_SCOPES=${BASELINE_SCOPES}`,
      `TT_TOKEN_EXPIRES_AT=${BASELINE_TOKEN_EXPIRES_AT}`,
      `TT_REFRESH_EXPIRES_AT=${BASELINE_REFRESH_EXPIRES_AT}`,
      'TT_PROFILE_WORK_ACCESS_TOKEN=test-access-token-WORK',
      'TT_PROFILE_WORK_OPEN_ID=work-open-id-0987654321',
      'TT_PROFILE_WORK_SCOPES=user.info.basic,video.list',
      `TT_PROFILE_WORK_REFRESH_EXPIRES_AT=${BASELINE_REFRESH_EXPIRES_AT}`,
      // CC-H2: an expiry that is not ISO-8601 makes `readProfile` throw.
      'TT_PROFILE_BROKEN_TOKEN_EXPIRES_AT=whenever',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  return path;
}

// ---------------------------------------------------------------------------
// the token seam
// ---------------------------------------------------------------------------

test('getAccessToken is the only door to a bearer and routes through the refresher', async () => {
  const seen: { profile: string; force: unknown }[] = [];
  const ctx = apiCtx({
    profile: 'WORK',
    refresh: (profile, deps) => {
      seen.push({ profile, force: deps.force });
      return Promise.resolve('bearer-from-refresher');
    },
  });

  assert.equal(await ctx.getAccessToken(), 'bearer-from-refresher');
  assert.equal(await ctx.getAccessToken({ force: true }), 'bearer-from-refresher');
  assert.deepEqual(seen, [
    { profile: 'WORK', force: undefined },
    { profile: 'WORK', force: true },
  ]);
});

test('the seams are optional — a context built from a profile alone still stands up', () => {
  // No clock and no refresher: the factory falls back to the system clock and
  // the real `ensureFreshAccessToken`. Neither is invoked here, so the test
  // still reads no wall clock and opens no socket.
  const ctx = createApiContext({
    profile: 'WORK',
    settings: settings(),
    log: NOOP_LOGGER,
  });

  assert.equal(ctx.profile, 'WORK');
  assert.equal(typeof ctx.clock.now(), 'number');
  assert.equal(typeof ctx.getAccessToken, 'function');
});

test('the factory hands the refresher the settings and the injected clock', async () => {
  const set = settings({ TT_TIMEOUT_MS: '4000' });
  let deps: RefreshDeps | undefined;
  const ctx = createApiContext({
    profile: 'DEFAULT',
    settings: set,
    log: NOOP_LOGGER,
    clock: mockClock(),
    env: { TT_CLIENT_KEY: 'from-injected-env' },
    refresh: (_profile, given) => {
      deps = given;
      return Promise.resolve('token');
    },
  });
  await ctx.getAccessToken();

  assert.equal(deps?.settings, set);
  assert.equal(deps?.clock?.now(), ctx.clock.now());
  assert.equal(deps?.env?.['TT_CLIENT_KEY'], 'from-injected-env');
});

// ---------------------------------------------------------------------------
// apiRequest
// ---------------------------------------------------------------------------

test('apiRequest composes the fields query parameter as a bare comma list', async () => {
  const stub = scriptFetch([ttEnvelope({ user: { open_id: 'x' } })]);
  await withFetch(stub, async () => {
    await apiRequest(apiCtx(), {
      method: 'GET',
      path: '/v2/user/info/',
      fields: ['open_id', 'display_name'],
    });
  });

  assert.equal(
    stub.calls[0]?.url,
    'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name',
  );
  assert.equal(
    stub.calls[0]?.headers['authorization'],
    'Bearer test-access-token-DEFAULT',
  );
});

test('apiRequest resolves the envelope payload and forwards the body verbatim', async () => {
  const stub = scriptFetch([ttEnvelope({ videos: [{ id: '7' }] })]);
  const page = await withFetch(stub, async () =>
    apiRequest<{ videos: { id: string }[] }>(apiCtx(), {
      method: 'POST',
      path: '/v2/video/list/',
      fields: ['id'],
      body: { max_count: 20 },
    }),
  );

  assert.deepEqual(page.videos, [{ id: '7' }]);
  assert.deepEqual(stub.calls[0]?.json(), { max_count: 20 });
});

test('a rejected access token buys exactly one forced refresh and one replay', async () => {
  const stub = scriptFetch([
    ttEnvelope(undefined, { code: 'access_token_invalid', message: 'expired' }),
    ttEnvelope({ user: { open_id: 'after-refresh' } }),
  ]);
  const forced: boolean[] = [];
  const ctx = apiCtx({
    refresh: (_profile, deps) => {
      forced.push(deps.force === true);
      return Promise.resolve('token');
    },
  });

  const payload = await withFetch(stub, async () =>
    apiRequest<{ user: { open_id: string } }>(ctx, {
      method: 'GET',
      path: '/v2/user/info/',
      fields: ['open_id'],
    }),
  );

  assert.equal(payload.user.open_id, 'after-refresh');
  assert.equal(stub.calls.length, 2);
  assert.deepEqual(forced, [false, true]);
});

test('a second rejection after the replay is terminal and reads as auth_expired', async () => {
  const stub = scriptFetch([
    ttEnvelope(undefined, { code: 'access_token_invalid', message: 'expired' }),
    ttEnvelope(undefined, { code: 'access_token_invalid', message: 'still expired' }),
  ]);

  await withFetch(stub, async () => {
    await assert.rejects(
      apiRequest(apiCtx({ profile: 'WORK' }), {
        method: 'GET',
        path: '/v2/user/info/',
        fields: ['open_id'],
      }),
      (error: unknown) => {
        assert.ok(isTikTokError(error));
        assert.equal(error.kind, 'auth');
        assert.equal(error.code, 'auth_expired');
        assert.equal(error.retryable, false);
        assert.ok(error.message.includes('login --profile WORK'));
        return true;
      },
    );
  });

  // Two calls, never three: looping on a credential TikTok keeps refusing is
  // how a client burns an account's rate budget for nothing.
  assert.equal(stub.calls.length, 2);
});

test('an error that is not a token rejection is not replayed', async () => {
  const stub = scriptFetch([
    ttEnvelope(undefined, { code: 'scope_permission_missed', message: 'no' }),
  ]);

  await withFetch(stub, async () => {
    await assert.rejects(
      apiRequest(apiCtx(), {
        method: 'GET',
        path: '/v2/user/info/',
        fields: ['username'],
      }),
      (error: unknown) => {
        assert.ok(isTikTokError(error));
        assert.equal(error.apiCode, 'scope_permission_missed');
        return true;
      },
    );
  });
  assert.equal(stub.calls.length, 1);
});

test('a non-token failure on the replay propagates unchanged', async () => {
  const stub = scriptFetch([
    ttEnvelope(undefined, { code: 'access_token_invalid', message: 'expired' }),
    ttEnvelope(undefined, { code: 'scope_permission_missed', message: 'no' }),
  ]);

  await withFetch(stub, async () => {
    await assert.rejects(
      apiRequest(apiCtx(), {
        method: 'GET',
        path: '/v2/user/info/',
        fields: ['username'],
      }),
      (error: unknown) => {
        assert.ok(isTikTokError(error));
        assert.equal(error.code, 'upstream_error');
        assert.equal(error.apiCode, 'scope_permission_missed');
        return true;
      },
    );
  });
  assert.equal(stub.calls.length, 2);
});

test('malformedPayload reports a shape change as an upstream problem', () => {
  const error = malformedPayload('/v2/user/info/', 'user object');
  assert.equal(error.kind, 'api');
  assert.equal(error.code, 'upstream_error');
  assert.equal(error.retryable, false);
  assert.ok(error.message.includes('/v2/user/info/'));
  assert.ok(error.message.includes('user object'));
});

// ---------------------------------------------------------------------------
// the credential snapshot (TOOLS.md § 6.2)
// ---------------------------------------------------------------------------

test('readCredentialSnapshot summarizes every configured profile without token material', async () => {
  const sandbox = await fsSandbox();
  try {
    const path = await envFile(sandbox.dir);
    const rows = await readCredentialSnapshot(
      apiCtx({ settings: settings({ TT_ENV_FILE: path }) }),
      {},
    );

    assert.deepEqual(
      rows.map((row) => row.name),
      ['BROKEN', 'DEFAULT', 'WORK'],
    );

    const def = rows.find((row) => row.name === 'DEFAULT');
    assert.equal(def?.isDefault, true);
    assert.equal(def?.openId, 'test-open-id-DEFAULT');
    assert.equal(def?.tokenExpiresAt, BASELINE_TOKEN_EXPIRES_AT);
    assert.equal(def?.refreshExpiresAt, BASELINE_REFRESH_EXPIRES_AT);
    assert.deepEqual(def?.scopes, BASELINE_SCOPES.split(','));

    const work = rows.find((row) => row.name === 'WORK');
    assert.equal(work?.isDefault, false);
    assert.deepEqual(work?.scopes, ['user.info.basic', 'video.list']);
    assert.equal(work?.tokenExpiresAt, undefined);

    // Nothing on the summary can carry a token, whatever the file holds.
    const serialized = JSON.stringify(rows);
    assert.ok(!serialized.includes('test-access-token-DEFAULT'));
    assert.ok(!serialized.includes('test-refresh-token-DEFAULT'));
    assert.ok(!serialized.includes('test-client-secret'));
  } finally {
    await sandbox.cleanup();
  }
});

test('a profile whose record cannot be read is reported as granting nothing', async () => {
  const sandbox = await fsSandbox();
  try {
    const path = await envFile(sandbox.dir);
    const rows = await readCredentialSnapshot(
      apiCtx({ settings: settings({ TT_ENV_FILE: path }) }),
      {},
    );
    const broken = rows.find((row) => row.name === 'BROKEN');

    assert.deepEqual(broken?.scopes, []);
    assert.equal(broken?.openId, undefined);
    assert.equal(broken?.isDefault, false);
  } finally {
    await sandbox.cleanup();
  }
});

test('the active profile drives isDefault, and a profile lock outranks it', async () => {
  const sandbox = await fsSandbox();
  try {
    const path = await envFile(sandbox.dir);
    const active = await readCredentialSnapshot(
      apiCtx({ settings: settings({ TT_ENV_FILE: path, TT_ACTIVE_PROFILE: 'WORK' }) }),
      {},
    );
    assert.equal(active.find((row) => row.name === 'WORK')?.isDefault, true);

    const locked = await readCredentialSnapshot(
      apiCtx({
        settings: settings({
          TT_ENV_FILE: path,
          TT_ACTIVE_PROFILE: 'WORK',
          TT_LOCK_PROFILE: 'DEFAULT',
        }),
      }),
      {},
    );
    assert.equal(locked.find((row) => row.name === 'DEFAULT')?.isDefault, true);
    assert.equal(locked.find((row) => row.name === 'WORK')?.isDefault, false);
  } finally {
    await sandbox.cleanup();
  }
});

test('grantedScopes answers for the context profile, and [] for one with no record', async () => {
  const sandbox = await fsSandbox();
  try {
    const path = await envFile(sandbox.dir);
    const set = settings({ TT_ENV_FILE: path });

    assert.deepEqual(
      await grantedScopes(apiCtx({ profile: 'WORK', settings: set }), {}),
      ['user.info.basic', 'video.list'],
    );
    assert.deepEqual(
      await grantedScopes(apiCtx({ profile: 'BROKEN', settings: set }), {}),
      [],
    );
    assert.deepEqual(
      await grantedScopes(apiCtx({ profile: 'GHOST', settings: set }), {}),
      [],
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('a missing env file is an empty credential store, not a failure', async () => {
  const sandbox = await fsSandbox();
  try {
    const set = settings({ TT_ENV_FILE: join(sandbox.dir, 'absent.env') });
    const rows = await readCredentialSnapshot(apiCtx({ settings: set }), {});

    assert.deepEqual(
      rows.map((row) => row.name),
      ['DEFAULT'],
    );
    assert.deepEqual(rows[0]?.scopes, []);
  } finally {
    await sandbox.cleanup();
  }
});

test('without TT_ENV_FILE in the settings the snapshot resolves the path from the environment', async () => {
  const sandbox = await fsSandbox();
  try {
    const path = await envFile(sandbox.dir);
    // `settings()` carries no envFile, so the second argument is what decides
    // which store is read — the same resolution the CLI performs.
    const rows = await readCredentialSnapshot(apiCtx(), { TT_ENV_FILE: path });

    assert.deepEqual(
      rows.map((row) => row.name),
      ['BROKEN', 'DEFAULT', 'WORK'],
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('maskOpenId keeps enough to tell two profiles apart and no more', () => {
  assert.equal(maskOpenId('abcd1234efgh5678'), 'abcd…5678');
  assert.equal(maskOpenId('12345678'), '…');
  assert.equal(maskOpenId(''), '…');
  assert.equal(maskOpenId('123456789'), '1234…6789');
});

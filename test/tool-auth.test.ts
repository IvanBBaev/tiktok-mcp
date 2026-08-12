/**
 * `tiktok_get_auth_status` (TOOLS.md § 3.1).
 *
 * The tool is the model's diagnostic entry point, so the tests are about what it
 * is allowed to say: the per-profile × per-package matrix, the two hint shapes
 * (`reauth` for a credential that cannot heal itself, `user_action` for a scope
 * no profile grants), and the rule that binds all of it — a result, a hint or an
 * error may carry scopes, expiries and a masked `open_id`, and nothing else
 * (TOOLS.md § 2.5).
 *
 * The credential store is a real file in an `fsSandbox()`, pointed at by
 * `TT_ENV_FILE`: `test/helpers.ts` strips `TT_*` from `process.env`, so the file
 * is the only source of profiles and the read cannot leak into the developer's
 * own credentials.
 */

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createApiContext, type ApiContext } from '../src/api/context.js';
import { createLogger } from '../src/core/log.js';
import { loadSettings } from '../src/core/settings.js';
import type { ToolCtx } from '../src/mcp/define.js';
import type { ToolResult } from '../src/mcp/result.js';
import { getAuthStatusTool, type AuthStatus } from '../src/tools/auth.js';
import {
  BASELINE_REFRESH_EXPIRES_AT,
  BASELINE_SCOPES,
  BASELINE_TOKEN_EXPIRES_AT,
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

/** The app credentials every profile shares; without them a record is unreadable. */
const APP_CREDENTIALS = ['TT_CLIENT_KEY=test-client-key', 'TT_CLIENT_SECRET=test-secret'];

/** A fully granted default profile whose refresh token is still alive. */
const HEALTHY_DEFAULT = [
  'TT_ACCESS_TOKEN=test-access-token-DEFAULT',
  'TT_REFRESH_TOKEN=test-refresh-token-DEFAULT',
  'TT_OPEN_ID=test-open-id-DEFAULT',
  `TT_SCOPES=${BASELINE_SCOPES}`,
  `TT_TOKEN_EXPIRES_AT=${BASELINE_TOKEN_EXPIRES_AT}`,
  `TT_REFRESH_EXPIRES_AT=${BASELINE_REFRESH_EXPIRES_AT}`,
];

async function envFile(dir: string, lines: readonly string[]): Promise<string> {
  const path = join(dir, '.tiktok-mcp.env');
  await writeFile(path, [...APP_CREDENTIALS, ...lines, ''].join('\n'), { mode: 0o600 });
  return path;
}

function apiCtx(envFilePath: string, profile = 'DEFAULT'): ApiContext {
  return createApiContext({
    profile,
    settings: loadSettings({ TT_ENV_FILE: envFilePath }),
    log: NOOP_LOGGER,
    clock: mockClock(),
    refresh: () => Promise.resolve('test-access-token-DEFAULT'),
  });
}

function toolCtx(api: ApiContext): ToolCtx {
  return { api, log: NOOP_LOGGER };
}

/** Run the handler against a sandboxed credential file and clean up after it. */
async function withStore<T>(
  lines: readonly string[],
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const sandbox = await fsSandbox();
  try {
    return await fn(await envFile(sandbox.dir, lines));
  } finally {
    await sandbox.cleanup();
  }
}

function dataOf(result: ToolResult<AuthStatus>): AuthStatus {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.ok(result.data !== undefined);
  return result.data;
}

// ---------------------------------------------------------------------------
// the local report
// ---------------------------------------------------------------------------

test('a fully granted profile reports every package as ok and needs no hint', async () => {
  await withStore(HEALTHY_DEFAULT, async (path) => {
    const result = await getAuthStatusTool.handler({}, toolCtx(apiCtx(path)));
    const [row] = dataOf(result).profiles;

    assert.equal(dataOf(result).profiles.length, 1);
    assert.equal(row?.name, 'DEFAULT');
    assert.equal(row?.is_default, true);
    assert.equal(row?.open_id_masked, 'test…AULT');
    assert.equal(row?.token_expires_at, BASELINE_TOKEN_EXPIRES_AT);
    assert.equal(row?.refresh_expires_at, BASELINE_REFRESH_EXPIRES_AT);
    assert.deepEqual(row?.packages, {
      auth: 'ok',
      user: 'ok',
      video: 'ok',
      publish: 'ok',
      'publish-write': 'ok',
    });
    assert.equal(result.hints, undefined);
    assert.equal(row?.probe, undefined);
  });
});

test('a partial grant is reported per package, naming the first missing scope', async () => {
  await withStore(
    [
      'TT_SCOPES=user.info.basic',
      'TT_OPEN_ID=test-open-id-DEFAULT',
      `TT_REFRESH_EXPIRES_AT=${BASELINE_REFRESH_EXPIRES_AT}`,
    ],
    async (path) => {
      const result = await getAuthStatusTool.handler({}, toolCtx(apiCtx(path)));
      const [row] = dataOf(result).profiles;

      assert.deepEqual(row?.packages, {
        auth: 'ok',
        user: 'ok',
        video: 'missing_scope:video.list',
        publish: 'missing_scope:video.publish',
        'publish-write': 'missing_scope:video.publish',
      });
      // CC-A7: a partial grant is normal, so the call still succeeds.
      assert.equal(result.ok, true);
    },
  );
});

test('every configured profile appears, and only one is the default', async () => {
  await withStore(
    [
      ...HEALTHY_DEFAULT,
      'TT_PROFILE_WORK_ACCESS_TOKEN=test-access-token-WORK',
      'TT_PROFILE_WORK_OPEN_ID=work-open-id-0987654321',
      'TT_PROFILE_WORK_SCOPES=user.info.basic,video.list',
      `TT_PROFILE_WORK_REFRESH_EXPIRES_AT=${BASELINE_REFRESH_EXPIRES_AT}`,
    ],
    async (path) => {
      const rows = dataOf(
        await getAuthStatusTool.handler({}, toolCtx(apiCtx(path, 'WORK'))),
      ).profiles;

      assert.deepEqual(
        rows.map((row) => row.name),
        ['DEFAULT', 'WORK'],
      );
      assert.deepEqual(
        rows.map((row) => row.is_default),
        [true, false],
      );
      // `account` selects the probe target; it does not move the default.
      assert.equal(rows.find((row) => row.name === 'WORK')?.open_id_masked, 'work…4321');
    },
  );
});

test('no result, hint or error carries token material', async () => {
  await withStore(HEALTHY_DEFAULT, async (path) => {
    const result = await getAuthStatusTool.handler({}, toolCtx(apiCtx(path)));
    const serialized = JSON.stringify(result);

    for (const secret of [
      'test-access-token-DEFAULT',
      'test-refresh-token-DEFAULT',
      'test-secret',
      'test-open-id-DEFAULT',
    ]) {
      assert.ok(!serialized.includes(secret), `leaked ${secret}`);
    }
  });
});

// ---------------------------------------------------------------------------
// hints (TOOLS.md § 5.2)
// ---------------------------------------------------------------------------

test('a credential that cannot renew itself earns one reauth hint', async () => {
  // No TT_REFRESH_EXPIRES_AT: nothing on record says the refresh token is alive.
  await withStore(['TT_SCOPES=' + BASELINE_SCOPES], async (path) => {
    const result = await getAuthStatusTool.handler({}, toolCtx(apiCtx(path)));
    const hint = result.hints?.[0];
    assert.ok(hint !== undefined);

    assert.equal(hint.type, 'reauth');
    assert.equal(hint.profile, 'DEFAULT');
    assert.equal(hint.command, 'npx tiktok-mcp-ai login --profile DEFAULT');
    assert.ok(hint.text.includes('npx tiktok-mcp-ai login --profile DEFAULT'));
  });
});

test('an expired refresh token counts as needing a login; an expired access token does not', async () => {
  // The clock is at 2026-01-01; the refresh expiry below is a year behind it.
  await withStore(
    [
      `TT_SCOPES=${BASELINE_SCOPES}`,
      'TT_TOKEN_EXPIRES_AT=2025-01-01T00:00:00.000Z',
      'TT_REFRESH_EXPIRES_AT=2025-06-01T00:00:00.000Z',
    ],
    async (path) => {
      const expired = await getAuthStatusTool.handler({}, toolCtx(apiCtx(path)));
      assert.equal(expired.hints?.[0]?.type, 'reauth');
    },
  );

  await withStore(
    [
      `TT_SCOPES=${BASELINE_SCOPES}`,
      'TT_TOKEN_EXPIRES_AT=2025-01-01T00:00:00.000Z',
      `TT_REFRESH_EXPIRES_AT=${BASELINE_REFRESH_EXPIRES_AT}`,
    ],
    async (path) => {
      // `ensureFreshAccessToken` renews this on the next call — sending the user
      // to a browser for it would be wrong.
      const fresh = await getAuthStatusTool.handler({}, toolCtx(apiCtx(path)));
      assert.equal(fresh.hints, undefined);
    },
  );
});

test('the reauth hint names the profile the call ran against when several are stale', async () => {
  await withStore(
    [
      `TT_SCOPES=${BASELINE_SCOPES}`,
      `TT_PROFILE_WORK_SCOPES=${BASELINE_SCOPES}`,
      'TT_PROFILE_WORK_ACCESS_TOKEN=test-access-token-WORK',
    ],
    async (path) => {
      const result = await getAuthStatusTool.handler({}, toolCtx(apiCtx(path, 'WORK')));
      assert.equal(result.hints?.[0]?.profile, 'WORK');
    },
  );
});

test('a package no profile can reach earns one user_action hint listing its scopes', async () => {
  await withStore(
    [
      'TT_SCOPES=user.info.basic,video.list',
      `TT_REFRESH_EXPIRES_AT=${BASELINE_REFRESH_EXPIRES_AT}`,
    ],
    async (path) => {
      const result = await getAuthStatusTool.handler({}, toolCtx(apiCtx(path)));
      const hint = result.hints?.[0];
      assert.ok(hint !== undefined);

      assert.equal(hint.type, 'user_action');
      assert.equal(hint.action, 'login');
      assert.ok(hint.text.includes('publish, publish-write'));
      assert.ok(hint.text.includes('video.publish,video.upload'));
    },
  );
});

test('hints stay inside the § 5.2 budget: at most three, at most 300 characters each', async () => {
  await withStore(['TT_SCOPES=user.info.basic'], async (path) => {
    const result = await getAuthStatusTool.handler({}, toolCtx(apiCtx(path)));
    const hints = result.hints ?? [];

    assert.ok(hints.length <= 3, `${String(hints.length)} hints`);
    for (const hint of hints) {
      assert.ok(hint.text.length <= 300, `${String(hint.text.length)} characters`);
    }
  });
});

// ---------------------------------------------------------------------------
// probe: true
// ---------------------------------------------------------------------------

test('probe makes exactly one user-info call and stamps the probed row', async () => {
  await withStore(HEALTHY_DEFAULT, async (path) => {
    const stub = scriptFetch([ttEnvelope({ user: { open_id: 'test-open-id-DEFAULT' } })]);
    const result = await withFetch(stub, async () =>
      getAuthStatusTool.handler({ probe: true }, toolCtx(apiCtx(path))),
    );
    const [row] = dataOf(result).profiles;

    assert.equal(stub.calls.length, 1);
    assert.equal(
      stub.calls[0]?.url,
      'https://open.tiktokapis.com/v2/user/info/?fields=open_id',
    );
    assert.deepEqual(row?.probe, { ok: true, checked_at: '2026-01-01T00:00:00.000Z' });
    // The probe answers for the resolved profile only.
    assert.equal(JSON.stringify(result).includes('"probe"'), true);
  });
});

test('a probe TikTok rejects returns the documented auth failure, not a row flag', async () => {
  await withStore(HEALTHY_DEFAULT, async (path) => {
    const stub = scriptFetch([
      ttEnvelope(undefined, { code: 'access_token_invalid', message: 'expired' }),
      ttEnvelope(undefined, { code: 'access_token_invalid', message: 'expired' }),
    ]);
    const result = await withFetch(stub, async () =>
      getAuthStatusTool.handler({ probe: true }, toolCtx(apiCtx(path))),
    );

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'auth_expired');
    assert.equal(result.error?.retryable, false);
    assert.equal(result.hints?.[0]?.type, 'reauth');
    assert.equal(result.hints?.[0]?.profile, 'DEFAULT');
    assert.ok(!JSON.stringify(result).includes('test-access-token-DEFAULT'));
  });
});

test('a probe failure that is not an auth verdict is not reported as one', async () => {
  await withStore(HEALTHY_DEFAULT, async (path) => {
    const stub = scriptFetch([
      // Not an authentication verdict: an api-kind failure must reach the
      // wrapper unchanged rather than be reported as "your token is bad".
      ttEnvelope(undefined, { code: 'scope_permission_missed', message: 'no' }),
    ]);

    await withFetch(stub, async () => {
      await assert.rejects(
        getAuthStatusTool.handler({ probe: true }, toolCtx(apiCtx(path))),
        /TikTok returned an error/,
      );
    });
  });
});

test('a live signal reaches the probe request', async () => {
  await withStore(HEALTHY_DEFAULT, async (path) => {
    const controller = new AbortController();
    const stub = scriptFetch([ttEnvelope({ user: { open_id: 'test-open-id-DEFAULT' } })]);
    const ctx: ToolCtx = { ...toolCtx(apiCtx(path)), signal: controller.signal };
    const result = await withFetch(stub, async () =>
      getAuthStatusTool.handler({ probe: true }, ctx),
    );

    assert.equal(dataOf(result).profiles[0]?.probe?.ok, true);
    assert.equal(controller.signal.aborted, false);
  });
});

test('probe: false is the default and touches no network', async () => {
  await withStore(HEALTHY_DEFAULT, async (path) => {
    const stub = scriptFetch([]);
    const result = await withFetch(stub, async () =>
      getAuthStatusTool.handler({ probe: false }, toolCtx(apiCtx(path))),
    );

    assert.equal(stub.calls.length, 0);
    assert.equal(dataOf(result).profiles[0]?.probe, undefined);
  });
});

// ---------------------------------------------------------------------------
// the declared surface
// ---------------------------------------------------------------------------

test('cc-g1: the input schema is strict and carries the shared account argument', () => {
  assert.equal(
    getAuthStatusTool.input.safeParse({ probe: true, prboe: true }).success,
    false,
  );
  assert.equal(getAuthStatusTool.input.safeParse({ account: 'WORK' }).success, true);
  assert.equal(getAuthStatusTool.input.safeParse({}).success, true);
});

test('the tool that diagnoses a missing scope is never gated by one', () => {
  assert.deepEqual(getAuthStatusTool.scopes, []);
  assert.equal(getAuthStatusTool.package, 'auth');
  assert.equal(getAuthStatusTool.annotations.readOnlyHint, true);
});

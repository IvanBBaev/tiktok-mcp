/**
 * `src/api/endpoints.ts` — the `(method, path)` table that decides a request's
 * retry class (ARCHITECTURE § 6.3, roadmap ARC-R1).
 *
 * Three things are pinned here: the table fails closed (an unlisted write is
 * `init`), a caller can only make the class stricter, and every endpoint the
 * api layer calls is listed — so a new endpoint cannot inherit a retry class
 * by accident.
 */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { apiRequest, createApiContext, type ApiContext } from '../src/api/context.js';
import { OEMBED_ENDPOINT } from '../src/api/embed.js';
import {
  classifyEndpoint,
  effectiveRetryClass,
  ENDPOINTS,
} from '../src/api/endpoints.js';
import { isTikTokError } from '../src/core/errors.js';
import { createLogger } from '../src/core/log.js';
import { loadSettings } from '../src/core/settings.js';
import type { RefreshDeps } from '../src/core/oauth.js';
import { REPO_ROOT } from '../scripts/lib/repo.js';
import {
  baselineEnv,
  mockClock,
  runVirtual,
  scriptFetch,
  ttEnvelope,
  withFetch,
} from './helpers.js';

const UNLISTED_POST = '/v2/post/publish/unlisted/thing/';

function apiCtx(
  refresh?: (profile: string, deps: RefreshDeps) => Promise<string>,
): ApiContext {
  return createApiContext({
    profile: 'DEFAULT',
    settings: loadSettings({ ...baselineEnv(), TT_MAX_RETRIES: '3' }),
    log: createLogger({ level: 'error' }),
    clock: mockClock(),
    refresh: refresh ?? (() => Promise.resolve('test-access-token-DEFAULT')),
  });
}

/** A fetch stub that fails every attempt with a transport error. */
function resettingFetch(): { calls: number; stub: typeof globalThis.fetch } {
  const state = {
    calls: 0,
    stub: (() => {
      state.calls += 1;
      return Promise.reject(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        }),
      );
    }) as typeof globalThis.fetch,
  };
  return state;
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

test('arc-r1: listed endpoints get their listed class', () => {
  for (const entry of ENDPOINTS) {
    assert.equal(
      classifyEndpoint(entry.method, entry.path),
      entry.retryClass,
      entry.path,
    );
  }
  assert.equal(classifyEndpoint('POST', '/v2/video/list/'), 'read');
  assert.equal(classifyEndpoint('POST', '/v2/post/publish/video/init/'), 'init');
});

test('arc-r1: an unlisted non-GET fails closed to init', () => {
  assert.equal(classifyEndpoint('POST', UNLISTED_POST), 'init');
  // A listed read path under another method is not that read.
  assert.equal(classifyEndpoint('POST', '/v2/user/info/'), 'init');
});

test('arc-r1: a chunk PUT is chunk and an unlisted GET is read', () => {
  assert.equal(classifyEndpoint('PUT', '/upload/'), 'chunk');
  assert.equal(classifyEndpoint('GET', '/v2/some/new/read/'), 'read');
});

test('arc-r1: a caller may only make the class stricter', () => {
  assert.equal(effectiveRetryClass('GET', '/v2/user/info/', 'init'), 'init');
  assert.equal(effectiveRetryClass('GET', '/v2/user/info/', 'chunk'), 'chunk');
  assert.equal(effectiveRetryClass('GET', '/v2/user/info/'), 'read');
  assert.equal(
    effectiveRetryClass('POST', '/v2/post/publish/video/init/', 'read'),
    'init',
  );
  assert.equal(effectiveRetryClass('POST', UNLISTED_POST, 'read'), 'init');
  assert.equal(effectiveRetryClass('PUT', '/upload/', 'read'), 'chunk');
});

test('arc-r1: every endpoint used in src/api is in the table, and no entry is stale', async () => {
  const dir = join(REPO_ROOT, 'src', 'api');
  const files = (await readdir(dir)).filter(
    (name) => name.endsWith('.ts') && name !== 'endpoints.ts',
  );
  const used = new Set<string>();
  for (const name of files) {
    const text = await readFile(join(dir, name), 'utf8');
    for (const match of text.matchAll(/['"`](\/v2\/[a-z0-9_/]+)['"`]/g)) {
      used.add(match[1] as string);
    }
  }
  used.add(new URL(OEMBED_ENDPOINT).pathname);

  const listed = new Set(ENDPOINTS.map((entry) => entry.path));
  assert.ok(
    used.size >= 9,
    `expected the api layer's endpoints, found ${String(used.size)}`,
  );
  for (const path of used) {
    assert.ok(
      listed.has(path),
      `${path} is called from src/api but missing from ENDPOINTS`,
    );
  }
  for (const path of listed) {
    assert.ok(used.has(path), `${path} is in ENDPOINTS but no src/api module calls it`);
  }
});

// ---------------------------------------------------------------------------
// apiRequest under the table
// ---------------------------------------------------------------------------

test('arc-r1: a POST to an unlisted path is not retried on 503', async () => {
  const stub = scriptFetch([
    new Response('upstream unavailable', { status: 503 }),
    ttEnvelope({ never: 'reached' }),
  ]);

  await withFetch(stub, async () => {
    await assert.rejects(
      apiRequest(apiCtx(), { method: 'POST', path: UNLISTED_POST, body: {} }),
      (error: unknown) => isTikTokError(error),
    );
  });

  assert.equal(stub.calls.length, 1);
});

test('arc-r1: a POST to an unlisted path is not retried on a network reset', async () => {
  const fetch = resettingFetch();

  await withFetch(fetch.stub, async () => {
    await assert.rejects(
      // A looser hint is ignored: the table says `init`.
      apiRequest(apiCtx(), {
        method: 'POST',
        path: UNLISTED_POST,
        body: {},
        retryClass: 'read',
      }),
      (error: unknown) => isTikTokError(error),
    );
  });

  assert.equal(fetch.calls, 1);
});

test('arc-r1: a POST to an unlisted path is not replayed after a 401', async () => {
  const stub = scriptFetch([
    ttEnvelope(undefined, { code: 'access_token_invalid', message: 'expired' }),
    ttEnvelope({ never: 'reached' }),
  ]);
  const forced: boolean[] = [];
  const ctx = apiCtx((_profile, deps) => {
    forced.push(deps.force === true);
    return Promise.resolve('token');
  });

  await withFetch(stub, async () => {
    await assert.rejects(
      apiRequest(ctx, { method: 'POST', path: UNLISTED_POST, body: {} }),
      (error: unknown) =>
        isTikTokError(error) && error.apiCode === 'access_token_invalid',
    );
  });

  assert.equal(stub.calls.length, 1);
  assert.deepEqual(forced, [false]);
});

test('arc-r1: a listed read POST is still retried on 503', async () => {
  const stub = scriptFetch([
    new Response('upstream unavailable', { status: 503 }),
    ttEnvelope({ videos: [] }),
  ]);

  const clock = mockClock();
  const ctx = createApiContext({
    profile: 'DEFAULT',
    settings: loadSettings({ ...baselineEnv(), TT_MAX_RETRIES: '3' }),
    log: createLogger({ level: 'error' }),
    clock,
    refresh: () => Promise.resolve('test-access-token-DEFAULT'),
  });

  await withFetch(stub, async () => {
    // The backoff sleeps on virtual time: step it until the retry lands.
    await runVirtual(
      clock,
      apiRequest(ctx, {
        method: 'POST',
        path: '/v2/video/list/',
        fields: ['id'],
        body: {},
      }),
    );
  });

  assert.equal(stub.calls.length, 2);
});

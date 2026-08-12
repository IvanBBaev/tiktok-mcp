/**
 * `src/api/user.ts` — `GET /v2/user/info/`.
 *
 * The module is thin on purpose, so the tests are about the two things that are
 * not: `fields` is a required query parameter and is validated locally against
 * the documented vocabulary (a typo must not cost a round trip), and a 200 that
 * omits the `user` object is an upstream shape change rather than a crash.
 *
 * `USER_FIELD_SCOPES` is the map the tool layer uses to drop ungrantable fields
 * before the request, so its completeness is asserted here rather than assumed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiContext, type ApiContext } from '../src/api/context.js';
import { getUserInfo, USER_FIELD_SCOPES, USER_FIELDS } from '../src/api/user.js';
import { isTikTokError } from '../src/core/errors.js';
import { createLogger } from '../src/core/log.js';
import { loadSettings } from '../src/core/settings.js';
import { baselineEnv, mockClock, scriptFetch, ttEnvelope, withFetch } from './helpers.js';

const NOOP_LOGGER = createLogger({ level: 'error' });

function apiCtx(): ApiContext {
  return createApiContext({
    profile: 'DEFAULT',
    settings: loadSettings(baselineEnv()),
    log: NOOP_LOGGER,
    clock: mockClock(),
    refresh: () => Promise.resolve('test-access-token-DEFAULT'),
  });
}

test('getUserInfo sends the requested fields verbatim and returns the user object', async () => {
  const stub = scriptFetch([
    ttEnvelope({ user: { open_id: 'open-id-1', display_name: 'Ada' } }),
  ]);
  const user = await withFetch(stub, async () =>
    getUserInfo(apiCtx(), ['open_id', 'display_name']),
  );

  assert.deepEqual(user, { open_id: 'open-id-1', display_name: 'Ada' });
  assert.equal(stub.calls[0]?.method, 'GET');
  assert.equal(
    stub.calls[0]?.url,
    'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name',
  );
  // A GET carries no body — `core/http` rejects one outright.
  assert.equal(stub.calls[0]?.body, undefined);
});

test('an empty field list fails locally, before any request', async () => {
  const stub = scriptFetch([]);
  await withFetch(stub, async () => {
    await assert.rejects(getUserInfo(apiCtx(), []), (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.kind, 'validation');
      assert.equal(error.code, 'invalid_params');
      assert.ok(error.message.includes('No request was sent to TikTok.'));
      return true;
    });
  });
  assert.equal(stub.calls.length, 0);
});

test('an undocumented field name fails locally and names the vocabulary', async () => {
  const stub = scriptFetch([]);
  await withFetch(stub, async () => {
    await assert.rejects(
      getUserInfo(apiCtx(), ['open_id', 'follower_kount']),
      (error: unknown) => {
        assert.ok(isTikTokError(error));
        assert.equal(error.code, 'invalid_params');
        assert.ok(error.message.includes("'follower_kount'"));
        assert.ok(error.message.includes('video_count'));
        return true;
      },
    );
  });
  assert.equal(stub.calls.length, 0);
});

test('a 200 without the user object reads as an upstream shape change', async () => {
  const stub = scriptFetch([ttEnvelope({})]);
  await withFetch(stub, async () => {
    await assert.rejects(getUserInfo(apiCtx(), ['open_id']), (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.kind, 'api');
      assert.equal(error.code, 'upstream_error');
      assert.ok(error.message.includes('user object'));
      return true;
    });
  });
});

test('an already-aborted signal stops the call at the transport', async () => {
  const stub = scriptFetch([ttEnvelope({ user: { open_id: 'x' } })]);
  const controller = new AbortController();
  controller.abort(new Error('caller went away'));

  await withFetch(stub, async () => {
    await assert.rejects(
      getUserInfo(apiCtx(), ['open_id'], { signal: controller.signal }),
      /caller went away|abort/i,
    );
  });
});

test('every documented field maps to a scope, and the map has no extras', () => {
  const mapped = Object.keys(USER_FIELD_SCOPES);
  assert.deepEqual([...mapped].sort(), [...USER_FIELDS].sort());
  for (const field of USER_FIELDS) {
    const scope = USER_FIELD_SCOPES[field];
    assert.ok(
      ['user.info.basic', 'user.info.profile', 'user.info.stats'].includes(scope),
      `${field} maps to an unknown scope: ${scope}`,
    );
  }
});

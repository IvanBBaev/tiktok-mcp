/**
 * `src/api/video.ts` — `POST /v2/video/list/` and `POST /v2/video/query/`.
 *
 * The corner cases this module owns are the ones that cost a caller money if
 * they are guessed, so each has its own case: the cursor is opaque and
 * round-trips in the JSON type TikTok used (CC-C1), an empty page with
 * `has_more: true` is legal (CC-C2), `max_count` is clamped locally rather than
 * sent out of range (CC-C5), more than 20 ids is a local rejection (CC-C6), and
 * ids TikTok silently omits come back as `missingIds` (CC-C7).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiContext, type ApiContext } from '../src/api/context.js';
import {
  DEFAULT_VIDEO_FIELDS,
  listVideos,
  MAX_QUERY_IDS,
  queryVideos,
  VIDEO_FIELDS,
} from '../src/api/video.js';
import { isTikTokError } from '../src/core/errors.js';
import { createLogger } from '../src/core/log.js';
import { loadSettings } from '../src/core/settings.js';
import {
  baselineEnv,
  mockClock,
  scriptFetch,
  ttEnvelope,
  withFetch,
  type RecordedCall,
} from './helpers.js';

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

/** The JSON body of a recorded call, as a plain record. */
function bodyOf(call: RecordedCall | undefined): Record<string, unknown> {
  assert.ok(call !== undefined, 'expected a recorded request');
  return call.json() as Record<string, unknown>;
}

/** The `fields` query parameter of a recorded call, split back into names. */
function fieldsOf(call: RecordedCall | undefined): string[] {
  assert.ok(call !== undefined, 'expected a recorded request');
  const query = new URL(call.url).searchParams.get('fields');
  assert.ok(query !== null, 'expected a fields query parameter');
  return query.split(',');
}

// ---------------------------------------------------------------------------
// listVideos
// ---------------------------------------------------------------------------

test('listVideos requests the default field set and the full page size', async () => {
  const stub = scriptFetch([ttEnvelope({ videos: [], cursor: 0, has_more: false })]);
  const page = await withFetch(stub, async () => listVideos(apiCtx(), {}));

  assert.equal(stub.calls[0]?.method, 'POST');
  assert.equal(new URL(stub.calls[0]?.url ?? '').pathname, '/v2/video/list/');
  assert.deepEqual(fieldsOf(stub.calls[0]), [...DEFAULT_VIDEO_FIELDS]);
  assert.deepEqual(bodyOf(stub.calls[0]), { max_count: 20 });
  assert.deepEqual(page, { videos: [], cursor: '0', hasMore: false });
});

test('the id is always requested, whatever fields the caller asked for', async () => {
  const stub = scriptFetch([ttEnvelope({ videos: [], has_more: false })]);
  await withFetch(stub, async () => listVideos(apiCtx(), { fields: ['title'] }));

  assert.deepEqual(fieldsOf(stub.calls[0]), ['id', 'title']);
});

test('cc-c5: max_count is clamped into 1–20 instead of being sent out of range', async () => {
  const stub = scriptFetch([
    ttEnvelope({ videos: [], has_more: false }),
    ttEnvelope({ videos: [], has_more: false }),
    ttEnvelope({ videos: [], has_more: false }),
  ]);
  await withFetch(stub, async () => {
    await listVideos(apiCtx(), { maxCount: 0 });
    await listVideos(apiCtx(), { maxCount: 999 });
    await listVideos(apiCtx(), { maxCount: 7.9 });
  });

  assert.equal(bodyOf(stub.calls[0])['max_count'], 1);
  assert.equal(bodyOf(stub.calls[1])['max_count'], 20);
  assert.equal(bodyOf(stub.calls[2])['max_count'], 7);
});

test('cc-c1: a numeric cursor round-trips as a JSON number, anything else as a string', async () => {
  const stub = scriptFetch([
    ttEnvelope({ videos: [], has_more: false }),
    ttEnvelope({ videos: [], has_more: false }),
    ttEnvelope({ videos: [], has_more: false }),
  ]);
  await withFetch(stub, async () => {
    await listVideos(apiCtx(), { cursor: '1712345678000' });
    await listVideos(apiCtx(), { cursor: 'eyJvZmZzZXQiOjIwfQ==' });
    // Too large for a lossless number round trip: echoed verbatim, not rounded.
    await listVideos(apiCtx(), { cursor: '99999999999999999999' });
  });

  assert.equal(bodyOf(stub.calls[0])['cursor'], 1712345678000);
  assert.equal(bodyOf(stub.calls[1])['cursor'], 'eyJvZmZzZXQiOjIwfQ==');
  assert.equal(bodyOf(stub.calls[2])['cursor'], '99999999999999999999');
});

test('cc-c1: no cursor means "from the start" — the key is absent, not empty', async () => {
  const stub = scriptFetch([ttEnvelope({ videos: [], has_more: false })]);
  await withFetch(stub, async () => listVideos(apiCtx(), {}));

  assert.equal('cursor' in bodyOf(stub.calls[0]), false);
});

test('cc-c1: the response cursor is carried as an opaque string, never parsed', async () => {
  const stub = scriptFetch([
    ttEnvelope({ videos: [], cursor: 1712345678000, has_more: true }),
    ttEnvelope({ videos: [], cursor: 'opaque-token', has_more: true }),
    ttEnvelope({ videos: [], has_more: true }),
    ttEnvelope({ videos: [], cursor: null, has_more: true }),
  ]);
  const pages = await withFetch(stub, async () => [
    await listVideos(apiCtx(), {}),
    await listVideos(apiCtx(), {}),
    await listVideos(apiCtx(), {}),
    await listVideos(apiCtx(), {}),
  ]);

  assert.deepEqual(
    pages.map((page) => page.cursor),
    ['1712345678000', 'opaque-token', '', ''],
  );
});

test('cc-c2: an empty page with has_more true is legal, not an error', async () => {
  const stub = scriptFetch([ttEnvelope({ cursor: 5, has_more: true })]);
  const page = await withFetch(stub, async () => listVideos(apiCtx(), {}));

  assert.deepEqual(page, { videos: [], cursor: '5', hasMore: true });
});

test('has_more is true only when TikTok says so literally', async () => {
  const stub = scriptFetch([
    ttEnvelope({ videos: [], has_more: 'true' }),
    ttEnvelope({ videos: [] }),
  ]);
  const pages = await withFetch(stub, async () => [
    await listVideos(apiCtx(), {}),
    await listVideos(apiCtx(), {}),
  ]);

  assert.deepEqual(
    pages.map((page) => page.hasMore),
    [false, false],
  );
});

test('a videos member that is not an array reads as an upstream shape change', async () => {
  const stub = scriptFetch([ttEnvelope({ videos: { id: '1' }, has_more: false })]);
  await withFetch(stub, async () => {
    await assert.rejects(listVideos(apiCtx(), {}), (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.code, 'upstream_error');
      assert.ok(error.message.includes('/v2/video/list/'));
      assert.ok(error.message.includes('videos array'));
      return true;
    });
  });
});

test('an undocumented field name fails locally, before any request', async () => {
  const stub = scriptFetch([]);
  await withFetch(stub, async () => {
    await assert.rejects(
      listVideos(apiCtx(), { fields: ['title', 'view_kount'] }),
      (error: unknown) => {
        assert.ok(isTikTokError(error));
        assert.equal(error.kind, 'validation');
        assert.equal(error.code, 'invalid_params');
        assert.ok(error.message.includes("'view_kount'"));
        return true;
      },
    );
    await assert.rejects(listVideos(apiCtx(), { fields: [] }), (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.code, 'invalid_params');
      assert.ok(error.message.includes('at least one video field'));
      return true;
    });
  });
  assert.equal(stub.calls.length, 0);
});

test('every advertised video field is accepted by the request path', async () => {
  const stub = scriptFetch([ttEnvelope({ videos: [], has_more: false })]);
  await withFetch(stub, async () => listVideos(apiCtx(), { fields: VIDEO_FIELDS }));

  assert.deepEqual(fieldsOf(stub.calls[0]), [...VIDEO_FIELDS]);
});

// ---------------------------------------------------------------------------
// queryVideos
// ---------------------------------------------------------------------------

test('queryVideos filters by id and returns what TikTok sent', async () => {
  const stub = scriptFetch([
    ttEnvelope({ videos: [{ id: 'v1', title: 'one' }, { id: 'v2' }] }),
  ]);
  const result = await withFetch(stub, async () =>
    queryVideos(apiCtx(), ['v1', 'v2'], { fields: ['id', 'title'] }),
  );

  assert.equal(new URL(stub.calls[0]?.url ?? '').pathname, '/v2/video/query/');
  assert.deepEqual(bodyOf(stub.calls[0]), { filters: { video_ids: ['v1', 'v2'] } });
  assert.deepEqual(result.videos, [{ id: 'v1', title: 'one' }, { id: 'v2' }]);
  assert.deepEqual(result.missingIds, []);
});

test('cc-c7: ids TikTok omits are reported back rather than silently dropped', async () => {
  const stub = scriptFetch([ttEnvelope({ videos: [{ id: 'v2' }] })]);
  const result = await withFetch(stub, async () =>
    queryVideos(apiCtx(), ['v1', 'v2', 'v3']),
  );

  assert.deepEqual(result.missingIds, ['v1', 'v3']);
  assert.deepEqual(
    result.videos.map((video) => video.id),
    ['v2'],
  );
});

test('cc-c6: more than 20 ids is a local rejection that says how to split', async () => {
  const stub = scriptFetch([]);
  const ids = Array.from({ length: MAX_QUERY_IDS + 1 }, (_unused, i) => `v${String(i)}`);

  await withFetch(stub, async () => {
    await assert.rejects(queryVideos(apiCtx(), ids), (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.kind, 'validation');
      assert.equal(error.code, 'invalid_params');
      assert.ok(error.message.includes('21 ids were requested'));
      assert.ok(error.message.includes('batches of 20'));
      return true;
    });
  });
  assert.equal(stub.calls.length, 0);
});

test('exactly 20 ids is accepted — the cap is inclusive', async () => {
  const stub = scriptFetch([ttEnvelope({ videos: [] })]);
  const ids = Array.from({ length: MAX_QUERY_IDS }, (_unused, i) => `v${String(i)}`);
  const result = await withFetch(stub, async () => queryVideos(apiCtx(), ids));

  assert.equal(stub.calls.length, 1);
  assert.deepEqual(result.missingIds, ids);
});

test('an empty or blank id list fails locally', async () => {
  const stub = scriptFetch([]);
  await withFetch(stub, async () => {
    await assert.rejects(queryVideos(apiCtx(), []), (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.ok(error.message.includes('at least one video id'));
      return true;
    });
    await assert.rejects(queryVideos(apiCtx(), ['v1', '   ']), (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.ok(error.message.includes('must not be empty'));
      return true;
    });
    await assert.rejects(
      queryVideos(apiCtx(), ['v1'], { fields: ['nope'] }),
      (error: unknown) => {
        assert.ok(isTikTokError(error));
        assert.equal(error.code, 'invalid_params');
        return true;
      },
    );
  });
  assert.equal(stub.calls.length, 0);
});

test('a missing videos member on query is an empty answer, not a crash', async () => {
  const stub = scriptFetch([ttEnvelope({})]);
  const result = await withFetch(stub, async () => queryVideos(apiCtx(), ['v1']));

  assert.deepEqual(result, { videos: [], missingIds: ['v1'] });
});

test('an already-aborted signal stops the query at the transport', async () => {
  const stub = scriptFetch([ttEnvelope({ videos: [] })]);
  const controller = new AbortController();
  controller.abort(new Error('caller went away'));

  await withFetch(stub, async () => {
    await assert.rejects(
      queryVideos(apiCtx(), ['v1'], { signal: controller.signal }),
      /caller went away|abort/i,
    );
  });
});

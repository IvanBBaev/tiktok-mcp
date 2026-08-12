/**
 * `src/api/publish.ts` — the Content Posting API and the validation in front of
 * it.
 *
 * The cases are weighted towards what happens *before* the network: every rule
 * that fires locally is a post TikTok would have rejected (or a guideline
 * violation an audit would have caught) at the price of a burnt publish
 * attempt. So each corner case gets its own case — privacy comes from the live
 * creator_info (CC-E1), branded content cannot be private (CC-E2), captions are
 * capped in UTF-16 code units (CC-E3), creator-disabled interactions are forced
 * rather than argued with (CC-E4), and a carousel is 1–35 photos with a cover
 * index inside it (CC-E9) — plus the two properties an init must have: it is
 * attempted exactly once, and the `upload_token` it returns becomes a secret.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiContext, type ApiContext } from '../src/api/context.js';
import {
  auditRestrictionsActive,
  getCreatorInfo,
  getPublishStatus,
  initDraftUpload,
  initPhotoPost,
  initVideoPost,
  isTerminalStatus,
  MAX_PHOTOS,
  PHOTO_DESCRIPTION_MAX,
  PHOTO_TITLE_MAX,
  PRIVACY_LEVELS,
  resolvePhotoPostInfo,
  resolveVideoPostInfo,
  validatePhotoSource,
  VIDEO_TITLE_MAX,
  type CreatorInfo,
} from '../src/api/publish.js';
import { isTikTokError } from '../src/core/errors.js';
import { createLogger } from '../src/core/log.js';
import { redactText } from '../src/core/redact.js';
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

function bodyOf(call: RecordedCall | undefined): Record<string, unknown> {
  assert.ok(call !== undefined, 'expected a recorded request');
  return call.json() as Record<string, unknown>;
}

/** An audited creator with everything open — the baseline the cases deviate from. */
function creator(overrides: Partial<CreatorInfo> = {}): CreatorInfo {
  return {
    nickname: 'Test Creator',
    username: 'test.creator',
    privacyLevelOptions: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
    commentDisabled: false,
    duetDisabled: false,
    stitchDisabled: false,
    maxVideoPostDurationSec: 600,
    ...overrides,
  };
}

const DEFAULTS = { isAigc: true };

/** The upstream creator_info payload, fully populated. */
const CREATOR_PAYLOAD = {
  creator_avatar_url: 'https://p16.tiktokcdn.com/avatar.jpeg',
  creator_username: 'test.creator',
  creator_nickname: 'Test Creator',
  privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
  comment_disabled: false,
  duet_disabled: true,
  stitch_disabled: false,
  max_video_post_duration_sec: 300,
};

// ---------------------------------------------------------------------------
// creator_info
// ---------------------------------------------------------------------------

test('getCreatorInfo posts an empty body to the creator_info endpoint, with no fields query', async () => {
  const stub = scriptFetch([ttEnvelope(CREATOR_PAYLOAD)]);
  const info = await withFetch(stub, async () => getCreatorInfo(apiCtx()));

  const call = stub.calls[0];
  assert.equal(call?.method, 'POST');
  const url = new URL(call?.url ?? '');
  assert.equal(url.pathname, '/v2/post/publish/creator_info/query/');
  // The Content Posting API selects nothing: an empty `?fields=` would read as
  // a malformed request rather than as "no fields".
  assert.equal(url.search, '');
  assert.deepEqual(bodyOf(call), {});

  assert.deepEqual(info, {
    nickname: 'Test Creator',
    username: 'test.creator',
    avatarUrl: 'https://p16.tiktokcdn.com/avatar.jpeg',
    privacyLevelOptions: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
    commentDisabled: false,
    duetDisabled: true,
    stitchDisabled: false,
    maxVideoPostDurationSec: 300,
  });
});

test('absent creator_info members read as "not disabled" and stay absent', async () => {
  const stub = scriptFetch([ttEnvelope({ privacy_level_options: ['SELF_ONLY'] })]);
  const info = await withFetch(stub, async () => getCreatorInfo(apiCtx()));

  assert.deepEqual(info, {
    nickname: '',
    username: '',
    privacyLevelOptions: ['SELF_ONLY'],
    commentDisabled: false,
    duetDisabled: false,
    stitchDisabled: false,
  });
  assert.equal('avatarUrl' in info, false);
  assert.equal('maxVideoPostDurationSec' in info, false);
});

test('privacy_level_options is the one member a shape change cannot survive', async () => {
  const stub = scriptFetch([
    ttEnvelope({ privacy_level_options: 'SELF_ONLY' }),
    ttEnvelope({ privacy_level_options: ['SELF_ONLY', 7] }),
    ttEnvelope({}),
  ]);
  await withFetch(stub, async () => {
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(getCreatorInfo(apiCtx()), (error: unknown) => {
        assert.ok(isTikTokError(error));
        assert.equal(error.code, 'upstream_error');
        assert.ok(error.message.includes('privacy_level_options string array'));
        return true;
      });
    }
  });
});

test('audit_restrictions_active is true exactly when SELF_ONLY is the only option', () => {
  assert.equal(
    auditRestrictionsActive(creator({ privacyLevelOptions: ['SELF_ONLY'] })),
    true,
  );
  assert.equal(
    auditRestrictionsActive(
      creator({ privacyLevelOptions: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'] }),
    ),
    false,
  );
  assert.equal(auditRestrictionsActive(creator({ privacyLevelOptions: [] })), false);
  assert.equal(
    auditRestrictionsActive(creator({ privacyLevelOptions: ['PUBLIC_TO_EVERYONE'] })),
    false,
  );
});

// ---------------------------------------------------------------------------
// resolveVideoPostInfo
// ---------------------------------------------------------------------------

test('a resolved video post_info carries exactly the documented upstream keys', () => {
  const resolved = resolveVideoPostInfo(
    {
      title: 'Hello #world',
      privacyLevel: 'PUBLIC_TO_EVERYONE',
      videoCoverTimestampMs: 1500,
      brandOrganicToggle: true,
      isAigc: false,
    },
    creator(),
    DEFAULTS,
  );

  assert.deepEqual(resolved.postInfo, {
    title: 'Hello #world',
    privacy_level: 'PUBLIC_TO_EVERYONE',
    disable_comment: false,
    disable_duet: false,
    disable_stitch: false,
    video_cover_timestamp_ms: 1500,
    brand_content_toggle: false,
    brand_organic_toggle: true,
    is_aigc: false,
  });
  // Nothing was forced and nothing came from an env default.
  assert.deepEqual(resolved.derived, []);
});

test('re-resolving the same request reproduces the payload byte-for-byte', () => {
  const input = { title: 'Same', privacyLevel: 'SELF_ONLY' };
  const first = resolveVideoPostInfo(input, creator(), DEFAULTS);
  const second = resolveVideoPostInfo(input, creator(), DEFAULTS);

  assert.equal(JSON.stringify(first.postInfo), JSON.stringify(second.postInfo));
});

test('is_aigc falls back to the server default and says so in derived', () => {
  const resolved = resolveVideoPostInfo(
    { privacyLevel: 'SELF_ONLY' },
    creator(),
    DEFAULTS,
  );

  assert.equal(resolved.postInfo['is_aigc'], true);
  assert.deepEqual(resolved.derived, [
    {
      field: 'is_aigc',
      value: true,
      reason: 'defaulted from the server setting TT_DEFAULT_AIGC_LABEL',
    },
  ]);
});

test('an absent or empty title is sent as no title at all', () => {
  const absent = resolveVideoPostInfo({ privacyLevel: 'SELF_ONLY' }, creator(), DEFAULTS);
  const empty = resolveVideoPostInfo(
    { title: '', privacyLevel: 'SELF_ONLY' },
    creator(),
    DEFAULTS,
  );

  assert.equal('title' in absent.postInfo, false);
  assert.equal('title' in empty.postInfo, false);
});

test('cc-e3: the caption cap counts UTF-16 code units, so an emoji costs two', () => {
  const atLimit = '\u{1F600}'.repeat(VIDEO_TITLE_MAX / 2);
  assert.equal(atLimit.length, VIDEO_TITLE_MAX);
  assert.doesNotThrow(() =>
    resolveVideoPostInfo(
      { title: atLimit, privacyLevel: 'SELF_ONLY' },
      creator(),
      DEFAULTS,
    ),
  );

  assert.throws(
    () =>
      resolveVideoPostInfo(
        { title: `${atLimit}\u{1F600}`, privacyLevel: 'SELF_ONLY' },
        creator(),
        DEFAULTS,
      ),
    (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.kind, 'validation');
      assert.equal(error.code, 'invalid_params');
      assert.ok(error.message.includes('2202'));
      assert.ok(error.message.includes(String(VIDEO_TITLE_MAX)));
      assert.ok(error.message.includes('UTF-16'));
      return true;
    },
  );
});

test('cc-e1: privacy must come from the live creator_info, whatever the vocabulary says', () => {
  assert.ok(PRIVACY_LEVELS.includes('FOLLOWER_OF_CREATOR'));

  assert.throws(
    () =>
      resolveVideoPostInfo(
        { privacyLevel: 'FOLLOWER_OF_CREATOR' },
        creator({ privacyLevelOptions: ['SELF_ONLY'] }),
        DEFAULTS,
      ),
    (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.kind, 'validation');
      assert.equal(error.code, 'privacy_level_unavailable');
      assert.equal(error.retryable, false);
      assert.ok(error.message.includes("privacy_level 'FOLLOWER_OF_CREATOR'"));
      assert.ok(error.message.includes('Available options: SELF_ONLY'));
      return true;
    },
  );
});

test('cc-e1: an account with no posting options at all still gets a readable refusal', () => {
  assert.throws(
    () =>
      resolveVideoPostInfo(
        { privacyLevel: 'SELF_ONLY' },
        creator({ privacyLevelOptions: [] }),
        DEFAULTS,
      ),
    (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.ok(error.message.includes('Available options: (none)'));
      return true;
    },
  );
});

test('cc-e2: branded content cannot be combined with SELF_ONLY', () => {
  assert.throws(
    () =>
      resolveVideoPostInfo(
        { privacyLevel: 'SELF_ONLY', brandContentToggle: true },
        creator(),
        DEFAULTS,
      ),
    (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.kind, 'validation');
      assert.equal(error.code, 'branded_content_privacy_conflict');
      assert.equal(error.retryable, false);
      assert.ok(error.message.includes('brand_content_toggle: true'));
      assert.ok(error.message.includes('SELF_ONLY'));
      return true;
    },
  );

  // The organic toggle is a different thing and is not restricted.
  assert.doesNotThrow(() =>
    resolveVideoPostInfo(
      { privacyLevel: 'SELF_ONLY', brandOrganicToggle: true },
      creator(),
      DEFAULTS,
    ),
  );
});

test('cc-e1 before cc-e2: an unavailable privacy level is reported before the conflict it would cause', () => {
  assert.throws(
    () =>
      resolveVideoPostInfo(
        { privacyLevel: 'SELF_ONLY', brandContentToggle: true },
        creator({ privacyLevelOptions: ['PUBLIC_TO_EVERYONE'] }),
        DEFAULTS,
      ),
    (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.code, 'privacy_level_unavailable');
      return true;
    },
  );
});

test('cc-e4: creator-level switches force the payload and are reported in derived', () => {
  const resolved = resolveVideoPostInfo(
    { privacyLevel: 'SELF_ONLY', disableDuet: true, isAigc: true },
    creator({ commentDisabled: true, duetDisabled: true, stitchDisabled: true }),
    DEFAULTS,
  );

  assert.equal(resolved.postInfo['disable_comment'], true);
  assert.equal(resolved.postInfo['disable_duet'], true);
  assert.equal(resolved.postInfo['disable_stitch'], true);
  // `disable_duet` was already requested, so nothing was forced for it.
  assert.deepEqual(
    resolved.derived.map((entry) => entry.field),
    ['disable_comment', 'disable_stitch'],
  );
  assert.ok(resolved.derived[0]?.reason.includes('comments'));
  assert.equal(resolved.derived[0]?.value, true);
});

test('cc-e4: a creator who allows an interaction keeps the caller’s choice', () => {
  const resolved = resolveVideoPostInfo(
    { privacyLevel: 'SELF_ONLY', disableComment: true, isAigc: true },
    creator(),
    DEFAULTS,
  );

  assert.equal(resolved.postInfo['disable_comment'], true);
  assert.deepEqual(resolved.derived, []);
});

test('a cover timestamp must be a non-negative whole number of milliseconds', () => {
  for (const cover of [-1, 1.5, Number.NaN]) {
    assert.throws(
      () =>
        resolveVideoPostInfo(
          { privacyLevel: 'SELF_ONLY', videoCoverTimestampMs: cover },
          creator(),
          DEFAULTS,
        ),
      (error: unknown) => {
        assert.ok(isTikTokError(error));
        assert.equal(error.code, 'invalid_params');
        assert.ok(error.message.includes('video_cover_timestamp_ms'));
        return true;
      },
    );
  }

  const zero = resolveVideoPostInfo(
    { privacyLevel: 'SELF_ONLY', videoCoverTimestampMs: 0, isAigc: true },
    creator(),
    DEFAULTS,
  );
  assert.equal(zero.postInfo['video_cover_timestamp_ms'], 0);
});

// ---------------------------------------------------------------------------
// resolvePhotoPostInfo
// ---------------------------------------------------------------------------

test('a resolved photo post_info has no duet/stitch keys and its own caption caps', () => {
  const resolved = resolvePhotoPostInfo(
    {
      title: 'Carousel',
      description: 'A description',
      privacyLevel: 'PUBLIC_TO_EVERYONE',
      autoAddMusic: true,
      isAigc: false,
    },
    creator(),
    DEFAULTS,
  );

  assert.deepEqual(resolved.postInfo, {
    title: 'Carousel',
    description: 'A description',
    privacy_level: 'PUBLIC_TO_EVERYONE',
    disable_comment: false,
    auto_add_music: true,
    brand_content_toggle: false,
    brand_organic_toggle: false,
    is_aigc: false,
  });
});

test('cc-e3: photo captions are capped at 90 and 4000 UTF-16 code units', () => {
  assert.throws(
    () =>
      resolvePhotoPostInfo(
        { title: 'x'.repeat(PHOTO_TITLE_MAX + 1), privacyLevel: 'SELF_ONLY' },
        creator(),
        DEFAULTS,
      ),
    (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.code, 'invalid_params');
      assert.ok(error.message.startsWith('Invalid arguments: title:'));
      return true;
    },
  );

  assert.throws(
    () =>
      resolvePhotoPostInfo(
        {
          title: 'ok',
          description: 'x'.repeat(PHOTO_DESCRIPTION_MAX + 1),
          privacyLevel: 'SELF_ONLY',
        },
        creator(),
        DEFAULTS,
      ),
    (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.ok(error.message.includes('description:'));
      return true;
    },
  );
});

test('cc-e4: a creator with comments disabled forces the photo payload too', () => {
  const resolved = resolvePhotoPostInfo(
    { privacyLevel: 'SELF_ONLY' },
    creator({ commentDisabled: true, duetDisabled: true }),
    DEFAULTS,
  );

  assert.equal(resolved.postInfo['disable_comment'], true);
  assert.deepEqual(
    resolved.derived.map((entry) => entry.field),
    ['disable_comment', 'is_aigc'],
  );
});

test('cc-e2 applies to photos as well', () => {
  assert.throws(
    () =>
      resolvePhotoPostInfo(
        { privacyLevel: 'SELF_ONLY', brandContentToggle: true },
        creator(),
        DEFAULTS,
      ),
    (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.code, 'branded_content_privacy_conflict');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// cc-e9
// ---------------------------------------------------------------------------

test('cc-e9: a carousel needs between 1 and 35 photos', () => {
  assert.throws(
    () => validatePhotoSource([], 0),
    (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.code, 'invalid_params');
      assert.ok(error.message.includes('at least one photo URL'));
      return true;
    },
  );

  const tooMany = Array.from(
    { length: MAX_PHOTOS + 1 },
    (_unused, i) => `https://example.com/${String(i)}.jpg`,
  );
  assert.throws(
    () => validatePhotoSource(tooMany, 0),
    (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.ok(error.message.includes('36 photos'));
      assert.ok(error.message.includes('at most 35'));
      return true;
    },
  );

  assert.doesNotThrow(() => validatePhotoSource(tooMany.slice(0, MAX_PHOTOS), 34));
});

test('cc-e9: the cover index must point at one of the photos', () => {
  const photos = ['https://example.com/a.jpg', 'https://example.com/b.jpg'];
  for (const index of [-1, 2, 1.5]) {
    assert.throws(
      () => validatePhotoSource(photos, index),
      (error: unknown) => {
        assert.ok(isTikTokError(error));
        assert.equal(error.code, 'invalid_params');
        assert.ok(error.message.includes('photo_cover_index'));
        assert.ok(error.message.includes('between 0 and 1'));
        return true;
      },
    );
  }
  assert.doesNotThrow(() => validatePhotoSource(photos, 0));
  assert.doesNotThrow(() => validatePhotoSource(photos, 1));
});

// ---------------------------------------------------------------------------
// Init calls
// ---------------------------------------------------------------------------

const POST_INFO = { privacy_level: 'SELF_ONLY', is_aigc: true };

test('initVideoPost sends post_info and a PULL_FROM_URL source', async () => {
  const stub = scriptFetch([ttEnvelope({ publish_id: 'v_pub_url~v2.123' })]);
  const result = await withFetch(stub, async () =>
    initVideoPost(apiCtx(), {
      postInfo: POST_INFO,
      source: { source: 'PULL_FROM_URL', videoUrl: 'https://example.com/v.mp4' },
    }),
  );

  assert.equal(
    new URL(stub.calls[0]?.url ?? '').pathname,
    '/v2/post/publish/video/init/',
  );
  assert.deepEqual(bodyOf(stub.calls[0]), {
    post_info: POST_INFO,
    source_info: { source: 'PULL_FROM_URL', video_url: 'https://example.com/v.mp4' },
  });
  assert.deepEqual(result, { publishId: 'v_pub_url~v2.123' });
});

test('initVideoPost sends the chunk plan for a FILE_UPLOAD and returns the upload url', async () => {
  const uploadUrl =
    'https://open-upload.tiktokapis.com/video/?upload_id=7&upload_token=upload-token-abcdef123456';
  const stub = scriptFetch([
    ttEnvelope({ publish_id: 'v_pub_file~v2.456', upload_url: uploadUrl }),
  ]);
  const result = await withFetch(stub, async () =>
    initVideoPost(apiCtx(), {
      postInfo: POST_INFO,
      source: {
        source: 'FILE_UPLOAD',
        videoSize: 50_000_123,
        chunkSize: 50_000_123,
        totalChunkCount: 1,
      },
    }),
  );

  assert.deepEqual(bodyOf(stub.calls[0])['source_info'], {
    source: 'FILE_UPLOAD',
    video_size: 50_000_123,
    chunk_size: 50_000_123,
    total_chunk_count: 1,
  });
  assert.deepEqual(result, { publishId: 'v_pub_file~v2.456', uploadUrl });

  // The upload_token in that URL is the upload session's bearer credential.
  assert.equal(
    redactText('token upload-token-abcdef123456 leaked'),
    'token [REDACTED] leaked',
  );
});

test('an upload url without a token, or an unparseable one, is still returned', async () => {
  const stub = scriptFetch([
    ttEnvelope({ publish_id: 'p1', upload_url: 'https://example.com/put' }),
    ttEnvelope({ publish_id: 'p2', upload_url: 'not a url' }),
    ttEnvelope({ publish_id: 'p3', upload_url: '' }),
  ]);
  const results = await withFetch(stub, async () => [
    await initDraftUpload(apiCtx(), {
      source: { source: 'PULL_FROM_URL', videoUrl: 'https://example.com/v.mp4' },
    }),
    await initDraftUpload(apiCtx(), {
      source: { source: 'PULL_FROM_URL', videoUrl: 'https://example.com/v.mp4' },
    }),
    await initDraftUpload(apiCtx(), {
      source: { source: 'PULL_FROM_URL', videoUrl: 'https://example.com/v.mp4' },
    }),
  ]);

  assert.deepEqual(results, [
    { publishId: 'p1', uploadUrl: 'https://example.com/put' },
    { publishId: 'p2', uploadUrl: 'not a url' },
    { publishId: 'p3' },
  ]);
});

test('a publish init is attempted exactly once — never retried', async () => {
  // On the `read` class this envelope would be retried; on `init` it is terminal.
  const stub = scriptFetch([
    ttEnvelope(null, { code: 'internal_error', message: 'upstream hiccup' }),
  ]);
  await withFetch(stub, async () => {
    await assert.rejects(
      initVideoPost(apiCtx(), {
        postInfo: POST_INFO,
        source: { source: 'PULL_FROM_URL', videoUrl: 'https://example.com/v.mp4' },
      }),
      (error: unknown) => {
        assert.ok(isTikTokError(error));
        assert.equal(error.kind, 'api');
        assert.equal(error.apiCode, 'internal_error');
        return true;
      },
    );
  });

  assert.equal(stub.calls.length, 1);
});

test('an init response without a publish_id is an upstream shape change', async () => {
  const stub = scriptFetch([ttEnvelope({ upload_url: 'https://example.com/put' })]);
  await withFetch(stub, async () => {
    await assert.rejects(
      initVideoPost(apiCtx(), {
        postInfo: POST_INFO,
        source: { source: 'PULL_FROM_URL', videoUrl: 'https://example.com/v.mp4' },
      }),
      (error: unknown) => {
        assert.ok(isTikTokError(error));
        assert.equal(error.code, 'upstream_error');
        assert.ok(error.message.includes('publish_id string'));
        return true;
      },
    );
  });
});

test('initDraftUpload sends no post_info at all', async () => {
  const stub = scriptFetch([ttEnvelope({ publish_id: 'v_inbox~v2.789' })]);
  const result = await withFetch(stub, async () =>
    initDraftUpload(apiCtx(), {
      source: { source: 'PULL_FROM_URL', videoUrl: 'https://example.com/v.mp4' },
    }),
  );

  assert.equal(
    new URL(stub.calls[0]?.url ?? '').pathname,
    '/v2/post/publish/inbox/video/init/',
  );
  const body = bodyOf(stub.calls[0]);
  assert.equal('post_info' in body, false);
  assert.deepEqual(body['source_info'], {
    source: 'PULL_FROM_URL',
    video_url: 'https://example.com/v.mp4',
  });
  assert.deepEqual(result, { publishId: 'v_inbox~v2.789' });
});

test('initPhotoPost sends the PHOTO content init and returns only a publish id', async () => {
  const stub = scriptFetch([ttEnvelope({ publish_id: 'p_pub~v2.1' })]);
  const result = await withFetch(stub, async () =>
    initPhotoPost(apiCtx(), {
      postInfo: POST_INFO,
      postMode: 'DIRECT_POST',
      photoUrls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
      photoCoverIndex: 1,
    }),
  );

  assert.equal(
    new URL(stub.calls[0]?.url ?? '').pathname,
    '/v2/post/publish/content/init/',
  );
  assert.deepEqual(bodyOf(stub.calls[0]), {
    media_type: 'PHOTO',
    post_mode: 'DIRECT_POST',
    post_info: POST_INFO,
    source_info: {
      source: 'PULL_FROM_URL',
      photo_images: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
      photo_cover_index: 1,
    },
  });
  assert.deepEqual(result, { publishId: 'p_pub~v2.1' });
});

test('cc-e9: initPhotoPost re-checks the bounds before spending a publish attempt', async () => {
  const stub = scriptFetch([]);
  await withFetch(stub, async () => {
    await assert.rejects(
      initPhotoPost(apiCtx(), {
        postInfo: POST_INFO,
        postMode: 'DIRECT_POST',
        photoUrls: [],
        photoCoverIndex: 0,
      }),
      (error: unknown) => {
        assert.ok(isTikTokError(error));
        assert.equal(error.code, 'invalid_params');
        return true;
      },
    );
  });

  assert.equal(stub.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

test('getPublishStatus maps the documented members, misspelling included', async () => {
  const stub = scriptFetch([
    ttEnvelope({
      status: 'PUBLISH_COMPLETE',
      publicaly_available_post_id: [7350000000000000000],
      uploaded_bytes: 50_000_123,
    }),
  ]);
  const status = await withFetch(stub, async () =>
    getPublishStatus(apiCtx(), 'v_pub_file~v2.456'),
  );

  assert.equal(
    new URL(stub.calls[0]?.url ?? '').pathname,
    '/v2/post/publish/status/fetch/',
  );
  assert.deepEqual(bodyOf(stub.calls[0]), { publish_id: 'v_pub_file~v2.456' });
  assert.deepEqual(status, {
    status: 'PUBLISH_COMPLETE',
    publicPostIds: ['7350000000000000000'],
    uploadedBytes: 50_000_123,
  });
});

test('getPublishStatus accepts the corrected spelling too, and reports a failure reason', async () => {
  const stub = scriptFetch([
    ttEnvelope({
      status: 'FAILED',
      fail_reason: 'spam_risk_text',
      publicly_available_post_id: ['123'],
      downloaded_bytes: 42,
    }),
  ]);
  const status = await withFetch(stub, async () => getPublishStatus(apiCtx(), 'v_pub~1'));

  assert.deepEqual(status, {
    status: 'FAILED',
    failReason: 'spam_risk_text',
    publicPostIds: ['123'],
    downloadedBytes: 42,
  });
});

test('an in-flight status carries nothing but the status', async () => {
  const stub = scriptFetch([
    ttEnvelope({ status: 'PROCESSING_UPLOAD', fail_reason: '', uploaded_bytes: null }),
  ]);
  const status = await withFetch(stub, async () => getPublishStatus(apiCtx(), 'v_pub~1'));

  assert.deepEqual(status, { status: 'PROCESSING_UPLOAD' });
});

test('a status response without a status is an upstream shape change', async () => {
  const stub = scriptFetch([ttEnvelope({ fail_reason: 'internal' })]);
  await withFetch(stub, async () => {
    await assert.rejects(getPublishStatus(apiCtx(), 'v_pub~1'), (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.code, 'upstream_error');
      assert.ok(error.message.includes('status string'));
      return true;
    });
  });
});

test('an empty publish id is rejected locally, before any request', async () => {
  const stub = scriptFetch([]);
  await withFetch(stub, async () => {
    await assert.rejects(getPublishStatus(apiCtx(), '   '), (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.code, 'invalid_params');
      assert.ok(error.message.includes('publish_id'));
      return true;
    });
  });

  assert.equal(stub.calls.length, 0);
});

test('polling stops only on a documented terminal state', () => {
  assert.equal(isTerminalStatus('PUBLISH_COMPLETE'), true);
  assert.equal(isTerminalStatus('SEND_TO_USER_INBOX'), true);
  assert.equal(isTerminalStatus('FAILED'), true);
  assert.equal(isTerminalStatus('PROCESSING_UPLOAD'), false);
  assert.equal(isTerminalStatus('PROCESSING_DOWNLOAD'), false);
  // A status TikTok adds later is a new stage until proven otherwise.
  assert.equal(isTerminalStatus('PROCESSING_MODERATION'), false);
});

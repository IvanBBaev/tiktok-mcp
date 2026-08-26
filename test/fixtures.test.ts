/**
 * `scripts/lib/fixtures.ts` — the recorded-fixture format, its sanitizer and the
 * leak detector that guards the committed tree (TESTING.md § Recorded sandbox
 * fixtures).
 *
 * `scripts/**` is excluded from coverage (`.c8rc.json`), so nothing here moves a
 * coverage floor. These tests exist anyway, because this module is the thing
 * that decides whether a credential reaches a committed file: `fixtures:record`
 * writes captures that still hold a live access token, `fixtures:sanitize`
 * transforms them with the functions below, and whatever survives is what gets
 * reviewed as a diff and pushed. A gap in `sanitizeFixture`, or a shape
 * `findSecretShapes` cannot see, is a credential in git history — which no
 * coverage gate would ever have flagged.
 *
 * The negative half carries most of the weight. A leak detector that fires on
 * ordinary fixture content — video ids, CDN cover URLs, the sanitized
 * placeholders themselves — gets suppressed rather than fixed, so the sanitized
 * spellings are asserted clean as carefully as the live ones are asserted dirty.
 *
 * Every capture below is built in memory. `test/fixtures/recorded/` legitimately
 * does not exist until the first sandbox pass, and writing files there from a
 * unit test would both fake the thing under test and make the "absent tree"
 * discovery path untestable.
 */

import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';

import {
  FIXTURE_AREAS,
  FIXTURE_ROOT,
  FIXTURE_SCHEMA,
  PLACEHOLDER,
  RAW_ROOT,
  SANITIZED_UPLOAD_HOST,
  SECRET_SHAPES,
  STALE_AFTER_DAYS,
  ageInDays,
  endpointFor,
  findSecretShapes,
  fixturePath,
  isFixtureArea,
  isPlaceholder,
  isStale,
  listFixtureFiles,
  loadFixtures,
  parseFixture,
  pseudonym,
  pseudonymizeUrl,
  renderFixture,
  sanitizeFixture,
  sanitizeUploadUrl,
  sanitizeUrl,
  walkFixtureTree,
  type Fixture,
} from '../scripts/lib/fixtures.js';
import { repoPath } from '../scripts/lib/repo.js';
import { BASELINE_NOW_MS, TEST_LOG_ID } from './helpers.js';

// ---------------------------------------------------------------------------
// live-looking material
// ---------------------------------------------------------------------------

/**
 * Obviously fake, but shaped like the real thing. The shape is the point: every
 * assertion below is about whether a detector or a transform recognizes a
 * credential by its form, so a placeholder-looking secret would prove nothing.
 */
const LIVE_ACCESS_TOKEN = 'act.1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f';
const LIVE_REFRESH_TOKEN = 'rft.9f8e7d6c5b4a3928170615243342516071';
const LIVE_CLIENT_KEY = 'awx1234567890abcdef';
const LIVE_CLIENT_SECRET = '5f2c9d8e7b6a4f3e2d1c0b9a8f7e6d5c';
const LIVE_AUTH_CODE = 'Q0FfNzMwMDAwMDAwMDAwMDAwMDAwMQ';
const LIVE_CODE_VERIFIER = 'zqXk8Lm2Np4Qr6St8Uv0Wx2Yz4Ab6Cd8Ef0Gh2Ij4Kl';
const LIVE_OPEN_ID = '_000AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const LIVE_UNION_ID = 'c9f7b3a1-5d2e-4f60-8a1b-2c3d4e5f6071';
const LIVE_UPLOAD_ID = 'v02-0123456789abcdef';
/** Doubles as the JWT positive — a pre-signed upload token really is one. */
const LIVE_UPLOAD_TOKEN =
  'eyJhbGciOiJIUzI1NiJ9.eyJ1cGxvYWRfaWQiOiJ2MDIifQ.s3cr3tsignaturevalue';
/** No TikTok prefix, so only the parameter/field shapes can fire on it. */
const UNPREFIXED_TOKEN = '7f3d9c1e5b2a48069d1c3e5f7a9b0d2f';

const RECORDED_AT = '2026-01-01T00:00:00.000Z';
const API_HOST = 'open.tiktokapis.com';

// ---------------------------------------------------------------------------
// realistic raw captures
// ---------------------------------------------------------------------------

/** `GET /v2/user/info/` — the pseudonym surface: `open_id`, `union_id`, `log_id`. */
function rawUserInfo(): Fixture {
  return {
    schema: FIXTURE_SCHEMA,
    recordedAt: RECORDED_AT,
    area: 'user',
    name: 'info-basic',
    endpoint: { method: 'GET', host: API_HOST, path: '/v2/user/info/' },
    request: {
      url: `https://${API_HOST}/v2/user/info/?fields=open_id,union_id,display_name`,
      headers: {
        authorization: `Bearer ${LIVE_ACCESS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: null,
    },
    response: {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-tt-logid': TEST_LOG_ID,
      },
      body: {
        data: { user: { open_id: LIVE_OPEN_ID, union_id: LIVE_UNION_ID } },
        error: { code: 'ok', message: '', log_id: TEST_LOG_ID },
      },
    },
  };
}

/** `POST /v2/oauth/token/` — the only form-encoded body in the API surface. */
function rawTokenExchange(): Fixture {
  return {
    schema: FIXTURE_SCHEMA,
    recordedAt: RECORDED_AT,
    area: 'auth',
    name: 'token-exchange',
    endpoint: { method: 'POST', host: API_HOST, path: '/v2/oauth/token/' },
    request: {
      url: `https://${API_HOST}/v2/oauth/token/`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body:
        `client_key=${LIVE_CLIENT_KEY}&client_secret=${LIVE_CLIENT_SECRET}` +
        `&code=${LIVE_AUTH_CODE}&grant_type=authorization_code` +
        `&code_verifier=${LIVE_CODE_VERIFIER}`,
    },
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        access_token: LIVE_ACCESS_TOKEN,
        refresh_token: LIVE_REFRESH_TOKEN,
        open_id: LIVE_OPEN_ID,
        scope: 'user.info.basic,video.publish',
        expires_in: 86400,
        token_type: 'Bearer',
      },
    },
  };
}

/** `POST /v2/post/publish/video/init/` — the `upload_url` surface. */
function rawPublishInit(): Fixture {
  return {
    schema: FIXTURE_SCHEMA,
    recordedAt: RECORDED_AT,
    area: 'publish',
    name: 'init-video-upload',
    endpoint: { method: 'POST', host: API_HOST, path: '/v2/post/publish/video/init/' },
    request: {
      url: `https://${API_HOST}/v2/post/publish/video/init/`,
      headers: {
        authorization: `Bearer ${LIVE_ACCESS_TOKEN}`,
        'content-type': 'application/json; charset=UTF-8',
      },
      body: {
        source_info: { source: 'FILE_UPLOAD', video_size: 1024, total_chunk_count: 1 },
      },
    },
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        data: {
          publish_id: 'v_pub_url~v2.7300000000000000001',
          upload_url:
            `https://open-upload-i18n.tiktokapis.com/video/upload/` +
            `?upload_id=${LIVE_UPLOAD_ID}&upload_token=${LIVE_UPLOAD_TOKEN}`,
        },
        error: { code: 'ok', message: '', log_id: TEST_LOG_ID },
      },
    },
  };
}

/**
 * The same endpoint refusing the post. HTTP 200 with a non-`ok` `error.code` is
 * how TikTok reports a business failure, and that code is the single field the
 * replay contract exists to assert on.
 */
function rawPublishRejected(): Fixture {
  return {
    schema: FIXTURE_SCHEMA,
    recordedAt: RECORDED_AT,
    area: 'publish',
    name: 'init-spam-risk',
    endpoint: { method: 'POST', host: API_HOST, path: '/v2/post/publish/video/init/' },
    request: {
      url: `https://${API_HOST}/v2/post/publish/video/init/`,
      headers: { authorization: `Bearer ${LIVE_ACCESS_TOKEN}` },
      body: { post_info: { title: 'Sunset run', privacy_level: 'SELF_ONLY' } },
    },
    response: {
      status: 200,
      headers: { 'x-tt-logid': TEST_LOG_ID },
      body: {
        data: {},
        error: {
          code: 'spam_risk_too_many_posts',
          message: 'Daily post cap reached',
          log_id: TEST_LOG_ID,
        },
      },
    },
  };
}

/**
 * `PUT` against a pre-signed regional upload host. This is the capture whose
 * `endpoint` block moves during sanitization, because the whole URL is replaced.
 */
function rawUploadChunk(): Fixture {
  return {
    schema: FIXTURE_SCHEMA,
    recordedAt: RECORDED_AT,
    area: 'upload',
    name: 'chunk-put',
    endpoint: {
      method: 'PUT',
      host: 'open-upload-i18n.tiktokapis.com',
      path: '/video/upload/',
    },
    request: {
      url:
        `https://open-upload-i18n.tiktokapis.com/video/upload/` +
        `?upload_id=${LIVE_UPLOAD_ID}&upload_token=${LIVE_UPLOAD_TOKEN}`,
      headers: { 'content-range': 'bytes 0-1023/1024', 'content-type': 'video/mp4' },
      body: null,
    },
    response: {
      status: 201,
      headers: { 'x-tt-logid': TEST_LOG_ID },
      body: null,
    },
  };
}

/** Fresh instances every time: `sanitizeFixture` must never see a shared object. */
const CAPTURES: readonly (readonly [string, () => Fixture])[] = [
  ['user/info-basic', rawUserInfo],
  ['auth/token-exchange', rawTokenExchange],
  ['publish/init-video-upload', rawPublishInit],
  ['publish/init-spam-risk', rawPublishRejected],
  ['upload/chunk-put', rawUploadChunk],
];

// ---------------------------------------------------------------------------
// navigation and shape helpers
// ---------------------------------------------------------------------------

/** Walk a parsed document without spraying `as` casts across every assertion. */
function at(root: unknown, ...path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    assert.ok(
      typeof current === 'object' && current !== null,
      `${path.join('.')}: ${key} has no parent object`,
    );
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stringAt(root: unknown, ...path: readonly string[]): string {
  const value = at(root, ...path);
  assert.equal(typeof value, 'string', `${path.join('.')} must be a string`);
  return value as string;
}

/**
 * Character-class equality — the property `pseudonym` promises to preserve.
 * A `log_id` collapsed to `"fake"` would pass every parser; one that is still 35
 * characters of the same alphabet keeps a length or charset assumption honest.
 */
function assertSameShape(actual: string, original: string, label: string): void {
  assert.equal(actual.length, original.length, `${label}: length`);
  for (let i = 0; i < original.length; i += 1) {
    const want = original[i] ?? '';
    const got = actual[i] ?? '';
    const where = `${label}[${String(i)}]`;
    if (want >= '0' && want <= '9') assert.match(got, /^[0-9]$/, where);
    else if (want >= 'a' && want <= 'z') assert.match(got, /^[a-z]$/, where);
    else if (want >= 'A' && want <= 'Z') assert.match(got, /^[A-Z]$/, where);
    else assert.equal(got, want, `${where} must be kept verbatim`);
  }
}

// ---------------------------------------------------------------------------
// pseudonyms
// ---------------------------------------------------------------------------

test('pseudonym is deterministic and domain-separated', () => {
  assert.equal(pseudonym('open_id', LIVE_OPEN_ID), pseudonym('open_id', LIVE_OPEN_ID));
  // Same input, different domain: an `open_id` and a `log_id` that happened to
  // share a value must not become the same pseudonym, or a fixture would invent
  // a correlation the recording never had.
  assert.notEqual(pseudonym('open_id', TEST_LOG_ID), pseudonym('log_id', TEST_LOG_ID));
});

test('pseudonym preserves shape, so a fixture still exercises the parsers', () => {
  assertSameShape(pseudonym('log_id', TEST_LOG_ID), TEST_LOG_ID, 'log_id');
  assertSameShape(pseudonym('union_id', LIVE_UNION_ID), LIVE_UNION_ID, 'union_id');
  assertSameShape(pseudonym('open_id', LIVE_OPEN_ID), LIVE_OPEN_ID, 'open_id');

  // The separators of a hyphenated id stay exactly where they were.
  const union = pseudonym('union_id', LIVE_UNION_ID);
  assert.match(union, /^[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}$/);
});

test('pseudonym actually replaces the value, and the empty string is not a crash', () => {
  assert.notEqual(pseudonym('log_id', TEST_LOG_ID), TEST_LOG_ID);
  assert.notEqual(pseudonym('open_id', LIVE_OPEN_ID), LIVE_OPEN_ID);
  assert.equal(pseudonym('open_id', ''), '');
});

test('a non-Latin display name is replaced, not passed through as a separator', () => {
  // Everything outside ASCII used to survive, on the rule that kept `-` and `_`
  // where they were. A Cyrillic name is not a separator: it is the identity the
  // pseudonym exists to remove, and a rarer one than a Latin name at that.
  for (const name of ['Ада Лъвлейс', '中文名字', 'Ada 🎬 Lovelace']) {
    const fake = pseudonym('display_name', name);
    assert.equal(fake.length, name.length, `length preserved for ${name}`);
    assert.notEqual(fake, name);
    assert.ok(!/[^\x20-\x7e]/.test(fake), `no non-ASCII survives in ${fake}`);
    // Deterministic like every other domain, so the diff stays reviewable.
    assert.equal(pseudonym('display_name', name), fake);
  }
  // The ASCII separators the rule was written for are still untouched.
  assert.match(pseudonym('open_id', '_0-0.0'), /^_\d-\d\.\d$/);
});

// ---------------------------------------------------------------------------
// secret shapes — positives
// ---------------------------------------------------------------------------

test('SECRET_SHAPES is the six documented shapes, each global and each explained', () => {
  assert.deepEqual(
    SECRET_SHAPES.map((shape) => shape.name),
    [
      'bearer-token',
      'sensitive-param',
      'sensitive-field',
      'tiktok-token-prefix',
      'jwt',
      'private-key',
    ],
  );
  for (const shape of SECRET_SHAPES) {
    assert.ok(shape.re.global, `${shape.name}: the scan relies on matchAll`);
    assert.ok(shape.why.length > 0, `${shape.name}: a hit must say why it is a hit`);
  }
});

test('every secret shape fires on live material', () => {
  const positives: readonly (readonly [string, string])[] = [
    ['bearer-token', `authorization: Bearer ${LIVE_ACCESS_TOKEN}`],
    [
      'sensitive-param',
      `https://${API_HOST}/v2/user/info/?access_token=${UNPREFIXED_TOKEN}`,
    ],
    ['sensitive-field', `{"refresh_token": "${UNPREFIXED_TOKEN}"}`],
    ['tiktok-token-prefix', `{"token": "${LIVE_ACCESS_TOKEN}"}`],
    ['tiktok-token-prefix', `{"token": "${LIVE_REFRESH_TOKEN}"}`],
    ['jwt', `{"upload_url": "https://x.example/u/?t=${LIVE_UPLOAD_TOKEN}"}`],
    ['private-key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKC\n'],
    ['private-key', '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN\n'],
  ];
  for (const [shape, sample] of positives) {
    const hits = findSecretShapes(sample).map((hit) => hit.shape);
    assert.ok(
      hits.includes(shape),
      `${shape}: expected a hit, got ${JSON.stringify(hits)}`,
    );
  }
});

test('a hit reports the shape and a truncated excerpt, never the whole secret', () => {
  const hits = findSecretShapes(`authorization: Bearer ${LIVE_ACCESS_TOKEN}`);
  const first = hits[0];
  assert.ok(first !== undefined);
  assert.equal(first.shape, 'bearer-token');
  assert.ok(first.excerpt.length <= 25, `excerpt too long: ${first.excerpt}`);
  assert.equal(first.excerpt.includes(LIVE_ACCESS_TOKEN), false);
});

// ---------------------------------------------------------------------------
// secret shapes — negatives (the half that decides whether the gate survives)
// ---------------------------------------------------------------------------

test('the sanitized spellings do not fire', () => {
  const negatives = [
    `authorization: Bearer ${PLACEHOLDER.accessToken}`,
    'authorization: Bearer ***',
    'authorization: bearer REDACTED',
    `https://${API_HOST}/v2/user/info/?access_token=REDACTED`,
    `https://${SANITIZED_UPLOAD_HOST}/upload/?upload_id=v02-abc&upload_token=REDACTED`,
    'client_key=REDACTED&client_secret=REDACTED&code=REDACTED&grant_type=authorization_code',
    `{"access_token": "${PLACEHOLDER.accessToken}"}`,
    `{"refresh_token": "${PLACEHOLDER.refreshToken}"}`,
    '{"client_secret": "[REDACTED]"}',
    '{"upload_token": "REDACTED"}',
    `{"client_key": "${PLACEHOLDER.clientKey}"}`,
  ];
  for (const sample of negatives) {
    assert.deepEqual(findSecretShapes(sample), [], sample);
  }
});

test('an ordinary fixture body produces no hits', () => {
  // Video ids, CDN cover URLs and share links are long and high-entropy by
  // nature. A detector that flagged them would be turned off within a week.
  const clean = JSON.stringify(
    {
      data: {
        videos: [
          {
            id: '7300000000000000001',
            title: 'Sunset run',
            cover_image_url:
              'https://p16-sign-va.tiktokcdn.com/obj/tos-maliva-p-0068/9f1c0b7a5e' +
              '~tplv-noop.image?x-expires=1780000000&x-signature=Ab1Cd2%2FEf3',
            share_url: 'https://www.tiktok.com/@ada.lovelace/video/7300000000000000001',
          },
        ],
        cursor: '1780000000000',
        has_more: false,
        display_name: 'Ada Lovelace',
      },
      error: { code: 'ok', message: '', log_id: TEST_LOG_ID },
    },
    null,
    2,
  );
  assert.deepEqual(findSecretShapes(clean), []);
});

test('findSecretShapes is repeatable — a stale lastIndex would skip the second scan', () => {
  // The shapes are module-level global RegExp objects, so the scan is only
  // correct if it resets `lastIndex`. Two files in a row is the real case.
  const sample = `Bearer ${LIVE_ACCESS_TOKEN} then ?access_token=${UNPREFIXED_TOKEN}`;
  const first = findSecretShapes(sample);
  assert.ok(
    first.length > 1,
    'the sample must produce more than one hit to be a real test',
  );
  assert.deepEqual(findSecretShapes(sample), first);
  assert.deepEqual(findSecretShapes(sample), first);
});

test('a credential in the first parameter of a form body is still a hit', () => {
  // Position must not decide whether a leak is visible. `sensitive-param`
  // requires `^`, `?`, `&` or `;` before the name, and inside a serialized
  // fixture the first parameter of a form body is preceded by a quote.
  const rendered = JSON.stringify({
    request: { body: `access_token=${UNPREFIXED_TOKEN}&x=1` },
  });
  const later = JSON.stringify({
    request: { body: `x=1&access_token=${UNPREFIXED_TOKEN}` },
  });
  assert.deepEqual(
    findSecretShapes(rendered).map((hit) => hit.shape),
    findSecretShapes(later).map((hit) => hit.shape),
    'the same credential must be found in either parameter position',
  );
});

// ---------------------------------------------------------------------------
// sanitization
// ---------------------------------------------------------------------------

test('the Authorization header becomes the access-token placeholder', () => {
  const sanitized = sanitizeFixture(rawUserInfo());
  assert.equal(
    sanitized.request.headers['authorization'],
    `Bearer ${PLACEHOLDER.accessToken}`,
  );
  assert.equal(renderFixture(sanitized).includes(LIVE_ACCESS_TOKEN), false);
});

test('open_id and union_id become stable, shape-preserving pseudonyms', () => {
  const sanitized = sanitizeFixture(rawUserInfo());
  const openId = stringAt(sanitized, 'response', 'body', 'data', 'user', 'open_id');
  const unionId = stringAt(sanitized, 'response', 'body', 'data', 'user', 'union_id');

  assert.notEqual(openId, LIVE_OPEN_ID);
  assert.notEqual(unionId, LIVE_UNION_ID);
  assertSameShape(openId, LIVE_OPEN_ID, 'open_id');
  assertSameShape(unionId, LIVE_UNION_ID, 'union_id');
  assert.notEqual(openId, unionId);

  // Stable across runs: the same capture must render byte-identically, or every
  // re-record produces a diff nobody can review.
  assert.equal(renderFixture(sanitizeFixture(rawUserInfo())), renderFixture(sanitized));
});

test('log_id becomes a shape-preserving fake in both the envelope and the header', () => {
  const sanitized = sanitizeFixture(rawUserInfo());
  const envelope = stringAt(sanitized, 'response', 'body', 'error', 'log_id');
  const header = sanitized.response.headers['x-tt-logid'];
  assert.ok(header !== undefined);

  assert.notEqual(envelope, TEST_LOG_ID);
  assert.notEqual(header, TEST_LOG_ID);
  assertSameShape(envelope, TEST_LOG_ID, 'error.log_id');
  assertSameShape(header, TEST_LOG_ID, 'x-tt-logid');
  // One domain for both, so the header and the body of a replayed fixture still
  // agree with each other the way the live response did.
  assert.equal(header, envelope);
});

test('a JSON field named code survives verbatim — it is the payload, not a credential', () => {
  // `error.code` is TikTok's machine-readable outcome, and `src/api/` treats
  // anything but `ok` as a failure even on HTTP 200. Replacing it would turn
  // every recorded success into a replayed error.
  assert.equal(
    stringAt(sanitizeFixture(rawUserInfo()), 'response', 'body', 'error', 'code'),
    'ok',
  );
  assert.equal(
    stringAt(sanitizeFixture(rawPublishRejected()), 'response', 'body', 'error', 'code'),
    'spam_risk_too_many_posts',
  );
  assert.equal(
    stringAt(
      sanitizeFixture(rawPublishRejected()),
      'response',
      'body',
      'error',
      'message',
    ),
    'Daily post cap reached',
  );
});

test('upload_url becomes a synthetic URL with upload_token exactly REDACTED', () => {
  const sanitized = sanitizeFixture(rawPublishInit());
  const url = new URL(stringAt(sanitized, 'response', 'body', 'data', 'upload_url'));

  assert.equal(url.host, SANITIZED_UPLOAD_HOST);
  assert.equal(url.pathname, '/upload/');
  assert.equal(url.searchParams.get('upload_token'), 'REDACTED');
  const uploadId = url.searchParams.get('upload_id');
  assert.ok(uploadId !== null);
  assert.notEqual(uploadId, LIVE_UPLOAD_ID);
  assertSameShape(uploadId, LIVE_UPLOAD_ID, 'upload_id');
  assert.equal(renderFixture(sanitized).includes(LIVE_UPLOAD_TOKEN), false);
});

test('a form body loses its credentials and keeps grant_type verbatim', () => {
  const sanitized = sanitizeFixture(rawTokenExchange());
  const body = sanitized.request.body;
  assert.equal(
    body,
    'client_key=REDACTED&client_secret=REDACTED&code=REDACTED' +
      '&grant_type=authorization_code&code_verifier=REDACTED',
  );

  // Redacted, not dropped: a replay asserts on the request our client builds,
  // and a missing parameter must not be able to masquerade as a correct one.
  const params = new URLSearchParams(body);
  for (const name of ['client_key', 'client_secret', 'code', 'code_verifier']) {
    const value = params.get(name);
    assert.ok(value !== null, `${name} must stay present`);
    assert.ok(isPlaceholder(value), `${name} must be a placeholder, got ${value}`);
  }
  assert.equal(params.get('grant_type'), 'authorization_code');

  const rendered = renderFixture(sanitized);
  for (const secret of [
    LIVE_CLIENT_KEY,
    LIVE_CLIENT_SECRET,
    LIVE_AUTH_CODE,
    LIVE_CODE_VERIFIER,
  ]) {
    assert.equal(rendered.includes(secret), false, `${secret} survived`);
  }
});

test('a form body is sanitized whatever case the capture spelled Content-Type in', () => {
  // Header names are lower-cased on the way out, but the content-type lookup
  // that selects the form path reads the raw record. A capture that spelled it
  // `Content-Type` must not skip form sanitization.
  const raw = rawTokenExchange();
  const capitalized: Fixture = {
    ...raw,
    request: {
      ...raw.request,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    },
  };
  const rendered = renderFixture(sanitizeFixture(capitalized));
  assert.equal(
    rendered.includes(LIVE_CLIENT_KEY),
    false,
    'the client key survived sanitization',
  );
  assert.equal(
    rendered.includes(LIVE_CLIENT_SECRET),
    false,
    'the client secret survived',
  );
});

test('JSON credential fields become the angle-bracket placeholders', () => {
  const sanitized = sanitizeFixture(rawTokenExchange());
  assert.equal(
    stringAt(sanitized, 'response', 'body', 'access_token'),
    PLACEHOLDER.accessToken,
  );
  assert.equal(
    stringAt(sanitized, 'response', 'body', 'refresh_token'),
    PLACEHOLDER.refreshToken,
  );
  // Non-credential payload is untouched, or the fixture stops describing the API.
  assert.equal(
    stringAt(sanitized, 'response', 'body', 'scope'),
    'user.info.basic,video.publish',
  );
  assert.equal(at(sanitized, 'response', 'body', 'expires_in'), 86400);
});

test('sanitization is the whole contract: dirty before, clean after', () => {
  for (const [label, make] of CAPTURES) {
    const capture = make();
    const before = findSecretShapes(renderFixture(capture));
    assert.ok(
      before.length > 0,
      `${label}: the raw capture must look dirty to begin with`,
    );

    const after = findSecretShapes(renderFixture(sanitizeFixture(capture)));
    assert.deepEqual(after, [], `${label}: ${JSON.stringify(after)}`);
  }
});

test('sanitizing the same capture twice produces the same bytes', () => {
  // Stability, not idempotence, is the guarantee that makes a fixture diff
  // reviewable: a re-record of an unchanged interaction must be a no-op diff.
  for (const [label, make] of CAPTURES) {
    assert.equal(
      renderFixture(sanitizeFixture(make())),
      renderFixture(sanitizeFixture(make())),
      label,
    );
  }
});

test('sanitizeFixture is deliberately not idempotent, and must stay that way', () => {
  // A shape-preserving pseudonym is indistinguishable from the value it
  // replaced — that is the point of it — so a second pass pseudonymizes the
  // pseudonym. Making the sanitizer a fixed point would need a marker in the
  // file saying which fields were touched, which is exactly the correlation the
  // pseudonyms exist to remove. It cannot happen in practice:
  // `scripts/fixtures-sanitize.ts` reads only from `.fixtures-raw/` and writes
  // only to `test/fixtures/recorded/`, so nothing ever sanitizes twice.
  const once = sanitizeFixture(rawUserInfo());
  const twice = sanitizeFixture(once);
  assert.notEqual(renderFixture(twice), renderFixture(once));

  // What must survive a second pass is the shape, not the bytes.
  assertSameShape(
    stringAt(twice, 'response', 'body', 'data', 'user', 'open_id'),
    stringAt(once, 'response', 'body', 'data', 'user', 'open_id'),
    'twice-sanitized open_id',
  );
  assert.deepEqual(findSecretShapes(renderFixture(twice)), []);
});

test('sanitizeUrl redacts a credential parameter in place and leaves the rest alone', () => {
  const sanitized = sanitizeUrl(
    `https://${API_HOST}/v2/oauth/token/?client_key=${LIVE_CLIENT_KEY}&fields=open_id`,
  );
  const url = new URL(sanitized);
  assert.equal(url.searchParams.get('client_key'), 'REDACTED');
  assert.equal(url.searchParams.get('fields'), 'open_id');
  assert.deepEqual(findSecretShapes(sanitized), []);
});

test('sanitizeUrl routes an upload_token URL through the synthetic rewrite', () => {
  const sanitized = sanitizeUrl(
    `https://open-upload-i18n.tiktokapis.com/video/upload/` +
      `?upload_id=${LIVE_UPLOAD_ID}&upload_token=${LIVE_UPLOAD_TOKEN}`,
  );
  assert.equal(new URL(sanitized).host, SANITIZED_UPLOAD_HOST);
  assert.deepEqual(findSecretShapes(sanitized), []);
});

test('an identity URL loses the identity in its path, not just its query', () => {
  const deepLink = pseudonymizeUrl('deep_link', 'https://www.tiktok.com/@ada.lovelace');
  const parsed = new URL(deepLink);
  // Host and shape survive — the fixture still looks like a deep link.
  assert.equal(parsed.host, 'www.tiktok.com');
  assert.match(parsed.pathname, /^\/@[a-z]+\.[a-z]+$/);
  // The handle does not. `sanitizeUrl` alone left this verbatim, and a committed
  // fixture that names the account undoes the `display_name` pseudonym two
  // fields up.
  assert.ok(!deepLink.includes('ada.lovelace'), deepLink);
  assert.equal(
    pseudonymizeUrl('deep_link', 'https://www.tiktok.com/@ada.lovelace'),
    deepLink,
  );

  // A CDN avatar carries the open_id in its path and its format in the
  // extension; the first goes, the second stays.
  const avatar = pseudonymizeUrl(
    'avatar_url',
    `https://p16-sign.tiktokcdn-us.com/tos-avt-0068/${LIVE_OPEN_ID}~c5_100x100.jpeg?x-expires=1`,
  );
  assert.ok(avatar.endsWith('.jpeg') || avatar.includes('.jpeg?'), avatar);
  assert.ok(!avatar.includes(LIVE_OPEN_ID), avatar);

  // Not a URL at all: fall back to the plain pseudonym rather than throwing.
  assert.equal(
    pseudonymizeUrl('deep_link', 'not a url'),
    pseudonym('deep_link', 'not a url'),
  );
});

test('sanitizeFixture routes identity URL fields through the path rewrite', () => {
  const raw = rawUserInfo();
  const user = (raw.response.body as { data: { user: Record<string, unknown> } }).data
    .user;
  user['display_name'] = 'Ada Lovelace';
  user['profile_deep_link'] = 'https://www.tiktok.com/@ada.lovelace';
  const rendered = renderFixture(sanitizeFixture(raw));
  assert.ok(!rendered.includes('ada.lovelace'), rendered);
  assert.ok(!rendered.includes('Ada Lovelace'), rendered);
  // Still a deep link, so the fixture keeps whatever asserts on its shape honest.
  assert.match(rendered, /https:\\?\/\\?\/www\.tiktok\.com\\?\/@/);
});

test('an unparseable value still yields something safe', () => {
  // A capture is untrusted input: a malformed URL must not throw in the middle
  // of a sanitize run and leave the rest of the tree unwritten.
  assert.equal(sanitizeUrl('not a url at all'), 'not a url at all');
  const fallback = new URL(sanitizeUploadUrl('not a url at all'));
  assert.equal(fallback.host, SANITIZED_UPLOAD_HOST);
  assert.equal(fallback.searchParams.get('upload_token'), 'REDACTED');
  assert.ok((fallback.searchParams.get('upload_id') ?? '').length > 0);
});

// ---------------------------------------------------------------------------
// endpoint derivation
// ---------------------------------------------------------------------------

test('endpointFor derives the block a URL implies, and gives up on a non-URL', () => {
  assert.deepEqual(
    endpointFor('get', `https://${API_HOST}/v2/user/info/?fields=open_id`),
    {
      method: 'GET',
      host: API_HOST,
      path: '/v2/user/info/',
    },
  );
  assert.equal(endpointFor('PUT', 'not a url at all'), undefined);
});

test('sanitizing a capture whose URL moves keeps endpoint and request.url in step', () => {
  // The pre-signed upload host is replaced wholesale, so a carried-over
  // `endpoint` would point somewhere `request.url` no longer goes and
  // `parseFixture` would refuse to read the sanitizer's own output back.
  const sanitized = sanitizeFixture(rawUploadChunk());
  assert.equal(sanitized.endpoint.host, SANITIZED_UPLOAD_HOST);
  assert.equal(sanitized.endpoint.path, '/upload/');
  assert.equal(sanitized.endpoint.method, 'PUT');

  const reread = parseFixture(
    JSON.parse(renderFixture(sanitized)) as unknown,
    'upload/chunk-put.json',
  );
  assert.deepEqual(reread, sanitized);
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

const FILE = 'user/info-basic.json';

/** A well-formed on-disk document, with any one block overridden. */
function document(
  overrides: {
    root?: Record<string, unknown>;
    endpoint?: Record<string, unknown>;
    request?: Record<string, unknown>;
    response?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    schema: FIXTURE_SCHEMA,
    recordedAt: RECORDED_AT,
    area: 'user',
    name: 'info-basic',
    endpoint: {
      method: 'GET',
      host: API_HOST,
      path: '/v2/user/info/',
      ...overrides.endpoint,
    },
    request: {
      url: `https://${API_HOST}/v2/user/info/?fields=open_id`,
      headers: { authorization: `Bearer ${PLACEHOLDER.accessToken}` },
      body: null,
      ...overrides.request,
    },
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { error: { code: 'ok' } },
      ...overrides.response,
    },
    ...overrides.root,
  };
}

test('parseFixture accepts a well-formed document', () => {
  const parsed = parseFixture(document(), FILE);
  assert.equal(parsed.schema, FIXTURE_SCHEMA);
  assert.equal(parsed.area, 'user');
  assert.equal(parsed.name, 'info-basic');
  assert.deepEqual(parsed.endpoint, {
    method: 'GET',
    host: API_HOST,
    path: '/v2/user/info/',
  });
  assert.equal(parsed.response.status, 200);
  assert.deepEqual(parsed.response.body, { error: { code: 'ok' } });
});

test('parseFixture rejects every malformed shape, and names the file every time', () => {
  // The file name is the whole point of the message: the replay test runs over
  // a tree, and "invalid fixture" without a path is a bug report nobody can act
  // on.
  const rejections: readonly (readonly [string, Record<string, unknown>, RegExp])[] = [
    [
      'unknown schema',
      document({ root: { schema: 'tiktok-mcp/fixture@2' } }),
      /unknown schema/,
    ],
    ['unknown area', document({ root: { area: 'analytics' } }), /unknown area/],
    ['name is not kebab-case', document({ root: { name: 'Info_Basic' } }), /kebab-case/],
    [
      'recordedAt is not a date',
      document({ root: { recordedAt: 'yesterday' } }),
      /not a date/,
    ],
    [
      'status is not an integer',
      document({ response: { status: 200.5 } }),
      /integer HTTP status/,
    ],
    [
      'status is below 100',
      document({ response: { status: 99 } }),
      /integer HTTP status/,
    ],
    [
      'status is a string',
      document({ response: { status: '200' } }),
      /integer HTTP status/,
    ],
    [
      'method is lower-case',
      document({ endpoint: { method: 'get' } }),
      /must be upper-case/,
    ],
    [
      'path has no leading slash',
      document({ endpoint: { path: 'v2/x/' } }),
      /must start with \//,
    ],
    [
      'a header name is not lower-cased',
      document({ request: { headers: { Authorization: 'Bearer x' } } }),
      /must be lower-cased/,
    ],
    [
      'a header value is not a string',
      document({ request: { headers: { 'x-retry': 3 } } }),
      /must be a string/,
    ],
    [
      'request.url is not a URL',
      document({ request: { url: 'not-a-url' } }),
      /is not a URL/,
    ],
    [
      'endpoint host disagrees with request.url',
      document({ endpoint: { host: 'open.tiktokapis.example' } }),
      /does not match request\.url/,
    ],
    [
      'endpoint path disagrees with request.url',
      document({ endpoint: { path: '/v2/user/other/' } }),
      /does not match request\.url/,
    ],
    [
      'request is missing',
      document({ root: { request: undefined } }),
      /request must be an object/,
    ],
    ['the document is not an object', {}, /schema must be a non-empty string/],
  ];

  for (const [label, doc, reason] of rejections) {
    assert.throws(
      () => parseFixture(doc, FILE),
      (error: unknown) => {
        assert.ok(error instanceof Error, label);
        assert.ok(error.message.startsWith(`${FILE}: `), `${label}: ${error.message}`);
        assert.match(error.message, reason, label);
        return true;
      },
      label,
    );
  }
});

test('parseFixture rejects a document that is not an object at all', () => {
  assert.throws(() => parseFixture(null, FILE), /fixture must be an object/);
  assert.throws(() => parseFixture([], FILE), /fixture must be an object/);
});

test('a missing body normalizes to null rather than throwing', () => {
  // A chunk upload has no JSON body on either side; `undefined` and absent are
  // the same thing to the `?? null` normalization.
  const parsed = parseFixture(
    document({ request: { body: undefined }, response: { body: undefined } }),
    FILE,
  );
  assert.equal(parsed.request.body, null);
  assert.equal(parsed.response.body, null);
});

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

test('renderFixture is 2-space JSON with exactly one trailing newline', () => {
  // Byte-identical to Prettier's output: `test/**` is not in `.prettierignore`,
  // so `format:check` sees every committed fixture.
  const rendered = renderFixture(rawUserInfo());
  assert.ok(rendered.endsWith('}\n'));
  assert.equal(rendered.endsWith('\n\n'), false);
  assert.match(rendered, /^\{\n {2}"schema": /);
  assert.match(rendered, /\n {2}"request": \{\n {4}"url": /);
});

test('renderFixture round-trips through parseFixture', () => {
  for (const [label, make] of CAPTURES) {
    const capture = make();
    const parsed = parseFixture(
      JSON.parse(renderFixture(capture)) as unknown,
      `${label}.json`,
    );
    assert.deepEqual(parsed, capture, label);
  }
});

// ---------------------------------------------------------------------------
// paths and discovery
// ---------------------------------------------------------------------------

test('fixturePath is repo-relative with forward slashes on every platform', () => {
  // The Windows CI leg is blocking. `path.join` would emit backslashes there,
  // and a path built on one platform has to match a path committed on another.
  assert.equal(
    fixturePath(FIXTURE_ROOT, 'user', 'info-basic'),
    `${FIXTURE_ROOT}/user/info-basic.json`,
  );
  assert.equal(
    fixturePath(RAW_ROOT, 'upload', 'chunk-put'),
    `${RAW_ROOT}/upload/chunk-put.json`,
  );
  assert.equal(fixturePath(FIXTURE_ROOT, 'user', 'info-basic').includes('\\'), false);
});

test('isFixtureArea accepts the closed set and nothing else', () => {
  for (const area of FIXTURE_AREAS) assert.equal(isFixtureArea(area), true, area);
  assert.equal(isFixtureArea('analytics'), false);
  assert.equal(isFixtureArea('User'), false);
  assert.equal(isFixtureArea(''), false);
});

const ABSENT_ROOT = 'test/fixtures/never-recorded';

test('discovery over an absent tree reports nothing rather than crashing', async () => {
  // `test/fixtures/recorded/` does not exist until someone runs a sandbox pass,
  // and neither the loader nor the secret scan may fail to start because of it.
  assert.deepEqual(await listFixtureFiles(ABSENT_ROOT), []);
  assert.deepEqual(await walkFixtureTree(ABSENT_ROOT), []);
  assert.deepEqual(await loadFixtures(ABSENT_ROOT), []);
  assert.ok(Array.isArray(await listFixtureFiles()));
  assert.ok(Array.isArray(await walkFixtureTree()));
});

test('listFixtureFiles serves the loader; walkFixtureTree serves the secret scan', async () => {
  // The two guarantees are opposites. The loader must only see what it can
  // parse, so it looks at `<area>/*.json` and nothing else. The scan must prove
  // that *nothing* under the tree carries a credential, and a leak does not
  // have to be well-formed: a `.bak` left by a hand-edit, an editor swapfile or
  // a note in a typo'd directory all get committed like any other file.
  //
  // The tree is built under a throwaway, gitignored root. `test/fixtures/`
  // stays empty until a real sandbox pass writes it.
  const root = `.tmp-verify-fixtures-${String(process.pid)}`;
  try {
    await mkdir(repoPath(root, 'user'), { recursive: true });
    await mkdir(repoPath(root, 'notes'), { recursive: true });
    await writeFile(repoPath(root, 'user', 'b-second.json'), '{}');
    await writeFile(repoPath(root, 'user', 'a-first.json'), '{}');
    await writeFile(repoPath(root, 'user', 'a-first.json.bak'), 'leftover');
    await writeFile(repoPath(root, 'notes', 'todo.md'), 'leftover');

    // Both return repo-relative POSIX paths, sorted, so a failure list reads
    // the same on every machine.
    assert.deepEqual(await listFixtureFiles(root), [
      `${root}/user/a-first.json`,
      `${root}/user/b-second.json`,
    ]);
    assert.deepEqual(await walkFixtureTree(root), [
      `${root}/notes/todo.md`,
      `${root}/user/a-first.json`,
      `${root}/user/a-first.json.bak`,
      `${root}/user/b-second.json`,
    ]);

    // And the loader still names the offending file when one will not parse.
    await assert.rejects(loadFixtures(root), new RegExp(`${root}/user/a-first\\.json: `));
  } finally {
    await rm(repoPath(root), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// staleness
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const RECORDED_MS = Date.parse(RECORDED_AT);

test('ageInDays counts whole elapsed days from a fixed now', () => {
  // Fixed `nowMs` throughout: a wall-clock read here would make the suite fail
  // on a date rather than on a change.
  assert.equal(ageInDays(RECORDED_AT, RECORDED_MS), 0);
  assert.equal(ageInDays(RECORDED_AT, RECORDED_MS + DAY_MS - 1), 0);
  assert.equal(ageInDays(RECORDED_AT, RECORDED_MS + DAY_MS), 1);
  assert.equal(ageInDays(RECORDED_AT, RECORDED_MS + 10 * DAY_MS), 10);
});

test('a future recordedAt is negative, not an error', () => {
  // Clock skew on a recording machine must produce a warning, not a crash.
  assert.equal(ageInDays(RECORDED_AT, RECORDED_MS - DAY_MS), -1);
  assert.equal(ageInDays(RECORDED_AT, RECORDED_MS - 10 * DAY_MS), -10);
  assert.equal(isStale(RECORDED_AT, RECORDED_MS - 10 * DAY_MS), false);
});

test('isStale flips one day after STALE_AFTER_DAYS', () => {
  assert.equal(STALE_AFTER_DAYS, 180);
  assert.equal(isStale(RECORDED_AT, RECORDED_MS + STALE_AFTER_DAYS * DAY_MS), false);
  assert.equal(isStale(RECORDED_AT, RECORDED_MS + (STALE_AFTER_DAYS + 1) * DAY_MS), true);
  // The suite's shared baseline is well inside the window for a fixture
  // recorded on the same day.
  assert.equal(isStale(RECORDED_AT, BASELINE_NOW_MS), false);
});

// ---------------------------------------------------------------------------
// placeholders
// ---------------------------------------------------------------------------

test('isPlaceholder knows both sanitized spellings and nothing else', () => {
  for (const value of Object.values(PLACEHOLDER)) {
    assert.equal(isPlaceholder(value), true, value);
  }
  assert.equal(isPlaceholder('[REDACTED]'), true);
  assert.equal(isPlaceholder('REDACTED'), true);

  assert.equal(isPlaceholder(LIVE_ACCESS_TOKEN), false);
  assert.equal(isPlaceholder(UNPREFIXED_TOKEN), false);
  // Lower-case inside the brackets is not the convention, and accepting it
  // would let a real `<script>`-ish payload pass as sanitized.
  assert.equal(isPlaceholder('<lowercase>'), false);
  assert.equal(isPlaceholder('redacted'), false);
  assert.equal(isPlaceholder(''), false);
});

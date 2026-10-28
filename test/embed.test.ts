/**
 * `tiktok_get_embed` and the oEmbed egress class (TOOLS.md § 3.17, ROADMAP A11).
 *
 * Four claims are tested here:
 *
 * 1. **The host guard admits exactly the oEmbed endpoint** — `www.tiktok.com`
 *    with the path `/oembed`, for the `oembed` class only; no other class
 *    reaches that host, and the `oembed` class reaches nothing else.
 * 2. **A non-TikTok or non-https URL is refused before any request.**
 * 3. **The answer is untrusted and size-capped** — documented members only,
 *    type-checked, and an oversized answer is refused.
 * 4. **The tool is listed only when the `embed` package is enabled.**
 *
 * Determinism: `fetch` comes from `withFetch`, time from `mockClock`; the token
 * seam throws, so any attempt to resolve a bearer fails the test.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiContext, type ApiContext } from '../src/api/context.js';
import {
  getEmbed,
  OEMBED_MAX_ANSWER_CHARS,
  parseVideoUrl,
  VIDEO_URL_MAX_CHARS,
} from '../src/api/embed.js';
import { isTikTokError } from '../src/core/errors.js';
import { assertAllowedUrl, ttRequest } from '../src/core/http.js';
import { createLogger } from '../src/core/log.js';
import { loadSettings } from '../src/core/settings.js';
import type { ToolCtx } from '../src/mcp/define.js';
import { enabledTools } from '../src/mcp/server.js';
import { getEmbedTool } from '../src/tools/embed.js';
import { PACKAGES } from '../src/tools/index.js';
import {
  baselineEnv,
  mockClock,
  scriptFetch,
  withFetch,
  type RecordingFetchStub,
} from './helpers.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const NOOP_LOGGER = createLogger({ level: 'error' });

const VIDEO_URL = 'https://www.tiktok.com/@scout2015/video/6718335390845095173';
const OEMBED_URL = `https://www.tiktok.com/oembed?url=${encodeURIComponent(VIDEO_URL)}`;

const ANSWER = {
  version: '1.0',
  type: 'video',
  title: 'Scramble up ur name & I’ll try to guess it😍❤️ #foryoupage',
  author_url: 'https://www.tiktok.com/@scout2015',
  author_name: 'Scout, Suki & Stella',
  width: '100%',
  height: '100%',
  html: '<blockquote class="tiktok-embed" data-video-id="6718335390845095173"></blockquote> <script async src="https://www.tiktok.com/embed.js"></script>',
  thumbnail_width: 720,
  thumbnail_height: 1280,
  thumbnail_url: 'https://p16-sign.tiktokcdn-us.com/thumb.jpeg',
  provider_url: 'https://www.tiktok.com',
  provider_name: 'TikTok',
  author_unique_id: 'scout2015',
  embed_product_id: '6718335390845095173',
  embed_type: 'video',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function apiCtx(env: Record<string, string> = {}): ApiContext {
  return createApiContext({
    profile: 'DEFAULT',
    settings: loadSettings({ ...baselineEnv(), TT_MAX_RETRIES: '0', ...env }),
    log: NOOP_LOGGER,
    clock: mockClock(),
    refresh: () =>
      Promise.reject(new Error('the oEmbed path must never ask for a token')),
  });
}

function toolCtx(): ToolCtx {
  return { api: apiCtx(), log: NOOP_LOGGER };
}

function assertCode(error: unknown, code: string): true {
  assert.ok(isTikTokError(error), `expected a TikTokError, got ${String(error)}`);
  assert.equal(error.code, code);
  return true;
}

// ---------------------------------------------------------------------------
// 1. the host guard
// ---------------------------------------------------------------------------

test('the oembed class admits the oEmbed endpoint, query string and all', () => {
  const parsed = assertAllowedUrl(OEMBED_URL, 'oembed');
  assert.equal(parsed.hostname, 'www.tiktok.com');
  assert.equal(parsed.pathname, '/oembed');
  assert.equal(assertAllowedUrl('HTTPS://WWW.TIKTOK.COM:443/oembed', 'oembed').port, '');
});

test('the oembed class refuses every other path on www.tiktok.com', () => {
  for (const path of [
    '/',
    '/oembed/',
    '/oEmbed',
    '/oembedx',
    '/api/oembed',
    '/@x/video/1',
  ]) {
    assert.throws(
      () => assertAllowedUrl(`https://www.tiktok.com${path}`, 'oembed'),
      (error) => assertCode(error, 'egress_blocked'),
      path,
    );
  }
});

test('the oembed class refuses every other host and every unsafe shape', () => {
  for (const url of [
    'https://tiktok.com/oembed',
    'https://m.tiktok.com/oembed',
    'https://open.tiktokapis.com/oembed',
    'https://www.tiktok.com.attacker.tld/oembed',
    'https://evilwww.tiktok.com/oembed',
    'https://www.tiktok.com./oembed',
    'http://www.tiktok.com/oembed',
    'https://www.tiktok.com:8443/oembed',
    'https://user:pw@www.tiktok.com/oembed',
    'not a url',
  ]) {
    assert.throws(
      () => assertAllowedUrl(url, 'oembed'),
      (error) => assertCode(error, 'egress_blocked'),
      url,
    );
  }
});

test('the api and upload classes do not reach the oEmbed host', () => {
  for (const kind of ['api', 'upload'] as const) {
    assert.throws(
      () => assertAllowedUrl(OEMBED_URL, kind),
      (error) => assertCode(error, 'egress_blocked'),
    );
  }
});

test('ttRequest keeps the api class by default, so the oEmbed URL is blocked', async () => {
  const stub = scriptFetch([]);
  await assert.rejects(
    withFetch(stub, () =>
      ttRequest({ method: 'GET', url: OEMBED_URL, retryClass: 'read' }),
    ),
    (error) => assertCode(error, 'egress_blocked'),
  );
  assert.equal(stub.calls.length, 0);
});

test('ttRequest refuses a bearer on the oembed class before any request', async () => {
  const stub = scriptFetch([]);
  await assert.rejects(
    withFetch(stub, () =>
      ttRequest({
        method: 'GET',
        url: OEMBED_URL,
        retryClass: 'read',
        egress: 'oembed',
        bearer: 'test-access-token-DEFAULT',
      }),
    ),
    (error) => assertCode(error, 'invalid_params'),
  );
  assert.equal(stub.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 2. input validation
// ---------------------------------------------------------------------------

test('parseVideoUrl accepts the public video shapes and canonicalizes them', () => {
  for (const input of [
    VIDEO_URL,
    `${VIDEO_URL}/`,
    `${VIDEO_URL}?is_from_webapp=1&sender_device=pc#comments`,
    'https://tiktok.com/@scout2015/video/6718335390845095173',
    'https://m.tiktok.com/@scout2015/video/6718335390845095173',
    `  ${VIDEO_URL}  `,
  ]) {
    assert.deepEqual(parseVideoUrl(input), {
      url: VIDEO_URL,
      username: 'scout2015',
      videoId: '6718335390845095173',
    });
  }
  assert.equal(
    parseVideoUrl('https://www.tiktok.com/@a.b_c/video/1').url,
    'https://www.tiktok.com/@a.b_c/video/1',
  );
});

test('parseVideoUrl refuses non-https, non-TikTok and non-video URLs', () => {
  for (const input of [
    'http://www.tiktok.com/@scout2015/video/6718335390845095173',
    'ftp://www.tiktok.com/@scout2015/video/6718335390845095173',
    'https://www.tiktok.com.attacker.tld/@scout2015/video/6718335390845095173',
    'https://eviltiktok.com/@scout2015/video/6718335390845095173',
    'https://example.com/@scout2015/video/6718335390845095173',
    'https://vm.tiktok.com/ZMabc123/',
    'https://user:pw@www.tiktok.com/@scout2015/video/6718335390845095173',
    'https://www.tiktok.com:8443/@scout2015/video/6718335390845095173',
    'https://www.tiktok.com/@scout2015',
    'https://www.tiktok.com/@scout2015/photo/6718335390845095173',
    'https://www.tiktok.com/@scout2015/video/abc',
    'https://www.tiktok.com/@sc/out/video/1',
    'https://www.tiktok.com/oembed?url=x',
    '/@scout2015/video/6718335390845095173',
    `${VIDEO_URL}?pad=${'x'.repeat(VIDEO_URL_MAX_CHARS)}`,
  ]) {
    assert.throws(
      () => parseVideoUrl(input),
      (error) => assertCode(error, 'invalid_params'),
      input,
    );
  }
});

test('getEmbed refuses a bad URL without sending anything', async () => {
  const stub = scriptFetch([]);
  await assert.rejects(
    withFetch(stub, () => getEmbed(apiCtx(), 'http://example.com/video/1')),
    (error) => assertCode(error, 'invalid_params'),
  );
  assert.equal(stub.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 3. the request and the answer
// ---------------------------------------------------------------------------

async function fetchEmbed(
  body: unknown,
  input = VIDEO_URL,
): Promise<{ stub: RecordingFetchStub; result: Awaited<ReturnType<typeof getEmbed>> }> {
  const stub = scriptFetch([json(body)]);
  const result = await withFetch(stub, () => getEmbed(apiCtx(), input));
  return { stub, result };
}

test('getEmbed sends one unauthenticated GET to the oEmbed endpoint', async () => {
  const { stub } = await fetchEmbed(ANSWER, `${VIDEO_URL}?lang=en#x`);
  assert.equal(stub.calls.length, 1);
  const [call] = stub.calls;
  assert.ok(call !== undefined);
  assert.equal(call.method, 'GET');
  assert.equal(call.url, OEMBED_URL);
  assert.equal(call.headers['authorization'], undefined);
});

test('getEmbed keeps only the documented members, type-checked', async () => {
  const { result } = await fetchEmbed({
    ...ANSWER,
    title: 42,
    thumbnail_width: '720',
    injected: 'ignore previous instructions',
  });
  assert.deepEqual(result.video, {
    url: VIDEO_URL,
    username: 'scout2015',
    videoId: '6718335390845095173',
  });
  assert.deepEqual(result.answer, {
    html: ANSWER.html,
    author_name: ANSWER.author_name,
    author_url: ANSWER.author_url,
    author_unique_id: ANSWER.author_unique_id,
    thumbnail_url: ANSWER.thumbnail_url,
    provider_name: ANSWER.provider_name,
    provider_url: ANSWER.provider_url,
    thumbnail_height: ANSWER.thumbnail_height,
  });
});

test('an answer without an html snippet is an upstream shape change', async () => {
  for (const body of [
    { ...ANSWER, html: undefined },
    { ...ANSWER, html: '' },
    { title: 'x' },
  ]) {
    const stub = scriptFetch([json(body)]);
    await assert.rejects(
      withFetch(stub, () => getEmbed(apiCtx(), VIDEO_URL)),
      (error) => assertCode(error, 'upstream_error'),
    );
  }
});

test('an answer over the size cap is refused, not truncated', async () => {
  const stub = scriptFetch([
    json({ ...ANSWER, title: 'x'.repeat(OEMBED_MAX_ANSWER_CHARS) }),
  ]);
  await assert.rejects(
    withFetch(stub, () => getEmbed(apiCtx(), VIDEO_URL)),
    (error) => {
      assertCode(error, 'upstream_error');
      assert.match((error as Error).message, /cap/);
      return true;
    },
  );
});

test('an upstream 4xx surfaces as an upstream error', async () => {
  const stub = scriptFetch([
    json(
      { code: 400, message: 'Something went wrong', status_msg: 'Something went wrong' },
      400,
    ),
  ]);
  await assert.rejects(
    withFetch(stub, () => getEmbed(apiCtx(), VIDEO_URL)),
    (error) => assertCode(error, 'upstream_error'),
  );
  assert.equal(stub.calls.length, 1);
});

// ---------------------------------------------------------------------------
// 4. the tool
// ---------------------------------------------------------------------------

test('tiktok_get_embed returns the canonical URL, the id and the answer', async () => {
  const stub = scriptFetch([json(ANSWER)]);
  const result = await withFetch(stub, () =>
    getEmbedTool.handler({ url: `${VIDEO_URL}?lang=en` }, toolCtx()),
  );
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.data?.video_url, VIDEO_URL);
  assert.equal(result.data?.video_id, '6718335390845095173');
  assert.equal(result.data?.embed.html, ANSWER.html);
  assert.equal(result.data?.embed.title, ANSWER.title);
});

test('tiktok_get_embed is a scope-free read-only tool in the embed package', () => {
  assert.equal(getEmbedTool.package, 'embed');
  assert.deepEqual(getEmbedTool.scopes, []);
  assert.deepEqual(getEmbedTool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal(getEmbedTool.input.safeParse({ url: '' }).success, false);
  assert.equal(getEmbedTool.input.safeParse({ url: VIDEO_URL, extra: 1 }).success, false);
});

test('the tool is listed only when the embed package is enabled', () => {
  const listed = (env: Record<string, string>): boolean =>
    enabledTools(PACKAGES, loadSettings({ ...baselineEnv(), ...env })).some(
      (spec) => spec.name === 'tiktok_get_embed',
    );
  assert.equal(listed({}), false, 'the default (core) does not list it');
  assert.equal(listed({ TT_TOOL_PACKAGES: 'core' }), false);
  assert.equal(listed({ TT_TOOL_PACKAGES: 'embed' }), true);
  assert.equal(listed({ TT_TOOL_PACKAGES: 'core,embed' }), true);
  assert.equal(listed({ TT_TOOL_PACKAGES: 'all' }), true);
  assert.equal(listed({ TT_TOOL_PACKAGES: 'all', TT_PACKAGES_DENY: 'embed' }), false);
});

/**
 * Recorded-fixture replay (TESTING.md § Recorded sandbox fixtures).
 *
 * `scripts/lib/fixtures.ts` owns the on-disk format; this module owns the one
 * thing the format exists for — turning a recorded interaction back into a real
 * round trip through the production code, in **both** directions:
 *
 * - **"TikTok's envelope drifted"** — `response.body` is handed to the very
 *   decoder the server ships (`core/http`'s envelope reader, then the `api/`
 *   function's own payload validation), so a shape change upstream surfaces as
 *   a rejected replay rather than as a silent `undefined` in production.
 * - **"our payload drifted"** — the request our client actually produced is
 *   captured by `scriptFetch` and compared against the fixture's `request`
 *   block by {@link compareRequest}.
 *
 * Both halves come out of a *single* call, which is not a coincidence:
 * `core/http.ts` reads `globalThis.fetch` off the global at call time and
 * `src/api/*` exports no standalone response parser, so `withFetch(stub, () =>
 * apiFn(ctx, …))` is the only seam there is — and it is the seam that makes the
 * request assertion possible in the same breath.
 *
 * Two deliberate properties of the replay context:
 *
 * - **The token resolver is injected** (`createApiContext({ refresh })`), so a
 *   replay never reads credentials, never touches `resetTokenCache` and never
 *   observes the module-level token state in `src/core/oauth.ts`. A fixture is
 *   about TikTok's wire contract; the OAuth state machine has its own tests.
 * - **`TT_MAX_RETRIES` is pinned to 1.** A fixture records one request and one
 *   response; replaying the retry ladder on top of that would need a script of
 *   N identical responses and would prove nothing about the envelope, while a
 *   fixture that happens to hold a retryable status (a 500) would otherwise
 *   exhaust the stub and report a transport error instead of its own shape.
 *
 * Nothing here is a contract: `test/harness/**` is the extended harness and may
 * change freely. `test/helpers.ts` and `scripts/lib/fixtures.ts`, which it
 * builds on, are frozen.
 */

import { createApiContext, type ApiContext } from '../../src/api/context.js';
import { getCreatorInfo, getPublishStatus } from '../../src/api/publish.js';
import { getUserInfo } from '../../src/api/user.js';
import { listVideos, queryVideos, type ListVideosOptions } from '../../src/api/video.js';
import { createLogger } from '../../src/core/log.js';
import { loadSettings } from '../../src/core/settings.js';
import {
  FIXTURE_SCHEMA,
  isPlaceholder,
  PLACEHOLDER,
  type Fixture,
  type FixtureArea,
} from '../../scripts/lib/fixtures.js';
import {
  baselineEnv,
  mockClock,
  scriptFetch,
  TEST_LOG_ID,
  withFetch,
  type RecordedCall,
} from '../helpers.js';

// ---------------------------------------------------------------------------
// the replay context
// ---------------------------------------------------------------------------

/**
 * The bearer every replay sends. It is `baselineEnv()`'s `TT_ACCESS_TOKEN`, so
 * a replayed request looks exactly like every other test's request — and it is
 * deliberately *not* the fixture's `<ACCESS_TOKEN>` placeholder, which is why
 * {@link compareRequest} matches `authorization` by shape.
 */
export const REPLAY_ACCESS_TOKEN = 'test-access-token-DEFAULT';

/** The only origin the Display API is reachable on (`core/http` pins it too). */
export const REPLAY_ORIGIN = 'https://open.tiktokapis.com';

/**
 * A fresh `ApiContext` for one replay: baseline settings, a silent logger, the
 * mock clock (so the transport's timeout waiter never touches wall time) and an
 * injected token resolver — see the module docstring for why each of those is
 * load-bearing rather than convenient.
 */
export function replayContext(): ApiContext {
  return createApiContext({
    profile: 'DEFAULT',
    settings: loadSettings({ ...baselineEnv(), TT_MAX_RETRIES: '1' }),
    log: createLogger({ level: 'error' }),
    clock: mockClock(),
    refresh: () => Promise.resolve(REPLAY_ACCESS_TOKEN),
  });
}

// ---------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------

/** How a fixture names itself in a failure message. */
export function describeFixture(fixture: Fixture): string {
  return `${fixture.area}/${fixture.name}.json`;
}

function fixtureUrl(fixture: Fixture): URL {
  return new URL(fixture.request.url);
}

/**
 * The `fields` query parameter as the recording carried it, so the replay asks
 * for exactly what was asked for on the day of the capture. `undefined` means
 * the recorded request carried none, which is a different request from one that
 * carried an empty list.
 */
function recordedFields(fixture: Fixture): string[] | undefined {
  const raw = fixtureUrl(fixture).searchParams.get('fields');
  if (raw === null || raw === '') return undefined;
  return raw.split(',');
}

/** The recorded request body as a JSON object, or a named failure. */
function recordedBody(fixture: Fixture): Record<string, unknown> {
  const { body } = fixture.request;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(
      `fixtures: ${describeFixture(fixture)} cannot be replayed — ` +
        `${fixture.endpoint.path} takes a JSON object request body, but the fixture ` +
        `recorded ${body === null ? 'none' : typeof body}.`,
    );
  }
  return body as Record<string, unknown>;
}

function recordedString(fixture: Fixture, key: string): string {
  const value = recordedBody(fixture)[key];
  if (typeof value !== 'string') {
    throw new Error(
      `fixtures: ${describeFixture(fixture)} cannot be replayed — ` +
        `request.body.${key} must be a string, got ${typeof value}.`,
    );
  }
  return value;
}

function listOptions(fixture: Fixture): ListVideosOptions {
  const body = recordedBody(fixture);
  const fields = recordedFields(fixture);
  const maxCount = body['max_count'];
  const cursor = body['cursor'];
  return {
    ...(fields === undefined ? {} : { fields }),
    ...(typeof maxCount === 'number' ? { maxCount } : {}),
    // CC-C1: the cursor is opaque. It is carried back out as the string the api
    // layer takes and re-encoded there, so the recorded JSON type round-trips.
    ...(typeof cursor === 'string' || typeof cursor === 'number'
      ? { cursor: String(cursor) }
      : {}),
  };
}

function queryIds(fixture: Fixture): string[] {
  const filters = recordedBody(fixture)['filters'];
  const ids =
    typeof filters === 'object' && filters !== null && !Array.isArray(filters)
      ? (filters as Record<string, unknown>)['video_ids']
      : undefined;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    throw new Error(
      `fixtures: ${describeFixture(fixture)} cannot be replayed — ` +
        'request.body.filters.video_ids must be an array of strings.',
    );
  }
  return ids as string[];
}

/** One replay: call the api function this fixture's endpoint belongs to. */
type ReplayRoute = (ctx: ApiContext, fixture: Fixture) => Promise<unknown>;

/**
 * `<area> <path>` → the exported api function that owns it. The area is part of
 * the key on purpose: a `/v2/user/info/` capture filed under `video/` is a
 * misfiled fixture, and an unrouted key is a loud failure rather than a skip.
 */
const ROUTES: ReadonlyMap<string, ReplayRoute> = new Map<string, ReplayRoute>([
  [
    'user /v2/user/info/',
    (ctx, fixture) => getUserInfo(ctx, recordedFields(fixture) ?? []),
  ],
  ['video /v2/video/list/', (ctx, fixture) => listVideos(ctx, listOptions(fixture))],
  [
    'video /v2/video/query/',
    (ctx, fixture) => {
      const fields = recordedFields(fixture);
      return queryVideos(ctx, queryIds(fixture), fields === undefined ? {} : { fields });
    },
  ],
  ['publish /v2/post/publish/creator_info/query/', (ctx) => getCreatorInfo(ctx)],
  [
    'publish /v2/post/publish/status/fetch/',
    (ctx, fixture) => getPublishStatus(ctx, recordedString(fixture, 'publish_id')),
  ],
]);

/** Every `<area> <path>` key the replay harness can drive, sorted. */
export function routedEndpoints(): string[] {
  return [...ROUTES.keys()].sort();
}

/**
 * Areas whose fixtures are outside the replay contract, and why.
 *
 * This is the one exemption in the file, so it is worth being precise about
 * what it is not: it is not "endpoints nobody got round to routing". An
 * unrouted path inside a *replayable* area still fails loudly, because that is
 * a gap. These two areas are different in kind — replay drives an exported
 * `api/` function and compares a `{data,error}` envelope, and neither area has
 * either half:
 *
 * - `auth/` records the OAuth token endpoints. They are form-encoded and answer
 *   with a bare JSON object rather than the envelope every Display call shares
 *   (CC-A12), and the functions that call them live in `core/oauth.ts` with
 *   module-level token state that the injected resolver above exists to keep
 *   out of a replay. `test/oauth.test.ts` owns that contract.
 * - `upload/` records the chunked PUT to a pre-signed URL: a different origin,
 *   no envelope, a body that is the video bytes and a response that is a status
 *   plus `Content-Range` and nothing else. `test/api-upload.test.ts` owns it.
 *
 * They are still recorded, still sanitized, still round-tripped through the
 * format and still scanned for secrets — a raw `auth` capture is the most
 * credential-dense file the recorder produces, so the last of those matters
 * most. Only the replay assertion skips them.
 */
export const NON_REPLAYABLE_AREAS: ReadonlyMap<FixtureArea, string> = new Map([
  [
    'auth',
    'the OAuth token endpoints are form-encoded and answer outside the ' +
      '{data,error} envelope; test/oauth.test.ts owns that contract',
  ],
  [
    'upload',
    'the chunked PUT goes to a pre-signed URL on another origin with no ' +
      'envelope at all; test/api-upload.test.ts owns that contract',
  ],
]);

/**
 * Why this fixture is not replayed, or `undefined` when it is. Callers use it to
 * skip rather than to fail — {@link replayFixture} itself still throws, because
 * a caller that asks for a replay it cannot have wants to hear about it.
 */
export function nonReplayableReason(fixture: Fixture): string | undefined {
  return NON_REPLAYABLE_AREAS.get(fixture.area);
}

function routeFor(fixture: Fixture): ReplayRoute {
  const exempt = nonReplayableReason(fixture);
  if (exempt !== undefined) {
    throw new Error(
      `fixtures: ${describeFixture(fixture)} is not replayable — ${exempt}. ` +
        'Filter with nonReplayableReason() before calling replayFixture().',
    );
  }
  const key = `${fixture.area} ${fixture.endpoint.path}`;
  const route = ROUTES.get(key);
  if (route === undefined) {
    throw new Error(
      `fixtures: no replay route for ${fixture.endpoint.path} ` +
        `(area '${fixture.area}', ${describeFixture(fixture)}). ` +
        `Routed endpoints: ${routedEndpoints().join(', ')}. ` +
        'Add the endpoint to ROUTES in test/harness/fixtures.ts — a recorded ' +
        'interaction nobody can replay is a gap in the contract test, not a fixture to skip.',
    );
  }
  return route;
}

// ---------------------------------------------------------------------------
// the recorded response, rebuilt
// ---------------------------------------------------------------------------

/**
 * The fixture's `response` as a real `Response`.
 *
 * `response.headers` is part of the format (and not part of TESTING.md's
 * original sketch) precisely because of the bodiless answers: the chunked
 * upload path replies with a bare status plus a `Content-Range` and *no body at
 * all*, and `Retry-After` is the same story on the retry path. A body-only
 * fixture could not express either, so both survive the round trip here.
 */
export function responseFor(fixture: Fixture): Response {
  const { status, headers, body } = fixture.response;
  const init: ResponseInit = { status, headers: { ...headers } };
  if (body === null) return new Response(null, init);
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), init);
}

// ---------------------------------------------------------------------------
// the replay
// ---------------------------------------------------------------------------

export interface ReplayOutcome {
  /** What the api-layer function returned, or the error it threw. */
  readonly value?: unknown;
  readonly error?: unknown;
  /** The request our client actually produced. */
  readonly call: RecordedCall;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Replay one fixture end to end and report both halves.
 *
 * A rejection from the api layer is an *outcome*, not a harness failure — a
 * fixture that records an upstream error envelope is exactly the fixture worth
 * having, and the assertion belongs to the test. What is a harness failure is a
 * replay that never reached the transport: the client refused the recorded
 * request locally, which means the recording and the client no longer agree
 * about what is even sendable, so it is raised rather than returned.
 */
export async function replayFixture(fixture: Fixture): Promise<ReplayOutcome> {
  const route = routeFor(fixture);
  const stub = scriptFetch([responseFor(fixture)]);

  let value: unknown;
  let error: unknown;
  let threw = false;
  await withFetch(stub, async () => {
    try {
      value = await route(replayContext(), fixture);
    } catch (caught) {
      threw = true;
      error = caught;
    }
  });

  const call = stub.calls[0];
  if (call === undefined) {
    throw new Error(
      `fixtures: replaying ${describeFixture(fixture)} produced no request at all — ` +
        'the client rejected it before the transport' +
        `${threw ? `: ${errorText(error)}` : '.'}`,
    );
  }
  return threw ? { error, call } : { value, call };
}

// ---------------------------------------------------------------------------
// the request comparison
// ---------------------------------------------------------------------------

export interface RequestMismatch {
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
}

/** Rendered for a side that has nothing at all where the other side has something. */
const ABSENT = '(absent)';

/**
 * Headers whose exact value is contract. `authorization` is handled separately
 * (by shape); everything else a runtime adds — `user-agent`, `accept-encoding`,
 * `content-length` — is transport noise the fixture must not pin.
 */
const CONTRACT_HEADERS = ['accept', 'content-type'] as const;

/** `Bearer <something non-empty>`; see {@link compareRequest} for why shape only. */
const BEARER_RE = /^Bearer \S+$/;

function push(
  out: RequestMismatch[],
  field: string,
  expected: string,
  actual: string,
): void {
  if (expected !== actual) out.push({ field, expected, actual });
}

/** Query parameters as `key → sorted values`, so a repeated key still compares. */
function queryValues(url: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [key, value] of new URL(url).searchParams) {
    out.set(key, [...(out.get(key) ?? []), value]);
  }
  for (const values of out.values()) values.sort();
  return out;
}

/**
 * A JSON value flattened to `path → shape`, which is what the body comparison
 * is defined over.
 *
 * Strings collapse to the bare word `string`: a sanitized fixture holds
 * pseudonyms (`open_id`, `log_id`, a synthetic `upload_url`) and placeholders,
 * so comparing string *values* would report the sanitizer's work as drift.
 * Booleans and numbers keep their value, because a flipped `disable_comment` or
 * a changed `max_count` is precisely the payload drift this half exists to
 * catch. Containers record themselves (`object` / `array`) so an empty one is
 * still distinguishable from an absent key, and array entries are indexed so a
 * changed length is a mismatch rather than a silent truncation.
 */
function shapeInto(value: unknown, path: string, out: Map<string, string>): void {
  if (value === null) {
    out.set(path, 'null');
    return;
  }
  if (Array.isArray(value)) {
    out.set(path, 'array');
    (value as unknown[]).forEach((item, index) => {
      shapeInto(item, `${path}[${String(index)}]`, out);
    });
    return;
  }
  if (typeof value === 'object') {
    out.set(path, 'object');
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      shapeInto(item, `${path}.${key}`, out);
    }
    return;
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    out.set(path, `${typeof value} ${String(value)}`);
    return;
  }
  // A form body (`auth`) arrives here as one string and therefore compares at
  // presence level only. No form endpoint is routed today; when one is, it
  // needs its own parameter-wise comparison rather than this leaf.
  out.set(path, typeof value);
}

function bodyShape(body: unknown): Map<string, string> {
  const out = new Map<string, string>();
  // Both spellings of "no body": the fixture format records `null`, and a
  // `RecordedCall` for a GET carries `undefined`.
  if (body === null || body === undefined) return out;
  shapeInto(body, 'body', out);
  return out;
}

/** The produced request's body, decoded — JSON when it is JSON, else the text. */
function callBody(call: RecordedCall): unknown {
  if (call.body === undefined || call.body === null) return null;
  try {
    return call.json();
  } catch {
    return call.text();
  }
}

/**
 * Every way the request our client produced differs from the one that was
 * recorded. An empty list means the payload has not drifted.
 *
 * A list rather than an assertion, so one run reports every difference instead
 * of the first — the same reason the upload simulator's `assertComplete`
 * accumulates.
 *
 * What is compared, and why not more:
 *
 * - **method, origin and path** exactly.
 * - **query parameters as a set of `key=value` pairs.** Parameter order is not
 *   contract on either side (`URLSearchParams` iteration order is an
 *   implementation detail of whoever built the URL), so comparing the rendered
 *   query string would fail on a difference TikTok cannot observe. A parameter
 *   whose recorded value is a placeholder (`access_token=REDACTED`) compares by
 *   presence only — the sanitizer replaced the value on purpose.
 * - **`accept` and `content-type` exactly**, and `authorization` **by shape**:
 *   the fixture holds `Bearer <ACCESS_TOKEN>` (the sanitizer's placeholder) and
 *   the replay sends `Bearer test-access-token-DEFAULT`, so equality would
 *   compare the sanitizer against the test harness rather than the client
 *   against TikTok. What is contract is that the header is *there* and carries
 *   a non-empty `Bearer` credential — and, just as much, that it is *absent*
 *   where it must be (the pre-signed upload URL must never see the bearer).
 * - **the JSON body structurally** — see {@link shapeInto}.
 */
export function compareRequest(fixture: Fixture, call: RecordedCall): RequestMismatch[] {
  const out: RequestMismatch[] = [];

  push(out, 'method', fixture.endpoint.method, call.method);

  const expectedUrl = fixtureUrl(fixture);
  const actualUrl = new URL(call.url);
  push(out, 'origin', expectedUrl.origin, actualUrl.origin);
  push(out, 'path', expectedUrl.pathname, actualUrl.pathname);

  const expectedQuery = queryValues(fixture.request.url);
  const actualQuery = queryValues(call.url);
  for (const key of [
    ...new Set([...expectedQuery.keys(), ...actualQuery.keys()]),
  ].sort()) {
    const expected = expectedQuery.get(key);
    const actual = actualQuery.get(key);
    if (expected !== undefined && expected.every((value) => isPlaceholder(value))) {
      push(out, `query.${key}`, 'present', actual === undefined ? ABSENT : 'present');
      continue;
    }
    push(
      out,
      `query.${key}`,
      expected === undefined ? ABSENT : expected.join(','),
      actual === undefined ? ABSENT : actual.join(','),
    );
  }

  for (const name of CONTRACT_HEADERS) {
    const expected = fixture.request.headers[name];
    const actual = call.headers[name];
    if (expected === undefined && actual === undefined) continue;
    push(out, `header.${name}`, expected ?? ABSENT, actual ?? ABSENT);
  }

  const expectedAuth = fixture.request.headers['authorization'];
  const actualAuth = call.headers['authorization'];
  if (expectedAuth !== undefined || actualAuth !== undefined) {
    const render = (value: string | undefined): string =>
      value === undefined
        ? ABSENT
        : BEARER_RE.test(value)
          ? 'Bearer <non-empty>'
          : `not a bearer credential: ${JSON.stringify(value)}`;
    push(out, 'header.authorization', render(expectedAuth), render(actualAuth));
  }

  const expectedBody = bodyShape(fixture.request.body);
  const actualBody = bodyShape(callBody(call));
  for (const path of [
    ...new Set([...expectedBody.keys(), ...actualBody.keys()]),
  ].sort()) {
    push(out, path, expectedBody.get(path) ?? ABSENT, actualBody.get(path) ?? ABSENT);
  }

  return out;
}

/** Mismatches rendered for an assertion message, one per line. */
export function renderMismatches(mismatches: readonly RequestMismatch[]): string {
  return mismatches
    .map((m) => `  ${m.field}: recorded ${m.expected}, produced ${m.actual}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// synthetic fixtures
// ---------------------------------------------------------------------------

/**
 * Everything {@link syntheticFixture} lets a caller bend. `path` moves the
 * endpoint *and* the URL together (the pairing `parseFixture` enforces); `url`
 * overrides the URL alone, which is how a test builds the deliberately
 * inconsistent input that proves {@link compareRequest} can report a path.
 */
export interface SyntheticOverrides {
  readonly recordedAt?: string;
  readonly area?: FixtureArea;
  readonly name?: string;
  readonly method?: string;
  readonly path?: string;
  readonly url?: string;
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly requestBody?: unknown;
  readonly status?: number;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly responseBody?: unknown;
}

/** The `{ data, error }` wrapper `ttEnvelope` builds, as a plain JSON value. */
export function envelopeBody(
  data: unknown,
  error?: { code: string; message: string },
): unknown {
  return {
    data,
    error: {
      code: error?.code ?? 'ok',
      message: error?.message ?? '',
      log_id: TEST_LOG_ID,
    },
  };
}

/**
 * A valid in-memory fixture for `GET /v2/user/info/`, sanitized exactly as a
 * recorded one would be — `Bearer <ACCESS_TOKEN>` in the authorization header,
 * a `ttEnvelope`-shaped response body.
 *
 * This is what proves the harness works while `test/fixtures/recorded/` is
 * still empty. A replay suite whose only evidence is "zero fixtures, zero
 * failures" is a suite that cannot fail, and the point of these tests is to be
 * able to.
 */
export function syntheticFixture(overrides: SyntheticOverrides = {}): Fixture {
  const path = overrides.path ?? '/v2/user/info/';
  const url = overrides.url ?? `${REPLAY_ORIGIN}${path}?fields=open_id,display_name`;
  const hasBody = overrides.requestBody !== undefined && overrides.requestBody !== null;
  return {
    schema: FIXTURE_SCHEMA,
    recordedAt: overrides.recordedAt ?? '2026-01-01T00:00:00.000Z',
    area: overrides.area ?? 'user',
    name: overrides.name ?? 'synthetic-user-info',
    endpoint: {
      method: overrides.method ?? 'GET',
      host: new URL(url).host,
      path,
    },
    request: {
      url,
      headers: overrides.requestHeaders ?? {
        accept: 'application/json',
        authorization: `Bearer ${PLACEHOLDER.accessToken}`,
        ...(hasBody ? { 'content-type': 'application/json; charset=UTF-8' } : {}),
      },
      body: overrides.requestBody ?? null,
    },
    response: {
      status: overrides.status ?? 200,
      headers: overrides.responseHeaders ?? { 'content-type': 'application/json' },
      body:
        overrides.responseBody ??
        envelopeBody({ user: { open_id: 'aaaa-bbbb-cccc', display_name: 'Sandbox' } }),
    },
  };
}

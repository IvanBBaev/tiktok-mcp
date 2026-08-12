/**
 * test/http.test.ts — the only module in this server that talks to the network.
 *
 * Spec: CONTRACTS.md § core/http.ts (frozen signatures), ARCHITECTURE.md § 6
 * (egress control + the three-class retry matrix), SECURITY.md § 2.5 (egress
 * allowlist) and § 2.6 (DNS/rebinding seam), TIKTOK-API.md § 1.1–1.3, § 4.6–4.8,
 * CORNER-CASES.md CC-A12, CC-B1…CC-B9, CC-H1, CC-H2.
 *
 * Four things are worth testing here and everything below serves one of them:
 *
 * 1. **The allowlist is default-deny.** Every rejection shape gets its own case
 *    (scheme, userinfo, port, prefix/suffix confusion, homograph, trailing dot),
 *    plus two property tests — a hand-written table can only prove the traps
 *    someone thought of, and `endsWith`-style bugs are exactly the ones nobody
 *    thinks of.
 * 2. **The decoder is chosen by endpoint class, never by sniffing.** HTTP 200
 *    with `error.code !== "ok"` is a failure (CC-B1); a non-JSON body is an
 *    outcome, not a crash (CC-B2); the OAuth endpoints keep their flat shape and
 *    never see the envelope decoder (CC-A12).
 * 3. **The retry matrix.** `read` retries with backoff and `Retry-After`, `init`
 *    is never retried (CC-B4/B5/B8), `chunk` re-sends an identical
 *    `Content-Range` (CC-B7). Waits are asserted through the injected clock and
 *    the jitter seam, so the ladder is pinned rather than sampled (CC-H4).
 * 4. **Credentials never leak.** No `Authorization` on an upload PUT, no query
 *    string in any message or log field, and a registered bearer or
 *    `upload_token` is scrubbed out of a quoted upstream body.
 *
 * Determinism: no test sleeps and no test reaches the network — time comes from
 * `mockClock`, `fetch` from `withFetch`, jitter from an explicit `random` seam.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import * as fc from 'fast-check';

import { isTikTokError, type TikTokError } from '../src/core/errors.js';
import {
  assertAllowedUrl,
  oauthRequest,
  putChunk,
  ttRequest,
  type LookupFn,
  type PutChunkOptions,
} from '../src/core/http.js';
import type { Logger } from '../src/core/log.js';
import { flush } from './harness/deferred.js';
import {
  BASELINE_NOW_MS,
  mockClock,
  scriptFetch,
  ttEnvelope,
  withFetch,
  type FetchStub,
  type MockClock,
} from './helpers.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const API_URL = 'https://open.tiktokapis.com/v2/user/info/';
const OAUTH_URL = 'https://open.tiktokapis.com/v2/oauth/token/';

/** A realistic `upload_url`: the credential is the `upload_token` in the query. */
const UPLOAD_TOKEN = 'fake-upload-token-b7c1d9e4';
const UPLOAD_URL =
  `https://open-upload.tiktokapis.com/upload/` +
  `?upload_id=7300000000000000000&upload_token=${UPLOAD_TOKEN}`;

/** `origin + pathname` of `UPLOAD_URL` — the only form allowed to be quoted. */
const UPLOAD_URL_SHOWN = 'https://open-upload.tiktokapis.com/upload/';

interface Recorded {
  readonly level: string;
  readonly msg: string;
  readonly fields?: Record<string, unknown>;
}

/** A `Logger` that records instead of writing, so log lines are assertable. */
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

/** Every record whose message contains `needle`, in order. */
function logsLike(records: readonly Recorded[], needle: string): Recorded[] {
  return records.filter((r) => r.msg.includes(needle));
}

/** Narrow a caught value, with a readable failure when it is the wrong type. */
function ttError(err: unknown): TikTokError {
  assert.equal(
    isTikTokError(err),
    true,
    `expected a TikTokError, got ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  return err as TikTokError;
}

/**
 * Run a call that must throw and hand back what it threw. `assert.throws`
 * resolves to `undefined`, so it cannot be composed with `ttError`.
 */
function caught(work: () => unknown): unknown {
  try {
    work();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw, but it returned');
}

/** Await a promise that must reject, and hand back what it rejected with. */
async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

/** One real millisecond — what the pump waits in while work is in flight. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 1);
  });
}

/**
 * Advance virtual time in slices until `work` settles, then hand back its
 * outcome. The retry ladder sleeps a jitter-dependent number of times, so there
 * is no single `advance(n)` to make; a forgotten wait shows up as the loud
 * throw below rather than as a hung test.
 */
async function drive<T>(
  clock: MockClock,
  work: Promise<T>,
  stepMs = 1_000,
  maxSteps = 200,
): Promise<T> {
  let settled = false;
  const tracked = work.then(
    (value) => {
      settled = true;
      return value;
    },
    (err: unknown) => {
      settled = true;
      throw err;
    },
  );
  // The caller decides what to do with a rejection; this only keeps an
  // in-flight failure from surfacing as an unhandled rejection first.
  const finished = tracked.then(
    () => undefined,
    () => undefined,
  );
  await flush(2);
  // A slice ends on whichever comes first: the work settling, or one real
  // millisecond. A flush-only pump spins its whole budget in far less than a
  // millisecond, which on a loaded runner is how a step loop outruns the work
  // it is supposed to be waiting for.
  for (let step = 0; step < maxSteps && !settled; step += 1) {
    await clock.advance(stepMs);
    await Promise.race([finished, tick()]);
  }
  if (!settled) {
    throw new Error(
      `drive: the call had not settled after ${String(stepMs * maxSteps)} ms of ` +
        'virtual time — either it is waiting on something the mock clock does not own, ' +
        'or the fetch stub never answered',
    );
  }
  return tracked;
}

// ---------------------------------------------------------------------------
// fetch player
// ---------------------------------------------------------------------------

/**
 * One request the player observed. Deliberately close to the frozen harness's
 * `RecordedCall`, plus `duplex` — a streamed upload body must go out as
 * `duplex: "half"` and that is not observable any other way.
 */
interface Attempt {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly duplex: string | undefined;
  text(): string;
}

/**
 * What the next request gets: a canned `Response`, a rejection (a transport
 * failure), or `"hang"` — a request that never answers on its own and rejects
 * only when its `AbortSignal` fires, which is the only way to reach the timeout
 * and caller-abort paths.
 *
 * `scriptFetch` from the frozen harness plays `Response`s and is used wherever
 * that is enough; it cannot express the other two, so the transport tests use
 * this local player instead of widening a contract file.
 */
type Step = Response | Error | 'hang';

function lowerHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined || raw === null) return out;
  if (raw instanceof Headers) {
    for (const [name, value] of raw.entries()) out[name.toLowerCase()] = value;
    return out;
  }
  if (Array.isArray(raw)) {
    for (const pair of raw as string[][]) {
      const [name, value] = pair;
      if (name !== undefined && value !== undefined) out[name.toLowerCase()] = value;
    }
    return out;
  }
  for (const [name, value] of Object.entries(raw as Record<string, string>)) {
    out[name.toLowerCase()] = value;
  }
  return out;
}

function bodyText(body: unknown): string {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  throw new TypeError('Attempt.text(): this body kind is not decodable synchronously');
}

function playFetch(steps: readonly Step[]): { fetch: FetchStub; calls: Attempt[] } {
  const calls: Attempt[] = [];
  let next = 0;

  const stub: FetchStub = (input, init) => {
    const raw = init as { body?: unknown; duplex?: unknown } | undefined;
    const body = raw?.body;
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: lowerHeaders(init?.headers),
      body,
      duplex: typeof raw?.duplex === 'string' ? raw.duplex : undefined,
      text: () => bodyText(body),
    });

    const step = steps[next];
    next += 1;
    if (step === undefined) {
      throw new Error(
        `playFetch: unexpected request #${String(next)} — the script holds ` +
          `${String(steps.length)} step(s). An extra upstream call is a test failure.`,
      );
    }
    if (step instanceof Response) return Promise.resolve(step.clone());
    if (step instanceof Error) return Promise.reject(step);

    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        throw new Error('playFetch: a "hang" step needs the caller to pass a signal');
      }
      const fail = (): void => {
        const reason: unknown = signal.reason;
        // `fetch` rejects with the abort reason verbatim and so must the stub —
        // the production code branches on which reason arrived.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(reason);
      };
      if (signal.aborted) {
        fail();
        return;
      }
      signal.addEventListener('abort', fail, { once: true });
    });
  };

  return { fetch: stub, calls };
}

/** The `index`-th request, with a readable failure when it was never made. */
function attempt(calls: readonly Attempt[], index = 0): Attempt {
  const found = calls[index];
  assert.notEqual(
    found,
    undefined,
    `expected at least ${String(index + 1)} request(s), saw ${String(calls.length)}`,
  );
  return found as Attempt;
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A DNS seam that answers with fixed addresses, or fails. */
function fakeLookup(
  answer: readonly { address: string; family: number }[] | NodeJS.ErrnoException,
): { lookup: LookupFn; calls: string[] } {
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
    if (answer instanceof Error) {
      callback(answer, []);
      return;
    }
    callback(null, answer);
  };
  // `LookupFn` is `node:dns`'s heavily overloaded `lookup`; a stub can only
  // implement the one overload this module calls (`{ all: true }` + callback).
  return { lookup: impl as unknown as LookupFn, calls };
}

// ---------------------------------------------------------------------------
// egress allowlist (SECURITY.md § 2.5)
// ---------------------------------------------------------------------------

test('assertAllowedUrl accepts the api host and hands back the parsed URL', () => {
  const parsed = assertAllowedUrl(`${API_URL}?fields=open_id`, 'api');
  assert.equal(parsed.hostname, 'open.tiktokapis.com');
  assert.equal(parsed.pathname, '/v2/user/info/');
  assert.equal(parsed.searchParams.get('fields'), 'open_id');
});

test('assertAllowedUrl normalizes case and an explicit :443', () => {
  // The WHATWG parser lower-cases the host and drops the default port, so both
  // of these *are* the allowlisted host — rejecting them would be a bug.
  assert.equal(
    assertAllowedUrl('HTTPS://OPEN.TIKTOKAPIS.COM/v2/user/info/', 'api').hostname,
    'open.tiktokapis.com',
  );
  assert.equal(assertAllowedUrl('https://open.tiktokapis.com:443/v2/', 'api').port, '');
});

test('assertAllowedUrl accepts all three upload host shapes for upload calls', () => {
  for (const host of [
    'open.tiktokapis.com',
    'open-upload.tiktokapis.com',
    'upload.us.tiktokapis.com',
    'upload.eu-central-1.tiktokapis.com',
  ]) {
    assert.equal(
      assertAllowedUrl(`https://${host}/upload/`, 'upload').hostname,
      host,
      `${host} is a documented upload host (TIKTOK-API § 4.7 rule 2)`,
    );
  }
});

test('assertAllowedUrl refuses an upload host for an api call', () => {
  // The kinds are not interchangeable: an api call may only reach the api host.
  for (const host of ['open-upload.tiktokapis.com', 'upload.us.tiktokapis.com']) {
    assert.throws(
      () => assertAllowedUrl(`https://${host}/v2/x`, 'api'),
      (err: unknown) => ttError(err).code === 'egress_blocked',
    );
  }
});

test('assertAllowedUrl rejects a non-https scheme instead of upgrading it', () => {
  for (const url of [
    'http://open.tiktokapis.com/v2/x',
    'ftp://open.tiktokapis.com/v2/x',
    'data:text/plain,open.tiktokapis.com',
  ]) {
    const err = ttError(caught(() => assertAllowedUrl(url, 'api')));
    assert.equal(err.kind, 'validation');
    assert.equal(err.code, 'egress_blocked');
  }
});

test('assertAllowedUrl rejects userinfo credentials in the authority', () => {
  const err = ttError(
    caught(() => assertAllowedUrl('https://user:pw@open.tiktokapis.com/v2/x', 'api')),
  );
  assert.match(err.message, /userinfo credentials/);
  // The credential itself must not survive into the message.
  assert.equal(err.message.includes('pw@'), false);
});

test('assertAllowedUrl rejects any port other than 443', () => {
  const err = ttError(
    caught(() => assertAllowedUrl('https://open.tiktokapis.com:8443/v2/x', 'api')),
  );
  assert.match(err.message, /port 8443 is not 443/);
});

test('assertAllowedUrl rejects the endsWith and prefix traps', () => {
  for (const host of [
    'open.tiktokapis.com.attacker.tld', // suffix confusion
    'eviltiktokapis.com', // bare endsWith would accept this
    'notopen.tiktokapis.com',
    'open.tiktokapis.com.', // trailing dot is a different name
    'sub.open.tiktokapis.com', // subdomains are not the allowlisted host
  ]) {
    assert.throws(
      () => assertAllowedUrl(`https://${host}/v2/x`, 'upload'),
      (err: unknown) => ttError(err).code === 'egress_blocked',
      `${host} must be blocked`,
    );
  }
});

test('assertAllowedUrl anchors the regional upload pattern at both ends', () => {
  for (const host of [
    'upload.a.evil.tiktokapis.com', // the label may not contain a dot
    'upload.us.tiktokapis.com.evil.tld',
    'upload..tiktokapis.com', // empty label
    'upload.this-label-is-far-too-long.tiktokapis.com', // > 16 chars
    'upload.US.tiktokapis.com.x',
  ]) {
    assert.throws(
      () => assertAllowedUrl(`https://${host}/upload/`, 'upload'),
      (err: unknown) => ttError(err).code === 'egress_blocked',
      `${host} must not match the regional pattern`,
    );
  }
});

test('assertAllowedUrl rejects a homograph of the api host', () => {
  // A Cyrillic "о" IDNA-encodes to xn--… , which is simply a different name.
  const homograph = 'https://оpen.tiktokapis.com/v2/x';
  assert.notEqual(new URL(homograph).hostname, 'open.tiktokapis.com');
  assert.throws(
    () => assertAllowedUrl(homograph, 'api'),
    (err: unknown) => ttError(err).code === 'egress_blocked',
  );
});

test('assertAllowedUrl rejects anything the WHATWG parser will not take', () => {
  for (const url of ['', '/v2/user/info/', 'open.tiktokapis.com/v2', 'https://']) {
    const err = ttError(caught(() => assertAllowedUrl(url, 'api')));
    assert.match(err.message, /not a parsable absolute URL/);
    // Nothing of the raw input is echoed back.
    assert.match(err.message, /<unparsable url>/);
  }
});

test('assertAllowedUrl never quotes the query string of a blocked URL', () => {
  const err = ttError(
    caught(() =>
      assertAllowedUrl(
        'https://evil.example.com/upload/?upload_token=super-secret',
        'upload',
      ),
    ),
  );
  assert.equal(err.message.includes('super-secret'), false);
  assert.equal(err.message.includes('?'), false);
  assert.match(err.message, /https:\/\/evil\.example\.com\/upload\//);
});

test('assertAllowedUrl failures are non-retryable validation errors', () => {
  const err = ttError(caught(() => assertAllowedUrl('https://evil.tld/x', 'api')));
  assert.equal(err.kind, 'validation');
  assert.equal(err.code, 'egress_blocked');
  assert.equal(err.retryable, false);
  // The remediation says where the decision lives — the allowlist is a spec
  // edit, never a runtime relaxation.
  assert.match(err.remediation ?? '', /TIKTOK-API\.md § 4\.7/);
});

test('assertAllowedUrl property: an arbitrary domain is denied for api calls', () => {
  fc.assert(
    fc.property(fc.domain(), (host) => {
      fc.pre(host !== 'open.tiktokapis.com');
      assert.throws(() => assertAllowedUrl(`https://${host}/v2/x`, 'api'));
    }),
    { seed: 20260730, numRuns: 300 },
  );
});

test('assertAllowedUrl property: no prefix or suffix of an allowlisted host passes', () => {
  const label = fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/);
  fc.assert(
    fc.property(
      label,
      fc.constantFrom<'api' | 'upload'>('api', 'upload'),
      (part, kind) => {
        for (const host of [
          `open.tiktokapis.com.${part}.tld`,
          `${part}.open.tiktokapis.com`,
          `${part}tiktokapis.com`,
          `open-upload.tiktokapis.com.${part}.tld`,
          `upload.${part}.tiktokapis.com.${part}.tld`,
        ]) {
          assert.throws(
            () => assertAllowedUrl(`https://${host}/x`, kind),
            `${host} must be blocked for ${kind} calls`,
          );
        }
      },
    ),
    { seed: 20260730, numRuns: 200 },
  );
});

// ---------------------------------------------------------------------------
// ttRequest — request shape
// ---------------------------------------------------------------------------

test('ttRequest resolves the envelope data and sends accept + bearer', async () => {
  const stub = scriptFetch([ttEnvelope({ user: { open_id: 'open-id-1' } })]);
  const clock = mockClock();
  const value = await withFetch(stub, () =>
    ttRequest<{ user: { open_id: string } }>({
      method: 'GET',
      url: `${API_URL}?fields=open_id`,
      retryClass: 'read',
      bearer: 'fake-access-token-a1b2c3',
      clock,
    }),
  );

  assert.deepEqual(value, { user: { open_id: 'open-id-1' } });
  assert.equal(stub.calls.length, 1);
  const call = stub.calls[0];
  assert.equal(call?.url, `${API_URL}?fields=open_id`);
  assert.equal(call?.method, 'GET');
  assert.equal(call?.headers['accept'], 'application/json');
  assert.equal(call?.headers['authorization'], 'Bearer fake-access-token-a1b2c3');
  // A GET carries no body and therefore no content-type.
  assert.equal('content-type' in (call?.headers ?? {}), false);
  // The per-attempt timeout waiter must not outlive the call.
  assert.equal(clock.pending(), 0);
});

test('ttRequest sends a POST body as JSON with the documented content-type', async () => {
  const stub = scriptFetch([ttEnvelope({ ok: true })]);
  await withFetch(stub, () =>
    ttRequest({
      method: 'POST',
      url: API_URL,
      body: { post_info: { title: 'hello' } },
      retryClass: 'init',
      bearer: 'fake-access-token-d4e5f6',
      clock: mockClock(),
    }),
  );

  const call = stub.calls[0];
  assert.equal(call?.method, 'POST');
  assert.equal(call?.headers['content-type'], 'application/json; charset=UTF-8');
  assert.deepEqual(call?.json(), { post_info: { title: 'hello' } });
});

test('ttRequest rejects a GET with a body before any request is sent', async () => {
  const play = playFetch([]);
  const err = ttError(
    await withFetch(play.fetch, () =>
      rejection(
        ttRequest({
          method: 'GET',
          url: API_URL,
          body: { nope: true },
          retryClass: 'read',
          clock: mockClock(),
        }),
      ),
    ),
  );
  assert.equal(err.kind, 'validation');
  assert.equal(err.code, 'invalid_params');
  assert.match(err.message, /No request was sent to TikTok/);
  assert.equal(play.calls.length, 0);
});

test('ttRequest rejects an invalid timeoutMs or budgetMs before any request', async () => {
  const play = playFetch([]);
  await withFetch(play.fetch, async () => {
    for (const [option, opts] of [
      ['timeoutMs', { timeoutMs: 0 }],
      ['timeoutMs', { timeoutMs: Number.NaN }],
      ['budgetMs', { budgetMs: -1 }],
    ] as const) {
      const err = ttError(
        await rejection(
          ttRequest({
            method: 'GET',
            url: API_URL,
            retryClass: 'read',
            clock: mockClock(),
            ...opts,
          }),
        ),
      );
      assert.equal(err.code, 'invalid_params');
      assert.match(err.message, new RegExp(option));
    }
  });
  assert.equal(play.calls.length, 0);
});

test('ttRequest refuses a non-allowlisted URL and logs it without the query', async () => {
  const play = playFetch([]);
  const { logger, records } = recordingLogger();
  const err = ttError(
    await withFetch(play.fetch, () =>
      rejection(
        ttRequest({
          method: 'GET',
          url: 'https://evil.example.com/v2/user/info/?access_token=leaked-token',
          retryClass: 'read',
          clock: mockClock(),
          logger,
        }),
      ),
    ),
  );

  assert.equal(err.code, 'egress_blocked');
  assert.equal(play.calls.length, 0);
  const blocked = logsLike(records, 'egress blocked')[0];
  assert.equal(blocked?.level, 'warn');
  assert.equal(blocked?.fields?.['url'], 'https://evil.example.com/v2/user/info/');
  assert.equal(JSON.stringify(blocked).includes('leaked-token'), false);
});

test('ttRequest logs an unparsable URL as a placeholder, never as an echo', async () => {
  // The log line is written before the throw, so it cannot assume the input
  // parses — echoing a raw unparsable value back is how secrets leak sideways.
  const play = playFetch([]);
  const { logger, records } = recordingLogger();
  await withFetch(play.fetch, () =>
    rejection(
      ttRequest({
        method: 'GET',
        url: 'open.tiktokapis.com/v2/user/info/?access_token=leaked-token',
        retryClass: 'read',
        clock: mockClock(),
        logger,
      }),
    ),
  );

  const blocked = logsLike(records, 'egress blocked')[0];
  assert.equal(blocked?.fields?.['url'], '<unparsable url>');
  assert.equal(JSON.stringify(records).includes('leaked-token'), false);
  assert.equal(play.calls.length, 0);
});

// ---------------------------------------------------------------------------
// ttRequest — envelope decoding (CC-B1, CC-B2, CC-B9)
// ---------------------------------------------------------------------------

test('cc-b1 ttRequest treats HTTP 200 with error.code !== ok as a failure', async () => {
  const stub = scriptFetch([
    ttEnvelope(
      { partial: true },
      { code: 'spam_risk_too_many_posts', message: 'daily cap' },
    ),
  ]);
  const err = ttError(
    await withFetch(stub, () =>
      rejection(
        ttRequest({
          method: 'POST',
          url: API_URL,
          body: {},
          retryClass: 'init',
          clock: mockClock(),
        }),
      ),
    ),
  );

  assert.equal(err.kind, 'api');
  assert.equal(err.code, 'upstream_error');
  assert.equal(err.apiCode, 'spam_risk_too_many_posts');
  assert.match(err.message, /HTTP 200/);
  assert.match(err.message, /daily cap/);
  assert.equal(err.retryable, false);
});

test('cc-b1 ttRequest treats error.code "ok" with a non-2xx status as a failure', async () => {
  const stub = scriptFetch([
    new Response(JSON.stringify({ data: {}, error: { code: 'ok', message: '' } }), {
      status: 500,
    }),
  ]);
  const err = ttError(
    await withFetch(stub, () =>
      rejection(
        ttRequest({
          method: 'GET',
          url: API_URL,
          retryClass: 'init',
          clock: mockClock(),
        }),
      ),
    ),
  );
  assert.match(err.message, /HTTP 500/);
});

test('cc-b2 ttRequest reports a non-JSON body instead of crashing on it', async () => {
  const html = '<html>\n  <body>502 Bad Gateway</body>\n</html>';
  const stub = scriptFetch([new Response(html, { status: 502 })]);
  const err = ttError(
    await withFetch(stub, () =>
      rejection(
        ttRequest({
          method: 'GET',
          url: API_URL,
          retryClass: 'init',
          clock: mockClock(),
        }),
      ),
    ),
  );

  assert.equal(err.kind, 'api');
  assert.match(err.message, /not the documented JSON envelope/);
  // Whitespace-collapsed, so the message stays one line.
  assert.match(err.message, /<html> <body>502 Bad Gateway<\/body> <\/html>/);
  assert.match(err.remediation ?? '', /gateway or proxy/);
});

test('cc-b2 ttRequest reports an empty body as a body, not as success', async () => {
  // An empty 200 is the sharpest form: the status alone would read as success.
  const stub = scriptFetch([new Response(null, { status: 200 })]);
  const err = ttError(
    await withFetch(stub, () =>
      rejection(
        ttRequest({
          method: 'GET',
          url: API_URL,
          retryClass: 'init',
          clock: mockClock(),
        }),
      ),
    ),
  );
  assert.match(err.message, /<empty body>/);
});

test('cc-b2 ttRequest truncates a huge non-JSON body in the message', async () => {
  const stub = scriptFetch([new Response('x'.repeat(5_000), { status: 500 })]);
  const err = ttError(
    await withFetch(stub, () =>
      rejection(
        ttRequest({
          method: 'GET',
          url: API_URL,
          retryClass: 'init',
          clock: mockClock(),
        }),
      ),
    ),
  );
  assert.match(err.message, /…\[truncated\]$/);
  assert.equal(err.message.length < 600, true, 'the message must stay bounded');
});

test('ttRequest rejects a JSON value that is not an object', async () => {
  const stub = scriptFetch([new Response('[1,2,3]', { status: 200 })]);
  const err = ttError(
    await withFetch(stub, () =>
      rejection(
        ttRequest({
          method: 'GET',
          url: API_URL,
          retryClass: 'init',
          clock: mockClock(),
        }),
      ),
    ),
  );
  assert.match(err.message, /JSON value that is not an object/);
  assert.equal(err.retryable, false);
});

test('cc-b9 ttRequest formats a missing log_id as "absent"', async () => {
  const stub = scriptFetch([
    jsonResponse({ error: { code: 'invalid_params', message: 'bad field' } }, 400),
  ]);
  const err = ttError(
    await withFetch(stub, () =>
      rejection(
        ttRequest({
          method: 'GET',
          url: API_URL,
          retryClass: 'init',
          clock: mockClock(),
        }),
      ),
    ),
  );
  assert.match(err.message, /log_id absent/);
  assert.equal(err.logId, undefined);
});

test('cc-b9 ttRequest reads log_id from the envelope root when error has none', async () => {
  const stub = scriptFetch([
    jsonResponse(
      { log_id: 'root-log-id-1', error: { code: 'internal_error', message: '' } },
      500,
    ),
  ]);
  const err = ttError(
    await withFetch(stub, () =>
      rejection(
        ttRequest({
          method: 'GET',
          url: API_URL,
          retryClass: 'init',
          clock: mockClock(),
        }),
      ),
    ),
  );
  assert.equal(err.logId, 'root-log-id-1');
});

test('ttRequest resolves the whole object when the endpoint sends no data member', async () => {
  const stub = scriptFetch([
    jsonResponse({ creator_nickname: 'me', error: { code: 'ok', message: '' } }),
  ]);
  const value = await withFetch(stub, () =>
    ttRequest<Record<string, unknown>>({
      method: 'GET',
      url: API_URL,
      retryClass: 'read',
      clock: mockClock(),
    }),
  );
  assert.equal(value['creator_nickname'], 'me');
});

test('ttRequest never lets a registered bearer reach the error text', async () => {
  const bearer = 'fake-access-token-leak-probe-9f8e7d';
  const stub = scriptFetch([new Response(`gateway said: ${bearer}`, { status: 500 })]);
  const err = ttError(
    await withFetch(stub, () =>
      rejection(
        ttRequest({
          method: 'GET',
          url: API_URL,
          retryClass: 'init',
          bearer,
          clock: mockClock(),
        }),
      ),
    ),
  );
  assert.equal(err.message.includes(bearer), false);
  assert.match(err.message, /\[REDACTED\]/);
});

// ---------------------------------------------------------------------------
// retry matrix (ARCHITECTURE § 6, CC-B3, CC-B4, CC-B5, CC-B7, CC-B8)
// ---------------------------------------------------------------------------

test('cc-b7 ttRequest retries a read through 5xx and network failures', async () => {
  const clock = mockClock();
  const play = playFetch([
    new Response('gateway', { status: 503 }),
    new TypeError('fetch failed'),
    ttEnvelope({ ok: true }),
  ]);
  const value = await withFetch(play.fetch, () =>
    drive(
      clock,
      ttRequest<{ ok: boolean }>({
        method: 'GET',
        url: API_URL,
        retryClass: 'read',
        clock,
        random: () => 0,
      }),
    ),
  );
  assert.deepEqual(value, { ok: true });
  assert.equal(play.calls.length, 3);
});

test('cc-b7 ttRequest stops a read at maxAttempts and reports the last error', async () => {
  const clock = mockClock();
  const { logger, records } = recordingLogger();
  const play = playFetch([
    new Response('a', { status: 503 }),
    new Response('b', { status: 503 }),
  ]);
  const err = ttError(
    await withFetch(play.fetch, () =>
      rejection(
        drive(
          clock,
          ttRequest({
            method: 'GET',
            url: API_URL,
            retryClass: 'read',
            maxAttempts: 2,
            clock,
            logger,
            random: () => 0,
          }),
        ),
      ),
    ),
  );

  assert.equal(play.calls.length, 2);
  assert.equal(err.retryable, true, 'the caller may still try again later');
  const failed = logsLike(records, 'tiktok request failed')[0];
  assert.equal(failed?.fields?.['attempt'], 2);
  assert.equal(failed?.fields?.['attempts'], 2);
  assert.equal(failed?.fields?.['status'], 503);
  assert.equal(failed?.fields?.['retry_class'], 'read');
});

test('ttRequest clamps maxAttempts below 1 to a single attempt', async () => {
  const clock = mockClock();
  const play = playFetch([new Response('boom', { status: 500 })]);
  await withFetch(play.fetch, () =>
    rejection(
      drive(
        clock,
        ttRequest({
          method: 'GET',
          url: API_URL,
          retryClass: 'read',
          maxAttempts: 0,
          clock,
        }),
      ),
    ),
  );
  assert.equal(play.calls.length, 1);
});

test('ttRequest does not retry a read on a non-retryable status', async () => {
  const clock = mockClock();
  const play = playFetch([jsonResponse({ error: { code: 'invalid_params' } }, 400)]);
  await withFetch(play.fetch, () =>
    rejection(
      drive(clock, ttRequest({ method: 'GET', url: API_URL, retryClass: 'read', clock })),
    ),
  );
  assert.equal(play.calls.length, 1, '4xx is terminal even for the read class');
});

test('cc-b4 ttRequest never retries an init, not even on 5xx', async () => {
  const clock = mockClock();
  const play = playFetch([
    new Response('gateway', { status: 503 }),
    ttEnvelope({ never: 'reached' }),
  ]);
  const err = ttError(
    await withFetch(play.fetch, () =>
      rejection(
        drive(
          clock,
          ttRequest({
            method: 'POST',
            url: API_URL,
            body: {},
            retryClass: 'init',
            maxAttempts: 5, // ignored: only the read class honours it
            clock,
          }),
        ),
      ),
    ),
  );
  assert.equal(play.calls.length, 1);
  assert.equal(err.retryable, false);
});

test('cc-b8 ttRequest makes an init 429 terminal with a wait hint', async () => {
  const clock = mockClock();
  const play = playFetch([
    new Response(
      JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } }),
      {
        status: 429,
        headers: { 'retry-after': '60' },
      },
    ),
  ]);
  const err = ttError(
    await withFetch(play.fetch, () =>
      rejection(
        drive(
          clock,
          ttRequest({
            method: 'POST',
            url: API_URL,
            body: {},
            retryClass: 'init',
            clock,
          }),
        ),
      ),
    ),
  );

  assert.equal(play.calls.length, 1);
  assert.equal(err.kind, 'api');
  assert.equal(err.code, 'rate_limited');
  assert.equal(err.retryable, false);
  assert.match(err.message, /never retried automatically/);
  // CC-H2: the hint is an absolute ISO-8601 UTC instant off the injected clock.
  assert.equal(
    err.remediation,
    `Wait until ${new Date(BASELINE_NOW_MS + 60_000).toISOString()} (60 s) and call again. Do not retry earlier.`,
  );
});

test('cc-b8 ttRequest keeps a read 429 retryable', async () => {
  const clock = mockClock();
  const play = playFetch([
    new Response(
      JSON.stringify({ error: { code: 'rate_limit_exceeded', message: '' } }),
      {
        status: 429,
      },
    ),
  ]);
  const err = ttError(
    await withFetch(play.fetch, () =>
      rejection(
        drive(
          clock,
          ttRequest({
            method: 'GET',
            url: API_URL,
            retryClass: 'read',
            maxAttempts: 1,
            clock,
          }),
        ),
      ),
    ),
  );
  assert.equal(err.code, 'rate_limited');
  assert.equal(err.retryable, true);
  assert.equal(err.apiCode, 'rate_limit_exceeded');
  // With no Retry-After the hint falls back to one backoff step.
  assert.match(err.remediation ?? '', /^Wait until 2026-01-01T00:00:00\.500Z \(1 s\)/);
});

test('cc-b3 ttRequest honours Retry-After in delay-seconds form', async () => {
  const clock = mockClock();
  const { logger, records } = recordingLogger();
  const play = playFetch([
    new Response('busy', { status: 503, headers: { 'retry-after': '7' } }),
    ttEnvelope({ ok: true }),
  ]);
  await withFetch(play.fetch, () =>
    drive(
      clock,
      ttRequest({ method: 'GET', url: API_URL, retryClass: 'read', clock, logger }),
    ),
  );

  const retry = logsLike(records, 'tiktok request retry')[0];
  assert.equal(retry?.fields?.['retry_after_s'], 7);
  assert.equal(
    retry?.fields?.['retry_at'],
    new Date(BASELINE_NOW_MS + 7_000).toISOString(),
  );
});

test('cc-b3 ttRequest honours Retry-After in HTTP-date form', async () => {
  const clock = mockClock();
  const { logger, records } = recordingLogger();
  const play = playFetch([
    // BASELINE_NOW_MS is 2026-01-01T00:00:00Z, a Thursday.
    new Response('busy', {
      status: 503,
      headers: { 'retry-after': 'Thu, 01 Jan 2026 00:00:02 GMT' },
    }),
    ttEnvelope({ ok: true }),
  ]);
  await withFetch(play.fetch, () =>
    drive(
      clock,
      ttRequest({ method: 'GET', url: API_URL, retryClass: 'read', clock, logger }),
    ),
  );
  assert.equal(
    logsLike(records, 'tiktok request retry')[0]?.fields?.['retry_after_s'],
    2,
  );
});

test('cc-b3 ttRequest falls back to backoff for a malformed Retry-After', async () => {
  for (const header of ['-5', '1.5', 'soon', '   ', 'Thu, 99 Xxx 2026 00:00:00 GMT']) {
    const clock = mockClock();
    const { logger, records } = recordingLogger();
    const play = playFetch([
      new Response('busy', { status: 503, headers: { 'retry-after': header } }),
      ttEnvelope({ ok: true }),
    ]);
    await withFetch(play.fetch, () =>
      drive(
        clock,
        ttRequest({
          method: 'GET',
          url: API_URL,
          retryClass: 'read',
          clock,
          logger,
          random: () => 0,
        }),
      ),
    );
    const retry = logsLike(records, 'tiktok request retry')[0];
    assert.equal(
      retry?.fields?.['retry_at'],
      new Date(BASELINE_NOW_MS + 500).toISOString(),
      `"${header}" is not a usable Retry-After and must fall back to backoff`,
    );
  }
});

test('cc-b3 ttRequest backoff is min(500·2^n, 8000) plus bounded jitter', async () => {
  // The jitter seam is driven at both ends of its range, so the window is
  // pinned rather than sampled: 500/1000 with no jitter, 625/1250 with all of it.
  for (const [random, expected] of [
    [() => 0, [1, 1]],
    [() => 1, [1, 2]],
  ] as const) {
    const clock = mockClock();
    const { logger, records } = recordingLogger();
    const play = playFetch([
      new Response('a', { status: 503 }),
      new Response('b', { status: 503 }),
      ttEnvelope({ ok: true }),
    ]);
    await withFetch(play.fetch, () =>
      drive(
        clock,
        ttRequest({
          method: 'GET',
          url: API_URL,
          retryClass: 'read',
          clock,
          logger,
          random,
        }),
      ),
    );
    const retries = logsLike(records, 'tiktok request retry');
    assert.deepEqual(
      retries.map((r) => r.fields?.['retry_after_s']),
      expected,
    );
  }

  // The first wait is exactly the base plus max jitter: 500 + floor(500·0.25).
  const clock = mockClock();
  const { logger, records } = recordingLogger();
  const play = playFetch([new Response('a', { status: 503 }), ttEnvelope({ ok: true })]);
  await withFetch(play.fetch, () =>
    drive(
      clock,
      ttRequest({
        method: 'GET',
        url: API_URL,
        retryClass: 'read',
        clock,
        logger,
        random: () => 1,
      }),
    ),
  );
  assert.equal(
    logsLike(records, 'tiktok request retry')[0]?.fields?.['retry_at'],
    new Date(BASELINE_NOW_MS + 625).toISOString(),
  );
});

test('cc-b3 ttRequest caps Retry-After at 30 s and at the remaining budget', async () => {
  // A ten-minute Retry-After is capped to the 30 s ceiling…
  const wide = mockClock();
  const wideLog = recordingLogger();
  const widePlay = playFetch([
    new Response('busy', { status: 503, headers: { 'retry-after': '600' } }),
    ttEnvelope({ ok: true }),
  ]);
  await withFetch(widePlay.fetch, () =>
    drive(
      wide,
      ttRequest({
        method: 'GET',
        url: API_URL,
        retryClass: 'read',
        clock: wide,
        logger: wideLog.logger,
      }),
      1_000,
      400,
    ),
  );
  assert.equal(
    logsLike(wideLog.records, 'tiktok request retry')[0]?.fields?.['retry_after_s'],
    30,
  );

  // …and further, to whatever is left of the call's own budget.
  const tight = mockClock();
  const tightLog = recordingLogger();
  const tightPlay = playFetch([
    new Response('busy', { status: 503, headers: { 'retry-after': '600' } }),
    ttEnvelope({ ok: true }),
  ]);
  await withFetch(tightPlay.fetch, () =>
    drive(
      tight,
      ttRequest({
        method: 'GET',
        url: API_URL,
        retryClass: 'read',
        budgetMs: 2_000,
        clock: tight,
        logger: tightLog.logger,
      }),
    ),
  );
  assert.equal(
    logsLike(tightLog.records, 'tiktok request retry')[0]?.fields?.['retry_after_s'],
    2,
  );
});

test('ttRequest ends the ladder when the wall-clock budget is spent', async () => {
  const clock = mockClock();
  const play = playFetch([
    new Response('a', { status: 503 }),
    new Response('b', { status: 503 }),
    new Response('c', { status: 503 }),
  ]);
  await withFetch(play.fetch, () =>
    rejection(
      drive(
        clock,
        ttRequest({
          method: 'GET',
          url: API_URL,
          retryClass: 'read',
          maxAttempts: 5,
          budgetMs: 100,
          clock,
          random: () => 0,
        }),
      ),
    ),
  );
  // Attempt 1 fails with 100 ms of budget left, waits it out, and attempt 2
  // finds nothing left — the remaining three attempts are never made.
  assert.equal(play.calls.length, 2);
});

// ---------------------------------------------------------------------------
// transport: redirects, timeouts, aborts (CC-B4, CC-B5, CC-B6, CC-H1)
// ---------------------------------------------------------------------------

test('cc-b6 ttRequest treats a refused redirect as an egress violation', async () => {
  const clock = mockClock();
  const play = playFetch([
    new TypeError('fetch failed', { cause: new Error('unexpected redirect') }),
  ]);
  const err = ttError(
    await withFetch(play.fetch, () =>
      rejection(
        drive(
          clock,
          ttRequest({ method: 'GET', url: API_URL, retryClass: 'read', clock }),
        ),
      ),
    ),
  );

  assert.equal(err.kind, 'validation');
  assert.equal(err.code, 'egress_blocked');
  assert.match(err.message, /redirect: "error"/);
  assert.equal(play.calls.length, 1, 'a redirect is never retried');
});

test('cc-b4 ttRequest reports a network failure on an init as ambiguous', async () => {
  const clock = mockClock();
  const play = playFetch([new TypeError('fetch failed')]);
  const err = ttError(
    await withFetch(play.fetch, () =>
      rejection(
        drive(
          clock,
          ttRequest({
            method: 'POST',
            url: API_URL,
            body: {},
            retryClass: 'init',
            clock,
          }),
        ),
      ),
    ),
  );

  assert.equal(err.kind, 'network');
  assert.equal(err.code, 'network_ambiguous');
  assert.equal(err.retryable, false);
  assert.match(err.remediation ?? '', /publish journal/);
});

test('ttRequest reports a network failure on a read as retryable', async () => {
  const clock = mockClock();
  const play = playFetch([new TypeError('fetch failed')]);
  const err = ttError(
    await withFetch(play.fetch, () =>
      rejection(
        drive(
          clock,
          ttRequest({
            method: 'GET',
            url: API_URL,
            retryClass: 'read',
            maxAttempts: 1,
            clock,
          }),
        ),
      ),
    ),
  );
  assert.equal(err.code, 'network_error');
  assert.equal(err.retryable, true);
});

test('cc-h1 ttRequest times out a read on the injected clock', async () => {
  const clock = mockClock();
  const play = playFetch(['hang']);
  const err = ttError(
    await withFetch(play.fetch, () =>
      rejection(
        drive(
          clock,
          ttRequest({
            method: 'GET',
            url: API_URL,
            retryClass: 'read',
            maxAttempts: 1,
            timeoutMs: 5_000,
            clock,
          }),
        ),
      ),
    ),
  );

  assert.equal(err.kind, 'network');
  assert.equal(err.code, 'timeout');
  assert.equal(err.retryable, true);
  assert.match(err.message, /timed out after 5000 ms/);
  assert.match(err.remediation ?? '', /TT_TIMEOUT_MS/);
  // No timer survives the call.
  assert.equal(clock.pending(), 0);
});

test('cc-b5 ttRequest reports an init timeout as ambiguous', async () => {
  const clock = mockClock();
  const play = playFetch(['hang']);
  const err = ttError(
    await withFetch(play.fetch, () =>
      rejection(
        drive(
          clock,
          ttRequest({
            method: 'POST',
            url: API_URL,
            body: {},
            retryClass: 'init',
            timeoutMs: 3_000,
            clock,
          }),
        ),
      ),
    ),
  );
  assert.equal(err.code, 'network_ambiguous');
  assert.match(err.message, /may still have been processed/);
  assert.equal(clock.pending(), 0);
});

test('ttRequest propagates a caller abort verbatim', async () => {
  const clock = mockClock();
  const play = playFetch(['hang']);
  const controller = new AbortController();
  const reason = new Error('caller went away');

  const err = await withFetch(play.fetch, async () => {
    const call = ttRequest({
      method: 'GET',
      url: API_URL,
      retryClass: 'read',
      timeoutMs: 60_000,
      signal: controller.signal,
      clock,
    });
    const outcome = rejection(call);
    await flush(2);
    controller.abort(reason);
    return outcome;
  });

  assert.equal(err, reason, 'an abort is the caller’s own reason, not a TikTokError');
  assert.equal(isTikTokError(err), false);
  assert.equal(clock.pending(), 0);
});

test('ttRequest refuses an already-aborted signal without touching the network', async () => {
  const play = playFetch([]);
  const reason = new Error('aborted before the call');
  const err = await withFetch(play.fetch, () =>
    rejection(
      ttRequest({
        method: 'GET',
        url: API_URL,
        retryClass: 'read',
        signal: AbortSignal.abort(reason),
        clock: mockClock(),
      }),
    ),
  );
  assert.equal(err, reason);
  assert.equal(play.calls.length, 0);
});

// ---------------------------------------------------------------------------
// DNS pre-flight seam (SECURITY.md § 2.6)
// ---------------------------------------------------------------------------

test('ttRequest resolves nothing extra when no lookup seam is injected', async () => {
  const stub = scriptFetch([ttEnvelope({ ok: true })]);
  await withFetch(stub, () =>
    ttRequest({ method: 'GET', url: API_URL, retryClass: 'read', clock: mockClock() }),
  );
  assert.equal(stub.calls.length, 1);
});

test('ttRequest blocks a DNS answer that points at a non-routable address', async () => {
  const nonRoutable = [
    '127.0.0.1',
    '10.0.0.7',
    '172.16.4.1',
    '192.168.1.10',
    '169.254.169.254', // the cloud metadata service
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ];

  for (const address of nonRoutable) {
    const play = playFetch([]);
    const { logger, records } = recordingLogger();
    const dns = fakeLookup([{ address, family: address.includes(':') ? 6 : 4 }]);
    const err = ttError(
      await withFetch(play.fetch, () =>
        rejection(
          ttRequest({
            method: 'GET',
            url: API_URL,
            retryClass: 'read',
            lookup: dns.lookup,
            logger,
            clock: mockClock(),
          }),
        ),
      ),
    );

    assert.equal(err.code, 'egress_blocked', `${address} must be refused`);
    assert.match(err.message, /non-routable address/);
    assert.equal(play.calls.length, 0, `${address}: no socket may be opened`);
    assert.equal(dns.calls[0], 'open.tiktokapis.com');
    assert.equal(
      logsLike(records, 'egress blocked')[0]?.fields?.['reason'],
      'private_address',
    );
  }
});

test('ttRequest proceeds when every DNS answer is routable', async () => {
  const stub = scriptFetch([ttEnvelope({ ok: true })]);
  const dns = fakeLookup([
    { address: '23.55.60.1', family: 4 },
    { address: '2606:4700::1111', family: 6 },
  ]);
  await withFetch(stub, () =>
    ttRequest({
      method: 'GET',
      url: API_URL,
      retryClass: 'read',
      lookup: dns.lookup,
      clock: mockClock(),
    }),
  );
  assert.equal(stub.calls.length, 1);
  assert.equal(dns.calls.length, 1);
});

test('ttRequest turns a DNS failure into a retryable network error', async () => {
  const clock = mockClock();
  const play = playFetch([]);
  const failure: NodeJS.ErrnoException = Object.assign(
    new Error('getaddrinfo ENOTFOUND'),
    {
      code: 'ENOTFOUND',
    },
  );
  const dns = fakeLookup(failure);
  const err = ttError(
    await withFetch(play.fetch, () =>
      rejection(
        drive(
          clock,
          ttRequest({
            method: 'GET',
            url: API_URL,
            retryClass: 'read',
            maxAttempts: 2,
            lookup: dns.lookup,
            clock,
            random: () => 0,
          }),
        ),
      ),
    ),
  );

  assert.equal(err.kind, 'network');
  assert.equal(err.code, 'network_error');
  assert.equal(err.retryable, true);
  assert.match(err.message, /Could not resolve open\.tiktokapis\.com/);
  // The read class retries a resolution failure, and no socket is ever opened.
  assert.equal(dns.calls.length, 2);
  assert.equal(play.calls.length, 0);
});

// ---------------------------------------------------------------------------
// oauthRequest — the flat decoder (CC-A12)
// ---------------------------------------------------------------------------

test('cc-a12 oauthRequest returns the flat object verbatim, data member and all', async () => {
  // A token response is flat: no `{data,error}` envelope. A `data` key in it is
  // just another field and must NOT be unwrapped.
  const stub = scriptFetch([
    jsonResponse({
      access_token: 'fake-oauth-access-1',
      expires_in: 86_400,
      refresh_token: 'fake-oauth-refresh-1',
      open_id: 'open-id-9',
      scope: 'video.publish',
      data: { not: 'an envelope' },
    }),
  ]);
  const value = await withFetch(stub, () =>
    oauthRequest<Record<string, unknown>>({
      method: 'POST',
      url: OAUTH_URL,
      body: { grant_type: 'authorization_code' },
      clock: mockClock(),
    }),
  );

  assert.equal(value['access_token'], 'fake-oauth-access-1');
  assert.deepEqual(value['data'], { not: 'an envelope' });
});

test('oauthRequest form-encodes the body and sets the form content-type', async () => {
  const stub = scriptFetch([jsonResponse({ access_token: 'fake-oauth-access-2' })]);
  await withFetch(stub, () =>
    oauthRequest({
      method: 'POST',
      url: OAUTH_URL,
      body: {
        client_key: 'fake-client-key',
        grant_type: 'refresh_token',
        expires_in: 900,
        absent: undefined,
      },
      clock: mockClock(),
    }),
  );

  const call = stub.calls[0];
  assert.equal(call?.headers['content-type'], 'application/x-www-form-urlencoded');
  const sent = new URLSearchParams(call?.text() ?? '');
  assert.equal(sent.get('client_key'), 'fake-client-key');
  assert.equal(sent.get('grant_type'), 'refresh_token');
  assert.equal(sent.get('expires_in'), '900', 'a non-string value is stringified');
  assert.equal(sent.has('absent'), false, 'undefined members are dropped');
});

test('oauthRequest accepts a URLSearchParams or a pre-encoded string body', async () => {
  const stub = scriptFetch([
    jsonResponse({ access_token: 'a' }),
    jsonResponse({ access_token: 'b' }),
  ]);
  await withFetch(stub, async () => {
    await oauthRequest({
      method: 'POST',
      url: OAUTH_URL,
      body: new URLSearchParams({ code: 'fake-auth-code-1' }),
      clock: mockClock(),
    });
    await oauthRequest({
      method: 'POST',
      url: OAUTH_URL,
      body: 'grant_type=refresh_token&refresh_token=fake-oauth-refresh-2',
      clock: mockClock(),
    });
  });

  assert.equal(stub.calls[0]?.text(), 'code=fake-auth-code-1');
  assert.equal(
    stub.calls[1]?.text(),
    'grant_type=refresh_token&refresh_token=fake-oauth-refresh-2',
  );
});

test('oauthRequest rejects a body it cannot form-encode', async () => {
  const play = playFetch([]);
  const err = ttError(
    await withFetch(play.fetch, () =>
      rejection(
        oauthRequest({
          method: 'POST',
          url: OAUTH_URL,
          body: ['not', 'a', 'record'],
          clock: mockClock(),
        }),
      ),
    ),
  );
  assert.equal(err.code, 'invalid_params');
  assert.equal(play.calls.length, 0);
});

test('oauthRequest never sends an Authorization header, even when given a bearer', async () => {
  // The client credentials live in the form body; a bearer here is a caller
  // mistake and must not be put on the wire.
  const stub = scriptFetch([jsonResponse({ access_token: 'fake-oauth-access-3' })]);
  await withFetch(stub, () =>
    oauthRequest({
      method: 'POST',
      url: OAUTH_URL,
      body: { grant_type: 'refresh_token' },
      bearer: 'fake-access-token-should-not-be-sent',
      clock: mockClock(),
    }),
  );
  assert.equal('authorization' in (stub.calls[0]?.headers ?? {}), false);
});

test('cc-a12 oauthRequest maps a flat error to an auth failure', async () => {
  const stub = scriptFetch([
    jsonResponse(
      {
        error: 'invalid_grant',
        error_description: 'Refresh token is invalid or expired',
        log_id: 'oauth-log-id-1',
      },
      400,
    ),
  ]);
  const err = ttError(
    await withFetch(stub, () =>
      rejection(
        oauthRequest({
          method: 'POST',
          url: OAUTH_URL,
          body: { grant_type: 'refresh_token' },
          clock: mockClock(),
        }),
      ),
    ),
  );

  assert.equal(err.kind, 'auth');
  assert.equal(err.code, 'oauth_error');
  assert.equal(err.apiCode, 'invalid_grant');
  assert.equal(err.logId, 'oauth-log-id-1');
  assert.equal(err.retryable, false);
  assert.match(err.message, /Refresh token is invalid or expired/);
});

test('cc-a12 oauthRequest treats a flat error on HTTP 200 as a failure', async () => {
  // The token endpoint has been observed answering 200 with an `error` field;
  // the status is not the signal.
  const stub = scriptFetch([jsonResponse({ error: 'invalid_request' }, 200)]);
  const err = ttError(
    await withFetch(stub, () =>
      rejection(
        oauthRequest({ method: 'POST', url: OAUTH_URL, body: {}, clock: mockClock() }),
      ),
    ),
  );
  assert.equal(err.kind, 'auth');
  assert.equal(err.apiCode, 'invalid_request');
  assert.match(err.message, /log_id absent/);
});

test('oauthRequest reports a non-2xx without an OAuth error field', async () => {
  const stub = scriptFetch([jsonResponse({ log_id: 'oauth-log-id-2' }, 500)]);
  const err = ttError(
    await withFetch(stub, () =>
      rejection(
        oauthRequest({ method: 'POST', url: OAUTH_URL, body: {}, clock: mockClock() }),
      ),
    ),
  );
  assert.equal(err.kind, 'api');
  assert.equal(err.code, 'upstream_error');
  assert.equal(err.logId, 'oauth-log-id-2');
  assert.match(err.message, /without an OAuth error field/);
});

test('oauthRequest reports a non-JSON token response without crashing', async () => {
  const stub = scriptFetch([new Response('<html>503</html>', { status: 503 })]);
  const err = ttError(
    await withFetch(stub, () =>
      rejection(
        oauthRequest({ method: 'POST', url: OAUTH_URL, body: {}, clock: mockClock() }),
      ),
    ),
  );
  assert.match(err.message, /not a JSON object/);
  assert.equal(err.retryable, false);
});

test('oauthRequest is never retried', async () => {
  const clock = mockClock();
  const play = playFetch([
    new Response('gateway', { status: 503 }),
    jsonResponse({ access_token: 'never-reached' }),
  ]);
  await withFetch(play.fetch, () =>
    rejection(
      drive(clock, oauthRequest({ method: 'POST', url: OAUTH_URL, body: {}, clock })),
    ),
  );
  assert.equal(play.calls.length, 1);
});

test('oauthRequest is egress-guarded like every other call', async () => {
  const play = playFetch([]);
  const err = ttError(
    await withFetch(play.fetch, () =>
      rejection(
        oauthRequest({
          method: 'POST',
          url: 'https://open-upload.tiktokapis.com/v2/oauth/token/',
          body: {},
          clock: mockClock(),
        }),
      ),
    ),
  );
  assert.equal(err.code, 'egress_blocked');
  assert.equal(play.calls.length, 0);
});

// ---------------------------------------------------------------------------
// putChunk — raw upload PUT (TIKTOK-API § 4.6–4.8, CC-D6)
// ---------------------------------------------------------------------------

const CHUNK = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const CHUNK_RANGE = 'bytes 0-7/8';

function chunkOptions(overrides: Partial<PutChunkOptions> = {}): PutChunkOptions {
  return {
    uploadUrl: UPLOAD_URL,
    contentRange: CHUNK_RANGE,
    contentType: 'video/mp4',
    body: CHUNK,
    timeoutMs: 120_000,
    ...overrides,
  };
}

test('putChunk sends the range headers and never an Authorization header', async () => {
  const clock = mockClock();
  const play = playFetch([new Response('', { status: 201 })]);
  const result = await withFetch(play.fetch, () =>
    drive(clock, putChunk(chunkOptions({ clock }))),
  );

  assert.deepEqual(result, { status: 201 });
  const call = attempt(play.calls);
  assert.equal(call.method, 'PUT');
  assert.equal(call.headers['content-range'], CHUNK_RANGE);
  assert.equal(call.headers['content-type'], 'video/mp4');
  assert.equal(call.headers['content-length'], '8', 'derived from the byte length');
  assert.equal(
    'authorization' in call.headers,
    false,
    'the upload_token in the URL is the credential (§ 4.7 rule 4)',
  );
  assert.equal(call.text(), '\b');
  assert.equal(clock.pending(), 0);
});

test('putChunk registers the upload_token and never quotes the query string', async () => {
  const clock = mockClock();
  const play = playFetch([
    new Response(`gateway trace: ${UPLOAD_TOKEN}`, { status: 500 }),
  ]);
  const err = ttError(
    await withFetch(play.fetch, () =>
      rejection(
        drive(clock, putChunk(chunkOptions({ clock, chunkRetries: 0, random: () => 0 }))),
      ),
    ),
  );

  // The URL still went out intact…
  assert.equal(attempt(play.calls).url, UPLOAD_URL);
  // …but nothing that quotes it may carry the token or the query.
  assert.equal(err.message.includes(UPLOAD_TOKEN), false);
  assert.equal(err.message.includes('upload_token'), false);
  assert.equal(err.message.includes(UPLOAD_URL_SHOWN), true);
});

test('putChunk exposes uploaded_bytes from the response Content-Range', async () => {
  const clock = mockClock();
  const play = playFetch([
    new Response('', {
      status: 416,
      headers: { 'content-range': 'bytes 0-4194303/8388608' },
    }),
  ]);
  const result = await withFetch(play.fetch, () =>
    drive(clock, putChunk(chunkOptions({ clock }))),
  );
  // 416 resolves — it is the resync source, not a failure (CC-D6).
  assert.deepEqual(result, { status: 416, uploadedBytes: 4_194_303 });
});

test('putChunk omits uploadedBytes when Content-Range is absent or malformed', async () => {
  for (const headers of [
    undefined,
    { 'content-range': 'bytes */8388608' },
    { 'content-range': 'items 0-3/8' },
    { 'content-range': 'bytes 0-abc/8' },
  ]) {
    const clock = mockClock();
    const play = playFetch([
      new Response(
        '',
        headers === undefined ? { status: 201 } : { status: 201, headers },
      ),
    ]);
    const result = await withFetch(play.fetch, () =>
      drive(clock, putChunk(chunkOptions({ clock }))),
    );
    assert.deepEqual(result, { status: 201 }, JSON.stringify(headers));
  }
});

test('putChunk resolves every terminal 4xx instead of retrying it', async () => {
  for (const status of [400, 403, 404, 416]) {
    const clock = mockClock();
    const play = playFetch([new Response('', { status })]);
    const result = await withFetch(play.fetch, () =>
      drive(clock, putChunk(chunkOptions({ clock }))),
    );
    assert.equal(result.status, status);
    assert.equal(play.calls.length, 1, `HTTP ${String(status)} is terminal`);
  }
});

test('cc-b7 putChunk retries a 5xx with a byte-identical Content-Range', async () => {
  const clock = mockClock();
  const play = playFetch([
    new Response('a', { status: 500 }),
    new Response('b', { status: 502 }),
    new Response('', { status: 201 }),
  ]);
  const result = await withFetch(play.fetch, () =>
    drive(clock, putChunk(chunkOptions({ clock, random: () => 0 }))),
  );

  assert.equal(result.status, 201);
  assert.equal(play.calls.length, 3);
  for (const call of play.calls) {
    assert.equal(call.headers['content-range'], CHUNK_RANGE);
    assert.equal(call.headers['content-length'], '8');
  }
});

test('putChunk rejects once the chunk retries are exhausted', async () => {
  const clock = mockClock();
  const { logger, records } = recordingLogger();
  const play = playFetch([
    new Response('a', { status: 500 }),
    new Response('b', { status: 500 }),
  ]);
  const err = ttError(
    await withFetch(play.fetch, () =>
      rejection(
        drive(
          clock,
          putChunk(chunkOptions({ clock, chunkRetries: 1, logger, random: () => 0 })),
        ),
      ),
    ),
  );

  assert.equal(play.calls.length, 2);
  assert.equal(err.kind, 'network');
  assert.equal(err.code, 'upstream_error');
  assert.equal(err.retryable, true);
  assert.match(err.remediation ?? '', /identical byte range/);
  assert.equal(
    logsLike(records, 'tiktok request failed')[0]?.fields?.['retry_class'],
    'chunk',
  );
});

test('putChunk with chunkRetries 0 makes exactly one attempt', async () => {
  const clock = mockClock();
  const play = playFetch([new Response('a', { status: 503 })]);
  await withFetch(play.fetch, () =>
    rejection(drive(clock, putChunk(chunkOptions({ clock, chunkRetries: 0 })))),
  );
  assert.equal(play.calls.length, 1);
});

test('putChunk falls back to the default retry count for a nonsense chunkRetries', async () => {
  const clock = mockClock();
  const play = playFetch([
    new Response('a', { status: 500 }),
    new Response('b', { status: 500 }),
    new Response('c', { status: 500 }),
    new Response('d', { status: 500 }),
  ]);
  await withFetch(play.fetch, () =>
    rejection(
      drive(clock, putChunk(chunkOptions({ clock, chunkRetries: -3, random: () => 0 }))),
    ),
  );
  // 1 + the documented default of 3.
  assert.equal(play.calls.length, 4);
});

test('putChunk attempts a stream body once and declares duplex: half', async () => {
  const clock = mockClock();
  const play = playFetch([new Response('a', { status: 500 })]);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(CHUNK);
      controller.close();
    },
  });
  const { logger, records } = recordingLogger();

  await withFetch(play.fetch, () =>
    rejection(
      drive(
        clock,
        putChunk(chunkOptions({ clock, body: stream, contentLength: 8, logger })),
      ),
    ),
  );

  // A stream cannot be replayed, so the in-call ladder is disabled and the
  // caller re-reads the range instead (the identical Content-Range makes that safe).
  assert.equal(play.calls.length, 1);
  const call = attempt(play.calls);
  assert.equal(call.duplex, 'half');
  assert.equal(
    call.headers['content-length'],
    '8',
    'the caller must supply it for a stream',
  );
  assert.equal(logsLike(records, 'not replayable').length, 1);
});

test('putChunk sends no content-length for a stream when the caller omits it', async () => {
  const clock = mockClock();
  const play = playFetch([new Response('', { status: 201 })]);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(CHUNK);
      controller.close();
    },
  });
  await withFetch(play.fetch, () =>
    drive(clock, putChunk(chunkOptions({ clock, body: stream }))),
  );
  assert.equal('content-length' in attempt(play.calls).headers, false);
});

test('putChunk refuses an upload URL that is not on the allowlist', async () => {
  const play = playFetch([]);
  const { logger, records } = recordingLogger();
  const err = ttError(
    await withFetch(play.fetch, () =>
      rejection(
        putChunk(
          chunkOptions({
            uploadUrl: 'https://upload.evil.tld/upload/?upload_token=leaked',
            clock: mockClock(),
            logger,
          }),
        ),
      ),
    ),
  );

  assert.equal(err.code, 'egress_blocked');
  assert.equal(play.calls.length, 0);
  // Both URL-bearing fields are origin+path only — the token is in the query.
  const blocked = logsLike(records, 'egress blocked')[0];
  assert.equal(blocked?.fields?.['url'], 'https://upload.evil.tld/upload/');
  assert.equal(blocked?.fields?.['upload_url'], 'https://upload.evil.tld/upload/');
  assert.equal(JSON.stringify(blocked).includes('leaked'), false);
});

test('cc-h1 putChunk times out an attempt on the injected clock', async () => {
  const clock = mockClock();
  const play = playFetch(['hang', new Response('', { status: 201 })]);
  const result = await withFetch(play.fetch, () =>
    drive(clock, putChunk(chunkOptions({ clock, timeoutMs: 4_000, random: () => 0 }))),
  );

  // A timeout is retryable for the chunk class, so the second attempt lands.
  assert.equal(result.status, 201);
  assert.equal(play.calls.length, 2);
  assert.equal(clock.pending(), 0);
});

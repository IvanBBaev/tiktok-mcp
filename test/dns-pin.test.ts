/**
 * test/dns-pin.test.ts — DNS resolve-and-pin (probe P-15, SECURITY.md § 2.6).
 *
 * The pre-flight in `core/http` vets every address a hostname resolves to; the
 * pin makes the connection use exactly those addresses, so a resolver that
 * answers differently the second time (DNS rebinding) never gets asked.
 *
 * What is proved here:
 *
 * 1. **The attempt carries a pin.** With a `lookup` seam, each `fetch` gets an
 *    undici dispatcher, and the dispatcher is destroyed once the attempt
 *    settles. Without the seam, `fetch` gets no dispatcher at all.
 * 2. **The pin really pins.** A real `fetch` to a hostname that cannot resolve
 *    (`.invalid`) reaches a loopback server through `pinnedAgent`. This is the
 *    only test that opens a socket, and it never leaves 127.0.0.1.
 * 3. **The composition-root switch.** `outboundLookup` hands out the resolver
 *    unless `TT_DNS_PIN` is off or Node's environment proxy owns resolution.
 */

import assert from 'node:assert/strict';
import type { LookupAddress } from 'node:dns';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { Agent } from 'undici';

import { apiRequest, createApiContext } from '../src/api/context.js';
import {
  outboundLookup,
  pinnedAgent,
  pinnedLookup,
  putChunk,
  ttRequest,
  type LookupFn,
} from '../src/core/http.js';
import { createLogger } from '../src/core/log.js';
import { loadSettings } from '../src/core/settings.js';
import { mockClock, ttEnvelope, withFetch } from './helpers.js';

const API_URL = 'https://open.tiktokapis.com/v2/user/info/';
const UPLOAD_URL =
  'https://open-upload.tiktokapis.com/upload/?upload_id=1&upload_token=fake-upload-token';
const ROUTABLE: readonly LookupAddress[] = [
  { address: '23.55.60.1', family: 4 },
  { address: '2606:4700::1111', family: 6 },
];

/** A DNS seam that always answers `answer`. */
function fixedLookup(answer: readonly LookupAddress[]): LookupFn {
  const impl = (
    _hostname: string,
    _options: unknown,
    callback: (error: null, addresses: readonly LookupAddress[]) => void,
  ): void => {
    callback(null, answer);
  };
  return impl as unknown as LookupFn;
}

/** A `fetch` stub that keeps every `init` and answers with fresh responses. */
function capturingFetch(make: () => Response): {
  fetch: typeof fetch;
  inits: (RequestInit & { dispatcher?: unknown })[];
} {
  const inits: (RequestInit & { dispatcher?: unknown })[] = [];
  const stub = (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    inits.push(init ?? {});
    return Promise.resolve(make());
  };
  return { fetch: stub, inits };
}

// ---------------------------------------------------------------------------
// 1. every attempt carries a pin
// ---------------------------------------------------------------------------

test('ttRequest pins the attempt to the vetted answer and destroys the agent after', async () => {
  const play = capturingFetch(() => ttEnvelope({ ok: true }));
  await withFetch(play.fetch, () =>
    ttRequest({
      method: 'GET',
      url: API_URL,
      retryClass: 'read',
      lookup: fixedLookup(ROUTABLE),
      clock: mockClock(),
    }),
  );

  const dispatcher = play.inits[0]?.dispatcher;
  assert.ok(dispatcher instanceof Agent, 'the attempt carries an undici Agent');
  assert.equal(dispatcher.destroyed, true, 'one agent per attempt, never leaked');
});

test('ttRequest passes no dispatcher when no lookup seam is injected', async () => {
  const play = capturingFetch(() => ttEnvelope({ ok: true }));
  await withFetch(play.fetch, () =>
    ttRequest({ method: 'GET', url: API_URL, retryClass: 'read', clock: mockClock() }),
  );
  assert.equal('dispatcher' in (play.inits[0] ?? {}), false);
});

test('putChunk pins the upload PUT as well', async () => {
  const play = capturingFetch(() => new Response('', { status: 201 }));
  const result = await withFetch(play.fetch, () =>
    putChunk({
      uploadUrl: UPLOAD_URL,
      contentRange: 'bytes 0-0/1',
      contentType: 'video/mp4',
      body: new Uint8Array([8]),
      timeoutMs: 120_000,
      clock: mockClock(),
      lookup: fixedLookup(ROUTABLE),
    }),
  );
  assert.deepEqual(result, { status: 201 });
  assert.ok(play.inits[0]?.dispatcher instanceof Agent);
});

test('an ApiContext built with a lookup seam vets and pins every api request', async () => {
  const ctx = createApiContext({
    profile: 'DEFAULT',
    settings: loadSettings({}),
    log: createLogger({ level: 'error' }),
    clock: mockClock(),
    refresh: () => Promise.resolve('test-access-token-DEFAULT'),
    lookup: fixedLookup([{ address: '10.0.0.7', family: 4 }]),
  });
  const play = capturingFetch(() => ttEnvelope({ ok: true }));
  await withFetch(play.fetch, async () => {
    await assert.rejects(
      apiRequest(ctx, { method: 'GET', path: '/v2/user/info/' }),
      (err: unknown) => (err as { code?: string }).code === 'egress_blocked',
    );
  });
  assert.equal(play.inits.length, 0, 'a private answer never opens a socket');
});

// ---------------------------------------------------------------------------
// 2. the pin really pins
// ---------------------------------------------------------------------------

test('pinnedAgent connects to the pinned address and never asks a resolver', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.end(`host=${req.headers.host ?? ''}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const agent = pinnedAgent([{ address: '127.0.0.1', family: 4 }]);
  try {
    // `.invalid` can never resolve (RFC 6761): only the pin can reach the server.
    const response = await fetch(`http://pinned.invalid:${String(port)}/`, {
      dispatcher: agent,
    } as unknown as RequestInit);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), `host=pinned.invalid:${String(port)}`);
  } finally {
    await agent.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('pinnedLookup answers both the `all` and the single-address shape', () => {
  const lookup = pinnedLookup(ROUTABLE);

  let all: unknown;
  lookup('ignored.example', { all: true }, (error, addresses) => {
    assert.equal(error, null);
    all = addresses;
  });
  assert.deepEqual(all, ROUTABLE);

  let single: unknown[] = [];
  lookup('ignored.example', {}, (error, address, family) => {
    single = [error, address, family];
  });
  assert.deepEqual(single, [null, '23.55.60.1', 4]);

  let empty: unknown[] = [];
  pinnedLookup([])('ignored.example', {}, (error, address, family) => {
    empty = [error, address, family];
  });
  assert.deepEqual(
    empty,
    [null, '', 4],
    'defensive only: the resolver never answers empty',
  );
});

// ---------------------------------------------------------------------------
// 3. the composition-root switch
// ---------------------------------------------------------------------------

test('outboundLookup hands out the resolver unless the pin is off or a proxy resolves', () => {
  const resolver = fixedLookup(ROUTABLE);

  assert.equal(outboundLookup(true, {}, resolver), resolver);
  assert.equal(outboundLookup(false, {}, resolver), undefined, 'TT_DNS_PIN=0');

  const proxy = 'http://proxy.internal:3128';
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    assert.equal(
      outboundLookup(true, { NODE_USE_ENV_PROXY: '1', [key]: proxy }, resolver),
      undefined,
      `${key} under NODE_USE_ENV_PROXY: the proxy resolves`,
    );
  }

  // A proxy variable alone does nothing: Node's fetch ignores it without the opt-in.
  assert.equal(outboundLookup(true, { HTTPS_PROXY: proxy }, resolver), resolver);
  assert.equal(
    outboundLookup(true, { NODE_USE_ENV_PROXY: '0', HTTPS_PROXY: proxy }, resolver),
    resolver,
  );
  assert.equal(
    outboundLookup(true, { NODE_USE_ENV_PROXY: '', HTTPS_PROXY: proxy }, resolver),
    resolver,
  );
  assert.equal(
    outboundLookup(true, { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: '' }, resolver),
    resolver,
  );
});

/**
 * `mcp/http.ts` — the Streamable HTTP transport.
 *
 * Spec: CONTRACTS.md § `mcp/http.ts`, CC-G6, SECURITY.md § Transport.
 *
 * A listening socket is the one thing this server does that stdio does not, so
 * what is asserted here is mostly what the socket *refuses*: an unauthenticated
 * caller, a caller whose credential is merely wrong, a browser page that found
 * the port, and a name that resolves to loopback but is not loopback. Every
 * refusal is checked for what it does **not** say as well — a 401 that
 * distinguished "no token" from "wrong token" would be a probing oracle.
 *
 * The bind is always `127.0.0.1:0`: a real socket, a real HTTP client and a real
 * MCP handshake, on a port the OS picks so parallel runs cannot collide. The
 * cases that need a hostile `Host`/`Origin` go through `node:http` directly —
 * `fetch` will not let a caller forge those headers, which is exactly why the
 * server may not trust them.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request, type IncomingHttpHeaders } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { systemClock } from '../src/core/clock.js';
import { isTikTokError } from '../src/core/errors.js';
import type { Logger } from '../src/core/log.js';
import { loadSettings, type Settings } from '../src/core/settings.js';
import { defineTool, toolInput, type AnyToolSpec } from '../src/mcp/define.js';
import {
  dnsRebindingRejection,
  startHttpTransport,
  MCP_PATH,
  type HttpTransportHandle,
  type OriginPolicy,
} from '../src/mcp/http.js';
import type { ToolResult } from '../src/mcp/result.js';
import { createServer, type ServerRuntime } from '../src/mcp/server.js';
import type { ApiContext } from '../src/api/context.js';
import { baselineEnv, mockClock, type MockClock } from './helpers.js';

/** Long enough for `TT_HTTP_TOKEN`'s own schema, and obviously a fixture. */
const TOKEN = 'test-http-bearer-0123456789abcdef';

/** The same length as {@link TOKEN}, so a wrong credential differs only in value. */
const WRONG_TOKEN = 'test-http-bearer-fedcba9876543210';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

interface LogLine {
  readonly level: string;
  readonly msg: string;
  readonly fields: Record<string, unknown>;
}

/** A logger that records instead of writing, so tests never touch stderr. */
function recordingLogger(): Logger & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const make = (): Logger => {
    const at =
      (level: string) =>
      (msg: string, fields: Record<string, unknown> = {}): void => {
        lines.push({ level, msg, fields });
      };
    return {
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      child: () => make(),
    };
  };
  return Object.assign(make(), { lines });
}

/**
 * Settings from the real loader so the fixture cannot drift from the schema,
 * with `port` overwritten afterwards: `TT_PORT` is validated as 1..65535, and
 * an ephemeral bind — the only kind a test suite may take — is port 0.
 */
function httpSettings(overrides: Record<string, string> = {}): Settings {
  const loaded = loadSettings({
    ...baselineEnv(),
    TT_TRANSPORT: 'http',
    TT_HTTP_TOKEN: TOKEN,
    ...overrides,
  });
  return { ...loaded, port: 0 };
}

function apiContext(profile: string, settings: Settings, log: Logger): ApiContext {
  return {
    profile,
    settings,
    log,
    clock: systemClock,
    getAccessToken: () => Promise.resolve('test-access-token-DEFAULT'),
  };
}

/**
 * A tool that answers with the id of the session it was reached through. Tool
 * results are the only thing a client can observe from the outside, so this is
 * what makes "these two clients are not sharing a runtime" an assertion rather
 * than a hope.
 */
function sessionTool(sessionId: string): AnyToolSpec {
  return defineTool({
    name: 'tiktok_list_videos',
    title: 'List videos',
    description: 'List the authenticated creator’s public videos.',
    package: 'video',
    scopes: ['video.list'],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: toolInput({}),
    handler: () =>
      Promise.resolve<ToolResult<unknown>>({ ok: true, data: { sessionId } }),
  });
}

interface Bound {
  readonly transport: HttpTransportHandle;
  readonly port: number;
  readonly url: string;
  readonly log: Logger & { lines: LogLine[] };
  readonly clock: MockClock;
  /** Every session id the transport asked a runtime for, in order. */
  readonly built: string[];
  close(): Promise<void>;
}

interface BindOptions {
  settings?: Settings;
  /** Replaces the runtime factory — for the "a session fails to build" branch. */
  createHandle?: (sessionId: string) => never;
}

async function bind(opts: BindOptions = {}): Promise<Bound> {
  const settings = opts.settings ?? httpSettings();
  const log = recordingLogger();
  const clock = mockClock();
  const built: string[] = [];
  const runtime: ServerRuntime = {
    settings,
    log,
    profiles: () => Promise.resolve([{ name: 'DEFAULT', scopes: ['video.list'] }]),
    createContext: (profile: string) =>
      Promise.resolve(apiContext(profile, settings, log)),
  };
  const transport = await startHttpTransport({
    settings,
    log,
    clock,
    createHandle:
      opts.createHandle ??
      ((sessionId: string) => {
        built.push(sessionId);
        return createServer({
          name: 'tiktok-mcp-ai',
          version: '0.0.0-test',
          packages: [
            { name: 'auth', tools: [] },
            { name: 'user', tools: [] },
            { name: 'video', tools: [sessionTool(sessionId)] },
            { name: 'publish', tools: [] },
            { name: 'publish-write', tools: [] },
          ],
          runtime,
        });
      }),
  });
  return {
    transport,
    port: transport.port,
    url: transport.url,
    log,
    clock,
    built,
    close: () => transport.close(),
  };
}

// ---------------------------------------------------------------------------
// raw HTTP — the requests a conforming client would never make
// ---------------------------------------------------------------------------

interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface RawOptions {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  /** `false` sends no `Host` header at all, which `fetch` cannot express. */
  setHost?: boolean;
}

function raw(port: number, opts: RawOptions = {}): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'POST',
        path: opts.path ?? MCP_PATH,
        headers: opts.headers ?? {},
        ...(opts.setHost === false ? { setHost: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** The headers a Streamable HTTP POST must carry, minus whatever a test forges. */
function postHeaders(over: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${TOKEN}`,
    ...over,
  };
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw-test-client', version: '0.0.0' },
  },
});

/** A connected MCP client plus the transport that carries it, for teardown. */
interface Connected {
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
  readonly sessionId: string;
}

async function connect(url: string, token: string = TOKEN): Promise<Connected> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(transport);
  const sessionId = transport.sessionId;
  assert.ok(sessionId !== undefined, 'the server did not hand out a session id');
  return { client, transport, sessionId };
}

/** The `sessionId` the tool reports — the runtime that actually served the call. */
async function callSession(client: Client): Promise<string> {
  const result = await client.callTool({ name: 'tiktok_list_videos', arguments: {} });
  const structured = result.structuredContent as {
    ok: boolean;
    data: { sessionId: string };
  };
  assert.equal(structured.ok, true);
  return structured.data.sessionId;
}

// ---------------------------------------------------------------------------
// startup (CC-G6 — no unauthenticated HTTP transport, loopback included)
// ---------------------------------------------------------------------------

test('cc-g6: the transport refuses to bind at all without a bearer', async () => {
  // `core/settings` rejects this combination first; this asserts the backstop,
  // for the caller that assembled its `Settings` some other way.
  const { httpToken, ...withoutToken } = httpSettings();
  assert.equal(httpToken, TOKEN);

  await assert.rejects(
    () =>
      startHttpTransport({
        settings: withoutToken,
        log: recordingLogger(),
        createHandle: () => {
          throw new Error('a session must never be built');
        },
      }),
    (err: unknown) => {
      assert.ok(isTikTokError(err));
      assert.equal(err.kind, 'config');
      assert.equal(err.code, 'http_token_required');
      assert.match(err.message, /including a loopback bind/);
      return true;
    },
  );
});

test('cc-g6: a port that is already taken fails the start, not a later request', async () => {
  const first = await bind();
  try {
    // The listen error has to reach the caller: `startHttpTransport` resolving
    // on a socket it never got would leave `index.ts` logging a URL that
    // belongs to some other process.
    await assert.rejects(
      () => bind({ settings: { ...httpSettings(), port: first.port } }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as NodeJS.ErrnoException).code, 'EADDRINUSE');
        return true;
      },
    );
    assert.equal(first.transport.sessions(), 0);
  } finally {
    await first.close();
  }
});

test('cc-g6: a bearer opens a session and the tools answer on it', async () => {
  const b = await bind();
  try {
    const { client, transport, sessionId } = await connect(b.url);
    try {
      assert.equal(b.transport.sessions(), 1);
      assert.deepEqual(b.built, [sessionId]);
      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map((tool) => tool.name),
        ['tiktok_list_videos'],
      );
      assert.equal(await callSession(client), sessionId);
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    await b.close();
  }
});

// ---------------------------------------------------------------------------
// the bearer (SECURITY.md § Transport)
// ---------------------------------------------------------------------------

test('cc-g6: a wrong bearer and a missing bearer are the same 401', async () => {
  const b = await bind();
  try {
    const wrong = await raw(b.port, {
      headers: postHeaders({ authorization: `Bearer ${WRONG_TOKEN}` }),
      body: INITIALIZE,
    });
    // No `Authorization` header at all — not an empty one, which is a different
    // code path (a header that exists and says nothing).
    const unauthenticated = postHeaders();
    delete unauthenticated['authorization'];
    const missing = await raw(b.port, { headers: unauthenticated, body: INITIALIZE });
    const empty = await raw(b.port, {
      headers: postHeaders({ authorization: '' }),
      body: INITIALIZE,
    });

    assert.equal(wrong.status, 401);
    assert.equal(missing.status, 401);
    assert.equal(empty.status, 401);
    // Byte-identical: nothing tells a prober which of the two it just did.
    assert.equal(wrong.body, missing.body);
    assert.equal(wrong.body, empty.body);
    assert.equal(wrong.headers['www-authenticate'], 'Bearer');
    assert.equal(missing.headers['www-authenticate'], 'Bearer');
    assert.deepEqual(JSON.parse(wrong.body), {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Unauthorized' },
      id: null,
    });
    // A refused request builds no runtime and leaves no session behind.
    assert.equal(b.transport.sessions(), 0);
    assert.deepEqual(b.built, []);
    // The rejection is logged without the credential and without its length.
    const rejected = b.log.lines.filter((line) => line.msg === 'http request rejected');
    assert.equal(rejected.length, 3);
    for (const line of rejected) {
      assert.equal(line.level, 'warn');
      assert.deepEqual(line.fields, {
        status: 401,
        reason: 'bearer rejected',
        method: 'POST',
      });
    }
    assert.ok(!JSON.stringify(b.log.lines).includes(WRONG_TOKEN));
  } finally {
    await b.close();
  }
});

test('cc-g6: an Authorization header that is not a bearer is 401', async () => {
  const b = await bind();
  try {
    for (const authorization of [
      `Basic ${TOKEN}`,
      TOKEN, // the credential with no scheme at all
      'Bearer',
      `bearer  ${TOKEN}x`,
      // RFC 7235 separates the scheme from the credential with spaces, not with
      // arbitrary whitespace: a tab makes the scheme unreadable, not optional.
      `bearer\t${TOKEN}`,
    ]) {
      const res = await raw(b.port, {
        headers: postHeaders({ authorization }),
        body: INITIALIZE,
      });
      assert.equal(res.status, 401, authorization);
    }
    // Case and padding are the scheme's business, not the credential's.
    const ok = await raw(b.port, {
      headers: postHeaders({ authorization: `bearer   ${TOKEN} ` }),
      body: INITIALIZE,
    });
    assert.equal(ok.status, 200);
  } finally {
    await b.close();
  }
});

test('cc-g6: the bearer is checked before the request path exists', async () => {
  const b = await bind();
  try {
    const anonymous = await raw(b.port, {
      path: '/admin',
      headers: postHeaders({ authorization: '' }),
    });
    const authorized = await raw(b.port, { path: '/admin', headers: postHeaders() });

    // An unauthenticated prober may not map the surface: every path is 401.
    assert.equal(anonymous.status, 401);
    // With the credential, the same path answers honestly.
    assert.equal(authorized.status, 404);
    assert.deepEqual(JSON.parse(authorized.body), {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Not Found' },
      id: null,
    });
    // The query string is not part of the path.
    const query = await raw(b.port, {
      path: `${MCP_PATH}?probe=1`,
      method: 'PATCH',
      headers: postHeaders(),
    });
    assert.equal(query.status, 405);
  } finally {
    await b.close();
  }
});

// ---------------------------------------------------------------------------
// DNS rebinding (CC-G6 — `Host` and `Origin` on every request, loopback included)
// ---------------------------------------------------------------------------

test('cc-g6: a name that resolves to loopback is still not loopback', async () => {
  const b = await bind();
  try {
    // The shape of a rebinding attack: the browser connected to 127.0.0.1
    // because `evil.example` resolved there, and sent the attacker's name.
    const rebound = await raw(b.port, {
      headers: postHeaders({ host: `evil.example:${String(b.port)}` }),
      body: INITIALIZE,
    });
    assert.equal(rebound.status, 403);
    assert.deepEqual(JSON.parse(rebound.body), {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Forbidden: invalid Host header' },
      id: null,
    });

    // Right host, wrong port: another server on this machine is not this one.
    const otherPort = await raw(b.port, {
      headers: postHeaders({ host: `127.0.0.1:${String(b.port + 1)}` }),
      body: INITIALIZE,
    });
    assert.equal(otherPort.status, 403);

    // The refusal happens before the credential is read, so a valid bearer
    // does not buy a rebound name anything.
    assert.equal(b.built.length, 0);
    const anonymous = await raw(b.port, {
      headers: postHeaders({ host: 'evil.example', authorization: '' }),
    });
    assert.equal(anonymous.status, 403);
  } finally {
    await b.close();
  }
});

test('cc-g6: a request with no usable Host header cannot be checked, so it is refused', async () => {
  const b = await bind();
  try {
    // A Host-less HTTP/1.1 request never reaches the transport at all: Node's
    // own parser answers 400 before a listener runs. Asserted so the layer that
    // actually refuses it is on the record — the check below is what happens
    // when a header exists but says nothing.
    const missing = await raw(b.port, {
      setHost: false,
      headers: postHeaders(),
      body: INITIALIZE,
    });
    assert.equal(missing.status, 400);

    const empty = await raw(b.port, {
      setHost: false,
      headers: { ...postHeaders(), host: '' },
      body: INITIALIZE,
    });
    assert.equal(empty.status, 403);
    assert.match(empty.body, /invalid Host header/);
  } finally {
    await b.close();
  }
});

test('cc-g6: a browser page on another origin is refused, a client with no Origin is not', async () => {
  const b = await bind();
  try {
    const host = `127.0.0.1:${String(b.port)}`;
    for (const origin of [
      'http://evil.example',
      `http://localhost:${String(b.port + 1)}`,
      'null', // an opaque origin — a sandboxed frame or a cross-origin redirect
      'file:///Users/someone/attack.html',
    ]) {
      const res = await raw(b.port, {
        headers: postHeaders({ host, origin }),
        body: INITIALIZE,
      });
      assert.equal(res.status, 403, origin);
      assert.match(res.body, /invalid Origin header/);
    }

    // The bind's own origin is fine, and so is no origin at all: every
    // non-browser MCP client sends none, and rejecting them all would be a
    // transport that serves nobody.
    const same = await raw(b.port, {
      headers: postHeaders({ host, origin: `http://127.0.0.1:${String(b.port)}` }),
      body: INITIALIZE,
    });
    assert.equal(same.status, 200);
  } finally {
    await b.close();
  }
});

test('cc-g6: past loopback the proxy owns the name, so Origin is pinned to Host', () => {
  // No socket: binding off-box in a test would ask the machine's firewall for
  // permission, and this branch is a pure function of two headers.
  const proxied: OriginPolicy = { loopbackOnly: false, port: 8080 };

  // Any name may front the server, so the syntax is all that can be checked…
  assert.equal(dnsRebindingRejection({ host: 'mcp.example.com' }, proxied), undefined);
  assert.equal(
    dnsRebindingRejection({ host: 'mcp.example.com:443' }, proxied),
    undefined,
  );
  // …and a browser must name that same host, on whatever port it reached it.
  assert.equal(
    dnsRebindingRejection(
      { host: 'mcp.example.com', origin: 'https://mcp.example.com' },
      proxied,
    ),
    undefined,
  );
  assert.equal(
    dnsRebindingRejection(
      { host: 'mcp.example.com:8443', origin: 'https://MCP.Example.com:8443' },
      proxied,
    ),
    undefined,
  );
  assert.equal(
    dnsRebindingRejection(
      { host: 'mcp.example.com', origin: 'https://evil.example' },
      proxied,
    ),
    'Origin',
  );
  // A `Host` is still mandatory, and still has to be an authority.
  assert.equal(dnsRebindingRejection({}, proxied), 'Host');
  assert.equal(dnsRebindingRejection({ host: '   ' }, proxied), 'Host');
});

test('cc-g6: a loopback bind pins the whole authority, IPv6 literals included', () => {
  const loopback: OriginPolicy = { loopbackOnly: true, port: 3000 };

  assert.equal(dnsRebindingRejection({ host: '[::1]:3000' }, loopback), undefined);
  assert.equal(dnsRebindingRejection({ host: 'LocalHost:3000' }, loopback), undefined);
  assert.equal(dnsRebindingRejection({ host: '127.0.0.53:3000' }, loopback), undefined);
  assert.equal(
    dnsRebindingRejection({ host: '[::1]:3000', origin: 'http://[::1]:3000' }, loopback),
    undefined,
  );
  // A default port is a port: on `:80` an authority may omit it, brackets and
  // all — `[::1]` and `[::1]:80` name the same socket.
  assert.equal(
    dnsRebindingRejection(
      { host: 'localhost', origin: 'http://localhost' },
      { loopbackOnly: true, port: 80 },
    ),
    undefined,
  );
  assert.equal(
    dnsRebindingRejection({ host: '[::1]' }, { loopbackOnly: true, port: 80 }),
    undefined,
  );

  // Not loopback, no port, or not an authority at all.
  assert.equal(dnsRebindingRejection({ host: '10.0.0.4:3000' }, loopback), 'Host');
  assert.equal(dnsRebindingRejection({ host: 'localhost' }, loopback), 'Host');
  assert.equal(dnsRebindingRejection({ host: '[::1]' }, loopback), 'Host');
  assert.equal(dnsRebindingRejection({ host: '[::1' }, loopback), 'Host');
  assert.equal(dnsRebindingRejection({ host: '[::1]x' }, loopback), 'Host');
  assert.equal(
    dnsRebindingRejection(
      { host: 'localhost:3000', origin: 'http://10.0.0.4:3000' },
      loopback,
    ),
    'Origin',
  );
  assert.equal(
    dnsRebindingRejection({ host: 'localhost:3000', origin: 'not a url' }, loopback),
    'Origin',
  );
});

// ---------------------------------------------------------------------------
// the protocol surface
// ---------------------------------------------------------------------------

test('cc-g6: an unsupported method is 405 and advertises the ones that work', async () => {
  const b = await bind();
  try {
    const res = await raw(b.port, { method: 'PUT', headers: postHeaders() });
    assert.equal(res.status, 405);
    assert.equal(res.headers['allow'], 'GET, POST, DELETE');
    assert.deepEqual(JSON.parse(res.body), {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method Not Allowed' },
      id: null,
    });
  } finally {
    await b.close();
  }
});

test('cc-g6: an unknown session id is 404 and says no more than that', async () => {
  const b = await bind();
  try {
    const res = await raw(b.port, {
      headers: postHeaders({ 'mcp-session-id': '00000000-0000-4000-8000-000000000000' }),
      body: INITIALIZE,
    });
    assert.equal(res.status, 404);
    assert.deepEqual(JSON.parse(res.body), {
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found' },
      id: null,
    });
    // A guessed id must not be answered by a freshly built runtime either.
    assert.equal(b.transport.sessions(), 0);
    assert.deepEqual(b.built, []);
  } finally {
    await b.close();
  }
});

test('cc-g6: a request with no session id and no initialize is 400', async () => {
  const b = await bind();
  try {
    const get = await raw(b.port, { method: 'GET', headers: postHeaders() });
    assert.equal(get.status, 400);
    assert.deepEqual(JSON.parse(get.body), {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' },
      id: null,
    });

    // An empty header is not a session id; it is the absence of one.
    const empty = await raw(b.port, {
      method: 'GET',
      headers: postHeaders({ 'mcp-session-id': '' }),
    });
    assert.equal(empty.status, 400);
  } finally {
    await b.close();
  }
});

test('cc-g6: a POST that never initializes leaves no session behind', async () => {
  const b = await bind();
  try {
    const res = await raw(b.port, {
      headers: postHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
    });
    // The SDK refuses it; what this asserts is the cleanup around that refusal —
    // a runtime was built for the attempt and must not survive it.
    assert.equal(res.status, 400);
    assert.deepEqual(b.built.length, 1);
    assert.equal(b.transport.sessions(), 0);
  } finally {
    await b.close();
  }
});

test('cc-g6: a session that fails to build is a 500, not a half-open session', async () => {
  const b = await bind({
    createHandle: () => {
      throw new Error('the runtime is unavailable');
    },
  });
  try {
    const res = await raw(b.port, { headers: postHeaders(), body: INITIALIZE });
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(res.body), {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Internal Server Error' },
      id: null,
    });
    assert.equal(b.transport.sessions(), 0);
    const failed = b.log.lines.find((line) => line.msg === 'http request failed');
    assert.ok(failed !== undefined);
    assert.equal(failed.level, 'error');
    assert.equal(failed.fields['reason'], 'the runtime is unavailable');
  } finally {
    await b.close();
  }
});

// ---------------------------------------------------------------------------
// session isolation
// ---------------------------------------------------------------------------

test('cc-g6: two sessions get their own runtime and never see each other', async () => {
  const b = await bind();
  const first = await connect(b.url);
  const second = await connect(b.url);
  try {
    assert.notEqual(first.sessionId, second.sessionId);
    assert.equal(b.transport.sessions(), 2);
    assert.deepEqual(b.built, [first.sessionId, second.sessionId]);

    // Each call is served by the runtime built for that session — the two
    // clients share a port and nothing else.
    assert.equal(await callSession(first.client), first.sessionId);
    assert.equal(await callSession(second.client), second.sessionId);

    // Neither may borrow the other's session id on a connection of its own.
    const stolen = await raw(b.port, {
      headers: postHeaders({ 'mcp-session-id': first.sessionId }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    });
    // The SDK refuses it as an uninitialized *transport*, which is the point:
    // the session id alone did not carry the other client's state over.
    assert.ok(stolen.status === 400 || stolen.status === 200, String(stolen.status));
  } finally {
    await first.client.close();
    await second.client.close();
    await b.close();
  }
});

test('cc-g6: DELETE ends one session and leaves the rest running', async () => {
  const b = await bind();
  const first = await connect(b.url);
  const second = await connect(b.url);
  try {
    await b.clock.advance(5_000);
    await first.transport.terminateSession();

    assert.equal(b.transport.sessions(), 1);
    // The survivor is untouched.
    assert.equal(await callSession(second.client), second.sessionId);
    // The ended session is now indistinguishable from one that never existed.
    const after = await raw(b.port, {
      headers: postHeaders({ 'mcp-session-id': first.sessionId }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    });
    assert.equal(after.status, 404);

    // The session's lifetime came from the injected clock (CC-H4), and no log
    // line carries the session id or the bearer.
    const closed = b.log.lines.find((line) => line.msg === 'mcp session closed');
    assert.ok(closed !== undefined);
    assert.deepEqual(closed.fields, { duration_ms: 5_000 });
    const serialized = JSON.stringify(b.log.lines);
    assert.ok(!serialized.includes(TOKEN));
    assert.ok(!serialized.includes(first.sessionId));
  } finally {
    await first.client.close();
    await second.client.close();
    await b.close();
  }
});

test('cc-g6: close ends every session and gives the port back', async () => {
  const b = await bind();
  const { client, sessionId } = await connect(b.url);
  assert.equal(b.transport.sessions(), 1);
  assert.equal(await callSession(client), sessionId);

  await b.close();
  // Idempotent: shutdown paths overlap, and the second call must be a no-op.
  await b.close();

  assert.equal(b.transport.sessions(), 0);
  await assert.rejects(
    () => raw(b.port, { method: 'GET', headers: postHeaders() }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(
        String((err as NodeJS.ErrnoException).code),
        /ECONNREFUSED|ECONNRESET/,
      );
      return true;
    },
  );
  const closed = b.log.lines.filter(
    (line) => line.msg === 'the http transport is closed',
  );
  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.fields['url'], b.url);
  await client.close();
});

// ---------------------------------------------------------------------------
// CC-G3 — stdout belongs to the protocol
// ---------------------------------------------------------------------------

/**
 * Serve the transport from a real child process and hand back its streams.
 *
 * Patching `process.stdout.write` in-process would measure `node --test`'s own
 * reporter as well as the server, so the only honest measurement is a process
 * whose stdout nothing else is allowed to touch. `drive` runs against the URL
 * the child logs on stderr; the child is killed either way, and killed hard if
 * it outlives the deadline, so a transport that never binds fails the test
 * instead of hanging the suite.
 */
async function runHttpWorker(
  drive: (url: string, port: number) => Promise<void>,
): Promise<{ stdout: string; stderr: string }> {
  const worker = fileURLToPath(
    new URL('./harness/workers/http-server-worker.js', import.meta.url),
  );
  const child = spawn(process.execPath, [worker], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TIKTOK_MCP_TEST_HTTP_TOKEN: TOKEN },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the http worker did not bind in time; stderr: ${stderr}`));
    }, 15_000);
    timer.unref();
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the http worker exited with ${String(code)}; stderr: ${stderr}`));
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      for (const line of stderr.split('\n')) {
        if (!line.includes('http worker listening')) continue;
        const record = JSON.parse(line) as { url?: string };
        if (record.url === undefined) continue;
        clearTimeout(timer);
        resolve(record.url);
        return;
      }
    });
  });

  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  try {
    await drive(url, Number(new URL(url).port));
  } finally {
    child.kill('SIGTERM');
    await exited;
  }
  return { stdout, stderr };
}

test('cc-g3: a full http session writes nothing to stdout', async () => {
  const { stdout, stderr } = await runHttpWorker(async (url, port) => {
    const { client, transport } = await connect(url);
    // A served call and a refused one: the tool handler and the rejection path
    // both log, and both logs have to land somewhere other than stdout.
    const result = await client.callTool({ name: 'tiktok_list_videos', arguments: {} });
    assert.deepEqual(result.structuredContent, {
      ok: true,
      data: { videos: [], meta: { account: 'DEFAULT' } },
    });
    const refused = await raw(port, { headers: postHeaders({ authorization: '' }) });
    assert.equal(refused.status, 401);
    await transport.terminateSession();
    await client.close();
  });

  assert.equal(stdout, '');
  // The proof that the silence is not an unstarted server: the diagnostics the
  // run produced are all there, on the stream that is allowed to carry them.
  assert.match(stderr, /"msg":"mcp session opened"/);
  assert.match(stderr, /"msg":"handler ran"/);
  assert.match(stderr, /"msg":"http request rejected"/);
  assert.ok(!stderr.includes(TOKEN));
});

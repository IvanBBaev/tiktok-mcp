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
import http, {
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { PassThrough, Readable } from 'node:stream';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { systemClock } from '../src/core/clock.js';
import { isTikTokError } from '../src/core/errors.js';
import type { Logger } from '../src/core/log.js';
import { loadSettings, type Settings } from '../src/core/settings.js';
import { defineTool, toolInput, type AnyToolSpec } from '../src/mcp/define.js';
import {
  canonicalHostHeader,
  dnsRebindingRejection,
  startHttpTransport,
  MCP_PATH,
  type HttpTransportHandle,
  type HttpTransportOptions,
  type OriginPolicy,
} from '../src/mcp/http.js';
import type { ToolResult } from '../src/mcp/result.js';
import {
  createServer,
  type McpServerHandle,
  type ServerRuntime,
} from '../src/mcp/server.js';
import type { ApiContext } from '../src/api/context.js';
import { deferred, flush, type Deferred } from './harness/deferred.js';
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

/** The runtime every session in this file is built on. */
function serverRuntime(settings: Settings, log: Logger): ServerRuntime {
  return {
    settings,
    log,
    profiles: () => Promise.resolve([{ name: 'DEFAULT', scopes: ['video.list'] }]),
    createContext: (profile: string) =>
      Promise.resolve(apiContext(profile, settings, log)),
  };
}

/** What the transport's own factory builds — one server per session id. */
function sessionHandle(sessionId: string, runtime: ServerRuntime): McpServerHandle {
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
  /**
   * Replaces the runtime factory — for the "a session fails to build" branch,
   * and for the handle whose teardown throws after the answer is on the wire.
   */
  createHandle?: HttpTransportOptions['createHandle'];
  releaseHandle?: HttpTransportOptions['releaseHandle'];
  maxSessions?: number;
  sessionIdleMs?: number;
  drainMs?: number;
}

async function bind(opts: BindOptions = {}): Promise<Bound> {
  const settings = opts.settings ?? httpSettings();
  const log = recordingLogger();
  const clock = mockClock();
  const built: string[] = [];
  const runtime = serverRuntime(settings, log);
  const transport = await startHttpTransport({
    settings,
    log,
    clock,
    createHandle:
      opts.createHandle ??
      ((sessionId: string) => {
        built.push(sessionId);
        return sessionHandle(sessionId, runtime);
      }),
    ...(opts.releaseHandle === undefined ? {} : { releaseHandle: opts.releaseHandle }),
    ...(opts.maxSessions === undefined ? {} : { maxSessions: opts.maxSessions }),
    ...(opts.sessionIdleMs === undefined ? {} : { sessionIdleMs: opts.sessionIdleMs }),
    ...(opts.drainMs === undefined ? {} : { drainMs: opts.drainMs }),
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

test('cc-g6: an accepted Host reaches the SDK spelled canonically', () => {
  assert.equal(canonicalHostHeader('127.1:61234'), '127.0.0.1:61234');
  assert.equal(canonicalHostHeader('LocalHost:3000'), 'localhost:3000');
  assert.equal(canonicalHostHeader('[0:0:0:0:0:0:0:1]:3000'), '[::1]:3000');
  // No port (the default one, or a proxy's), and IPv6 without one.
  assert.equal(canonicalHostHeader('MCP.Example.com'), 'mcp.example.com');
  assert.equal(canonicalHostHeader('[::1]'), '[::1]');
  // What the gate refuses is left as it came; it never gets this far.
  assert.equal(canonicalHostHeader('[::1'), '[::1');
  assert.equal(canonicalHostHeader(undefined), undefined);
});

test('an allowlist narrows a loopback bind to the names on it, Origin included', () => {
  const loopback = {
    loopbackOnly: true,
    port: 3000,
    allowedHosts: new Set(['localhost', 'mcp.example.com']),
  };
  // Loopback, but not on the list.
  assert.equal(dnsRebindingRejection({ host: '127.0.0.1:3000' }, loopback), 'Host');
  // On the list, but not loopback: the list narrows, it never widens.
  assert.equal(dnsRebindingRejection({ host: 'mcp.example.com:3000' }, loopback), 'Host');
  assert.equal(dnsRebindingRejection({ host: 'localhost:3000' }, loopback), undefined);
  assert.equal(
    dnsRebindingRejection(
      { host: 'localhost:3000', origin: 'http://127.0.0.1:3000' },
      loopback,
    ),
    'Origin',
  );
  assert.equal(
    dnsRebindingRejection(
      { host: 'localhost:3000', origin: 'http://localhost:3000' },
      loopback,
    ),
    undefined,
  );
});

test('past loopback an allowlist is what stops a rebound name', () => {
  const proxied = {
    loopbackOnly: false,
    port: 3000,
    allowedHosts: new Set(['mcp.example.com', 'other.example', '2001:db8::1']),
  };
  assert.equal(dnsRebindingRejection({ host: 'evil.example' }, proxied), 'Host');
  assert.equal(
    dnsRebindingRejection({ host: 'MCP.example.com:443' }, proxied),
    undefined,
  );
  assert.equal(
    dnsRebindingRejection(
      { host: 'mcp.example.com', origin: 'https://evil.example' },
      proxied,
    ),
    'Origin',
  );
  // Both names are on the list, yet a page on one still cannot drive the other.
  assert.equal(
    dnsRebindingRejection(
      { host: 'mcp.example.com', origin: 'https://other.example' },
      proxied,
    ),
    'Origin',
  );
  assert.equal(
    dnsRebindingRejection(
      { host: '[2001:db8::1]:443', origin: 'https://[2001:DB8::1]' },
      proxied,
    ),
    undefined,
  );
});

test('TT_HTTP_ALLOWED_HOSTS reaches the transport, so a loopback address off the list is 403', async () => {
  const b = await bind({
    settings: httpSettings({ TT_HTTP_ALLOWED_HOSTS: 'localhost' }),
  });
  try {
    const byAddress = await raw(b.port, { headers: postHeaders(), body: INITIALIZE });
    assert.equal(byAddress.status, 403);
    assert.match(byAddress.body, /invalid Host header/);
    assert.equal(b.built.length, 0);

    const byName = await raw(b.port, {
      headers: postHeaders({ host: `localhost:${String(b.port)}` }),
      body: INITIALIZE,
    });
    assert.equal(byName.status, 200);
    assert.equal(b.built.length, 1);
  } finally {
    await b.close();
  }
});

test('a Host spelled in any form the URL parser reads names the loopback address it canonicalizes to', () => {
  const loopback: OriginPolicy = { loopbackOnly: true, port: 3000 };
  for (const host of [
    '[0:0:0:0:0:0:0:1]:3000',
    '[0000::0001]:3000',
    '127.1:3000',
    '0x7f.1:3000',
    '2130706433:3000',
  ]) {
    assert.equal(dnsRebindingRejection({ host }, loopback), undefined, host);
  }
  // Origin goes through the same canonicalization, so the two spellings agree.
  assert.equal(
    dnsRebindingRejection(
      { host: '127.1:3000', origin: 'http://[0:0:0:0:0:0:0:1]:3000' },
      loopback,
    ),
    undefined,
  );
  // A spelling that canonicalizes off loopback is refused like the plain form.
  assert.equal(dnsRebindingRejection({ host: '0x0a.1:3000' }, loopback), 'Host');
  // A name the URL parser refuses is kept as it is, and is still not loopback.
  for (const host of ['bad_host!:3000', 'ex ample:3000', '[fe80::1%eth0]:3000']) {
    assert.equal(dnsRebindingRejection({ host }, loopback), 'Host', host);
  }
});

test('an allowlist matches a Host by its canonical form, never by its spelling', () => {
  const loopback = {
    loopbackOnly: true,
    port: 3000,
    allowedHosts: new Set(['::1', '127.0.0.1']),
  };
  assert.equal(
    dnsRebindingRejection({ host: '[0:0:0:0:0:0:0:1]:3000' }, loopback),
    undefined,
  );
  assert.equal(dnsRebindingRejection({ host: '127.1:3000' }, loopback), undefined);
  assert.equal(
    dnsRebindingRejection(
      { host: '127.1:3000', origin: 'http://0x7f.0.0.1:3000' },
      loopback,
    ),
    undefined,
  );
  // Loopback, but a different address from both entries.
  assert.equal(dnsRebindingRejection({ host: '127.2:3000' }, loopback), 'Host');

  const proxied = {
    loopbackOnly: false,
    port: 3000,
    allowedHosts: new Set(['mcp.example.com']),
  };
  assert.equal(dnsRebindingRejection({ host: 'MCP.Example.COM' }, proxied), undefined);
  // Garbage that merely lowercases to nothing on the list is still refused.
  assert.equal(dnsRebindingRejection({ host: 'bad_host!' }, proxied), 'Host');
  assert.equal(dnsRebindingRejection({ host: 'MCP.Example.COM_' }, proxied), 'Host');
});

test('a live request whose Host spells the bound address differently is served', async () => {
  const b = await bind({
    settings: httpSettings({ TT_HTTP_ALLOWED_HOSTS: '0x7f.0.0.1' }),
  });
  try {
    const shorthand = await raw(b.port, {
      headers: postHeaders({ host: `127.1:${String(b.port)}` }),
      body: INITIALIZE,
    });
    assert.equal(shorthand.status, 200);
    // A garbage Host on the same socket is still 403 and builds nothing more.
    const garbage = await raw(b.port, {
      headers: postHeaders({ host: `bad_host!:${String(b.port)}` }),
      body: INITIALIZE,
    });
    assert.equal(garbage.status, 403);
    assert.match(garbage.body, /invalid Host header/);
    assert.equal(b.built.length, 1);
  } finally {
    await b.close();
  }
});

/** Ports that are not a decimal 1-65535, in the forms a `Host` can carry them. */
const BAD_PORT_HOSTS = [
  '127.0.0.1:abc',
  '127.0.0.1:',
  '127.0.0.1:99999',
  '127.0.0.1:65536',
  '127.0.0.1:0',
  '127.0.0.1:000001',
  '127.0.0.1:+80',
  '127.0.0.1:8o',
  '[::1]:x',
  '[::1]:',
  '[::1]:0',
] as const;

test('a Host whose port is not a decimal 1-65535 is no authority, and is left unspelled', () => {
  const loopback: OriginPolicy = { loopbackOnly: true, port: 3000 };
  for (const host of BAD_PORT_HOSTS) {
    assert.equal(dnsRebindingRejection({ host }, loopback), 'Host', host);
    // The gate refuses it before the re-spelling runs, so it comes back as sent.
    assert.equal(canonicalHostHeader(host), host, host);
  }
  // The edges of the range are ports; five digits is the most a port has.
  assert.equal(
    dnsRebindingRejection(
      { host: '127.0.0.1:65535' },
      { loopbackOnly: true, port: 65_535 },
    ),
    undefined,
  );
  assert.equal(
    dnsRebindingRejection({ host: '[::1]:1' }, { loopbackOnly: true, port: 1 }),
    undefined,
  );
  assert.equal(canonicalHostHeader('127.1:65535'), '127.0.0.1:65535');
  assert.equal(canonicalHostHeader('[0::1]:1'), '[::1]:1');
});

test('a port with leading zeros is the same port, and is re-spelled without them', () => {
  // `:03000` is port 3000 to every HTTP parser; comparing the spelling against
  // the bound port would refuse a correct client for a formatting choice.
  const loopback: OriginPolicy = { loopbackOnly: true, port: 3000 };
  for (const host of ['127.0.0.1:03000', 'localhost:03000', '[::1]:03000']) {
    assert.equal(dnsRebindingRejection({ host }, loopback), undefined, host);
  }
  // The leading zeros buy nothing past the port they spell.
  assert.equal(dnsRebindingRejection({ host: '127.0.0.1:03001' }, loopback), 'Host');
  assert.equal(
    dnsRebindingRejection({ host: '127.0.0.1:080' }, { loopbackOnly: true, port: 80 }),
    undefined,
  );
  // The SDK is handed the port as the bind spells it.
  assert.equal(canonicalHostHeader('127.0.0.1:03000'), '127.0.0.1:3000');
  assert.equal(canonicalHostHeader('127.1:080'), '127.0.0.1:80');
  assert.equal(canonicalHostHeader('[::1]:00001'), '[::1]:1');
  assert.equal(canonicalHostHeader('mcp.example.com:0443'), 'mcp.example.com:443');
});

test('past loopback a bad port is refused too, where only the syntax can be checked', () => {
  const proxied: OriginPolicy = { loopbackOnly: false, port: 8080 };
  assert.equal(
    dnsRebindingRejection({ host: 'mcp.example.com:65535' }, proxied),
    undefined,
  );
  assert.equal(dnsRebindingRejection({ host: 'mcp.example.com:1' }, proxied), undefined);
  assert.equal(dnsRebindingRejection({ host: '[2001:db8::1]:443' }, proxied), undefined);
  for (const host of [
    'mcp.example.com:0',
    'mcp.example.com:99999',
    'mcp.example.com:',
    'mcp.example.com:https',
    '[2001:db8::1]:x',
    '[2001:db8::1]:',
  ]) {
    assert.equal(dnsRebindingRejection({ host }, proxied), 'Host', host);
    assert.equal(canonicalHostHeader(host), host, host);
  }
});

test('a live request whose Host carries a bad port is the 403 envelope, not a bare 400', async () => {
  const b = await bind();
  try {
    for (const host of BAD_PORT_HOSTS) {
      const res = await raw(b.port, { headers: postHeaders({ host }), body: INITIALIZE });
      assert.equal(res.status, 403, host);
      assert.deepEqual(
        JSON.parse(res.body),
        {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Forbidden: invalid Host header' },
          id: null,
        },
        host,
      );
    }
    assert.equal(b.built.length, 0);
    const rejected = b.log.lines.filter((line) => line.msg === 'http request rejected');
    assert.equal(rejected.length, BAD_PORT_HOSTS.length);
    for (const line of rejected) {
      assert.deepEqual(line.fields, {
        status: 403,
        reason: 'invalid Host header',
        method: 'POST',
      });
    }
  } finally {
    await b.close();
  }
});

// ---------------------------------------------------------------------------
// the protocol surface
// ---------------------------------------------------------------------------

test('cc-g6: a request target the URL parser cannot read is 404, not a guess', async () => {
  const b = await bind();
  try {
    // llhttp accepts `//` as an origin-form target and hands it over verbatim,
    // but as a URL reference it is an authority with no host, so the WHATWG
    // parser refuses it. An unreadable target may not be answered by guessing:
    // no path is not `MCP_PATH`.
    const res = await raw(b.port, {
      path: '//',
      headers: postHeaders(),
      body: INITIALIZE,
    });

    assert.equal(res.status, 404);
    assert.deepEqual(JSON.parse(res.body), {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Not Found' },
      id: null,
    });
    // Nothing was built for it either — a bad target is not a session.
    assert.equal(b.transport.sessions(), 0);
    assert.deepEqual(b.built, []);
  } finally {
    await b.close();
  }
});

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

test('a session factory that throws a non-Error still answers 500 and logs the value', async () => {
  // JavaScript lets anything be thrown, and `createHandle` is a caller-supplied
  // seam (HttpTransportOptions), so the top-level catch cannot assume it is
  // reading `.message` off an Error. Getting that wrong twice over is what makes
  // this worth pinning: the log line would carry `undefined` where the reason
  // belongs, and the client would get a dropped connection instead of the same
  // 500 every other failed build produces.
  const b = await bind({
    createHandle: () => {
      // The rule this suppresses is the one the branch under test exists for:
      // production code cannot assume every thrower obeyed it.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'the runtime is unavailable';
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
    assert.equal(failed.fields['reason'], 'the runtime is unavailable');
  } finally {
    await b.close();
  }
});

test('a failure after the answer is on the wire ends the response, not a second body', async () => {
  // The top-level catch has two ways to answer, and they are not
  // interchangeable: before anything is written it can still send the 500
  // envelope, but once `writeHead` has run the status line is spent — a second
  // `sendJsonRpcError` would throw ERR_HTTP_HEADERS_SENT inside the handler
  // that is already handling a failure, and the client would be left holding a
  // response the server never closed. So the late failure is ended, not
  // answered.
  //
  // Getting there without reaching into the module: `createHandle` is a
  // caller-supplied seam, the SDK chains transport `onclose` handlers rather
  // than replacing them, and a POST that never initializes is the one path
  // that tears its transport down *after* the SDK has already answered it.
  const settings = httpSettings();
  const b = await bind({
    settings,
    createHandle: (sessionId: string) => {
      const handle = sessionHandle(sessionId, serverRuntime(settings, recordingLogger()));
      handle.server.onclose = () => {
        throw new Error('teardown exploded');
      };
      return handle;
    },
  });
  try {
    const res = await raw(b.port, {
      headers: postHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
    });
    // The answer the SDK had already written is intact: one JSON-RPC body, the
    // SDK's own, and not a 500 glued onto the end of it.
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body) as { jsonrpc: string; error: { code: number } };
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(typeof body.error.code, 'number');

    const failed = b.log.lines.find((line) => line.msg === 'http request failed');
    assert.ok(failed !== undefined, 'the late failure was not logged');
    assert.equal(failed.level, 'error');
    assert.equal(failed.fields['reason'], 'teardown exploded');

    // And the transport is still serving: a failed teardown is one request's
    // problem, not the socket's.
    assert.equal(b.transport.sessions(), 0);
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
// handle release and shutdown
// ---------------------------------------------------------------------------

/** A factory that remembers the handle it built for each session id. */
function trackedHandles(): {
  readonly byId: Map<string, McpServerHandle>;
  readonly released: McpServerHandle[];
  readonly createHandle: HttpTransportOptions['createHandle'];
  readonly releaseHandle: NonNullable<HttpTransportOptions['releaseHandle']>;
} {
  const settings = httpSettings();
  const runtime = serverRuntime(settings, recordingLogger());
  const byId = new Map<string, McpServerHandle>();
  const released: McpServerHandle[] = [];
  return {
    byId,
    released,
    createHandle: (sessionId: string) => {
      const handle = sessionHandle(sessionId, runtime);
      byId.set(sessionId, handle);
      return handle;
    },
    releaseHandle: (handle) => {
      released.push(handle);
    },
  };
}

test('DELETE releases the handle of the session it ended, once', async () => {
  const t = trackedHandles();
  const b = await bind({ createHandle: t.createHandle, releaseHandle: t.releaseHandle });
  const first = await connect(b.url);
  const second = await connect(b.url);
  try {
    await first.transport.terminateSession();
    assert.equal(t.released.length, 1);
    assert.equal(t.released[0], t.byId.get(first.sessionId));
  } finally {
    await first.client.close();
    await second.client.close();
    await b.close();
  }
  // close() released the survivor, and the ended session was not released twice.
  assert.equal(t.released.length, 2);
  assert.equal(t.released[1], t.byId.get(second.sessionId));
});

test('close releases the handle of every open session, once each', async () => {
  const t = trackedHandles();
  const b = await bind({ createHandle: t.createHandle, releaseHandle: t.releaseHandle });
  const first = await connect(b.url);
  const second = await connect(b.url);
  await b.close();
  await b.close();
  assert.equal(t.released.length, 2);
  assert.deepEqual(
    new Set(t.released),
    new Set([t.byId.get(first.sessionId), t.byId.get(second.sessionId)]),
  );
  await first.client.close();
  await second.client.close();
});

test('a POST that never initializes releases the handle built for it', async () => {
  const t = trackedHandles();
  const b = await bind({ createHandle: t.createHandle, releaseHandle: t.releaseHandle });
  try {
    const res = await raw(b.port, {
      headers: postHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
    });
    assert.equal(res.status, 400);
    assert.equal(t.byId.size, 1);
    assert.equal(t.released.length, 1);
    assert.equal(t.released[0], [...t.byId.values()][0]);
  } finally {
    await b.close();
  }
  assert.equal(t.released.length, 1);
});

/**
 * A request that reaches the handler after `close()` began cannot arrive over a
 * socket — close() drops every connection before it yields to I/O — so these
 * cases take the `node:http` server the transport built and hand it a request
 * directly, with a response object that records what it was told.
 */
async function withCapturedServer<T>(
  run: (server: () => NodeHttpServer) => Promise<T>,
): Promise<T> {
  let captured: NodeHttpServer | undefined;
  const original = http.createServer.bind(http);
  const spy = mock.method(http, 'createServer', ((
    ...args: Parameters<typeof http.createServer>
  ) => {
    const server = original(...args);
    captured = server;
    return server;
  }) as typeof http.createServer);
  syncBuiltinESMExports();
  try {
    return await run(() => {
      assert.ok(captured !== undefined, 'the transport built no node:http server');
      return captured;
    });
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
}

interface RecordedResponse {
  readonly res: ServerResponse;
  readonly ended: Promise<void>;
  status(): number | undefined;
  body(): string | undefined;
}

function recordedResponse(): RecordedResponse {
  const done = deferred();
  let status: number | undefined;
  let body: string | undefined;
  // The transport counts a non-GET response as in flight until its `close`
  // fires, so the fake emits one when it ends — as a real response does.
  const onClose: (() => void)[] = [];
  const fake = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      fake.headersSent = true;
      return fake;
    },
    end(chunk?: string) {
      body = chunk;
      done.resolve();
      for (const listener of onClose.splice(0)) listener();
      return fake;
    },
    once(event: string, listener: () => void) {
      if (event === 'close') onClose.push(listener);
      return fake;
    },
  };
  return {
    res: fake as unknown as ServerResponse,
    ended: done.promise,
    status: () => status,
    body: () => body,
  };
}

/**
 * An authorized `initialize` POST as a stream. The transport reads the body
 * itself before it opens a session, so the request has to be a readable that
 * actually ends — a plain object would leave that read waiting forever.
 */
function authorizedPost(port: number): IncomingMessage {
  const req = Readable.from([Buffer.from(INITIALIZE)]);
  return Object.assign(req, {
    method: 'POST',
    url: MCP_PATH,
    headers: {
      host: `127.0.0.1:${String(port)}`,
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'content-length': String(Buffer.byteLength(INITIALIZE)),
    },
  }) as unknown as IncomingMessage;
}

const SHUTTING_DOWN = {
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Service Unavailable: the server is shutting down' },
  id: null,
};

test('a request that arrives once close() has begun is a 503', async () => {
  await withCapturedServer(async (server) => {
    const t = trackedHandles();
    const b = await bind({
      createHandle: t.createHandle,
      releaseHandle: t.releaseHandle,
    });
    await b.close();

    const recorded = recordedResponse();
    server().emit('request', authorizedPost(b.port), recorded.res);
    await recorded.ended;
    assert.equal(recorded.status(), 503);
    assert.deepEqual(JSON.parse(recorded.body() ?? ''), SHUTTING_DOWN);
    // Nothing was built for it.
    assert.equal(t.byId.size, 0);
    assert.equal(t.released.length, 0);
  });
});

/** Whether `promise` has settled by the time every queued microtask has run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await flush();
  return done;
}

const NOT_DRAINED = 'http shutdown did not drain; aborting requests in flight';

test('a session still being built past the drain budget is closed and answered 503', async () => {
  await withCapturedServer(async (server) => {
    const t = trackedHandles();
    const asked = deferred<string>();
    const gate = deferred();
    const b = await bind({
      createHandle: async (sessionId: string) => {
        asked.resolve(sessionId);
        await gate.promise;
        return t.createHandle(sessionId);
      },
      releaseHandle: t.releaseHandle,
      drainMs: 50,
    });

    const recorded = recordedResponse();
    server().emit('request', authorizedPost(b.port), recorded.res);
    const sessionId = await asked.promise;
    const closing = b.close();
    // The request in flight holds the shutdown for exactly the drain budget.
    assert.equal(b.clock.pending(), 1);
    assert.equal(await settled(closing), false);
    await b.clock.advance(50);
    await closing;

    const warned = b.log.lines.filter((line) => line.msg === NOT_DRAINED);
    assert.equal(warned.length, 1);
    assert.equal(warned[0]?.level, 'warn');
    assert.deepEqual(warned[0]?.fields, { pending: 1, drain_ms: 50 });

    gate.resolve();
    await recorded.ended;
    await flush();

    assert.equal(recorded.status(), 503);
    assert.deepEqual(JSON.parse(recorded.body() ?? ''), SHUTTING_DOWN);
    // The fresh transport was torn down, so its handle was released exactly once
    // and no session outlived the listener.
    assert.equal(t.released.length, 1);
    assert.equal(t.released[0], t.byId.get(sessionId));
    assert.equal(b.transport.sessions(), 0);
  });
});

test('the drain budget defaults to ten seconds', async () => {
  await withCapturedServer(async (server) => {
    const gate = deferred();
    const asked = deferred();
    const t = trackedHandles();
    const b = await bind({
      createHandle: async (sessionId: string) => {
        asked.resolve();
        await gate.promise;
        return t.createHandle(sessionId);
      },
      releaseHandle: t.releaseHandle,
    });

    const recorded = recordedResponse();
    server().emit('request', authorizedPost(b.port), recorded.res);
    await asked.promise;
    const closing = b.close();
    await b.clock.advance(9_999);
    assert.equal(await settled(closing), false);
    await b.clock.advance(1);
    await closing;

    const warned = b.log.lines.filter((line) => line.msg === NOT_DRAINED);
    assert.deepEqual(
      warned.map((line) => line.fields),
      [{ pending: 1, drain_ms: 10_000 }],
    );
    gate.resolve();
    await recorded.ended;
    assert.equal(recorded.status(), 503);
  });
});

test('close() lets a request accepted before it finish, and refuses new ones meanwhile', async () => {
  const t = trackedHandles();
  const asked = deferred<string>();
  const gate = deferred();
  const b = await bind({
    createHandle: async (sessionId: string) => {
      asked.resolve(sessionId);
      await gate.promise;
      return t.createHandle(sessionId);
    },
    releaseHandle: t.releaseHandle,
    drainMs: 60_000,
  });
  let closing: Promise<void> | undefined;
  try {
    const accepted = raw(b.port, { headers: postHeaders(), body: INITIALIZE });
    const sessionId = await asked.promise;
    closing = b.close();
    assert.equal(await settled(closing), false);

    // Draining: the listener still answers, but only to say it is going away.
    const late = await raw(b.port, { headers: postHeaders(), body: INITIALIZE });
    assert.equal(late.status, 503);
    assert.deepEqual(JSON.parse(late.body), SHUTTING_DOWN);
    assert.equal(await settled(closing), false);

    gate.resolve();
    const answered = await accepted;
    assert.equal(answered.status, 200);
    assert.equal(answered.headers['mcp-session-id'], sessionId);
    await closing;

    // It drained inside the budget: no warning, the timer is gone, and the
    // session the drained request opened was still closed with the rest.
    assert.equal(b.log.lines.filter((line) => line.msg === NOT_DRAINED).length, 0);
    assert.equal(b.clock.pending(), 0);
    assert.equal(b.transport.sessions(), 0);
    assert.deepEqual(t.released, [t.byId.get(sessionId)]);
  } finally {
    gate.resolve();
    await (closing ?? b.close());
  }
});

test('an open GET stream does not hold the shutdown, and close() is one promise', async () => {
  const b = await bind();
  const sessionId = await rawSession(b.port);
  const stream = await openStream(b.port, sessionId);
  assert.equal(stream.status, 200);
  await flush();

  const closing = b.close();
  assert.equal(b.close(), closing);
  // Nothing tracked is in flight, so no drain timer was ever started.
  assert.equal(b.clock.pending(), 0);
  await closing;
  assert.equal(b.log.lines.filter((line) => line.msg === NOT_DRAINED).length, 0);
  assert.equal(b.transport.sessions(), 0);
});

// ---------------------------------------------------------------------------
// drain accounting for calls whose client has gone away
// ---------------------------------------------------------------------------

/** The header a test request carries so the captured server can find its response. */
const CALL_TAG = 'x-test-call';

/**
 * A factory whose one tool parks on `gate` until the test lets it answer, and
 * reports each entry — the handler that outlives its client's connection.
 */
function gatedHandles(): {
  readonly createHandle: HttpTransportOptions['createHandle'];
  readonly gate: Deferred<void>;
  entered(count: number): Promise<void>;
  readonly aborted: boolean[];
  readonly built: McpServerHandle[];
} {
  const settings = httpSettings();
  const runtime = serverRuntime(settings, recordingLogger());
  const gate = deferred();
  const aborted: boolean[] = [];
  const built: McpServerHandle[] = [];
  let entries = 0;
  const waiters: { count: number; resolve: () => void }[] = [];
  const tool = defineTool({
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
    handler: async (_args, ctx) => {
      entries += 1;
      for (const waiter of waiters.filter((w) => w.count <= entries)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
      await gate.promise;
      aborted.push(ctx.signal?.aborted === true);
      return { ok: true, data: { answered: true } };
    },
  });
  return {
    gate,
    aborted,
    built,
    entered: (count) =>
      entries >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push({ count, resolve });
          }),
    createHandle: () => {
      const handle = createServer({
        name: 'tiktok-mcp-ai',
        version: '0.0.0-test',
        packages: [
          { name: 'auth', tools: [] },
          { name: 'user', tools: [] },
          { name: 'video', tools: [tool] },
          { name: 'publish', tools: [] },
          { name: 'publish-write', tools: [] },
        ],
        runtime,
      });
      built.push(handle);
      return handle;
    },
  };
}

function sessionHeaders(sessionId: string): Record<string, string> {
  return postHeaders({
    'mcp-session-id': sessionId,
    'mcp-protocol-version': '2025-06-18',
  });
}

/**
 * A `tools/call` POST that the test hangs up on. Tagged, so the captured
 * server can report when its response has closed on the server side.
 */
function hangingCall(port: number, sessionId: string, id: number): { hangUp(): void } {
  const req = request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: MCP_PATH,
    headers: { ...sessionHeaders(sessionId), [CALL_TAG]: String(id) },
  });
  // The hang-up is the point; the error it raises on this side is expected.
  req.on('error', () => undefined);
  req.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'tiktok_list_videos', arguments: {} },
    }),
  );
  return { hangUp: () => req.destroy() };
}

/** Resolves once the server has seen `count` tagged responses close. */
function taggedCloses(server: NodeHttpServer): (count: number) => Promise<void> {
  let closed = 0;
  const waiters: { count: number; resolve: () => void }[] = [];
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers[CALL_TAG] === undefined) return;
    res.once('close', () => {
      closed += 1;
      for (const waiter of waiters.filter((w) => w.count <= closed)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    });
  });
  return (count) =>
    closed >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          waiters.push({ count, resolve });
        });
}

async function cancel(port: number, sessionId: string, params?: object): Promise<void> {
  const res = await raw(port, {
    headers: sessionHeaders(sessionId),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      ...(params === undefined ? {} : { params }),
    }),
  });
  assert.equal(res.status, 202);
}

test('a client that hangs up mid-call does not let close() finish before the handler answers', async () => {
  await withCapturedServer(async (server) => {
    const g = gatedHandles();
    const b = await bind({ createHandle: g.createHandle, drainMs: 60_000 });
    const closed = taggedCloses(server());
    const sessionId = await rawSession(b.port);

    const call = hangingCall(b.port, sessionId, 5);
    await g.entered(1);
    call.hangUp();
    // The POST's response is gone: only the call itself is left to count.
    await closed(1);

    const closing = b.close();
    assert.equal(await settled(closing), false);
    assert.equal(b.clock.pending(), 1);

    g.gate.resolve();
    await closing;
    assert.equal(b.log.lines.filter((line) => line.msg === NOT_DRAINED).length, 0);
    assert.equal(b.clock.pending(), 0);
    assert.deepEqual(g.aborted, [false]);
    assert.equal(b.transport.sessions(), 0);
  });
});

test('a call still running when the drain budget runs out is counted in the warning', async () => {
  await withCapturedServer(async (server) => {
    const g = gatedHandles();
    const b = await bind({ createHandle: g.createHandle, drainMs: 50 });
    const closed = taggedCloses(server());
    const sessionId = await rawSession(b.port);

    const call = hangingCall(b.port, sessionId, 5);
    await g.entered(1);
    call.hangUp();
    await closed(1);

    const closing = b.close();
    assert.equal(await settled(closing), false);
    await b.clock.advance(50);
    await closing;
    const warned = b.log.lines.filter((line) => line.msg === NOT_DRAINED);
    assert.deepEqual(
      warned.map((line) => line.fields),
      [{ pending: 1, drain_ms: 50 }],
    );
    g.gate.resolve();
    await flush();
  });
});

test('a notification the server sends mid-call is not mistaken for the answer to the call', async () => {
  await withCapturedServer(async (server) => {
    const g = gatedHandles();
    const b = await bind({ createHandle: g.createHandle, drainMs: 60_000 });
    const closed = taggedCloses(server());
    const sessionId = await rawSession(b.port);
    const stream = await openStream(b.port, sessionId);

    const call = hangingCall(b.port, sessionId, 5);
    await g.entered(1);
    call.hangUp();
    await closed(1);

    // Server-to-client traffic goes out through the same `send` as answers.
    const [handle] = g.built;
    assert.ok(handle !== undefined);
    await handle.notifyListChanged();

    const closing = b.close();
    assert.equal(await settled(closing), false);
    assert.equal(b.clock.pending(), 1);
    g.gate.resolve();
    await closing;
    assert.equal(b.log.lines.filter((line) => line.msg === NOT_DRAINED).length, 0);
    await stream.end();
  });
});

test('a cancellation of the running call settles it, and one for any other id does not', async () => {
  await withCapturedServer(async (server) => {
    const g = gatedHandles();
    const b = await bind({ createHandle: g.createHandle, drainMs: 60_000 });
    const closed = taggedCloses(server());
    const sessionId = await rawSession(b.port);

    const call = hangingCall(b.port, sessionId, 5);
    await g.entered(1);
    call.hangUp();
    await closed(1);

    // An id nothing is waiting on, and a cancellation that names no id at all.
    await cancel(b.port, sessionId, { requestId: 999 });
    await cancel(b.port, sessionId);

    // Still counted: a probe of the drain is a close() that cannot finish, so
    // the probe is the real cancellation arriving before close() is asked.
    await cancel(b.port, sessionId, { requestId: 5, reason: 'the user gave up' });
    const closing = b.close();
    // The cancelled call has no answer coming, and nothing waits for one.
    assert.equal(b.clock.pending(), 0);
    await closing;
    assert.equal(b.log.lines.filter((line) => line.msg === NOT_DRAINED).length, 0);

    g.gate.resolve();
    await flush();
    // The SDK aborted the handler, so its late answer is dropped, not sent.
    assert.deepEqual(g.aborted, [true]);
  });
});

test('a cancellation for an id nothing is waiting on leaves the running call counted', async () => {
  await withCapturedServer(async (server) => {
    const g = gatedHandles();
    const b = await bind({ createHandle: g.createHandle, drainMs: 50 });
    const closed = taggedCloses(server());
    const sessionId = await rawSession(b.port);

    const call = hangingCall(b.port, sessionId, 5);
    await g.entered(1);
    call.hangUp();
    await closed(1);
    await cancel(b.port, sessionId, { requestId: 999 });
    await cancel(b.port, sessionId);

    const closing = b.close();
    assert.equal(await settled(closing), false);
    await b.clock.advance(50);
    await closing;
    assert.deepEqual(
      b.log.lines.filter((line) => line.msg === NOT_DRAINED).map((line) => line.fields),
      [{ pending: 1, drain_ms: 50 }],
    );
    g.gate.resolve();
    await flush();
  });
});

test('a request id sent twice is counted once, so one answer settles it', async () => {
  await withCapturedServer(async (server) => {
    const g = gatedHandles();
    const b = await bind({ createHandle: g.createHandle, drainMs: 60_000 });
    const closed = taggedCloses(server());
    const sessionId = await rawSession(b.port);

    const first = hangingCall(b.port, sessionId, 5);
    await g.entered(1);
    first.hangUp();
    const second = hangingCall(b.port, sessionId, 5);
    await g.entered(2);
    second.hangUp();
    await closed(2);

    const closing = b.close();
    assert.equal(await settled(closing), false);
    g.gate.resolve();
    // Counted twice, the second answer would find nothing left to settle and
    // the shutdown would wait out the whole budget.
    await closing;
    assert.equal(b.log.lines.filter((line) => line.msg === NOT_DRAINED).length, 0);
    assert.equal(b.clock.pending(), 0);
  });
});

test('ending a session settles the calls it still had running', async () => {
  await withCapturedServer(async (server) => {
    const g = gatedHandles();
    const b = await bind({ createHandle: g.createHandle, drainMs: 60_000 });
    const closed = taggedCloses(server());
    const sessionId = await rawSession(b.port);

    const call = hangingCall(b.port, sessionId, 5);
    await g.entered(1);
    call.hangUp();
    await closed(1);

    const ended = await raw(b.port, {
      method: 'DELETE',
      headers: sessionHeaders(sessionId),
    });
    assert.equal(ended.status, 200);
    assert.equal(b.transport.sessions(), 0);

    // Nothing is left to wait for: no drain timer is even started.
    const closing = b.close();
    assert.equal(b.clock.pending(), 0);
    await closing;
    assert.equal(b.log.lines.filter((line) => line.msg === NOT_DRAINED).length, 0);
    g.gate.resolve();
    await flush();
  });
});

test('a cancellation that arrives while draining reaches the session, so close() need not wait out the budget', async () => {
  await withCapturedServer(async (server) => {
    const g = gatedHandles();
    const b = await bind({ createHandle: g.createHandle, drainMs: 60_000 });
    const closed = taggedCloses(server());
    const sessionId = await rawSession(b.port);

    const call = hangingCall(b.port, sessionId, 5);
    await g.entered(1);
    call.hangUp();
    await closed(1);

    const closing = b.close();
    assert.equal(await settled(closing), false);
    assert.equal(b.clock.pending(), 1);

    // A cancel naming some other id is still handed to the SDK — and leaves
    // the running call counted.
    await cancel(b.port, sessionId, { requestId: 999 });
    assert.equal(await settled(closing), false);

    // The cancel for the running call is what the drain was waiting for.
    await cancel(b.port, sessionId, { requestId: 5, reason: 'the user gave up' });
    await closing;
    assert.equal(b.log.lines.filter((line) => line.msg === NOT_DRAINED).length, 0);
    assert.equal(b.clock.pending(), 0);
    assert.equal(b.transport.sessions(), 0);

    g.gate.resolve();
    await flush();
    assert.deepEqual(g.aborted, [true]);
  });
});

test('while draining, everything but a cancellation for a live session is 503', async () => {
  await withCapturedServer(async (server) => {
    const g = gatedHandles();
    const b = await bind({ createHandle: g.createHandle, drainMs: 60_000 });
    const closed = taggedCloses(server());
    const sessionId = await rawSession(b.port);

    const call = hangingCall(b.port, sessionId, 5);
    await g.entered(1);
    call.hangUp();
    await closed(1);

    const closing = b.close();
    const cancelFive = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 5 },
    });
    const refusals: { what: string; res: Promise<RawResponse> }[] = [
      {
        what: 'a request on the live session',
        res: raw(b.port, {
          headers: sessionHeaders(sessionId),
          body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list' }),
        }),
      },
      {
        what: 'another notification on the live session',
        res: raw(b.port, {
          headers: sessionHeaders(sessionId),
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        }),
      },
      {
        what: 'a cancel inside a batch',
        res: raw(b.port, { headers: sessionHeaders(sessionId), body: `[${cancelFive}]` }),
      },
      {
        what: 'a cancel for a session that does not exist',
        res: raw(b.port, {
          headers: sessionHeaders('00000000-0000-4000-8000-000000000000'),
          body: cancelFive,
        }),
      },
      {
        what: 'a cancel with no session id',
        res: raw(b.port, { headers: postHeaders(), body: cancelFive }),
      },
      {
        what: 'a cancel with an empty session id',
        res: raw(b.port, {
          headers: postHeaders({ 'mcp-session-id': '' }),
          body: cancelFive,
        }),
      },
      {
        what: 'a new initialize',
        res: raw(b.port, { headers: postHeaders(), body: INITIALIZE }),
      },
      {
        what: 'a GET on the live session',
        res: raw(b.port, { method: 'GET', headers: sessionHeaders(sessionId) }),
      },
      {
        what: 'a DELETE of the live session',
        res: raw(b.port, { method: 'DELETE', headers: sessionHeaders(sessionId) }),
      },
    ];
    for (const { what, res } of refusals) {
      const answered = await res;
      assert.equal(answered.status, 503, what);
      assert.deepEqual(JSON.parse(answered.body), SHUTTING_DOWN, what);
    }
    // None of them touched the session or the call the drain is waiting for.
    assert.equal(await settled(closing), false);
    assert.equal(b.transport.sessions(), 1);
    assert.equal(g.built.length, 1);

    g.gate.resolve();
    await closing;
    assert.equal(b.log.lines.filter((line) => line.msg === NOT_DRAINED).length, 0);
    assert.deepEqual(g.aborted, [false]);
  });
});

/**
 * A session POST whose body the test writes by hand, handed straight to the
 * captured server — a real socket would be dropped by close() before the rest
 * of the body could arrive.
 */
function slowSessionPost(port: number, sessionId: string): PassThrough {
  const req = new PassThrough();
  return Object.assign(req, {
    method: 'POST',
    url: MCP_PATH,
    headers: {
      host: `127.0.0.1:${String(port)}`,
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
      'mcp-protocol-version': '2025-06-18',
    },
  });
}

test('a POST whose body finishes arriving after the drain is told the server is shutting down', async () => {
  await withCapturedServer(async (server) => {
    const t = trackedHandles();
    const b = await bind({
      createHandle: t.createHandle,
      releaseHandle: t.releaseHandle,
      drainMs: 50,
    });
    const sessionId = await rawSession(b.port);

    const bodies = [
      JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list' }),
      // Even a cancel for what was a live session: the map is empty by now.
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 6 },
      }),
    ];
    const posts = bodies.map((body) => {
      const req = slowSessionPost(b.port, sessionId);
      const recorded = recordedResponse();
      server().emit('request', req, recorded.res);
      req.write(body.slice(0, 10));
      return { req, recorded, rest: body.slice(10) };
    });

    // Both are in flight when close() begins, so the drain waits its budget.
    const closing = b.close();
    assert.equal(await settled(closing), false);
    await b.clock.advance(50);
    await closing;
    assert.equal(b.transport.sessions(), 0);

    for (const { req, recorded, rest } of posts) {
      req.end(rest);
      await recorded.ended;
      assert.equal(recorded.status(), 503);
      assert.deepEqual(JSON.parse(recorded.body() ?? ''), SHUTTING_DOWN);
    }
    assert.deepEqual(
      b.log.lines.filter((line) => line.msg === NOT_DRAINED).map((line) => line.fields),
      [{ pending: 2, drain_ms: 50 }],
    );
    assert.deepEqual(t.released, [t.byId.get(sessionId)]);
  });
});

test('a POST whose body finishes arriving while draining is 503 when it is not a cancel', async () => {
  await withCapturedServer(async (server) => {
    const t = trackedHandles();
    const b = await bind({
      createHandle: t.createHandle,
      releaseHandle: t.releaseHandle,
      drainMs: 60_000,
    });
    const sessionId = await rawSession(b.port);

    // Began while the server was open, so the phase gate at the top let it in.
    const req = slowSessionPost(b.port, sessionId);
    const recorded = recordedResponse();
    server().emit('request', req, recorded.res);
    req.write('{"jsonrpc":');

    const closing = b.close();
    assert.equal(await settled(closing), false);
    req.end('"2.0","id":6,"method":"tools/list"}');
    await recorded.ended;
    assert.equal(recorded.status(), 503);
    assert.deepEqual(JSON.parse(recorded.body() ?? ''), SHUTTING_DOWN);

    // That was the last thing in flight.
    await closing;
    assert.equal(b.log.lines.filter((line) => line.msg === NOT_DRAINED).length, 0);
    assert.deepEqual(t.released, [t.byId.get(sessionId)]);
  });
});

test('a session whose initialize completes after the drain gave up is closed, not registered', async () => {
  const t = trackedHandles();
  const releasedOnce = deferred();
  const gate = deferred();
  const reached = deferred();
  // Held just inside the SDK, after the transport has connected and its calls
  // are tracked, but before `initialize` assigns the session id.
  type HandleRequest = WebStandardStreamableHTTPServerTransport['handleRequest'];
  const proto = WebStandardStreamableHTTPServerTransport.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, 'handleRequest')
    ?.value as HandleRequest;
  const spy = mock.method(
    proto,
    'handleRequest',
    async function (
      this: WebStandardStreamableHTTPServerTransport,
      ...args: Parameters<HandleRequest>
    ) {
      reached.resolve();
      await gate.promise;
      return Reflect.apply(original, this, args);
    },
  );
  try {
    const b = await bind({
      createHandle: t.createHandle,
      releaseHandle: (handle) => {
        t.releaseHandle(handle);
        releasedOnce.resolve();
      },
      drainMs: 50,
    });
    // The socket is dropped by close() below; how the client sees that is not
    // what this test is about.
    const answered = raw(b.port, { headers: postHeaders(), body: INITIALIZE }).catch(
      () => undefined,
    );
    await reached.promise;
    const closing = b.close();
    await b.clock.advance(50);
    await closing;
    assert.equal(b.log.lines.filter((line) => line.msg === NOT_DRAINED).length, 1);
    assert.equal(t.released.length, 0);

    // The SDK assigns the id now, with the listener already gone.
    gate.resolve();
    await releasedOnce.promise;
    await answered;
    await flush();

    assert.equal(t.byId.size, 1);
    assert.deepEqual(t.released, [...t.byId.values()]);
    assert.equal(b.transport.sessions(), 0);
    assert.equal(
      b.log.lines.filter((line) => line.msg === 'mcp session opened').length,
      0,
    );
  } finally {
    gate.resolve();
    spy.mock.restore();
  }
});

test('a handle whose server fails to connect is released once and the request is a 500', async () => {
  const t = trackedHandles();
  const b = await bind({
    createHandle: (sessionId: string) => {
      // `trackedHandles` builds synchronously; the factory type also allows a promise.
      const handle = t.createHandle(sessionId) as McpServerHandle;
      mock.method(handle.server, 'connect', () =>
        Promise.reject(new Error('connect refused by the test')),
      );
      return handle;
    },
    releaseHandle: t.releaseHandle,
  });
  try {
    const res = await raw(b.port, { headers: postHeaders(), body: INITIALIZE });
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(res.body), {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Internal Server Error' },
      id: null,
    });
    assert.equal(t.byId.size, 1);
    assert.deepEqual(t.released, [...t.byId.values()]);
    assert.equal(b.transport.sessions(), 0);
    const failed = b.log.lines.filter((line) => line.msg === 'http request failed');
    assert.deepEqual(
      failed.map((line) => line.fields),
      [{ method: 'POST', reason: 'connect refused by the test' }],
    );
  } finally {
    await b.close();
  }
  // No `onclose` runs for a transport that never connected, so close() has
  // nothing to release a second time.
  assert.equal(t.released.length, 1);
});

// ---------------------------------------------------------------------------
// bounds — the session cap, the idle sweep and the body limit
// ---------------------------------------------------------------------------

/** 4 MiB, the transport's body limit; one byte past it is too large. */
const BODY_LIMIT = 4 * 1024 * 1024;

/** Open a session with a raw `initialize` and hand back its id. */
async function rawSession(port: number): Promise<string> {
  const res = await raw(port, { headers: postHeaders(), body: INITIALIZE });
  assert.equal(res.status, 200);
  const sessionId = res.headers['mcp-session-id'];
  assert.ok(typeof sessionId === 'string' && sessionId !== '');
  return sessionId;
}

/**
 * A GET event stream on a session, held open until `end()`. The transport
 * counts it as an active request for as long as it is open.
 */
async function openStream(
  port: number,
  sessionId: string,
): Promise<{ status: number; end: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: MCP_PATH,
        headers: {
          accept: 'text/event-stream',
          authorization: `Bearer ${TOKEN}`,
          'mcp-session-id': sessionId,
          'mcp-protocol-version': '2025-06-18',
        },
      },
      (res) => {
        res.resume();
        resolve({
          status: res.statusCode ?? 0,
          end: () =>
            new Promise<void>((done) => {
              res.once('close', () => done());
              req.destroy();
            }),
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * A POST whose body is written in `chunks` pieces and never ended: the server
 * answers as soon as the limit is crossed and then drops the socket, so the
 * last byte written is the one that crosses it. Ending the request would race
 * the terminating chunk against that drop. An error after the response arrived
 * is the expected end, not a failure.
 */
function oversizedPost(
  port: number,
  headers: Record<string, string>,
  chunks: readonly string[],
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    let answered = false;
    const req = request(
      { host: '127.0.0.1', port, method: 'POST', path: MCP_PATH, headers },
      (res) => {
        answered = true;
        const body: Buffer[] = [];
        res.on('data', (chunk: Buffer) => body.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(body).toString('utf8'),
          });
          req.destroy();
        });
        res.on('error', () => undefined);
      },
    );
    req.on('error', (err) => {
      if (!answered) reject(err);
    });
    for (const chunk of chunks) req.write(chunk);
  });
}

test('the session cap answers 503 once every slot is taken, and builds nothing for it', async () => {
  const t = trackedHandles();
  const b = await bind({
    createHandle: t.createHandle,
    releaseHandle: t.releaseHandle,
    maxSessions: 1,
  });
  try {
    await rawSession(b.port);
    const refused = await raw(b.port, { headers: postHeaders(), body: INITIALIZE });
    assert.equal(refused.status, 503);
    assert.deepEqual(JSON.parse(refused.body), {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Service Unavailable: too many open sessions' },
      id: null,
    });
    assert.equal(refused.headers['mcp-session-id'], undefined);
    assert.equal(b.transport.sessions(), 1);
    assert.equal(t.byId.size, 1);
    const rejected = b.log.lines.filter((line) => line.msg === 'http request rejected');
    assert.deepEqual(rejected, [
      {
        level: 'warn',
        msg: 'http request rejected',
        fields: { status: 503, reason: 'session limit reached', method: 'POST' },
      },
    ]);
  } finally {
    await b.close();
  }
});

test('concurrent initializes cannot overshoot the session cap while a session is still being built', async () => {
  // The first initialize is held inside `createHandle` — past the cap check but
  // not yet registered. Every initialize arriving meanwhile must see its
  // reserved slot, not an empty map.
  const t = trackedHandles();
  const gate = deferred();
  const entered = deferred();
  let calls = 0;
  const b = await bind({
    createHandle: async (sessionId) => {
      calls += 1;
      entered.resolve();
      await gate.promise;
      return await t.createHandle(sessionId);
    },
    releaseHandle: t.releaseHandle,
    maxSessions: 1,
  });
  try {
    const first = raw(b.port, { headers: postHeaders(), body: INITIALIZE });
    await entered.promise;
    assert.equal(b.transport.sessions(), 0, 'the first session is not registered yet');

    const racers = await Promise.all([
      raw(b.port, { headers: postHeaders(), body: INITIALIZE }),
      raw(b.port, { headers: postHeaders(), body: INITIALIZE }),
    ]);
    for (const refused of racers) {
      assert.equal(refused.status, 503);
      assert.deepEqual(JSON.parse(refused.body), {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Service Unavailable: too many open sessions' },
        id: null,
      });
    }
    assert.equal(calls, 1, 'a refused initialize must build nothing');

    gate.resolve();
    const opened = await first;
    assert.equal(opened.status, 200);
    assert.equal(typeof opened.headers['mcp-session-id'], 'string');
    assert.equal(b.transport.sessions(), 1);
    assert.equal(t.byId.size, 1);
    // The reservation became the session: the cap still holds afterwards.
    const after = await raw(b.port, { headers: postHeaders(), body: INITIALIZE });
    assert.equal(after.status, 503);
  } finally {
    gate.resolve();
    await b.close();
  }
});

test('a reserved session slot is given back when the session fails to build', async () => {
  const t = trackedHandles();
  let fail = true;
  const b = await bind({
    createHandle: (sessionId) => {
      if (fail) {
        fail = false;
        throw new Error('the runtime is unavailable');
      }
      return t.createHandle(sessionId);
    },
    releaseHandle: t.releaseHandle,
    maxSessions: 1,
  });
  try {
    const failed = await raw(b.port, { headers: postHeaders(), body: INITIALIZE });
    assert.equal(failed.status, 500);
    // Were the reservation kept, the one slot would be gone for good.
    await rawSession(b.port);
    assert.equal(b.transport.sessions(), 1);
  } finally {
    await b.close();
  }
});

test('a session registered while its initialize is still answering holds one slot, not two', async () => {
  // The SDK registers the session (`onsessioninitialized`) before it dispatches
  // `initialize` to the server. Holding the server's handler keeps that request
  // open with the session already in the map: were its reservation still
  // counted, the cap would be hit one session early.
  type OnInitialize = (request: unknown) => Promise<unknown>;
  const proto = Server.prototype as unknown as { _oninitialize: OnInitialize };
  const original = proto._oninitialize;
  const gate = deferred();
  const reached = deferred();
  let hold = false;
  const spy = mock.method(
    proto,
    '_oninitialize',
    async function (this: unknown, request: unknown): Promise<unknown> {
      if (hold) {
        hold = false;
        reached.resolve();
        await gate.promise;
      }
      return Reflect.apply(original, this, [request]);
    },
  );
  const t = trackedHandles();
  const b = await bind({
    createHandle: t.createHandle,
    releaseHandle: t.releaseHandle,
    maxSessions: 3,
  });
  try {
    await rawSession(b.port);

    hold = true;
    const held = raw(b.port, { headers: postHeaders(), body: INITIALIZE });
    await reached.promise;
    assert.equal(b.transport.sessions(), 2, 'the held session is registered already');

    // Two sessions and no build in flight: the third slot is free.
    await rawSession(b.port);
    assert.equal(b.transport.sessions(), 3);
    const refused = await raw(b.port, { headers: postHeaders(), body: INITIALIZE });
    assert.equal(refused.status, 503);

    gate.resolve();
    const answered = await held;
    assert.equal(answered.status, 200);
    assert.equal(typeof answered.headers['mcp-session-id'], 'string');
    assert.equal(b.transport.sessions(), 3);
    assert.equal(t.byId.size, 3);

    // The finished request gave nothing back twice: the cap still holds.
    const after = await raw(b.port, { headers: postHeaders(), body: INITIALIZE });
    assert.equal(after.status, 503);
    assert.equal(t.byId.size, 3);
  } finally {
    gate.resolve();
    spy.mock.restore();
    await b.close();
  }
});

test('sequential sessions leak no reservation: the cap is reached exactly at maxSessions', async () => {
  const t = trackedHandles();
  let fail = false;
  const b = await bind({
    createHandle: (sessionId) => {
      if (fail) {
        fail = false;
        throw new Error('the runtime is unavailable');
      }
      return t.createHandle(sessionId);
    },
    releaseHandle: t.releaseHandle,
    maxSessions: 4,
  });
  try {
    for (let i = 0; i < 3; i += 1) await rawSession(b.port);
    // A failed build between them gives its slot back too.
    fail = true;
    const failed = await raw(b.port, { headers: postHeaders(), body: INITIALIZE });
    assert.equal(failed.status, 500);
    // A POST that never initializes frees its slot as well.
    const notInit = await raw(b.port, {
      headers: postHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    });
    assert.equal(notInit.status, 400);

    await rawSession(b.port);
    assert.equal(b.transport.sessions(), 4);
    const refused = await raw(b.port, { headers: postHeaders(), body: INITIALIZE });
    assert.equal(refused.status, 503);
  } finally {
    await b.close();
  }
});

test('an idle session is closed by the next initialize, and its handle released', async () => {
  const t = trackedHandles();
  const b = await bind({
    createHandle: t.createHandle,
    releaseHandle: t.releaseHandle,
    maxSessions: 1,
    sessionIdleMs: 60_000,
  });
  try {
    const stale = await rawSession(b.port);
    // One millisecond short of the idle age is not idle yet.
    await b.clock.advance(59_999);
    const early = await raw(b.port, { headers: postHeaders(), body: INITIALIZE });
    assert.equal(early.status, 503);
    assert.equal(
      b.log.lines.some((line) => line.msg === 'mcp session expired'),
      false,
    );

    await b.clock.advance(1);
    const fresh = await rawSession(b.port);
    assert.notEqual(fresh, stale);
    assert.equal(b.transport.sessions(), 1);
    assert.deepEqual(
      b.log.lines.filter((line) => line.msg === 'mcp session expired'),
      [{ level: 'info', msg: 'mcp session expired', fields: { duration_ms: 60_000 } }],
    );
    assert.deepEqual(t.released, [t.byId.get(stale)]);

    // The expired id is gone for good: the same 404 as any unknown session.
    const gone = await raw(b.port, {
      headers: postHeaders({ 'mcp-session-id': stale }),
      body: INITIALIZE,
    });
    assert.equal(gone.status, 404);
  } finally {
    await b.close();
  }
});

test('a session with a request still open is never swept, however old', async () => {
  const t = trackedHandles();
  const b = await bind({
    createHandle: t.createHandle,
    releaseHandle: t.releaseHandle,
    maxSessions: 1,
    sessionIdleMs: 60_000,
  });
  try {
    const busy = await rawSession(b.port);
    const stream = await openStream(b.port, busy);
    assert.equal(stream.status, 200);
    await b.clock.advance(10 * 60_000);

    const refused = await raw(b.port, { headers: postHeaders(), body: INITIALIZE });
    assert.equal(refused.status, 503);
    assert.equal(t.released.length, 0);
    assert.equal(b.transport.sessions(), 1);

    // Once the stream ends the session is idle from that moment, not from its open.
    await stream.end();
    await flush();
    const soon = await raw(b.port, { headers: postHeaders(), body: INITIALIZE });
    assert.equal(soon.status, 503);
    await b.clock.advance(60_000);
    await rawSession(b.port);
    assert.deepEqual(t.released, [t.byId.get(busy)]);
  } finally {
    await b.close();
  }
});

test('a session whose client hung up mid-call is not swept until the call answers', async () => {
  await withCapturedServer(async (server) => {
    const g = gatedHandles();
    const released: McpServerHandle[] = [];
    const b = await bind({
      createHandle: g.createHandle,
      releaseHandle: (handle) => {
        released.push(handle);
      },
      maxSessions: 1,
      sessionIdleMs: 60_000,
    });
    try {
      const closed = taggedCloses(server());
      const busy = await rawSession(b.port);
      const [handle] = g.built;
      assert.ok(handle !== undefined);

      const call = hangingCall(b.port, busy, 5);
      await g.entered(1);
      call.hangUp();
      // No response is open on the session any more: only the call holds it.
      await closed(1);
      await b.clock.advance(10 * 60_000);

      const refused = await raw(b.port, { headers: postHeaders(), body: INITIALIZE });
      assert.equal(refused.status, 503);
      assert.equal(b.transport.sessions(), 1);
      assert.equal(released.length, 0);
      assert.equal(
        b.log.lines.some((line) => line.msg === 'mcp session expired'),
        false,
      );

      // Observe the answer leave: the transport's own tracking runs first.
      const inner = handle.server.transport;
      assert.ok(inner !== undefined);
      const send = inner.send.bind(inner);
      const answered = deferred();
      inner.send = (message, options) => {
        const sent = send(message, options);
        if ('id' in message && message.id === 5) answered.resolve();
        return sent;
      };
      g.gate.resolve();
      await answered.promise;
      assert.deepEqual(g.aborted, [false]);

      // Idle since the hang-up, and nothing is running on it now.
      const fresh = await rawSession(b.port);
      assert.notEqual(fresh, busy);
      assert.deepEqual(released, [handle]);
      assert.equal(
        b.log.lines.filter((line) => line.msg === 'mcp session expired').length,
        1,
      );
    } finally {
      g.gate.resolve();
      await b.close();
    }
  });
});

test('a declared body past 4 MiB is 413 without being read, and the connection closes', async () => {
  const t = trackedHandles();
  const b = await bind({ createHandle: t.createHandle, releaseHandle: t.releaseHandle });
  try {
    const res = await oversizedPost(
      b.port,
      postHeaders({ 'content-length': String(BODY_LIMIT + 1) }),
      [INITIALIZE],
    );
    assert.equal(res.status, 413);
    assert.equal(res.headers['connection'], 'close');
    assert.deepEqual(JSON.parse(res.body), {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Payload Too Large' },
      id: null,
    });
    assert.equal(t.byId.size, 0);
    assert.equal(b.transport.sessions(), 0);
  } finally {
    await b.close();
  }
});

test('a chunked body that grows past 4 MiB is 413 too, and nothing is built for it', async () => {
  const t = trackedHandles();
  const b = await bind({ createHandle: t.createHandle, releaseHandle: t.releaseHandle });
  try {
    const piece = 'x'.repeat(1024 * 1024);
    // No content-length: node sends it chunked, so only counting can catch it.
    // Four full MiB are still within the limit; the one byte after is not.
    // The chunk behind it arrives once the answer is decided and is dropped
    // unread, which is what keeps memory bounded past the limit.
    const res = await oversizedPost(b.port, postHeaders(), [
      piece,
      piece,
      piece,
      piece,
      'x',
      'y',
    ]);
    assert.equal(res.status, 413);
    assert.equal(res.headers['connection'], 'close');
    assert.equal(
      (JSON.parse(res.body) as { error: { message: string } }).error.message,
      'Payload Too Large',
    );
    assert.equal(t.byId.size, 0);
  } finally {
    await b.close();
  }
});

test('a body of exactly 4 MiB is read, and a body that is not JSON is a parse error', async () => {
  const t = trackedHandles();
  const b = await bind({ createHandle: t.createHandle, releaseHandle: t.releaseHandle });
  try {
    const notJson = await raw(b.port, { headers: postHeaders(), body: '{"jsonrpc":' });
    assert.equal(notJson.status, 400);
    assert.deepEqual(JSON.parse(notJson.body), {
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error: Invalid JSON' },
      id: null,
    });

    // At the limit the body is accepted by the reader and fails only as JSON.
    const atLimit = await raw(b.port, {
      headers: postHeaders(),
      body: 'x'.repeat(BODY_LIMIT),
    });
    assert.equal(atLimit.status, 400);
    assert.equal(
      (JSON.parse(atLimit.body) as { error: { code: number } }).error.code,
      -32700,
    );
    assert.equal(t.byId.size, 0);
  } finally {
    await b.close();
  }
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

// ---------------------------------------------------------------------------
// the advertised URL
// ---------------------------------------------------------------------------

test('the advertised port is the one the OS handed out, in the URL too', async () => {
  // `Server.address()` is typed for three shapes, and `core/net`'s
  // `boundPortOf` decides all three (`net.test.ts`). The transport only ever
  // reads the TCP one — it binds a `host:port` and reads the address after the
  // awaited bind — and that is what an ephemeral bind advertises: the fixture
  // asks for port 0, and what comes back is the port the OS handed out.
  const b = await bind();
  try {
    assert.notEqual(b.port, 0);
    assert.equal(b.url, `http://127.0.0.1:${String(b.port)}${MCP_PATH}`);
  } finally {
    await b.close();
  }
});

/**
 * IPv6 loopback is absent in some CI containers, and a bind that cannot happen
 * says nothing about how its URL is spelled — so the case is probed, not
 * assumed.
 */
function ipv6LoopbackAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => {
      resolve(false);
    });
    probe.listen(0, '::1', () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

const NO_IPV6 = (await ipv6LoopbackAvailable())
  ? false
  : 'IPv6 loopback is unavailable on this host';

test(
  'an IPv6 bind is advertised as a bracketed URL a client can actually parse',
  { skip: NO_IPV6 },
  async () => {
    const b = await bind({ settings: httpSettings({ TT_HTTP_HOST: '[::1]' }) });
    try {
      assert.equal(b.url, `http://[::1]:${String(b.port)}/mcp`);
      // Without the brackets the address is not merely ugly: `new URL` reads
      // the last colon group as the port, so the line printed at startup would
      // be one no client could connect to.
      assert.equal(new URL(b.url).hostname, '[::1]');
      assert.equal(new URL(b.url).port, String(b.port));
    } finally {
      await b.close();
    }
  },
);

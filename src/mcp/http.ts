/**
 * The Streamable HTTP transport (CC-G6, SECURITY.md § Transport,
 * CONFIGURATION.md § Transport).
 *
 * stdio is the default because it opens no listening socket at all. This module
 * exists for the deployments that need one, and nearly every line of it is
 * about the two ways such a socket is abused:
 *
 * 1. **An unauthenticated caller.** `TT_HTTP_TOKEN` is required whenever
 *    `TT_TRANSPORT=http`, loopback included (SYN-31): `core/settings` refuses
 *    the startup without it, and {@link startHttpTransport} refuses again
 *    rather than trust that its caller validated the configuration — the second
 *    check costs nothing, and "serves publishes to anything running on the box"
 *    is not a bug worth being one refactor away from. The comparison runs over
 *    fixed-length SHA-256 digests: `===` on the raw strings leaks the shared
 *    prefix through timing, and `timingSafeEqual` on the raw bytes throws
 *    `RangeError` when the lengths differ, which is a length oracle with extra
 *    steps. A missing credential and a wrong one produce byte-identical 401s,
 *    so probing cannot tell "no token" from "not that token".
 * 2. **A hostile page in the operator's browser.** A page on any origin can
 *    POST to `http://127.0.0.1:3000`, and DNS rebinding lets it reach a bind
 *    that "only listens on loopback" under a name the attacker controls. So
 *    `Host` and `Origin` are validated on *every* request, loopback included
 *    (CC-G6), before anything else looks at the request. Bearer, the browser's
 *    same-origin policy and this check are three independent layers; this one
 *    is what still stops a page that has somehow learned the token.
 *
 * Sessions are isolated: `sessionIdGenerator` mints a `randomUUID` per session
 * and each session gets its **own** `McpServerHandle`, because one SDK `Server`
 * binds exactly one transport and its per-connection state (initialization,
 * pending requests, progress tokens) is precisely what must not leak between
 * callers. `DELETE` ends one session; closing the transport ends all of them.
 *
 * Nothing here writes to stdout (CC-G3) — diagnostics go through the injected
 * logger, which writes JSON lines to stderr — and no line carries the token: it
 * is registered with `core/redact` on the way in, so even a future mistake
 * renders it as `[REDACTED]`.
 *
 * Layering: `core ← api ← mcp ← tools`. The per-session handle comes from an
 * injected factory, so this module never learns which tools exist.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer as createNodeServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { systemClock, type Clock } from '../core/clock.js';
import { TikTokError } from '../core/errors.js';
import type { Logger } from '../core/log.js';
import { registerSecret } from '../core/redact.js';
import type { Settings } from '../core/settings.js';
import type { McpServerHandle } from './server.js';

/** The single path served. Anything else is a 404 — with a valid token or not. */
export const MCP_PATH = '/mcp';

/** The methods Streamable HTTP defines; everything else is a 405. */
const ALLOWED_METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'DELETE']);

/** Transport-level refusal — the code the SDK uses for the same class of answer. */
const TRANSPORT_ERROR = -32000;
/** "Session not found", again matching the SDK so clients need no special case. */
const SESSION_ERROR = -32001;

/** The `http` scheme's default port: an authority without one means this. */
const DEFAULT_HTTP_PORT = '80';

// ---------------------------------------------------------------------------
// DNS-rebinding defense
// ---------------------------------------------------------------------------

/**
 * What the `Host`/`Origin` check compares against. `loopbackOnly` is true when
 * the bind itself stays on the machine, which is the only case where the
 * reachable name is knowable: past loopback the operator has TLS termination in
 * front (CC-G6) and the name in `Host` is the proxy's, not ours.
 */
export interface OriginPolicy {
  loopbackOnly: boolean;
  /** The port actually bound, not the configured one — a test may bind 0. */
  port: number;
}

/** Loopback covers only what stays on the machine. `0.0.0.0` does not. */
function isLoopbackName(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  if (hostname === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/** `[::1]` in a URL or a `Host` header is the same host as `::1`. */
function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

interface Authority {
  hostname: string;
  /** Absent when the header carried no port, which means the scheme default. */
  port?: string;
}

/**
 * Split an authority into hostname and port. IPv6 literals are bracketed by the
 * HTTP grammar, which is what makes the last-colon split safe for everything
 * else.
 */
function parseAuthority(value: string): Authority | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end < 0) return undefined;
    const hostname = trimmed.slice(1, end).toLowerCase();
    const rest = trimmed.slice(end + 1);
    if (rest === '') return { hostname };
    if (!rest.startsWith(':')) return undefined;
    return { hostname, port: rest.slice(1) };
  }
  const colon = trimmed.lastIndexOf(':');
  if (colon < 0) return { hostname: trimmed.toLowerCase() };
  return {
    hostname: trimmed.slice(0, colon).toLowerCase(),
    port: trimmed.slice(colon + 1),
  };
}

/**
 * The DNS-rebinding gate (CC-G6, SECURITY.md § Transport): the name of the
 * offending header, or `undefined` when the request may proceed.
 *
 * Exported so the non-loopback branch stays testable without binding a socket
 * beyond loopback on whoever runs the suite.
 *
 * `Host` is mandatory — a request that names no authority cannot be checked
 * against one. On a loopback bind it must *be* loopback and carry the bound
 * port, which is exactly what a rebound name (`evil.example` resolving to
 * 127.0.0.1) fails. Past loopback the name belongs to the proxy in front, so
 * only its syntax can be checked here.
 *
 * `Origin` is optional because non-browser clients never send one and rejecting
 * its absence would reject every correct client. When it *is* present a browser
 * is speaking, and it must name this very server: a loopback bind pins the
 * whole authority, a proxied bind pins the hostname (the port a browser sees is
 * the proxy's, not the one bound here).
 */
export function dnsRebindingRejection(
  headers: { host?: string | undefined; origin?: string | undefined },
  policy: OriginPolicy,
): 'Host' | 'Origin' | undefined {
  const host = headers.host === undefined ? undefined : parseAuthority(headers.host);
  if (host === undefined) return 'Host';
  if (policy.loopbackOnly) {
    if (!isLoopbackName(host.hostname)) return 'Host';
    if ((host.port ?? DEFAULT_HTTP_PORT) !== String(policy.port)) return 'Host';
  }

  const origin = headers.origin;
  if (origin === undefined) return undefined;
  let url: URL;
  try {
    // `Origin: null` (an opaque origin — sandboxed frame, cross-origin
    // redirect) does not parse here, and failing to parse is a rejection.
    url = new URL(origin);
  } catch {
    return 'Origin';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Origin';
  const originHost = stripBrackets(url.hostname).toLowerCase();
  if (!policy.loopbackOnly) {
    return originHost === host.hostname ? undefined : 'Origin';
  }
  if (!isLoopbackName(originHost)) return 'Origin';
  const originPort = url.port === '' ? DEFAULT_HTTP_PORT : url.port;
  return originPort === String(policy.port) ? undefined : 'Origin';
}

// ---------------------------------------------------------------------------
// bearer
// ---------------------------------------------------------------------------

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * The credential out of `Authorization`, or the empty string when the header is
 * absent or is not a bearer. Absence deliberately yields a *value* instead of a
 * short circuit, so the comparison below runs identically either way.
 */
function presentedCredential(header: string | undefined): string {
  if (header === undefined) return '';
  const trimmed = header.trim();
  const space = trimmed.indexOf(' ');
  if (space < 0) return '';
  if (trimmed.slice(0, space).toLowerCase() !== 'bearer') return '';
  return trimmed.slice(space + 1).trim();
}

/**
 * Constant-time bearer comparison (SECURITY.md § Transport). Both sides are
 * hashed first: the digests are always 32 bytes, so `timingSafeEqual` never
 * sees a length mismatch and the wire length of the presented token leaks
 * nothing.
 */
function bearerAccepted(header: string | undefined, expected: Buffer): boolean {
  return timingSafeEqual(sha256(presentedCredential(header)), expected);
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

export interface HttpTransportOptions {
  settings: Settings;
  log: Logger;
  /**
   * Builds the MCP runtime for one session. Called once per accepted session
   * because an SDK `Server` binds exactly one transport — sharing a handle
   * would make two HTTP clients share initialization state and pending
   * requests.
   */
  createHandle: (sessionId: string) => McpServerHandle | Promise<McpServerHandle>;
  /** Injected so session ages are deterministic under `mockClock` (CC-H4). */
  clock?: Clock;
}

export interface HttpTransportHandle {
  /** The bound host as it goes into a URL (IPv6 bracketed). */
  readonly host: string;
  /** The bound port — it differs from `TT_PORT` only when that was 0. */
  readonly port: number;
  /** Where a client points its Streamable HTTP transport. */
  readonly url: string;
  /** Live sessions; a diagnostic, never a protocol input. */
  sessions(): number;
  /** Ends every session and releases the port. Idempotent. */
  close(): Promise<void>;
}

interface Session {
  readonly transport: StreamableHTTPServerTransport;
  readonly openedAtMs: number;
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    ...headers,
  });
  res.end(body);
}

/**
 * One header value as a string. Node folds repeated headers itself; the only
 * ones it hands back as an array are irrelevant here, and an array is not a
 * value this transport can act on.
 */
function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/* c8 ignore start -- both fallbacks are unreachable through the public surface:
   `req.url` is set on every server request, and llhttp rejects a target this
   parser could not read long before it gets here. They exist because the value
   is untrusted input and its type says it may be absent. */
/** The path out of a request target, or `undefined` when it does not parse. */
function requestPath(target: string | undefined): string | undefined {
  try {
    return new URL(target ?? '/', 'http://placeholder.invalid').pathname;
  } catch {
    return undefined;
  }
}

/** The port the socket actually got — `TT_PORT` may be 0 under test. */
function boundPortOf(server: NodeHttpServer, fallback: number): number {
  const address = server.address();
  // A listening TCP server always reports an `AddressInfo`; the string arm of
  // the union is the unix-socket case this transport never takes.
  return typeof address === 'object' && address !== null ? address.port : fallback;
}
/* c8 ignore stop */

function listen(server: NodeHttpServer, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

/**
 * Bind the Streamable HTTP endpoint and serve MCP on it.
 *
 * Resolves once the socket is listening, so the caller can log a URL that is
 * already reachable; the returned handle is the only way to take it down again.
 *
 * @throws TikTokError `kind: 'config'` when no `TT_HTTP_TOKEN` is configured.
 *   `core/settings` rejects that combination first (CC-G6); this is the
 *   backstop for a caller that built its `Settings` some other way.
 */
export async function startHttpTransport(
  opts: HttpTransportOptions,
): Promise<HttpTransportHandle> {
  const { settings, log } = opts;
  const clock = opts.clock ?? systemClock;
  const token = settings.httpToken;
  if (token === undefined) {
    throw new TikTokError({
      kind: 'config',
      code: 'http_token_required',
      message:
        'TT_HTTP_TOKEN is required whenever TT_TRANSPORT=http, including a loopback bind',
      remediation:
        'Set TT_HTTP_TOKEN to at least 16 printable ASCII characters, or use the default stdio transport.',
    });
  }
  // Defense in depth: no line here logs the token on purpose, and now no line
  // can log it by accident either (SECURITY.md § Redaction).
  registerSecret(token);
  const expectedDigest = sha256(token);

  const bindHost = stripBrackets(settings.httpHost);
  const policy: OriginPolicy = {
    loopbackOnly: isLoopbackName(bindHost.toLowerCase()),
    // Replaced with the real port once the socket is bound.
    port: settings.port,
  };

  const sessions = new Map<string, Session>();
  const httpLog = log.child({ component: 'mcp/http' });
  let closed = false;

  async function openSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = randomUUID();
    const handle = await opts.createHandle(id);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      // The SDK assigns the id while it handles `initialize`; registering from
      // its own hook is what keeps the map and the transport from disagreeing.
      onsessioninitialized: (sessionId: string) => {
        sessions.set(sessionId, { transport, openedAtMs: clock.now() });
        httpLog.info('mcp session opened');
      },
    });
    // Set before `connect`: the SDK chains onto an existing handler instead of
    // replacing it, so this cleanup and the server's own teardown both run.
    transport.onclose = (): void => {
      const session = sessions.get(id);
      if (session === undefined) return;
      sessions.delete(id);
      httpLog.info('mcp session closed', {
        duration_ms: clock.now() - session.openedAtMs,
      });
    };
    await handle.server.connect(transport);

    try {
      await transport.handleRequest(req, res);
    } finally {
      if (transport.sessionId === undefined) {
        // The POST was not an `initialize`, so the SDK answered 400 and took no
        // session id. Nothing may keep this transport — or its `Server` — alive.
        await transport.close();
      }
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = headerValue(req, 'mcp-session-id');
    if (sessionId !== undefined && sessionId !== '') {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        // One answer for "expired", "deleted" and "never existed": a session id
        // is a capability, and confirming one is a capability too.
        sendJsonRpcError(res, 404, SESSION_ERROR, 'Session not found');
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }
    if (req.method !== 'POST') {
      sendJsonRpcError(
        res,
        400,
        TRANSPORT_ERROR,
        'Bad Request: Mcp-Session-Id header is required',
      );
      return;
    }
    await openSession(req, res);
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Order matters: the rebinding gate and the bearer both run before the
      // path is looked at, so an unauthenticated prober cannot map the surface.
      const rejected = dnsRebindingRejection(
        { host: headerValue(req, 'host'), origin: headerValue(req, 'origin') },
        policy,
      );
      if (rejected !== undefined) {
        httpLog.warn('http request rejected', {
          status: 403,
          reason: `invalid ${rejected} header`,
          method: req.method,
        });
        sendJsonRpcError(
          res,
          403,
          TRANSPORT_ERROR,
          `Forbidden: invalid ${rejected} header`,
        );
        return;
      }
      if (!bearerAccepted(headerValue(req, 'authorization'), expectedDigest)) {
        // One body and one log line for both "no credential" and "wrong
        // credential" — telling them apart is exactly what a prober is after.
        httpLog.warn('http request rejected', {
          status: 401,
          reason: 'bearer rejected',
          method: req.method,
        });
        sendJsonRpcError(res, 401, TRANSPORT_ERROR, 'Unauthorized', {
          'www-authenticate': 'Bearer',
        });
        return;
      }
      if (requestPath(req.url) !== MCP_PATH) {
        sendJsonRpcError(res, 404, TRANSPORT_ERROR, 'Not Found');
        return;
      }
      // `req.method` is typed optional for the client-response shape of
      // `IncomingMessage`; an absent method is simply not an allowed one.
      if (!ALLOWED_METHODS.has(String(req.method))) {
        sendJsonRpcError(res, 405, TRANSPORT_ERROR, 'Method Not Allowed', {
          allow: [...ALLOWED_METHODS].join(', '),
        });
        return;
      }
      await route(req, res);
    } catch (cause) {
      httpLog.error('http request failed', {
        method: req.method,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
      // A half-written SSE stream cannot be turned back into a JSON error;
      // ending it is all that is left, and the client sees a truncated stream.
      if (res.headersSent) res.end();
      else sendJsonRpcError(res, 500, TRANSPORT_ERROR, 'Internal Server Error');
    }
  }

  const server = createNodeServer((req, res) => {
    void dispatch(req, res);
  });

  await listen(server, bindHost, settings.port);
  const boundPort = boundPortOf(server, settings.port);
  policy.port = boundPort;

  const displayHost = bindHost.includes(':') ? `[${bindHost}]` : bindHost;
  const url = `http://${displayHost}:${String(boundPort)}${MCP_PATH}`;

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    // Take the sessions out of the map first: their `onclose` then has nothing
    // left to report, and no request in flight can find a transport being torn
    // down. `allSettled` because a stuck session must not keep the port.
    const live = [...sessions.values()];
    sessions.clear();
    await Promise.allSettled(live.map((session) => session.transport.close()));
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      // Keep-alive sockets and any surviving SSE stream would hold the port
      // open past `close()`, and the caller asked for the port back.
      server.closeAllConnections();
    });
    httpLog.info('the http transport is closed', { url });
  }

  return {
    host: displayHost,
    port: boundPort,
    url,
    sessions: () => sessions.size,
    close,
  };
}

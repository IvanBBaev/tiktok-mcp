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
import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';

import { systemClock, type Clock } from '../core/clock.js';
import { TikTokError } from '../core/errors.js';
import type { Logger } from '../core/log.js';
import { boundPortOf } from '../core/net.js';
import { registerSecret } from '../core/redact.js';
import { canonicalHostName, type Settings } from '../core/settings.js';
import type { McpServerHandle } from './server.js';

/** The single path served. Anything else is a 404 — with a valid token or not. */
export const MCP_PATH = '/mcp';

/** The methods Streamable HTTP defines; everything else is a 405. */
const ALLOWED_METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'DELETE']);

/** Transport-level refusal — the code the SDK uses for the same class of answer. */
const TRANSPORT_ERROR = -32000;
/** "Session not found", again matching the SDK so clients need no special case. */
const SESSION_ERROR = -32001;
/** JSON-RPC "Parse error", as the SDK answers an unparsable body. */
const PARSE_ERROR = -32700;

/**
 * The largest request body read — the SDK's own historical cap. The body is
 * read here, not by the SDK, because its web-standard path buffers a body of
 * any size before parsing it on the event loop.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Live sessions at most; one more `initialize` is refused, not queued. */
const DEFAULT_MAX_SESSIONS = 128;

/**
 * A session with no request in flight and no open stream for this long is
 * closed the next time a session is opened. Clients that exit without a
 * DELETE are the common case, and each leaves a whole `Server` behind.
 */
const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;

/**
 * How long `close()` waits for requests already in flight before it tears the
 * sessions down anyway. A publish mid-upload is the case this is for: aborting
 * it leaves an `unknown` journal outcome the operator then has to chase.
 */
const DEFAULT_DRAIN_MS = 10_000;

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
  /**
   * `TT_HTTP_ALLOWED_HOSTS`: when present, `Host` — and a browser's `Origin` —
   * must name one of these. It is what closes DNS rebinding past loopback,
   * where the bind alone cannot say which names are ours.
   */
  allowedHosts?: ReadonlySet<string>;
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
 * The hostname as `Origin` and the allowlist both carry it (see
 * `canonicalHostName`). A name the URL parser refuses is kept lowercased: it can
 * match no allowlist entry and no loopback name, so the checks refuse it anyway.
 */
function canonicalHost(hostname: string): string {
  return canonicalHostName(hostname) ?? hostname.toLowerCase();
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
    const hostname = canonicalHost(trimmed.slice(1, end));
    const rest = trimmed.slice(end + 1);
    if (rest === '') return { hostname };
    if (!rest.startsWith(':')) return undefined;
    return withPort(hostname, rest.slice(1));
  }
  const colon = trimmed.lastIndexOf(':');
  if (colon < 0) return { hostname: canonicalHost(trimmed) };
  return withPort(canonicalHost(trimmed.slice(0, colon)), trimmed.slice(colon + 1));
}

/** A lone `notifications/cancelled` — the one message a draining server still takes. */
function isCancel(body: unknown): boolean {
  return isJSONRPCNotification(body) && body.method === 'notifications/cancelled';
}

/**
 * Only a decimal port in 1-65535 is an authority. Anything else would pass the
 * hostname gate and then earn a bare, envelope-less 400 from the SDK adapter.
 */
function withPort(hostname: string, port: string): Authority | undefined {
  if (!/^\d{1,5}$/.test(port)) return undefined;
  const value = Number(port);
  // Re-spelled: `:080` is port 80, and the comparison against the bound port
  // is by string.
  return value >= 1 && value <= 65_535 ? { hostname, port: String(value) } : undefined;
}

/**
 * The `Host` a request is handed to the SDK with, once the gate has accepted
 * it: the authority re-spelled canonically. The SDK's request adapter checks
 * `Host` again with its own, narrower grammar and answers a bare 400 to a
 * spelling it cannot reconcile with the URL parser's — `127.1` with a port of
 * 60000 or more, which an ephemeral bind hands out routinely — so a host the
 * gate already accepted must reach it in the one form both agree on.
 *
 * A value that does not parse is returned as it came: the gate refuses it
 * before this runs, so there is nothing to re-spell. Exported for the same
 * reason as the gate: the no-port form arrives only on the default port or through a proxy.
 */
export function canonicalHostHeader(value: string | undefined): string | undefined {
  const host = value === undefined ? undefined : parseAuthority(value);
  if (host === undefined) return value;
  const name = host.hostname.includes(':') ? `[${host.hostname}]` : host.hostname;
  return host.port === undefined ? name : `${name}:${host.port}`;
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
  const { allowedHosts } = policy;
  if (allowedHosts !== undefined && !allowedHosts.has(host.hostname)) return 'Host';
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
  if (allowedHosts !== undefined && !allowedHosts.has(originHost)) return 'Origin';
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
  /**
   * Called exactly once for every handle `createHandle` returned, when its
   * transport closes — a DELETE, an idle or shutdown close, or a POST that was
   * not an `initialize` and so never became a session. The owner drops the
   * handle from whatever it keeps them in.
   */
  releaseHandle?: (handle: McpServerHandle) => void;
  /** Injected so session ages are deterministic under `mockClock` (CC-H4). */
  clock?: Clock;
  /** Live-session cap; defaults to 128. A test seam, not a setting. */
  maxSessions?: number;
  /** Idle age after which a session is closed; defaults to 30 minutes. A test seam. */
  sessionIdleMs?: number;
  /** How long `close()` waits for requests in flight; defaults to 10 s. A test seam. */
  drainMs?: number;
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
  /**
   * Refuses new requests, waits up to the drain budget for the ones in flight,
   * then ends every session and releases the port. Idempotent: a second call
   * returns the first call's promise.
   */
  close(): Promise<void>;
}

interface Session {
  readonly transport: StreamableHTTPServerTransport;
  readonly openedAtMs: number;
  /** When the last request on it arrived or finished. */
  lastSeenMs: number;
  /** Requests whose response is still open — a GET stream counts until it ends. */
  active: number;
  /**
   * JSON-RPC calls not yet answered. A handler outlives its POST when the
   * client drops the connection, so `active` alone would let the idle sweep
   * close a session — and abort the handler — mid-publish.
   */
  readonly calls: ReadonlySet<RequestId>;
}

/**
 * `open` serves; `draining` refuses new requests while the accepted ones
 * finish; `closed` has torn the sessions down.
 */
type Phase = 'open' | 'draining' | 'closed';

/** A request that arrived after `close()` began: no new work is accepted. */
function sendShuttingDown(res: ServerResponse): void {
  sendJsonRpcError(
    res,
    503,
    TRANSPORT_ERROR,
    'Service Unavailable: the server is shutting down',
  );
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
 * The raw body of a request, or `undefined` when it exceeds `limit`. Past the
 * limit the rest is drained and dropped, so memory stays bounded while the
 * caller still gets to answer before the socket is ended.
 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        // Stop collecting and keep the stream flowing into nothing. The `end`
        // that may still follow resolves a promise that is already settled.
        req.off('data', onData);
        req.resume();
        chunks.length = 0;
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/**
 * The parsed JSON body of a POST, or `undefined` once the request has been
 * answered here: 413 past {@link MAX_BODY_BYTES}, 400 for a body that is not
 * JSON — the same answer the SDK gives, without the SDK ever buffering it.
 */
async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ body: unknown } | undefined> {
  const declared = Number(headerValue(req, 'content-length'));
  const raw = declared > MAX_BODY_BYTES ? undefined : await readBody(req, MAX_BODY_BYTES);
  if (raw === undefined) {
    sendJsonRpcError(res, 413, TRANSPORT_ERROR, 'Payload Too Large', {
      connection: 'close',
    });
    // Whatever is still arriving is not read; the socket goes with the answer.
    res.once('finish', () => {
      req.destroy();
    });
    return undefined;
  }
  try {
    return { body: JSON.parse(raw.toString('utf8')) };
  } catch {
    sendJsonRpcError(res, 400, PARSE_ERROR, 'Parse error: Invalid JSON');
    return undefined;
  }
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

/**
 * The path out of a request target, or `undefined` when it does not parse.
 *
 * A target llhttp accepts is not necessarily one the WHATWG parser can read:
 * `//` arrives here verbatim, and as a URL reference it is an authority with no
 * host, which throws. A target that names no path names no `MCP_PATH` either,
 * so the caller treats `undefined` the same way it treats any other path.
 */
function requestPath(target: string): string | undefined {
  try {
    return new URL(target, 'http://placeholder.invalid').pathname;
  } catch {
    return undefined;
  }
}

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
  if (settings.httpAllowedHosts !== undefined) {
    policy.allowedHosts = new Set(settings.httpAllowedHosts);
  }

  const sessions = new Map<string, Session>();
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  // Sessions being opened: counted against the cap from the check onward, since
  // a session only joins `sessions` once the SDK has handled its `initialize`.
  let opening = 0;
  const sessionIdleMs = opts.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  const drainMs = opts.drainMs ?? DEFAULT_DRAIN_MS;
  const httpLog = log.child({ component: 'mcp/http' });
  let phase: Phase = 'open';
  let closing: Promise<void> | undefined;
  /**
   * What the drain waits for: responses to non-GET requests still open (a GET
   * is a stream with no end), plus JSON-RPC requests whose handler has not
   * answered yet — a client that hung up mid-call leaves its handler running
   * with no response to count, and closing its session would abort it.
   */
  let pending = 0;
  let onIdle: (() => void) | undefined;

  function settle(): void {
    pending -= 1;
    if (pending === 0) onIdle?.();
  }

  function track(res: ServerResponse): void {
    pending += 1;
    res.once('close', settle);
  }

  /**
   * Count the transport's requests from arrival to answer. Wrapped after
   * `connect`, because the SDK installs its own `onmessage` there. A request the
   * client cancels gets no answer, so the cancellation settles it; closing the
   * transport settles whatever is left. Returns that close-time settle.
   */
  function trackCalls(
    transport: StreamableHTTPServerTransport,
    open: Set<RequestId>,
  ): () => void {
    const done = (id: RequestId | undefined): void => {
      if (id !== undefined && open.delete(id)) settle();
    };
    const receive = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if (isJSONRPCRequest(message) && !open.has(message.id)) {
        open.add(message.id);
        pending += 1;
      } else if (
        isJSONRPCNotification(message) &&
        message.method === 'notifications/cancelled'
      ) {
        done(message.params?.['requestId'] as RequestId | undefined);
      }
      receive?.(message, extra);
    };
    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
        done(message.id);
      }
      return send(message, options);
    };
    return () => {
      for (const id of [...open]) done(id);
    };
  }

  /** Resolve once no tracked response is open, or once the budget is spent. */
  async function drain(): Promise<void> {
    if (pending === 0) return;
    const idle = new Promise<'idle'>((resolve) => {
      onIdle = () => {
        resolve('idle');
      };
    });
    const timer = new AbortController();
    const timeout = clock.sleep(drainMs, timer.signal).then(
      () => 'timeout' as const,
      () => 'aborted' as const,
    );
    const outcome = await Promise.race([idle, timeout]);
    timer.abort();
    if (outcome === 'timeout') {
      httpLog.warn('http shutdown did not drain; aborting requests in flight', {
        pending,
        drain_ms: drainMs,
      });
    }
  }

  /**
   * Close every session idle past `sessionIdleMs`. Run when a session is
   * about to be opened — the only moment the count matters — so no timer
   * keeps the process alive. Out of the map first, like `close()`, so no
   * request can find a transport being torn down.
   */
  async function sweepIdle(): Promise<void> {
    const cutoff = clock.now() - sessionIdleMs;
    const expired: Session[] = [];
    for (const [id, session] of sessions) {
      if (session.active > 0 || session.calls.size > 0 || session.lastSeenMs > cutoff) {
        continue;
      }
      sessions.delete(id);
      expired.push(session);
      httpLog.info('mcp session expired', {
        duration_ms: clock.now() - session.openedAtMs,
      });
    }
    await Promise.allSettled(expired.map((session) => session.transport.close()));
  }

  async function openSession(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    await sweepIdle();
    if (sessions.size + opening >= maxSessions) {
      httpLog.warn('http request rejected', {
        status: 503,
        reason: 'session limit reached',
        method: req.method,
      });
      sendJsonRpcError(
        res,
        503,
        TRANSPORT_ERROR,
        'Service Unavailable: too many open sessions',
      );
      return;
    }
    // The slot is held until the session is in the map or has failed — once
    // and only once, or a session still answering its `initialize` would count
    // twice and refuse a request the cap has room for.
    opening += 1;
    let reserved = true;
    const release = (): void => {
      if (!reserved) return;
      reserved = false;
      opening -= 1;
    };
    try {
      await openReservedSession(req, res, body, release);
    } finally {
      release();
    }
  }

  async function openReservedSession(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
    release: () => void,
  ): Promise<void> {
    const id = randomUUID();
    const handle = await opts.createHandle(id);
    const openCalls = new Set<RequestId>();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      // The SDK assigns the id while it handles `initialize`; registering from
      // its own hook is what keeps the map and the transport from disagreeing.
      onsessioninitialized: (sessionId: string) => {
        release();
        // A drain that timed out has already emptied the map; a session
        // registered now would never be closed.
        if (phase === 'closed') {
          void transport.close();
          return;
        }
        const now = clock.now();
        sessions.set(sessionId, {
          transport,
          openedAtMs: now,
          lastSeenMs: now,
          active: 0,
          calls: openCalls,
        });
        httpLog.info('mcp session opened');
      },
    });
    // Set before `connect`: the SDK chains onto an existing handler instead of
    // replacing it, so this cleanup and the server's own teardown both run.
    let released = false;
    // Filled in after `connect`; a transport closing before then had no calls.
    const calls: { settle?: () => void } = {};
    transport.onclose = (): void => {
      calls.settle?.();
      if (!released) {
        released = true;
        opts.releaseHandle?.(handle);
      }
      const session = sessions.get(id);
      if (session === undefined) return;
      sessions.delete(id);
      httpLog.info('mcp session closed', {
        duration_ms: clock.now() - session.openedAtMs,
      });
    };
    try {
      await handle.server.connect(transport);
    } catch (cause) {
      // No `onclose` will ever run for a transport that never connected.
      released = true;
      opts.releaseHandle?.(handle);
      throw cause;
    }
    calls.settle = trackCalls(transport, openCalls);
    // `close()` may have torn the sessions down while the handle was being
    // built or connected; a session opened now would outlive the listener that
    // was meant to end it. While it is only draining, this request was accepted
    // before the shutdown and is allowed to finish.
    if (phase === 'closed') {
      await transport.close();
      sendShuttingDown(res);
      return;
    }

    try {
      await transport.handleRequest(req, res, body);
    } finally {
      if (transport.sessionId === undefined) {
        // The POST was not an `initialize`, so the SDK answered 400 and took no
        // session id. Nothing may keep this transport — or its `Server` — alive.
        await transport.close();
      }
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (phase === 'closed' || (phase === 'draining' && req.method !== 'POST')) {
      sendShuttingDown(res);
      return;
    }
    let body: unknown;
    if (req.method === 'POST') {
      const parsed = await readJsonBody(req, res);
      if (parsed === undefined) return;
      body = parsed.body;
    }
    const sessionId = headerValue(req, 'mcp-session-id');
    // While draining, only a cancel for a live session gets through: it is what
    // lets the drain stop waiting for the call it names. Checked after the body
    // read, so a slow body that outlasts the drain is still told "shutting
    // down" rather than the "Session not found" an emptied map would give.
    if (phase !== 'open' && !(isCancel(body) && sessions.has(sessionId ?? ''))) {
      sendShuttingDown(res);
      return;
    }
    if (sessionId !== undefined && sessionId !== '') {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        // One answer for "expired", "deleted" and "never existed": a session id
        // is a capability, and confirming one is a capability too.
        sendJsonRpcError(res, 404, SESSION_ERROR, 'Session not found');
        return;
      }
      session.lastSeenMs = clock.now();
      session.active += 1;
      res.once('close', () => {
        session.active -= 1;
        session.lastSeenMs = clock.now();
      });
      await session.transport.handleRequest(req, res, body);
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
    await openSession(req, res, body);
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
      req.headers.host = canonicalHostHeader(headerValue(req, 'host'));
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
      // `req.url` and `req.method` are typed optional for the client-response
      // shape of `IncomingMessage`; an absent target is simply not the MCP path,
      // and an absent method is simply not an allowed one.
      if (requestPath(String(req.url)) !== MCP_PATH) {
        sendJsonRpcError(res, 404, TRANSPORT_ERROR, 'Not Found');
        return;
      }
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
    if (req.method !== 'GET') track(res);
    void dispatch(req, res);
  });

  await listen(server, bindHost, settings.port);
  const boundPort = boundPortOf(server.address(), settings.port);
  policy.port = boundPort;

  const displayHost = bindHost.includes(':') ? `[${bindHost}]` : bindHost;
  const url = `http://${displayHost}:${String(boundPort)}${MCP_PATH}`;

  function close(): Promise<void> {
    closing ??= shutDown();
    return closing;
  }

  async function shutDown(): Promise<void> {
    phase = 'draining';
    await drain();
    phase = 'closed';
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

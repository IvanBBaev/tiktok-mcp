/**
 * core/http.ts — the ONLY place in this server that talks to the network.
 *
 * Spec: CONTRACTS.md § core/http.ts (frozen signatures), ARCHITECTURE.md § 6
 * (egress control + the three-class retry matrix), SECURITY.md § 2.5 (egress
 * allowlist) and § 2.6 (DNS/rebinding seam), TIKTOK-API.md § 1.1–1.3 (the error
 * trichotomy), § 4.7 (`upload_url` anatomy + host rule) and § 4.8 (chunk-PUT
 * response table), CORNER-CASES.md CC-A12, CC-B1…CC-B9, CC-H1, CC-H2.
 *
 * Four responsibilities, in dependency order:
 *
 * 1. **Egress allowlist** (`assertAllowedUrl`) — default-deny, WHATWG-parsed,
 *    exact host match or one anchored regex. A bare `endsWith` is banned by
 *    spec (`open.tiktokapis.com.attacker.tld` ends with nothing useful, and
 *    `eviltiktokapis.com` ends with `tiktokapis.com`). Widening the list is a
 *    spec edit, never a runtime relaxation.
 * 2. **Response decoding** — TikTok answers in three unrelated shapes and the
 *    decoder is selected by *endpoint class*, never by sniffing: the
 *    `{data,error}` envelope for data endpoints (`ttRequest`, CC-B1), the flat
 *    OAuth object for token endpoints (`oauthRequest`, CC-A12), and bare HTTP
 *    statuses for chunk PUTs (`putChunk`, § 1.3). A non-JSON body is a
 *    first-class outcome, never a `JSON.parse` crash (CC-B2).
 * 3. **Retry classes** (CC-B7) — `read` retries 429/5xx/network with backoff
 *    and `Retry-After`; `init` is **never** retried, not even on 429 (CC-B4,
 *    CC-B5, CC-B8); `chunk` retries 5xx/timeout in-call with an **identical**
 *    `Content-Range`.
 * 4. **Chunk PUT** (`putChunk`) — raw HTTP, no `Authorization` header ever: the
 *    `upload_token` in the URL *is* the credential, so it is registered as a
 *    redaction secret and no log line or error message ever carries more of an
 *    upload URL than `origin + pathname` (SECURITY.md § 2.5, TIKTOK-API § 4.7
 *    rule 4).
 *
 * Seams and house rules this module obeys:
 *
 * - **Time** flows through the injected `Clock` only. Every wait is a
 *   deadline re-derived from `clock.now()` on each wake, sliced into bounded
 *   `sleep`s, so a suspended laptop shortens the remaining wait instead of
 *   extending it (CC-H1). `setTimeout`, `Date.now` and `AbortSignal.timeout`
 *   are all banned here — the last one because it is a real timer the mock
 *   clock cannot drive.
 * - **`fetch`** is read off `globalThis` at call time, which is the seam the
 *   test harness swaps (`withFetch`).
 * - **Settings are never imported.** Every knob is an option with a documented
 *   default that mirrors CONFIGURATION.md; the composition root passes
 *   `settings.*` in explicitly. This file therefore has no hidden dependency
 *   on process state.
 * - **Logging** goes through an injected `Logger` (stderr-only, redacting) and
 *   defaults to a silent one, so importing this module never writes anywhere.
 *   Field names are restricted to `core/redact`'s allowlist.
 */

import { isIPv4, isIPv6 } from 'node:net';
import { systemClock, type Clock } from './clock.js';
import { isTikTokError, TikTokError, type ErrorKind } from './errors.js';
import { silentLogger, type Logger } from './log.js';
import { redactText, registerSecret } from './redact.js';

// ---------------------------------------------------------------------------
// egress allowlist (SECURITY.md § 2.5, TIKTOK-API.md § 4.7)
// ---------------------------------------------------------------------------

/** The one API host. Also a legal `upload_url` host per TIKTOK-API § 4.7. */
const API_HOST = 'open.tiktokapis.com';

/** The non-regional upload host TikTok's own examples show. */
const UPLOAD_HOST = 'open-upload.tiktokapis.com';

/**
 * Regional upload hosts (`upload.us.tiktokapis.com`, …). Anchored at both ends
 * and dot-delimited on purpose: the label may not contain a dot, so
 * `upload.a.evil.tiktokapis.com` and `upload.us.tiktokapis.com.evil.tld` are
 * both rejected. New observed shapes widen this pattern in the spec first.
 */
const REGIONAL_UPLOAD_HOST_RE = /^upload\.[a-z0-9-]{1,16}\.tiktokapis\.com$/;

// ---------------------------------------------------------------------------
// documented defaults (mirrors of CONFIGURATION.md — never read from settings)
// ---------------------------------------------------------------------------

/** `TT_TIMEOUT_MS` default: per-request (per-attempt) timeout. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** ARCHITECTURE § 6 retry matrix, `read` row: 3 attempts in total. */
const DEFAULT_READ_ATTEMPTS = 3;

/** `TT_CHUNK_RETRIES` default: attempts per chunk are `1 + this`. */
const DEFAULT_CHUNK_RETRIES = 3;

/** Backoff is `min(500·2^n, 8000) + jitter` (ARCHITECTURE § 6, CC-B3). */
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8_000;

/** Fraction of the backoff base added as jitter, drawn from the `random` seam. */
const BACKOFF_JITTER_FRACTION = 0.25;

/** `Retry-After` is honored but capped at `min(30 s, remaining budget)` (CC-B3). */
const RETRY_AFTER_MAX_MS = 30_000;

/**
 * Longest single `sleep` used to serve a wait. Waits are loops of bounded
 * sleeps with the deadline re-derived from `now()` on every wake (CC-H1), so
 * this only bounds how long the process can stay unaware that the wall clock
 * jumped.
 */
const SLEEP_SLICE_MS = 1_000;

/** Length cap for the body snippet carried in a CC-B2 error message. */
const BODY_SNIPPET_MAX = 200;

/** Length cap for upstream free text quoted into an error message. */
const UPSTREAM_TEXT_MAX = 200;

// ---------------------------------------------------------------------------
// public types
// ---------------------------------------------------------------------------

/**
 * Retry class, chosen by the caller from the endpoint's semantics
 * (ARCHITECTURE § 6 keeps the path→class mapping; this module only enforces the
 * behavior of a class):
 *
 * - `read` — idempotent reads: retry 429/5xx/network with backoff and
 *   `Retry-After` (CC-B3).
 * - `init` — publish inits: **never** retried (CC-B4/CC-B5); an upstream 429 is
 *   terminal with a wait hint (CC-B8).
 * - `chunk` — upload PUTs: in-call `1 + chunkRetries` attempts with an
 *   identical `Content-Range` (CC-B7). Used by `putChunk`.
 */
export type RetryClass = 'read' | 'init' | 'chunk';

/** Injectable DNS seam — shape-compatible with `node:dns`'s `lookup`. */
export type LookupFn = typeof import('node:dns').lookup;

export interface TtRequestOptions {
  method: 'GET' | 'POST';
  /** Must pass `assertAllowedUrl(url, "api")`; rejected before any fetch. */
  url: string;
  /** JSON request payload. `POST` only — a `GET` with a body is a caller bug. */
  body?: unknown;
  retryClass: RetryClass;
  /** Access token. Absent on OAuth calls and on every upload PUT. */
  bearer?: string;
  /** Per-attempt timeout; defaults to 30_000 ms (`TT_TIMEOUT_MS`). */
  timeoutMs?: number;
  signal?: AbortSignal;
  clock?: Clock;
  /** DNS seam (SECURITY.md § 2.6). When present, addresses are pre-flighted. */
  lookup?: LookupFn;

  // ---- additive options (documented deviations from CONTRACTS.md) ----

  /**
   * Total attempts for the `read` class; defaults to 3 (ARCHITECTURE § 6). Any
   * other class is 1 attempt regardless. Values below 1 are clamped to 1.
   */
  maxAttempts?: number;
  /**
   * Overall wall-clock budget for the call including backoff waits; defaults to
   * `timeoutMs * maxAttempts`. This is the "remaining budget" `Retry-After` is
   * capped against (CC-B3).
   */
  budgetMs?: number;
  /** Sink for diagnostics; defaults to a silent logger. */
  logger?: Logger;
  /** Jitter source; defaults to `Math.random`. Tests inject a seeded stream. */
  random?: () => number;
}

/** Options `oauthRequest` accepts: no retry class — OAuth is never retried. */
export type OauthRequestOptions = Omit<TtRequestOptions, 'retryClass'> & {
  /**
   * Accept a **loopback** origin instead of the pinned API host.
   *
   * Additive test-only seam, set by `core/oauth` and only when
   * `TT_OAUTH_BASE_URL` (CONFIGURATION.md § Internal / test-only) names a
   * loopback address. Cross-process tests fork the compiled build and cannot
   * inject a `fetch` stub into the child, so the token endpoint has to be
   * redirected through the environment (TESTING.md § multi-process).
   *
   * The relaxation is deliberately the narrowest one that makes that work: the
   * host must be loopback, so a mis-set override can leak a token to a listener
   * on this machine and nowhere else. Userinfo is still rejected, and every
   * non-loopback host still goes through `assertAllowedUrl` unchanged.
   */
  allowLoopbackOrigin?: boolean;
};

export interface ChunkPutResult {
  /** The HTTP status TikTok answered with (201/206/400/403/404/416/5xx). */
  status: number;
  /**
   * Bytes TikTok reports as accepted, parsed from the response's
   * `Content-Range: bytes 0-{UPLOADED_BYTES}/{TOTAL}` when present — chiefly on
   * 416, where it is the resync source (TIKTOK-API § 4.8, CC-D6). Reported
   * verbatim, in the same units as `status/fetch`'s `uploaded_bytes`; no ±1
   * arithmetic is applied here because the upstream unit is only pinned by
   * probe P-11.
   */
  uploadedBytes?: number;
}

export interface PutChunkOptions {
  /** Must pass `assertAllowedUrl(uploadUrl, "upload")`. Never logged whole. */
  uploadUrl: string;
  /** `bytes {first}-{last}/{total}` — byte-identical across retries (CC-D6). */
  contentRange: string;
  contentType: string;
  body: ReadableStream<Uint8Array> | Uint8Array;
  /** Per-attempt timeout. `TT_UPLOAD_TIMEOUT_MS` default (120_000) lives in settings. */
  timeoutMs: number;
  signal?: AbortSignal;

  // ---- additive options (documented deviations from CONTRACTS.md) ----

  clock?: Clock;
  lookup?: LookupFn;
  /** Retries after the first attempt; defaults to 3 (`TT_CHUNK_RETRIES`). */
  chunkRetries?: number;
  /** Overall budget for the chunk including backoff; defaults to `timeoutMs * attempts`. */
  budgetMs?: number;
  logger?: Logger;
  random?: () => number;
  /**
   * `Content-Length` for a streamed body. TikTok requires the header on every
   * chunk PUT (TIKTOK-API § 4.6); for a `Uint8Array` body it is derived, for a
   * `ReadableStream` the caller must supply it or the request goes out chunked.
   */
  contentLength?: number;
}

// ---------------------------------------------------------------------------
// internals: logging, small helpers
// ---------------------------------------------------------------------------

/**
 * The only form of a URL that may appear in a log line, an error message or an
 * exception: `origin + pathname`. The query string of an `upload_url` carries
 * the `upload_token`, and userinfo carries credentials — both live outside this
 * projection (SECURITY.md § 2.5). An unparsable input yields a placeholder
 * rather than an echo of the raw value.
 */
function safeUrlText(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return '<unparsable url>';
  }
  // Opaque-origin schemes (`data:`, `ftp:`) stringify their origin as "null".
  const origin =
    parsed.origin === 'null' ? `${parsed.protocol}//${parsed.host}` : parsed.origin;
  return `${origin}${parsed.pathname}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** CC-B2: a body that is not JSON is an outcome, not an exception. */
/**
 * TikTok ids are int64 and some arrive as bare JSON numbers
 * (`publicaly_available_post_id`). Past 2^53 a `number` silently rounds to a
 * different id, so an integer that does not fit is kept as its exact source
 * digits instead — the one lossless representation. Uses the reviver's
 * source-text context (Node 22+).
 */
function keepUnsafeIntegers(
  _key: string,
  value: unknown,
  context: { source: string },
): unknown {
  return typeof value === 'number' &&
    !Number.isSafeInteger(value) &&
    /^-?\d+$/.test(context.source)
    ? context.source
    : value;
}

function parseJsonBody(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: false };
  try {
    return {
      ok: true,
      value: JSON.parse(
        text,
        keepUnsafeIntegers as Parameters<typeof JSON.parse>[1],
      ) as unknown,
    };
  } catch {
    return { ok: false };
  }
}

/**
 * Whitespace-collapsed and redacted — in that order, and BEFORE any caller
 * truncates. `redactText` scrubs registered secrets by exact match, so a token
 * the length cap cuts in half is no longer a match and its surviving prefix
 * would reach the message; `TikTokError` redacting again on construction cannot
 * put it back together. Redaction is idempotent, so the later pass is free.
 */
function redactSnippet(text: string): string {
  return redactText(text).replace(/\s+/g, ' ').trim();
}

/** Whitespace-collapsed, redacted, length-capped body excerpt for a CC-B2 message. */
function bodySnippet(text: string): string {
  const oneLine = redactSnippet(text);
  if (oneLine === '') return '<empty body>';
  return oneLine.length <= BODY_SNIPPET_MAX
    ? oneLine
    : `${oneLine.slice(0, BODY_SNIPPET_MAX)}…[truncated]`;
}

function cap(text: string, max: number): string {
  const oneLine = redactSnippet(text);
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

/**
 * An upstream-supplied identifier on its way into an error message. An
 * `error.code` or a `log_id` is as unbounded as any other string TikTok sends,
 * so `UPSTREAM_TEXT_MAX` has to bind on those too: the human-readable message
 * is not the only field a hostile or broken server controls.
 */
function upstreamText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : cap(value, UPSTREAM_TEXT_MAX);
}

function positiveMs(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TikTokError({
      kind: 'validation',
      code: 'invalid_params',
      message: `Invalid arguments: ${name}: must be a finite number of milliseconds greater than 0. No request was sent to TikTok.`,
    });
  }
  return value;
}

function attemptsFrom(retries: number | undefined, fallback: number): number {
  const raw = retries ?? fallback;
  if (!Number.isFinite(raw) || raw < 0) return 1 + fallback;
  return 1 + Math.trunc(raw);
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

function egressBlocked(reason: string, shownUrl: string): TikTokError {
  return new TikTokError({
    kind: 'validation',
    code: 'egress_blocked',
    message:
      `Blocked an outbound request that is not on this server's egress allowlist ` +
      `(${reason}): ${shownUrl}. No request was sent. This is a bug or an attack — ` +
      `the allowlist is a spec-level decision and is never widened at runtime.`,
    remediation:
      'Only https://open.tiktokapis.com and the documented upload hosts are reachable. ' +
      'If TikTok started issuing a new upload host, the host pattern in docs/TIKTOK-API.md § 4.7 must be updated first.',
  });
}

interface FailureContext {
  readonly retryClass: RetryClass;
  readonly shownUrl: string;
  readonly method: string;
  readonly clock: Clock;
  readonly timeoutMs: number;
}

/**
 * CC-B4/CC-B5: for an `init` the transport failure may have happened *after*
 * the request was written, so the upstream state is unknown and the call is
 * terminal with a reconciliation hint. Reads and chunks are replay-safe.
 */
function transportFailure(cause: unknown, ctx: FailureContext): TikTokError {
  if (looksLikeRedirect(cause)) {
    // CC-B6: a redirect off the pinned origin is an egress violation, not a hop.
    return new TikTokError({
      kind: 'validation',
      code: 'egress_blocked',
      message:
        `TikTok answered ${ctx.method} ${ctx.shownUrl} with a redirect. Requests run with ` +
        `redirect: "error" — a redirect off the pinned origin is an egress violation and is ` +
        `never followed. No data was exchanged with the redirect target.`,
      cause,
    });
  }
  if (ctx.retryClass === 'init') {
    return new TikTokError({
      kind: 'network',
      code: 'network_ambiguous',
      message:
        `The connection to TikTok failed during ${ctx.method} ${ctx.shownUrl}. The request may ` +
        `already have been sent, so the outcome is unknown and it is NOT retried automatically.`,
      remediation:
        'Check the publish journal for an intent without an outcome and verify upstream state before creating a new attempt.',
      cause,
    });
  }
  return new TikTokError({
    kind: 'network',
    code: 'network_error',
    message: `The connection to TikTok failed during ${ctx.method} ${ctx.shownUrl}.`,
    retryable: true,
    remediation: 'Check network connectivity and call again.',
    cause,
  });
}

function timeoutFailure(ctx: FailureContext): TikTokError {
  if (ctx.retryClass === 'init') {
    // CC-B5: the init may have succeeded — same rule as CC-B4.
    return new TikTokError({
      kind: 'network',
      code: 'network_ambiguous',
      message:
        `${ctx.method} ${ctx.shownUrl} timed out after ${ctx.timeoutMs} ms. A publish init that ` +
        `times out may still have been processed, so the outcome is unknown and it is NOT retried.`,
      remediation:
        'Check the publish journal for an intent without an outcome and verify upstream state before creating a new attempt.',
    });
  }
  return new TikTokError({
    kind: 'network',
    code: 'timeout',
    message: `${ctx.method} ${ctx.shownUrl} timed out after ${ctx.timeoutMs} ms.`,
    retryable: true,
    remediation:
      'Call again; raise TT_TIMEOUT_MS (or TT_UPLOAD_TIMEOUT_MS for uploads) if this repeats on a healthy connection.',
  });
}

/**
 * A publish init answered by a gateway rather than TikTok — a 5xx without an
 * `error.code`, or any 2xx/5xx body that is not the JSON envelope — says
 * nothing about whether the backend created the task. Same rule as a timeout
 * (CC-B5): the outcome is unknown and the call is terminal.
 */
function gatewayAmbiguousFailure(status: number, ctx: FailureContext): Outcome<never> {
  return {
    ok: false,
    status,
    retryAfterMs: undefined,
    retryable: false,
    error: new TikTokError({
      kind: 'network',
      code: 'network_ambiguous',
      message:
        `${ctx.method} ${ctx.shownUrl} answered HTTP ${status} without a TikTok error envelope. ` +
        `A publish init may still have been processed, so the outcome is unknown and it is NOT retried.`,
      remediation:
        'Check the publish journal for an intent without an outcome and verify upstream state before creating a new attempt.',
    }),
  };
}

/**
 * A success envelope whose `data` is `null`, a scalar or an array. Every
 * endpoint documents an object there, and handing the value on would crash the
 * reader on its first property. For an init that crash would journal `error`,
 * which the duplicate guard lets through, although TikTok said `ok` — so the
 * init reads it as ambiguous and never retries; any other call reads it as an
 * upstream shape change.
 */
function malformedDataFailure(raw: RawResponse, ctx: FailureContext): Outcome<never> {
  const shape =
    `${ctx.method} ${ctx.shownUrl} answered HTTP ${raw.status} with error.code "ok" ` +
    `but a \`data\` that is not an object: ${bodySnippet(raw.bodyText)}`;
  if (ctx.retryClass === 'init') {
    return {
      ok: false,
      status: raw.status,
      retryAfterMs: undefined,
      retryable: false,
      error: new TikTokError({
        kind: 'network',
        code: 'network_ambiguous',
        message: `${shape}. A publish init may still have been accepted, so the outcome is unknown and it is NOT retried.`,
        remediation:
          'Check the publish journal for an intent without an outcome and verify upstream state before creating a new attempt.',
      }),
    };
  }
  return {
    ok: false,
    status: raw.status,
    retryAfterMs: undefined,
    retryable: false,
    error: upstreamFailure({
      kind: 'api',
      message: `TikTok returned an error: ${shape}. This is an upstream response-shape change, not a bad request.`,
      retryable: false,
      remediation: 'Retry later; if it persists, the endpoint contract has changed.',
    }),
  };
}

function initGatewayStatus(status: number): boolean {
  return status >= 500 || (status >= 200 && status < 300);
}

/**
 * Undici surfaces a blocked redirect as a `TypeError: fetch failed` whose cause
 * mentions the redirect; the exact wording is not part of any contract, so the
 * chain is inspected defensively and a miss simply degrades to "network error".
 */
function looksLikeRedirect(cause: unknown): boolean {
  const seen: string[] = [];
  let current: unknown = cause;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    seen.push(current.message);
    const code: unknown = (current as { code?: unknown }).code;
    if (typeof code === 'string') seen.push(code);
    current = current.cause;
  }
  return seen.some((text) => /redirect/i.test(text));
}

function rateLimitFailure(opts: {
  status: number;
  apiCode: string | undefined;
  logId: string | undefined;
  waitMs: number;
  ctx: FailureContext;
}): TikTokError {
  const { ctx } = opts;
  const terminal = ctx.retryClass === 'init';
  // CC-H2: the hint is an ISO-8601 UTC instant derived from the injected clock;
  // every comparison behind it stays numeric epoch milliseconds.
  const hint =
    `Wait until ${new Date(ctx.clock.now() + opts.waitMs).toISOString()} ` +
    `(${Math.ceil(opts.waitMs / 1000)} s) and call again. Do not retry earlier.`;
  return new TikTokError({
    kind: 'api',
    code: 'rate_limited',
    message: terminal
      ? `TikTok rate limit reached on a publish init (HTTP ${opts.status}). A publish init is ` +
        `never retried automatically — the upstream 6/min budget is shared across processes ` +
        `and a blind retry risks a duplicate post.`
      : `TikTok rate limit reached for this endpoint (HTTP ${opts.status}).`,
    retryable: !terminal,
    remediation: hint,
    ...(opts.apiCode === undefined ? {} : { apiCode: opts.apiCode }),
    ...(opts.logId === undefined ? {} : { logId: opts.logId }),
  });
}

function upstreamFailure(opts: {
  kind: ErrorKind;
  message: string;
  retryable: boolean;
  apiCode?: string;
  logId?: string;
  remediation?: string;
}): TikTokError {
  return new TikTokError({
    kind: opts.kind,
    code: opts.kind === 'auth' ? 'oauth_error' : 'upstream_error',
    message: opts.message,
    retryable: opts.retryable,
    ...(opts.apiCode === undefined ? {} : { apiCode: opts.apiCode }),
    ...(opts.logId === undefined ? {} : { logId: opts.logId }),
    ...(opts.remediation === undefined ? {} : { remediation: opts.remediation }),
  });
}

// ---------------------------------------------------------------------------
// allowlist
// ---------------------------------------------------------------------------

function hostAllowed(hostname: string, kind: 'api' | 'upload'): boolean {
  // Exact matches only — `endsWith` would accept `eviltiktokapis.com`, and a
  // non-anchored regex would accept `open.tiktokapis.com.attacker.tld`.
  if (hostname === API_HOST) return true;
  if (kind === 'api') return false;
  return hostname === UPLOAD_HOST || REGIONAL_UPLOAD_HOST_RE.test(hostname);
}

/**
 * The default-deny egress rule as a pure function: the parsed `URL` when the
 * input is accepted, otherwise the `TikTokError` (`kind: "validation"`,
 * `code: "egress_blocked"`) naming the first rule it broke. Nothing is thrown
 * here — `assertAllowedUrl` raises the verdict, and `guardUrl` reads the reason
 * off it for the log line first — so no caller narrows a `catch` binding.
 *
 * Accepted iff **all** of:
 * - the WHATWG parser accepts it as an absolute URL;
 * - scheme is exactly `https:` (an `http:` URL is rejected, never upgraded);
 * - there is no userinfo (`https://user:pw@host` is a classic allowlist bypass);
 * - the port is 443 — either implicit or the explicit `:443` the WHATWG parser
 *   normalizes away; any other authority port is rejected;
 * - `kind: "api"` ⇒ host is exactly `open.tiktokapis.com`;
 *   `kind: "upload"` ⇒ host is exactly `open.tiktokapis.com`, exactly
 *   `open-upload.tiktokapis.com`, or matches
 *   `^upload\.[a-z0-9-]{1,16}\.tiktokapis\.com$` (TIKTOK-API § 4.7 rule 2).
 *
 * Host comparison uses `URL.hostname`, i.e. the parser's IDNA/percent-decoded,
 * lower-cased form: `HTTPS://OPEN.TIKTOKAPIS.COM` is the allowlisted host,
 * while a homograph such as `оpen.tiktokapis.com` becomes `xn--pen-6kc…` and is
 * rejected. A trailing-dot host (`open.tiktokapis.com.`) is a different name
 * and is rejected too.
 */
function checkAllowedUrl(url: string, kind: 'api' | 'upload'): URL | TikTokError {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return egressBlocked('not a parsable absolute URL', '<unparsable url>');
  }
  const shown = safeUrlText(url);
  if (parsed.protocol !== 'https:') {
    return egressBlocked(`scheme "${parsed.protocol}" is not https:`, shown);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return egressBlocked('the URL carries userinfo credentials', shown);
  }
  if (parsed.port !== '') {
    return egressBlocked(`port ${parsed.port} is not 443`, shown);
  }
  if (!hostAllowed(parsed.hostname, kind)) {
    return egressBlocked(`host is not allowlisted for ${kind} calls`, shown);
  }
  return parsed;
}

/**
 * Default-deny egress guard. Throws `TikTokError` (`kind: "validation"`,
 * `code: "egress_blocked"`) before any socket is opened; returns the parsed
 * `URL` so callers reuse the normalized form instead of re-parsing. The rules
 * are `checkAllowedUrl`'s, above.
 */
export function assertAllowedUrl(url: string, kind: 'api' | 'upload'): URL {
  const verdict = checkAllowedUrl(url, kind);
  if (isTikTokError(verdict)) throw verdict;
  return verdict;
}

/**
 * Loopback literals a test-only OAuth origin override may name. `localhost` is
 * excluded on purpose: it is a *name*, and what it resolves to is not this
 * module's to decide. `URL.hostname` keeps IPv6 in its bracketed form.
 */
const LOOPBACK_HOST_RE = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/;

/**
 * The OAuth variant of `guardUrl`: a loopback origin is accepted when the
 * caller opted in (`allowLoopbackOrigin`, see `OauthRequestOptions`); anything
 * else falls through to the unchanged default-deny allowlist.
 */
function guardOauthUrl(
  raw: string,
  allowLoopbackOrigin: boolean,
  logger: Logger,
  fields: Record<string, unknown>,
): URL {
  if (allowLoopbackOrigin) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(raw);
    } catch {
      parsed = undefined;
    }
    if (
      parsed !== undefined &&
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === '' &&
      LOOPBACK_HOST_RE.test(parsed.hostname)
    ) {
      return parsed;
    }
  }
  return guardUrl(raw, 'api', logger, fields);
}

/** Guard + a log line that carries origin and path only (never the query). */
function guardUrl(
  raw: string,
  kind: 'api' | 'upload',
  logger: Logger,
  fields: Record<string, unknown>,
): URL {
  const verdict = checkAllowedUrl(raw, kind);
  if (!isTikTokError(verdict)) return verdict;
  logger.warn('egress blocked', {
    ...fields,
    url: safeUrlText(raw),
    reason: verdict.message,
  });
  throw verdict;
}

// ---------------------------------------------------------------------------
// DNS seam (SECURITY.md § 2.6)
// ---------------------------------------------------------------------------

/**
 * Private, loopback, link-local and otherwise non-routable literals. Used to
 * refuse a DNS answer that points an allowlisted name at an internal address
 * (the DNS-rebinding shape of SSRF). Anything that does not parse as an IP
 * address is refused too — a resolver answer is always a literal, so a string
 * that is not one is not something to connect to.
 */
function isPrivateAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  if (isIPv4(value)) return isPrivateV4(value.split('.').map(Number));
  // Brackets a URL host carries and a zone id (`fe80::1%en0`) are not part of
  // the address itself.
  const v6 = value.replace(/^\[/, '').replace(/\]$/, '').replace(/%.*$/, '');
  if (!isIPv6(v6)) return true;
  return isPrivateV6(ipv6Hextets(v6));
}

/** `octets` are four integers in 0–255 (`isIPv4` or two hextets guarantee it). */
function isPrivateV4(octets: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local (169.254/16, incl. IMDS)
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
  if (a === 192 && b === 168) return true; // private 192.168/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF 192.0.0/24, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast (deprecated)
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  return a >= 224; // multicast + reserved + broadcast
}

/**
 * The eight 16-bit groups of a valid IPv6 literal. The WHATWG URL serializer
 * does the normalization — it compresses, lowercases and rewrites an embedded
 * dotted IPv4 tail as two hex groups — so only the `::` gap is left to expand.
 * Classifying the groups rather than the text is what closes the spellings a
 * textual match misses: `0:0:0:0:0:0:0:0`, `::ffff:7f00:1`, `0::1`.
 */
function ipv6Hextets(v6: string): number[] {
  const host = new URL(`http://[${v6}]/`).hostname.slice(1, -1);
  const [head = '', tail] = host.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const gap = new Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...gap, ...right].map((group) => parseInt(group, 16));
}

/** The IPv4 address carried in two hextets. */
function embeddedV4(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isPrivateV6(h: readonly number[]): boolean {
  const [h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0, h7 = 0] = h;
  const zeroTo4 = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0;
  // `::/96` (unspecified, loopback, the deprecated IPv4-compatible form) and
  // `::ffff:0:0/96` (IPv4-mapped): classified by the IPv4 they carry, which
  // makes `::` 0.0.0.0 and `::1` 0.0.0.1 — both "this network", both refused.
  if (zeroTo4 && (h5 === 0 || h5 === 0xffff)) return isPrivateV4(embeddedV4(h6, h7));
  // `::ffff:0:0:0/96` (SIIT, IPv4-translated): the same rule, one group over.
  const zeroTo3 = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0;
  if (zeroTo3 && h4 === 0xffff && h5 === 0) return isPrivateV4(embeddedV4(h6, h7));
  if (h0 === 0x64 && h1 === 0xff9b) {
    // NAT64: the well-known /96 translates the IPv4 it carries; the local-use
    // 64:ff9b:1::/48 is private by definition.
    if (h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0)
      return isPrivateV4(embeddedV4(h6, h7));
    return h2 === 1;
  }
  // Only global unicast `2000::/3` is ever a public destination. Everything
  // outside it — the rest of `0000::/8`, discard `100::/64` and the dummy
  // prefix, SRv6 SIDs `5f00::/16`, unique-local `fc00::/7`, link- and
  // site-local `fe80::/9`, multicast `ff00::/8`, and the IETF-reserved space in
  // between — is refused by this one rule rather than an enumeration.
  if ((h0 & 0xe000) !== 0x2000) return true;
  if (h0 === 0x2002) return isPrivateV4(embeddedV4(h1, h2)); // 6to4 2002::/16
  // IETF protocol assignments 2001::/23 (Teredo, ORCHID, benchmarking, ...)
  // and documentation 2001:db8::/32 and 3fff::/20.
  if (h0 === 0x2001 && (h1 < 0x200 || h1 === 0xdb8)) return true;
  return h0 === 0x3fff && h1 < 0x1000;
}

/**
 * Honors the injectable `lookup` seam.
 *
 * Node's global `fetch` (undici) exposes no per-request `lookup`/connect hook,
 * and adding a dependency to get one is out of scope, so full resolve-and-pin
 * stays deferred exactly as SECURITY.md § 2.6 says. What this does instead —
 * and all it claims to do — is a **pre-flight resolution check**: when a
 * `lookup` is injected, the allowlisted hostname is resolved and the request is
 * refused if *any* answer is a loopback/private/link-local/multicast address.
 * There is a TOCTOU gap between this resolution and undici's own (a rebinding
 * attacker with control over an allowlisted name's DNS could still win it), so
 * this is defense in depth on top of the allowlist and TLS, not a pin.
 *
 * With no `lookup` injected (the v1 default) nothing extra happens and no
 * second resolution is spent.
 */
async function preflightDns(
  hostname: string,
  lookup: LookupFn | undefined,
  logger: Logger,
  fields: Record<string, unknown>,
): Promise<void> {
  if (lookup === undefined) return;
  const addresses = await new Promise<readonly { address: string; family: number }[]>(
    (resolve, reject) => {
      lookup(hostname, { all: true }, (error, result) => {
        if (error !== null) {
          reject(
            new TikTokError({
              kind: 'network',
              code: 'network_error',
              message: `Could not resolve ${hostname}: ${cap(error.message, 120)}`,
              retryable: true,
              remediation: 'Check DNS/network connectivity and call again.',
              cause: error,
            }),
          );
          return;
        }
        resolve(result);
      });
    },
  );
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      logger.warn('egress blocked', { ...fields, hostname, reason: 'private_address' });
      throw egressBlocked(
        `DNS resolved ${hostname} to the non-routable address ${entry.address}`,
        `https://${hostname}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// waiting (CC-B3, CC-H1)
// ---------------------------------------------------------------------------

/**
 * Sleep until a wall-clock deadline, re-deriving the remaining time from
 * `clock.now()` after every bounded slice (CC-H1). If the process was suspended
 * across the wait, the first wake sees the deadline already passed and returns
 * at once instead of sleeping the nominal amount again.
 */
async function sleepUntil(
  clock: Clock,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<void> {
  for (;;) {
    const remaining = deadlineMs - clock.now();
    if (remaining <= 0) return;
    await clock.sleep(Math.min(remaining, SLEEP_SLICE_MS), signal);
  }
}

/**
 * CC-B3: `Retry-After` in both documented forms — delay-seconds and HTTP-date.
 * Anything else (empty, negative, fractional, a bare token) yields `undefined`
 * so the caller falls back to exponential backoff; the result is never `NaN`.
 */
function parseRetryAfterMs(header: string | null, nowMs: number): number | undefined {
  if (header === null) return undefined;
  const raw = header.trim();
  if (raw === '') return undefined;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }
  // An HTTP-date always carries alphabetic month/weekday tokens; requiring them
  // keeps `Date.parse` away from inputs like "-5" whose parse is engine folklore.
  if (!/[a-z]{3}/i.test(raw)) return undefined;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  const delta = at - nowMs;
  return delta > 0 ? delta : 0;
}

/**
 * `min(500·2^n, 8000) + jitter`, or the (capped) `Retry-After` when the server
 * sent one. Both forms are clamped to `min(30 s, remaining budget)` — CC-B3.
 */
function waitForAttempt(opts: {
  attempt: number;
  retryAfterMs: number | undefined;
  remainingBudgetMs: number;
  random: () => number;
}): number {
  const ceiling = Math.max(0, Math.min(RETRY_AFTER_MAX_MS, opts.remainingBudgetMs));
  if (opts.retryAfterMs !== undefined) return Math.min(opts.retryAfterMs, ceiling);
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (opts.attempt - 1), BACKOFF_MAX_MS);
  const jitter = Math.floor(base * BACKOFF_JITTER_FRACTION * opts.random());
  return Math.min(base + jitter, ceiling);
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

interface RawResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly bodyText: string;
}

/**
 * Everything this module ever sends: a JSON/form string, or an upload chunk as
 * bytes or a stream. Spelled out rather than borrowing the DOM's `BodyInit`,
 * which is not a global under `lib: ES2023` + `@types/node` — and a narrower
 * type is the point anyway, since nothing here may send a `FormData` or a
 * `Blob`.
 */
type RequestBody = string | Uint8Array | ReadableStream<Uint8Array>;

interface RequestSpec {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: RequestBody;
  readonly duplex?: 'half';
}

/**
 * One attempt: compose `timeoutMs` with the caller's `signal`, run `fetch` with
 * `redirect: "error"` (CC-B6), and read the body inside the same window.
 *
 * The timeout is a `Clock` deadline, not `AbortSignal.timeout`, so it is
 * mock-drivable and honors CC-H1. Whichever of the two abort sources fires
 * first is the one reported: a caller abort propagates verbatim (its own
 * `AbortError`), a timeout becomes an actionable `TikTokError`. The timeout
 * waiter is always cancelled before returning, so no timer outlives the call.
 */
async function performRequest(
  target: URL,
  spec: RequestSpec,
  ctx: FailureContext & { signal?: AbortSignal },
): Promise<RawResponse> {
  const callerSignal = ctx.signal;
  if (callerSignal?.aborted === true) throw callerSignal.reason;

  const controller = new AbortController();
  let firstCause: 'timeout' | 'caller' | undefined;
  let abortReason: unknown;

  const detachCallerAbort = ((): (() => void) => {
    if (callerSignal === undefined) return () => undefined;
    const onAbort = (): void => {
      firstCause ??= 'caller';
      abortReason = callerSignal.reason;
      controller.abort(callerSignal.reason);
    };
    callerSignal.addEventListener('abort', onAbort, { once: true });
    return () => {
      callerSignal.removeEventListener('abort', onAbort);
    };
  })();

  const stopTimer = new AbortController();
  const timer = sleepUntil(
    ctx.clock,
    ctx.clock.now() + ctx.timeoutMs,
    stopTimer.signal,
  ).then(
    () => {
      firstCause ??= 'timeout';
      controller.abort(new Error('tiktok-mcp: request timeout'));
    },
    () => undefined,
  );

  // The outer `try` owns the cleanup, the inner one turns a fetch failure into
  // the right error. Nested rather than one `try/catch/finally` so the `finally`
  // is reached only by a return or an unwinding throw — every arm of the inner
  // `catch` throws, and there is no fall-through edge into the cleanup. The
  // `finally` body itself runs on every call.
  try {
    try {
      const response = await globalThis.fetch(target, {
        ...spec,
        redirect: 'error',
        signal: controller.signal,
      });
      const bodyText = await response.text();
      return { status: response.status, headers: response.headers, bodyText };
    } catch (error) {
      if (firstCause === 'caller') throw abortReason;
      if (firstCause === 'timeout') throw timeoutFailure(ctx);
      throw transportFailure(error, ctx);
    }
  } finally {
    stopTimer.abort();
    await timer;
    detachCallerAbort();
  }
}

// ---------------------------------------------------------------------------
// retry engine
// ---------------------------------------------------------------------------

type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: TikTokError;
      readonly retryable: boolean;
      readonly retryAfterMs: number | undefined;
      readonly status?: number;
    };

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * Turn a *thrown* attempt failure into a ladder outcome. Everything that never
 * produced an HTTP response — a blocked DNS answer, a timeout, a socket error —
 * arrives as a throw rather than a status, and the retry classes are defined
 * over those too (a `read` retries a transport failure, an `init` does not), so
 * they have to reach `withRetries` as outcomes instead of unwinding past it.
 * `retryable` is taken from the error, which is where the class decision was
 * already made. A caller abort is not an outcome and is rethrown verbatim.
 */
function outcomeFromThrow<T>(error: unknown): Outcome<T> {
  if (!isTikTokError(error)) throw error;
  return { ok: false, error, retryable: error.retryable, retryAfterMs: undefined };
}

/**
 * The shared attempt loop. `attempt` runs one try; a failed outcome is retried
 * only while the class allows it, the attempt budget is unspent, and the
 * wall-clock budget still has room. Every wait goes through `sleepUntil`, so a
 * caller abort during a backoff surfaces as that abort.
 *
 * The ladder is a `while` over a failed outcome: each round either throws the
 * last error or waits and tries again, and the first success is both the loop's
 * exit condition and the function's value.
 */
async function withRetries<T>(
  opts: {
    attempts: number;
    retryClass: RetryClass;
    clock: Clock;
    logger: Logger;
    random: () => number;
    budgetDeadlineMs: number;
    signal?: AbortSignal;
    fields: Record<string, unknown>;
  },
  attempt: (attemptNo: number) => Promise<Outcome<T>>,
): Promise<T> {
  let attemptNo = 1;
  let outcome = await attempt(attemptNo);
  while (!outcome.ok) {
    const lastAttempt = attemptNo >= opts.attempts;
    const remainingBudgetMs = opts.budgetDeadlineMs - opts.clock.now();
    if (!outcome.retryable || lastAttempt || remainingBudgetMs <= 0) {
      opts.logger.warn('tiktok request failed', {
        ...opts.fields,
        attempt: attemptNo,
        attempts: opts.attempts,
        retry_class: opts.retryClass,
        code: outcome.error.code,
        retryable: outcome.error.retryable,
        ...(outcome.status === undefined ? {} : { status: outcome.status }),
      });
      throw outcome.error;
    }

    const waitMs = waitForAttempt({
      attempt: attemptNo,
      retryAfterMs: outcome.retryAfterMs,
      remainingBudgetMs,
      random: opts.random,
    });
    opts.logger.warn('tiktok request retry', {
      ...opts.fields,
      attempt: attemptNo,
      attempts: opts.attempts,
      retry_class: opts.retryClass,
      code: outcome.error.code,
      retry_after_s: Math.ceil(waitMs / 1000),
      retry_at: new Date(opts.clock.now() + waitMs).toISOString(),
      ...(outcome.status === undefined ? {} : { status: outcome.status }),
    });
    await sleepUntil(opts.clock, opts.clock.now() + waitMs, opts.signal);
    attemptNo += 1;
    outcome = await attempt(attemptNo);
  }
  return outcome.value;
}

// ---------------------------------------------------------------------------
// ttRequest — the {data,error} envelope decoder
// ---------------------------------------------------------------------------

interface Envelope {
  readonly apiCode: string | undefined;
  readonly apiMessage: string | undefined;
  readonly logId: string | undefined;
  readonly hasData: boolean;
  readonly data: unknown;
}

function readEnvelope(record: Record<string, unknown>): Envelope {
  const error = asRecord(record['error']);
  // CC-B9: `log_id` may be missing anywhere it is normally expected.
  const logId = asString(error?.['log_id']) ?? asString(record['log_id']);
  return {
    apiCode: asString(error?.['code']),
    apiMessage: asString(error?.['message']),
    logId,
    hasData: 'data' in record,
    data: record['data'],
  };
}

function decodeEnvelope<T>(raw: RawResponse, ctx: FailureContext): Outcome<T> {
  const retryAfterMs = parseRetryAfterMs(raw.headers.get('retry-after'), ctx.clock.now());
  const parsed = parseJsonBody(raw.bodyText);
  const classRetryable = ctx.retryClass !== 'init';
  const rateLimited = (apiCode?: string, logId?: string): Outcome<T> => {
    const waitMs =
      retryAfterMs ??
      waitForAttempt({
        attempt: 1,
        retryAfterMs: undefined,
        remainingBudgetMs: RETRY_AFTER_MAX_MS,
        random: () => 0,
      });
    return {
      ok: false,
      status: raw.status,
      retryAfterMs,
      retryable: classRetryable,
      error: rateLimitFailure({ status: raw.status, apiCode, logId, waitMs, ctx }),
    };
  };
  // CC-B8: a 429 is the rate limit whatever its body — an edge that answers
  // with an empty or HTML page still means "wait", not "upstream error".
  if (raw.status === 429 && (!parsed.ok || asRecord(parsed.value) === undefined)) {
    return rateLimited();
  }

  if (!parsed.ok) {
    if (!classRetryable && initGatewayStatus(raw.status)) {
      return gatewayAmbiguousFailure(raw.status, ctx);
    }
    // CC-B2: HTML/empty/truncated gateway body — never a JSON.parse crash.
    return {
      ok: false,
      status: raw.status,
      retryAfterMs,
      retryable: classRetryable && isRetryableStatus(raw.status),
      error: upstreamFailure({
        kind: 'api',
        message:
          `TikTok answered ${ctx.method} ${ctx.shownUrl} with HTTP ${raw.status} and a body that ` +
          `is not the documented JSON envelope: ${bodySnippet(raw.bodyText)}`,
        retryable: classRetryable && isRetryableStatus(raw.status),
        remediation:
          'Usually a gateway or proxy in front of TikTok. Retry later; if it persists, quote the HTTP status to TikTok support.',
      }),
    };
  }

  const record = asRecord(parsed.value);
  if (record === undefined) {
    if (!classRetryable && initGatewayStatus(raw.status)) {
      return gatewayAmbiguousFailure(raw.status, ctx);
    }
    return {
      ok: false,
      status: raw.status,
      retryAfterMs,
      retryable: classRetryable && isRetryableStatus(raw.status),
      error: upstreamFailure({
        kind: 'api',
        message:
          `TikTok answered ${ctx.method} ${ctx.shownUrl} with HTTP ${raw.status} and a JSON value ` +
          `that is not an object: ${bodySnippet(raw.bodyText)}`,
        retryable: classRetryable && isRetryableStatus(raw.status),
      }),
    };
  }

  const envelope = readEnvelope(record);

  // CC-B1: HTTP 200 is not success — `error.code === "ok"` is.
  const upstreamFailed = envelope.apiCode !== undefined && envelope.apiCode !== 'ok';
  if (!upstreamFailed && raw.status >= 200 && raw.status < 300) {
    if (envelope.hasData && asRecord(envelope.data) === undefined) {
      return malformedDataFailure(raw, ctx);
    }
    return { ok: true, value: (envelope.hasData ? envelope.data : parsed.value) as T };
  }

  if (raw.status === 429 || envelope.apiCode === 'rate_limit_exceeded') {
    return rateLimited(envelope.apiCode, envelope.logId);
  }

  if (!classRetryable && raw.status >= 500 && envelope.apiCode === undefined) {
    return gatewayAmbiguousFailure(raw.status, ctx);
  }

  const retryable =
    classRetryable &&
    (isRetryableStatus(raw.status) || envelope.apiCode === 'internal_error');
  const detail =
    envelope.apiMessage === undefined
      ? ''
      : ` — ${cap(envelope.apiMessage, UPSTREAM_TEXT_MAX)}`;
  return {
    ok: false,
    status: raw.status,
    retryAfterMs,
    retryable,
    error: upstreamFailure({
      kind: 'api',
      message:
        `TikTok returned an error for ${ctx.method} ${ctx.shownUrl}: ` +
        `${upstreamText(envelope.apiCode) ?? `HTTP ${raw.status}`} (HTTP ${raw.status}, ` +
        `log_id ${upstreamText(envelope.logId) ?? 'absent'})${detail}`,
      retryable,
      ...(envelope.apiCode === undefined ? {} : { apiCode: envelope.apiCode }),
      ...(envelope.logId === undefined ? {} : { logId: envelope.logId }),
    }),
  };
}

/**
 * A data-endpoint call: egress-guarded, envelope-decoded (CC-B1/CC-B2/CC-B9),
 * retried per its class (CC-B7) and resolved with the envelope's `data` payload
 * (or the whole object when the endpoint answers without a `data` member).
 *
 * Defaults: `timeoutMs` 30_000 (`TT_TIMEOUT_MS`), `maxAttempts` 3 for the
 * `read` class and 1 for every other class, `budgetMs` `timeoutMs *
 * maxAttempts`, `clock` `systemClock`, `random` `Math.random`, `logger` silent.
 */
export async function ttRequest<T>(opts: TtRequestOptions): Promise<T> {
  const clock = opts.clock ?? systemClock;
  const logger = opts.logger ?? silentLogger;
  const random = opts.random ?? Math.random;
  const timeoutMs = positiveMs(opts.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const attempts =
    opts.retryClass === 'read'
      ? Math.max(1, Math.trunc(opts.maxAttempts ?? DEFAULT_READ_ATTEMPTS))
      : 1;
  const shownUrl = safeUrlText(opts.url);
  const fields = { method: opts.method, url: shownUrl, retry_class: opts.retryClass };

  if (opts.method === 'GET' && opts.body !== undefined) {
    throw new TikTokError({
      kind: 'validation',
      code: 'invalid_params',
      message:
        'Invalid arguments: body: a GET request cannot carry a body — put parameters in the query string. No request was sent to TikTok.',
    });
  }

  const target = guardUrl(opts.url, 'api', logger, fields);
  // Defense in depth: the credential store registers tokens too, but an error
  // built here must never be able to quote one (SECURITY.md § Redaction).
  if (opts.bearer !== undefined) registerSecret(opts.bearer);

  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  const spec: RequestSpec = {
    method: opts.method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  };
  if (opts.body !== undefined)
    headers['content-type'] = 'application/json; charset=UTF-8';

  const ctx: FailureContext & { signal?: AbortSignal } = {
    retryClass: opts.retryClass,
    shownUrl,
    method: opts.method,
    clock,
    timeoutMs,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  };

  return withRetries<T>(
    {
      attempts,
      retryClass: opts.retryClass,
      clock,
      logger,
      random,
      budgetDeadlineMs:
        clock.now() + positiveMs(opts.budgetMs, timeoutMs * attempts, 'budgetMs'),
      fields,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    },
    async (attemptNo) => {
      logger.debug('tiktok request', {
        ...fields,
        attempt: attemptNo,
        timeout_ms: timeoutMs,
      });
      try {
        await preflightDns(target.hostname, opts.lookup, logger, fields);
        const raw = await performRequest(target, spec, ctx);
        logger.debug('tiktok response', {
          ...fields,
          attempt: attemptNo,
          status: raw.status,
        });
        return decodeEnvelope<T>(raw, ctx);
      } catch (error) {
        return outcomeFromThrow<T>(error);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// oauthRequest — the flat OAuth decoder (CC-A12)
// ---------------------------------------------------------------------------

function encodeFormBody(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  const record = asRecord(body);
  if (record === undefined) {
    throw new TikTokError({
      kind: 'validation',
      code: 'invalid_params',
      message:
        'Invalid arguments: body: an OAuth request body must be a string, URLSearchParams, or a flat object of string values. No request was sent to TikTok.',
    });
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    params.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return params.toString();
}

/**
 * A token-endpoint call. Three differences from `ttRequest`, all load-bearing:
 *
 * - the **flat** OAuth shape (`error` / `error_description` / `log_id`) is
 *   decoded and the `{data,error}` envelope decoder is never applied (CC-A12) —
 *   the resolved value is the response object verbatim, `data` and all;
 * - the body is form-encoded (`application/x-www-form-urlencoded`), as the
 *   token endpoints require;
 * - it is **never retried** (ARCHITECTURE § 6) and never sends an
 *   `Authorization` header — the client credentials live in the form body, so a
 *   `bearer` passed in the options is deliberately ignored.
 */
export async function oauthRequest<T>(opts: OauthRequestOptions): Promise<T> {
  const clock = opts.clock ?? systemClock;
  const logger = opts.logger ?? silentLogger;
  const timeoutMs = positiveMs(opts.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const shownUrl = safeUrlText(opts.url);
  const fields = { method: opts.method, url: shownUrl, retry_class: 'init' };
  const target = guardOauthUrl(
    opts.url,
    opts.allowLoopbackOrigin ?? false,
    logger,
    fields,
  );

  const headers: Record<string, string> = { accept: 'application/json' };
  const spec: RequestSpec = {
    method: opts.method,
    headers,
    ...(opts.body === undefined ? {} : { body: encodeFormBody(opts.body) }),
  };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }

  const ctx: FailureContext & { signal?: AbortSignal } = {
    // OAuth calls share the `init` failure semantics: they are never retried.
    retryClass: 'init',
    shownUrl,
    method: opts.method,
    clock,
    timeoutMs,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  };

  logger.debug('tiktok oauth request', { ...fields, timeout_ms: timeoutMs });
  await preflightDns(target.hostname, opts.lookup, logger, fields);
  const raw = await performRequest(target, spec, ctx);
  logger.debug('tiktok oauth response', { ...fields, status: raw.status });

  const parsed = parseJsonBody(raw.bodyText);
  const record = parsed.ok ? asRecord(parsed.value) : undefined;
  if (record === undefined) {
    throw upstreamFailure({
      kind: 'api',
      message:
        `The TikTok token endpoint answered ${ctx.method} ${shownUrl} with HTTP ${raw.status} and ` +
        `a body that is not a JSON object: ${bodySnippet(raw.bodyText)}`,
      retryable: false,
      remediation:
        'Usually a gateway in front of TikTok. Try the login/refresh again later.',
    });
  }

  const flatError = asString(record['error']);
  const logId = asString(record['log_id']);
  if (flatError !== undefined && flatError !== '') {
    const description = asString(record['error_description']);
    throw upstreamFailure({
      kind: 'auth',
      message:
        `The TikTok token endpoint rejected the request: ${cap(flatError, UPSTREAM_TEXT_MAX)} ` +
        `(HTTP ${raw.status}, log_id ${upstreamText(logId) ?? 'absent'})` +
        (description === undefined ? '' : ` — ${cap(description, UPSTREAM_TEXT_MAX)}`),
      retryable: false,
      apiCode: flatError,
      ...(logId === undefined ? {} : { logId }),
    });
  }
  if (raw.status < 200 || raw.status >= 300) {
    throw upstreamFailure({
      kind: 'api',
      message:
        `The TikTok token endpoint answered HTTP ${raw.status} without an OAuth error field ` +
        `(log_id ${upstreamText(logId) ?? 'absent'}).`,
      retryable: false,
      ...(logId === undefined ? {} : { logId }),
    });
  }
  // `record` is `parsed.value` narrowed to an object — the guard above already
  // rejected everything else, so this is the same value, minus a re-narrowing.
  return record as T;
}

// ---------------------------------------------------------------------------
// putChunk — raw HTTP upload PUT (TIKTOK-API § 1.3, § 4.6–4.8)
// ---------------------------------------------------------------------------

/** `bytes 0-{UPLOADED_BYTES}/{TOTAL}` on the response — the 416 resync source. */
function parseUploadedBytes(headers: Headers): number | undefined {
  const raw = headers.get('content-range');
  if (raw === null) return undefined;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(raw.trim());
  if (match === null) return undefined;
  const uploaded = Number(match[2]);
  return Number.isFinite(uploaded) ? uploaded : undefined;
}

/**
 * One chunk of a FILE_UPLOAD transfer.
 *
 * Contract points that are not negotiable:
 *
 * - **No `Authorization` header, ever.** The `upload_token` inside the URL is
 *   the credential (TIKTOK-API § 4.7 rule 4), which also means a long upload
 *   survives access-token expiry (CC-A3).
 * - The token is registered with `core/redact` and the URL is never logged or
 *   quoted beyond `origin + pathname` — not in a log line, not in an error.
 * - `Content-Range` is byte-identical across retries: it is built once and the
 *   same headers object is reused, so a retry cannot drift (CC-D6).
 *
 * Resolution vs rejection: any HTTP status TikTok actually returned resolves as
 * `ChunkPutResult` — including the terminal 4xx ones (400 planner bug, 403
 * expired URL, 404 unknown task) and 416, whose `uploadedBytes` is the resync
 * source. Mapping those statuses to user-facing outcomes is the api layer's job
 * (§ 4.8); this function only decides what is *retried*: 5xx, timeout and
 * network failures, `1 + chunkRetries` times, 4xx never. A failure with no HTTP
 * response at all (network, timeout, exhausted retries) rejects with
 * `TikTokError`.
 *
 * A `ReadableStream` body cannot be replayed, so it is attempted once; the
 * caller re-reads the byte range and calls again (the range makes that safe).
 */
export async function putChunk(opts: PutChunkOptions): Promise<ChunkPutResult> {
  const clock = opts.clock ?? systemClock;
  const logger = opts.logger ?? silentLogger;
  const random = opts.random ?? Math.random;
  const timeoutMs = positiveMs(opts.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const shownUrl = safeUrlText(opts.uploadUrl);
  const fields = {
    method: 'PUT',
    upload_url: shownUrl,
    retry_class: 'chunk',
    content_range: opts.contentRange,
  };

  const target = guardUrl(opts.uploadUrl, 'upload', logger, fields);
  const uploadToken = target.searchParams.get('upload_token');
  // SECURITY.md § 2.5: the upload_token is a bearer-equivalent secret sink.
  if (uploadToken !== null) registerSecret(uploadToken);

  const replayable = opts.body instanceof Uint8Array;
  const attempts = replayable
    ? attemptsFrom(opts.chunkRetries, DEFAULT_CHUNK_RETRIES)
    : 1;
  if (!replayable) {
    logger.debug('chunk body is not replayable — in-call retries disabled', fields);
  }

  const headers: Record<string, string> = {
    'content-range': opts.contentRange,
    'content-type': opts.contentType,
  };
  const contentLength =
    opts.contentLength ??
    (opts.body instanceof Uint8Array ? opts.body.byteLength : undefined);
  if (contentLength !== undefined) headers['content-length'] = String(contentLength);

  const spec: RequestSpec = {
    method: 'PUT',
    headers,
    body: opts.body,
    ...(replayable ? {} : { duplex: 'half' as const }),
  };

  const ctx: FailureContext & { signal?: AbortSignal } = {
    retryClass: 'chunk',
    shownUrl,
    method: 'PUT',
    clock,
    timeoutMs,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  };

  return withRetries<ChunkPutResult>(
    {
      attempts,
      retryClass: 'chunk',
      clock,
      logger,
      random,
      budgetDeadlineMs:
        clock.now() + positiveMs(opts.budgetMs, timeoutMs * attempts, 'budgetMs'),
      fields,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    },
    async (attemptNo) => {
      logger.debug('chunk put', { ...fields, attempt: attemptNo, timeout_ms: timeoutMs });
      let raw: RawResponse;
      try {
        await preflightDns(target.hostname, opts.lookup, logger, fields);
        raw = await performRequest(target, spec, ctx);
      } catch (error) {
        return outcomeFromThrow<ChunkPutResult>(error);
      }
      const uploadedBytes = parseUploadedBytes(raw.headers);
      logger.debug('chunk put response', {
        ...fields,
        attempt: attemptNo,
        status: raw.status,
        ...(uploadedBytes === undefined ? {} : { uploaded_bytes: uploadedBytes }),
      });

      // 5xx is officially retryable with an identical Content-Range (§ 4.8).
      if (raw.status >= 500 && raw.status <= 599) {
        return {
          ok: false,
          status: raw.status,
          retryAfterMs: parseRetryAfterMs(raw.headers.get('retry-after'), clock.now()),
          retryable: true,
          error: new TikTokError({
            kind: 'network',
            code: 'upstream_error',
            message:
              `TikTok answered chunk PUT ${shownUrl} (${opts.contentRange}) with HTTP ` +
              `${raw.status}: ${bodySnippet(raw.bodyText)}`,
            retryable: true,
            remediation:
              'The identical byte range may be re-sent; the upload URL stays valid for about an hour after init.',
          }),
        };
      }

      return {
        ok: true,
        value: {
          status: raw.status,
          ...(uploadedBytes === undefined ? {} : { uploadedBytes }),
        },
      };
    },
  );
}

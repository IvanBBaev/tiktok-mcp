/**
 * Allowlist redaction — the primitive that sits BELOW every sink
 * (ARCHITECTURE.md § 10, SECURITY.md § Redaction). The logger, error
 * construction, doctor output, journal appends and tool results all pass their
 * payloads through this module before serialization; a second implementation
 * must not exist anywhere in the codebase.
 *
 * Two complementary defenses:
 *
 * 1. `redactValue` — structural, **allowlist-based and default-deny**: a key
 *    that is not on `ALLOWED_KEYS` has its value replaced by `[REDACTED]`,
 *    recursively, at every depth. Unknown keys are never passed through, so a
 *    newly introduced secret-bearing field is safe on the day it appears; the
 *    key name itself is scrubbed too, so a secret used *as* a key cannot leak.
 * 2. `registerSecret` / `redactText` — exact-value scrubbing of free text
 *    (error messages, body snippets — CC-B2), which catches secrets embedded
 *    in query strings and form bodies that key-based rules cannot see.
 *
 * The module is deliberately dependency-free (Layer 0, no imports at all) and
 * never throws: it is the last thing that runs before bytes hit a sink.
 */

/** Replacement for any denied value. */
const REDACTED = '[REDACTED]';

/** Replacement for a value already visited on the current path. */
const CIRCULAR = '[CIRCULAR]';

/** Replacement for the value of a scrubbed query/form parameter. */
const PARAM_REDACTED = 'REDACTED';

/** Deeper structures are denied wholesale rather than walked forever. */
const MAX_DEPTH = 8;

/**
 * Values shorter than this are ignored by `registerSecret`. No credential in
 * the secrets inventory (SECURITY.md) is this short, while registering a
 * one- or two-character value would scrub every log line into noise.
 */
const MIN_SECRET_LENGTH = 4;

/**
 * Query/form parameters whose value is a credential wherever it appears.
 * `state`, `code` and `code_verifier` are login-flow secrets (SECURITY.md
 * secrets inventory); `upload_token` is the upload-session bearer carried in
 * the `upload_url` query string.
 */
const SENSITIVE_PARAM_RE =
  /(^|[?&\s;])(upload_token|access_token|refresh_token|client_secret|client_key|code_verifier|code_challenge|state|code)=([^&\s"'#]*)/gi;

/** `Authorization: Bearer <token>` renders as `Bearer ***` (ARCHITECTURE § 10). */
const BEARER_RE = /\b(bearer\s+)[\w.~+/=-]+/gi;

/** A whole string that is nothing but an http(s) URL. */
const BARE_URL_RE = /^https?:\/\/\S+$/i;

/**
 * Log/journal/error field names whose *values* may be serialized. Everything
 * else is denied. Written in canonical snake_case and matched
 * separator-insensitively, so `log_id`, `logId` and `LOG_ID` are one entry.
 *
 * Adding a key here is a security decision: it must be a name whose value can
 * never carry a credential. `code` is on the list because it is the stable
 * machine error code of `TikTokError` / `ToolResult.error`; the OAuth
 * authorization `code` shares the name, which is exactly why that value is
 * also registered with `registerSecret` (defense in depth).
 */
const ALLOWED_KEYS: ReadonlySet<string> = new Set(
  [
    // Log envelope (core/log.ts)
    'level',
    'time',
    'ts',
    'msg',
    'message',
    'text',
    'logger',
    'component',
    'event',
    'name',
    // Identity — pseudonymous, truncated by the caller (ARCHITECTURE § 10)
    'open_id',
    'profile',
    'active_profile',
    'account',
    'display_name',
    // Errors and tool results (core/errors.ts, mcp/result.ts)
    'kind',
    'code',
    'api_code',
    'error_code',
    'log_id',
    'retryable',
    'remediation',
    'reason',
    'fail_reason',
    'ok',
    'error',
    'journal',
    'hints',
    'type',
    'action',
    'command',
    'truncated',
    // HTTP (core/http.ts) — `url`/`upload_url` additionally lose any query
    // string, see `stripUrlCredentials`
    'method',
    'url',
    'upload_url',
    'host',
    'hostname',
    'path',
    'pathname',
    'port',
    'status',
    'http_status',
    'status_code',
    'retry_class',
    'attempt',
    'attempts',
    'retry_after_s',
    'retry_at',
    'duration_ms',
    'timeout_ms',
    'redirect',
    'content_range',
    'content_type',
    'content_length',
    'bytes',
    'uploaded_bytes',
    'body_snippet',
    // OAuth — allowlist logging only (ARCHITECTURE § 10)
    'grant_type',
    'scope',
    'scopes',
    'expires_in',
    'token_type',
    'access_expires_at',
    'refresh_expires_at',
    // Write safety / plan store (mcp/plan-store.ts)
    'plan_id',
    'digest',
    'payload_digest',
    'expires_at',
    'created_at',
    'used',
    'outstanding',
    'write_mode',
    'mode',
    'force',
    'duplicate',
    'matched_attempt_id',
    'ttl_s',
    // Journal (mcp/journal.ts)
    'v',
    'attempt_id',
    'tool',
    'source',
    'result',
    'publish_id',
    'poll_after',
    'chunk',
    'records',
    'skipped_lines',
    'rotated',
    'limit',
    // Publish / media payload metadata
    'title',
    'title_excerpt',
    'description',
    'privacy_level',
    'video_id',
    'video_ids',
    'missing_ids',
    'cursor',
    'has_more',
    'max_count',
    'count',
    'index',
    'total',
    'total_chunks',
    'total_chunk_count',
    'chunk_index',
    'chunk_size',
    'file_size',
    'file_path',
    'media_root',
    // Process / configuration diagnostics
    'env_file',
    'dir',
    'platform',
    'version',
    'node_version',
    'transport',
    'package',
    'packages',
    'pid',
  ].map(normalizeKey),
);

/** Own properties of an `Error` handled explicitly (or dropped, for `stack`). */
const ERROR_INTRINSIC_KEYS: ReadonlySet<string> = new Set(['name', 'message', 'stack']);

/** Exact secret values, registered by the subsystems that mint or read them. */
const registeredSecrets = new Set<string>();

/** Separator- and case-insensitive key identity: `log_id` ≡ `logId` ≡ `LOG_ID`. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isAllowedKey(key: string): boolean {
  return ALLOWED_KEYS.has(normalizeKey(key));
}

/**
 * Register an exact secret value (tokens, `client_secret`, `upload_token` —
 * `upload_token` is a secret sink per SECURITY.md § Egress control). Values
 * shorter than `MIN_SECRET_LENGTH` are ignored; registration is idempotent.
 */
export function registerSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) return;
  registeredSecrets.add(secret);
}

/**
 * Scrub every registered secret out of free text (error messages, body
 * snippets), then mask the credential shapes that survive registration gaps:
 * sensitive query/form parameters by name and `Bearer` tokens. Idempotent.
 */
export function redactText(text: string): string {
  let out = text;
  for (const secret of registeredSecrets) {
    out = out.replaceAll(secret, REDACTED);
  }
  out = out.replace(
    SENSITIVE_PARAM_RE,
    (_match, prefix: string, param: string) => `${prefix}${param}=${PARAM_REDACTED}`,
  );
  return out.replace(BEARER_RE, '$1***');
}

/**
 * A string that is nothing but a URL is reduced to `origin + path`: the query
 * string of an `upload_url` carries the `upload_token`, and SECURITY.md allows
 * showing only origin and path. Userinfo credentials are dropped the same way.
 */
function stripUrlCredentials(value: string): string {
  if (!BARE_URL_RE.test(value) || !/[?#@]/.test(value)) return value;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function redactStringValue(value: string): string {
  return stripUrlCredentials(redactText(value));
}

function redactEntries(
  record: Record<string, unknown>,
  keys: readonly string[],
  depth: number,
  path: Set<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (isAllowedKey(key)) {
      out[key] = redactUnknown(record[key], depth + 1, path);
    } else {
      // The key name is scrubbed too — a secret used as a key must not leak.
      out[redactText(key)] = REDACTED;
    }
  }
  return out;
}

function redactObjectLike(value: object, depth: number, path: Set<object>): unknown {
  if (depth >= MAX_DEPTH) return REDACTED;
  if (path.has(value)) return CIRCULAR;

  if (value instanceof Date) {
    // CC-H2: times are ISO-8601 UTC everywhere they are serialized.
    return Number.isNaN(value.getTime()) ? REDACTED : value.toISOString();
  }

  if (value instanceof Error) {
    path.add(value);
    try {
      const own = Object.keys(value).filter((key) => !ERROR_INTRINSIC_KEYS.has(key));
      return {
        name: value.name,
        message: redactText(value.message),
        ...redactEntries(value as unknown as Record<string, unknown>, own, depth, path),
      };
    } finally {
      path.delete(value);
    }
  }

  if (Array.isArray(value)) {
    const items = value as unknown[];
    path.add(value);
    try {
      return items.map((item) => redactUnknown(item, depth + 1, path));
    } finally {
      path.delete(value);
    }
  }

  // Default-deny on shape as well: only plain objects are walked. Maps, Sets,
  // buffers, streams and class instances are denied wholesale.
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return REDACTED;

  const record = value as Record<string, unknown>;
  path.add(value);
  try {
    return redactEntries(record, Object.keys(record), depth, path);
  } finally {
    path.delete(value);
  }
}

function redactUnknown(value: unknown, depth: number, path: Set<object>): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string':
      return redactStringValue(value);
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return `${value}`;
    case 'object':
      return redactObjectLike(value, depth, path);
    default:
      // function / symbol — never serializable, never useful in a log line.
      return REDACTED;
  }
}

/**
 * Allowlist-based deep redaction — unknown keys are redacted by default.
 * Idempotent: `redactValue(redactValue(x))` deep-equals `redactValue(x)`.
 */
export function redactValue(value: unknown): unknown {
  return redactUnknown(value, 0, new Set<object>());
}

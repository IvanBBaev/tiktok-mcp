/**
 * Recorded-fixture format, sanitization and discovery (TESTING.md § Recorded
 * sandbox fixtures).
 *
 * One module, three consumers, deliberately: `fixtures-record.ts` writes raw
 * captures with it, `fixtures-sanitize.ts` transforms them with it, and the
 * replay contract test reads the committed files with it. Anything that both a
 * script and the test suite must agree on — the on-disk shape, what counts as a
 * placeholder, what counts as a secret — lives here so the two cannot drift
 * apart silently.
 *
 * Three design decisions worth stating up front:
 *
 * - **Raw and sanitized files share one shape.** The only difference is which
 *   directory they live in: `.fixtures-raw/` (gitignored, never reviewed) and
 *   `test/fixtures/recorded/` (committed, reviewed like code). A second schema
 *   for the raw side would buy nothing and give the sanitizer a translation
 *   step to get wrong.
 * - **`response.headers` is part of the format**, which TESTING.md's sketch did
 *   not call for. It has to be: the chunked-upload path answers with a bare
 *   status and a `Content-Range` and *no body at all* (`api/upload.ts`), so a
 *   body-only fixture cannot express the one interaction most worth recording.
 *   `Retry-After` is the same story on the retry path.
 * - **The HMAC key is committed and is not a secret.** Its job is a stable,
 *   shape-preserving pseudonym: the same `open_id` must render identically on
 *   every machine and in every re-record, or the human review of a fixture diff
 *   drowns in churn. It is not anonymity against someone who already holds a
 *   candidate `open_id` — the real defense there is that a sanitized fixture
 *   never carries the account's credentials at all.
 *
 * Nothing here imports from `src/` except `core/redact.ts`, whose `redactText`
 * runs as the sanitizer's last pass — a safety net under the explicit
 * transforms below, not a replacement for them.
 */

import { createHmac } from 'node:crypto';
import { type Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { redactText } from '../../src/core/redact.js';

import { repoPath } from './repo.js';

// ---------------------------------------------------------------------------
// the on-disk format
// ---------------------------------------------------------------------------

/** Bumped only for a change that makes older files unreadable. */
export const FIXTURE_SCHEMA = 'tiktok-mcp/fixture@1';

/** Committed, human-reviewed fixtures. Repo-relative, POSIX separators. */
export const FIXTURE_ROOT = 'test/fixtures/recorded';

/** Raw captures. Gitignored: they hold live credentials until sanitized. */
export const RAW_ROOT = '.fixtures-raw';

/**
 * One `<area>` directory per API surface, mirroring `src/api/`. The set is
 * closed so a typo lands as a validation failure rather than a silently
 * unreplayed directory.
 */
export const FIXTURE_AREAS = ['auth', 'user', 'video', 'publish', 'upload'] as const;

export type FixtureArea = (typeof FIXTURE_AREAS)[number];

export interface FixtureEndpoint {
  /** Upper-case HTTP method. */
  readonly method: string;
  /** Host only, no scheme, no port — `open.tiktokapis.com`. */
  readonly host: string;
  /** Path only, no query string — `/v2/user/info/`. */
  readonly path: string;
}

export interface FixtureRequest {
  /** The full URL as sent, query string included (sanitized). */
  readonly url: string;
  /** Header names lower-cased; multi-valued headers joined with `', '`. */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Parsed JSON for a JSON body, the raw string for a form body, `null` for no
   * body. A binary body (an upload chunk) is recorded as `null` — the bytes are
   * the file under test, not part of the contract.
   */
  readonly body: unknown;
}

export interface FixtureResponse {
  readonly status: number;
  /** Lower-cased. Carries `content-range` / `retry-after`, which are contract. */
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON, the raw string when the body is not JSON, or `null`. */
  readonly body: unknown;
}

export interface Fixture {
  readonly schema: typeof FIXTURE_SCHEMA;
  /** ISO-8601 UTC. Feeds the advisory staleness warning. */
  readonly recordedAt: string;
  readonly area: FixtureArea;
  /** kebab-case, unique within the area; it is the file's basename. */
  readonly name: string;
  readonly endpoint: FixtureEndpoint;
  readonly request: FixtureRequest;
  readonly response: FixtureResponse;
}

/** A fixture together with the repo-relative path it was read from. */
export interface LoadedFixture {
  readonly file: string;
  readonly fixture: Fixture;
}

// ---------------------------------------------------------------------------
// placeholders
// ---------------------------------------------------------------------------

/**
 * Sanitized credential values. The angle brackets are load-bearing: `redactText`
 * masks `Bearer <token>` by matching `[\w.~+/=-]+`, which `<ACCESS_TOKEN>` does
 * not match, so a placeholder survives the final pass intact and a real token
 * does not.
 */
export const PLACEHOLDER = {
  accessToken: '<ACCESS_TOKEN>',
  refreshToken: '<REFRESH_TOKEN>',
  clientKey: '<CLIENT_KEY>',
  clientSecret: '<CLIENT_SECRET>',
  authCode: '<AUTH_CODE>',
  codeVerifier: '<CODE_VERIFIER>',
  uploadToken: 'REDACTED',
} as const;

/**
 * A value already sanitized. Two spellings are legitimate: the angle-bracket
 * placeholders above, and the bare `REDACTED` that `redactText` leaves behind
 * in query/form position (`access_token=REDACTED`).
 */
const PLACEHOLDER_RE = /^(?:<[A-Z][A-Z0-9_]*>|REDACTED|\[REDACTED\])$/;

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_RE.test(value);
}

/** The synthetic `upload_url` every sanitized fixture points at. */
export const SANITIZED_UPLOAD_HOST = 'open-upload.tiktokapis.com';

// ---------------------------------------------------------------------------
// secret shapes — what the meta test forbids in a committed fixture
// ---------------------------------------------------------------------------

export interface SecretShape {
  /** Stable id, reported when the shape matches. */
  readonly name: string;
  readonly re: RegExp;
  /** Why this shape is a credential — printed with the failure. */
  readonly why: string;
}

/**
 * Shapes that must never appear in `test/fixtures/recorded/**`. Each is written
 * to *exclude* the sanitized spellings, so the list is a leak detector rather
 * than a description of the format — a fixture that matches is a fixture that
 * still carries live material.
 *
 * Deliberately no generic "long high-entropy string" rule: TikTok's own
 * `video_id`, `publish_id` and CDN cover URLs are exactly that shape, and a
 * detector that cries wolf on every fixture gets suppressed rather than fixed.
 * The coverage that rule would have bought comes from the structural side
 * instead — the sanitizer replaces by field name, not by looking at the value.
 */
export const SECRET_SHAPES: readonly SecretShape[] = [
  {
    name: 'bearer-token',
    re: /\bbearer\s+(?!<[A-Z][A-Z0-9_]*>|\*|REDACTED\b)[\w.~+/=-]{8,}/gi,
    why: 'an Authorization header still carries a live access token',
  },
  {
    // The prefix class carries `"`, `'` and whitespace as well as the URL
    // delimiters, because the text this runs over is a *serialized fixture*, not
    // a URL. A form body lives there as a JSON string, so its first parameter is
    // preceded by a quote and every later one by `&`: without the quote the same
    // credential is a hit in second position and invisible in first, which is
    // the one position every OAuth body puts `client_key` in.
    name: 'sensitive-param',
    re: /(^|[?&;"'\s])(upload_token|access_token|refresh_token|client_secret|client_key|code_verifier|code_challenge)=(?!REDACTED(?:[&;"]|$)|%3C|<)([^&\s"'#]{4,})/gi,
    why: 'a query or form parameter still carries its credential value',
  },
  {
    name: 'sensitive-field',
    re: /"(upload_token|access_token|refresh_token|client_secret|client_key|code_verifier|code_challenge)"\s*:\s*"(?!<[A-Z][A-Z0-9_]*>|REDACTED|\[REDACTED\])([^"]{4,})"/gi,
    why: 'a JSON field still carries its credential value',
  },
  {
    name: 'tiktok-token-prefix',
    re: /\b(?:act|rft|clt)\.[A-Za-z0-9_-]{16,}/g,
    why: "a value carries one of TikTok's token prefixes",
  },
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    why: 'a JSON Web Token survived sanitization',
  },
  {
    name: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    why: 'a PEM private key survived sanitization',
  },
];

export interface SecretHit {
  readonly shape: string;
  readonly why: string;
  /** The matched text, truncated — enough to locate, not enough to leak. */
  readonly excerpt: string;
}

/** Truncated so a failure message locates the leak without reprinting it. */
function excerpt(match: string): string {
  return match.length <= 24 ? match : `${match.slice(0, 24)}…`;
}

/**
 * Every secret shape found in `text`. Empty means clean. The regexes are
 * global, so `lastIndex` is reset before each scan — a shared `RegExp` object
 * that kept its index would skip matches on the second file.
 */
export function findSecretShapes(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const shape of SECRET_SHAPES) {
    shape.re.lastIndex = 0;
    for (const match of text.matchAll(shape.re)) {
      hits.push({ shape: shape.name, why: shape.why, excerpt: excerpt(match[0]) });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// pseudonyms
// ---------------------------------------------------------------------------

/**
 * Domain-separation key for the pseudonyms. Committed on purpose — see the
 * module docstring. Changing it re-writes every pseudonym in the tree, which
 * is a reviewable diff, not a silent break.
 */
const PSEUDONYM_KEY = 'tiktok-mcp/fixtures/pseudonym@1';

/** Deterministic byte stream for `kind:value`, extended by counter. */
function stream(kind: string, value: string, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let filled = 0;
  for (let counter = 0; filled < bytes; counter += 1) {
    const block = createHmac('sha256', PSEUDONYM_KEY)
      .update(`${kind}\0${value}\0${counter}`)
      .digest();
    const take = Math.min(block.length, bytes - filled);
    out.set(block.subarray(0, take), filled);
    filled += take;
  }
  return out;
}

const DIGITS = '0123456789';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * A stable, shape-preserving pseudonym: same length as the input, and every
 * character replaced by one of its own class (digit → digit, letter → letter of
 * the same case), everything else kept verbatim.
 *
 * Shape preservation is what makes the fixture still exercise the code under
 * test. A `log_id` collapsed to `"fake"` would pass every parser; one that is
 * still 35 characters of the same alphabet keeps a length or charset assumption
 * honest, and keeps the separators of a hyphenated `open_id` where they were.
 *
 * What survives verbatim is ASCII punctuation, and only that. Everything above
 * U+007F becomes a Latin letter, even though the substitution is visible: the
 * characters kept as-is are kept because they are *separators*, and the reason
 * to keep a separator does not extend to a Cyrillic or CJK display name, which
 * is the identity this function exists to remove. A rule that preserved script
 * would preserve a name that a handful of people on the platform have.
 */
export function pseudonym(kind: string, value: string): string {
  const bytes = stream(kind, value, value.length);
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i] ?? '';
    const byte = bytes[i] ?? 0;
    if (ch >= '0' && ch <= '9') out += DIGITS[byte % DIGITS.length];
    else if (ch >= 'a' && ch <= 'z') out += LOWER[byte % LOWER.length];
    else if (ch >= 'A' && ch <= 'Z') out += UPPER[byte % UPPER.length];
    // Iterating by code unit splits an emoji into its surrogates; mapping each
    // to a letter is what keeps the output a well-formed string rather than a
    // pair of lone surrogates.
    else if (ch.charCodeAt(0) > 0x7f) out += LOWER[byte % LOWER.length];
    else out += ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// sanitization
// ---------------------------------------------------------------------------

/**
 * JSON field names replaced wholesale by a placeholder, matched
 * separator-insensitively (`open_id` ≡ `openId`). This is the structural half
 * of the sanitizer: it replaces by *name*, so a field is safe on the day it
 * appears in a capture rather than on the day someone notices its value looks
 * like a token.
 *
 * `code` is deliberately absent. In JSON position that name is TikTok's own
 * error code — `{"error":{"code":"spam_risk_too_many_posts", …}}` — and it is
 * the single field the replay contract exists to assert on; replacing it would
 * sanitize away the payload rather than the credential. The OAuth
 * authorization `code` shares the name but only ever appears as a query or
 * form parameter, so it is covered by `CREDENTIAL_PARAMS` below.
 * `src/core/redact.ts` allowlists `code` for exactly the same reason.
 */
const CREDENTIAL_FIELDS: ReadonlyMap<string, string> = new Map([
  ['accesstoken', PLACEHOLDER.accessToken],
  ['refreshtoken', PLACEHOLDER.refreshToken],
  ['clientkey', PLACEHOLDER.clientKey],
  ['clientsecret', PLACEHOLDER.clientSecret],
  ['codeverifier', PLACEHOLDER.codeVerifier],
  ['codechallenge', PLACEHOLDER.codeVerifier],
  ['uploadtoken', PLACEHOLDER.uploadToken],
]);

/**
 * Query- and form-position replacement for every parameter in
 * `CREDENTIAL_PARAMS`.
 *
 * Deliberately not the angle-bracket spelling. Each of those names is also
 * matched by `redactText`'s sensitive-parameter rule, which runs as the last
 * pass and rewrites the value to a bare `REDACTED`; writing anything else here
 * would put two spellings of the same placeholder in one file, and the
 * angle-bracket one percent-encoded at that — `URLSearchParams.toString()`
 * renders it `client_key=%3CCLIENT_KEY%3E`, next to a plain
 * `client_secret=REDACTED` two parameters along. Agreeing with `redactText` up
 * front makes the output stable and the diff readable.
 */
const PARAM_REDACTED = 'REDACTED';

/**
 * Query/form parameter names carrying a credential. A superset of
 * `CREDENTIAL_FIELDS` by exactly one name — the OAuth authorization `code`,
 * which is a secret here and a payload in JSON position.
 */
const CREDENTIAL_PARAMS: ReadonlySet<string> = new Set([
  ...CREDENTIAL_FIELDS.keys(),
  'code',
  'state',
]);

/** JSON field names replaced by a shape-preserving pseudonym, keyed by domain. */
const PSEUDONYM_FIELDS: ReadonlyMap<string, string> = new Map([
  ['openid', 'open_id'],
  ['unionid', 'union_id'],
  ['logid', 'log_id'],
  ['creatorusername', 'username'],
  ['creatornickname', 'nickname'],
  ['displayname', 'display_name'],
  ['username', 'username'],
  ['avatarurl', 'avatar_url'],
  ['avatarurl100', 'avatar_url'],
  ['avatarlargeurl', 'avatar_url'],
  ['profiledeeplink', 'deep_link'],
]);

function normalizeField(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * A synthetic stand-in for a pre-signed `upload_url`. The host and the
 * `upload_id` shape are preserved so `assertAllowedUrl` and the chunk protocol
 * still see a plausible target; the bearer in the query string is gone.
 */
export function sanitizeUploadUrl(value: string): string {
  let uploadId = pseudonym('upload_id', 'v0201-unrecorded-upload-identifier');
  try {
    const parsed = new URL(value);
    const recorded = parsed.searchParams.get('upload_id');
    if (recorded !== null && recorded !== '') uploadId = pseudonym('upload_id', recorded);
  } catch {
    // An unparseable capture still gets a well-formed synthetic URL.
  }
  return `https://${SANITIZED_UPLOAD_HOST}/upload/?upload_id=${uploadId}&upload_token=${PLACEHOLDER.uploadToken}`;
}

/**
 * A URL with every sensitive query parameter replaced. Unlike `redactText`
 * this keeps the parameter *present* — a replay asserts on the shape of the
 * request our client produces, and a dropped parameter would make a missing
 * one look correct.
 */
export function sanitizeUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }
  if (parsed.searchParams.has('upload_token')) return sanitizeUploadUrl(value);
  for (const [key] of [...parsed.searchParams]) {
    if (CREDENTIAL_PARAMS.has(normalizeField(key))) {
      parsed.searchParams.set(key, PARAM_REDACTED);
    }
    const domain = PSEUDONYM_FIELDS.get(normalizeField(key));
    if (domain !== undefined) {
      parsed.searchParams.set(key, pseudonym(domain, parsed.searchParams.get(key) ?? ''));
    }
  }
  return parsed.toString();
}

/**
 * A URL that *is* an identity — `profile_deep_link`, `avatar_url` — with the
 * identity taken out of the path as well as the query.
 *
 * {@link sanitizeUrl} alone is not enough for these fields, and the gap is
 * quiet: it rewrites query parameters, so `https://www.tiktok.com/@ada.lovelace`
 * comes back unchanged and the committed fixture names the account as plainly
 * as the `display_name` two fields up — which the sanitizer did pseudonymize.
 * A CDN avatar path is the same story with the `open_id` in it.
 *
 * A trailing extension is kept because it is format rather than identity:
 * something downstream may well assert the avatar is a `.jpeg`.
 */
export function pseudonymizeUrl(domain: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return pseudonym(domain, value);
  }
  parsed.pathname = parsed.pathname
    .split('/')
    .map((segment) => {
      if (segment === '') return segment;
      const dot = segment.lastIndexOf('.');
      if (dot > 0)
        return `${pseudonym(domain, segment.slice(0, dot))}${segment.slice(dot)}`;
      return pseudonym(domain, segment);
    })
    .join('/');
  return sanitizeUrl(parsed.toString());
}

/** `application/x-www-form-urlencoded` body, sanitized parameter by parameter. */
function sanitizeForm(body: string): string {
  const params = new URLSearchParams(body);
  for (const [key] of [...params]) {
    if (CREDENTIAL_PARAMS.has(normalizeField(key))) params.set(key, PARAM_REDACTED);
  }
  return params.toString();
}

function sanitizeString(value: string): string {
  if (/^https?:\/\//i.test(value)) return sanitizeUrl(value);
  return value;
}

function sanitizeUnknown(value: unknown, field: string | undefined): unknown {
  if (field !== undefined) {
    const credential = CREDENTIAL_FIELDS.get(normalizeField(field));
    if (credential !== undefined) return credential;
    const domain = PSEUDONYM_FIELDS.get(normalizeField(field));
    if (domain !== undefined && typeof value === 'string') {
      return /^https?:\/\//i.test(value)
        ? pseudonymizeUrl(domain, value)
        : pseudonym(domain, value);
    }
    if (normalizeField(field) === 'uploadurl' && typeof value === 'string') {
      return sanitizeUploadUrl(value);
    }
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => sanitizeUnknown(item, undefined));
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeUnknown(item, key);
    }
    return out;
  }
  if (typeof value === 'string') return sanitizeString(value);
  return value;
}

/** Header names whose value is a credential regardless of what it looks like. */
const CREDENTIAL_HEADERS: ReadonlyMap<string, string> = new Map([
  ['authorization', `Bearer ${PLACEHOLDER.accessToken}`],
  ['cookie', PLACEHOLDER.accessToken],
  ['set-cookie', PLACEHOLDER.accessToken],
  ['x-tt-logid', ''],
]);

function sanitizeHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    const fixed = CREDENTIAL_HEADERS.get(key);
    if (fixed === '') {
      out[key] = pseudonym('log_id', value);
    } else if (fixed !== undefined) {
      out[key] = fixed;
    } else {
      out[key] = sanitizeString(value);
    }
  }
  return out;
}

/**
 * The `content-type` of a capture, whatever case it spelled the header in.
 *
 * The recorder lower-cases header names on the way in, so this only matters for
 * a capture that arrived some other way — hand-edited, or produced by a tool
 * that preserved the wire casing. That is precisely the capture the sanitizer
 * exists for, and reading the raw key directly would fail it silently: a
 * `Content-Type: application/x-www-form-urlencoded` body would miss
 * {@link sanitizeForm} entirely and pass through as an opaque string, live
 * `client_key` and all.
 */
function contentTypeOf(headers: Readonly<Record<string, string>>): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'content-type') return value;
  }
  return undefined;
}

function sanitizeBody(body: unknown, contentType: string | undefined): unknown {
  if (
    typeof body === 'string' &&
    contentType?.includes('x-www-form-urlencoded') === true
  ) {
    return sanitizeForm(body);
  }
  return sanitizeUnknown(body, undefined);
}

/**
 * The `endpoint` block a URL implies, or `undefined` when the URL will not
 * parse. `endpoint` is redundant with `request.url` by construction — it exists
 * so a reader can see what was called without parsing a query string, and
 * `parseFixture` enforces that the two agree. One derivation, used by both the
 * recorder that writes the block and the sanitizer that rewrites it, is what
 * keeps that check from ever being the thing that fails.
 */
export function endpointFor(method: string, url: string): FixtureEndpoint | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  return { method: method.toUpperCase(), host: parsed.host, path: parsed.pathname };
}

/**
 * The raw → committed transform, in full. Field-name driven first (the explicit
 * mapping above), then `redactText` as a last pass over the serialized document
 * — the same primitive every log sink runs through, so a shape the mapping
 * missed is still caught by the code that already knows about credentials.
 *
 * Pure and deterministic: the same capture sanitizes to the same bytes on every
 * machine, which is what makes the human review of a fixture diff meaningful.
 */
export function sanitizeFixture(fixture: Fixture): Fixture {
  const request: FixtureRequest = {
    url: sanitizeUrl(fixture.request.url),
    headers: sanitizeHeaders(fixture.request.headers),
    body: sanitizeBody(fixture.request.body, contentTypeOf(fixture.request.headers)),
  };
  // `endpoint` is re-derived rather than carried over, because sanitizing an
  // `upload_url` moves it: the pre-signed host a capture actually hit
  // (`open-upload-i18n.tiktokapis.com/video/upload/`) is replaced by the
  // synthetic one. Carrying the recorded endpoint through would produce a file
  // that `parseFixture` then refuses to read back — a fixture nobody can load
  // is worse than one nobody recorded.
  const endpoint = endpointFor(fixture.endpoint.method, request.url) ?? fixture.endpoint;
  const response: FixtureResponse = {
    status: fixture.response.status,
    headers: sanitizeHeaders(fixture.response.headers),
    body: sanitizeBody(fixture.response.body, contentTypeOf(fixture.response.headers)),
  };
  const sanitized: Fixture = { ...fixture, endpoint, request, response };
  // The last pass runs over the serialized form so it sees keys and values
  // alike, exactly as a log sink would. `[REDACTED]` and `REDACTED` need no
  // JSON escaping, so the document stays valid.
  return JSON.parse(redactText(JSON.stringify(sanitized))) as Fixture;
}

// ---------------------------------------------------------------------------
// validation, rendering, discovery
// ---------------------------------------------------------------------------

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(file: string, detail: string): never {
  throw new Error(`${file}: ${detail}`);
}

function requireRecord(
  value: unknown,
  file: string,
  what: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(file, `${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  file: string,
  what: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '')
    fail(file, `${what}.${key} must be a non-empty string`);
  return value;
}

function requireHeaders(
  value: unknown,
  file: string,
  what: string,
): Record<string, string> {
  const record = requireRecord(value, file, what);
  const out: Record<string, string> = {};
  for (const [name, item] of Object.entries(record)) {
    if (typeof item !== 'string') fail(file, `${what}.${name} must be a string`);
    if (name !== name.toLowerCase()) fail(file, `${what}.${name} must be lower-cased`);
    out[name] = item;
  }
  return out;
}

export function isFixtureArea(value: string): value is FixtureArea {
  return (FIXTURE_AREAS as readonly string[]).includes(value);
}

/**
 * Parse and validate one fixture document. Throws with the file name in the
 * message: a malformed fixture is a bug in the capture, and the replay test's
 * job is to say which file rather than to skip it.
 */
export function parseFixture(value: unknown, file: string): Fixture {
  const root = requireRecord(value, file, 'fixture');
  const schema = requireString(root, 'schema', file, 'fixture');
  if (schema !== FIXTURE_SCHEMA) fail(file, `unknown schema ${schema}`);

  const recordedAt = requireString(root, 'recordedAt', file, 'fixture');
  if (Number.isNaN(Date.parse(recordedAt)))
    fail(file, `recordedAt is not a date: ${recordedAt}`);

  const area = requireString(root, 'area', file, 'fixture');
  if (!isFixtureArea(area)) fail(file, `unknown area ${area}`);

  const name = requireString(root, 'name', file, 'fixture');
  if (!NAME_RE.test(name)) fail(file, `name must be kebab-case: ${name}`);

  const endpointRecord = requireRecord(root['endpoint'], file, 'endpoint');
  const endpoint: FixtureEndpoint = {
    method: requireString(endpointRecord, 'method', file, 'endpoint'),
    host: requireString(endpointRecord, 'host', file, 'endpoint'),
    path: requireString(endpointRecord, 'path', file, 'endpoint'),
  };
  if (endpoint.method !== endpoint.method.toUpperCase()) {
    fail(file, `endpoint.method must be upper-case: ${endpoint.method}`);
  }
  if (!endpoint.path.startsWith('/'))
    fail(file, `endpoint.path must start with /: ${endpoint.path}`);

  const requestRecord = requireRecord(root['request'], file, 'request');
  const url = requireString(requestRecord, 'url', file, 'request');
  const request: FixtureRequest = {
    url,
    headers: requireHeaders(requestRecord['headers'], file, 'request.headers'),
    body: requestRecord['body'] ?? null,
  };

  const responseRecord = requireRecord(root['response'], file, 'response');
  const status = responseRecord['status'];
  if (
    typeof status !== 'number' ||
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599
  ) {
    fail(file, 'response.status must be an integer HTTP status');
  }
  const response: FixtureResponse = {
    status,
    headers: requireHeaders(responseRecord['headers'], file, 'response.headers'),
    body: responseRecord['body'] ?? null,
  };

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    fail(file, `request.url is not a URL: ${url}`);
  }
  if (parsedUrl.host !== endpoint.host || parsedUrl.pathname !== endpoint.path) {
    fail(
      file,
      `endpoint ${endpoint.host}${endpoint.path} does not match request.url ${url}`,
    );
  }

  return { schema: FIXTURE_SCHEMA, recordedAt, area, name, endpoint, request, response };
}

/**
 * The committed rendering: 2-space JSON with a trailing newline, which is
 * byte-identical to what Prettier produces — `test/**` is not in
 * `.prettierignore`, so `npm run format:check` sees every fixture.
 */
export function renderFixture(fixture: Fixture): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

/** Repo-relative path a fixture belongs at, POSIX separators. */
export function fixturePath(root: string, area: FixtureArea, name: string): string {
  return posix.join(root, area, `${name}.json`);
}

/**
 * Every fixture file under `root`, repo-relative and sorted so a failure list
 * reads the same on every machine. A missing directory is not an error: the
 * tree is empty until the first sandbox pass, and the replay test reports that
 * as zero fixtures rather than as a crash.
 */
export async function listFixtureFiles(root: string = FIXTURE_ROOT): Promise<string[]> {
  const files: string[] = [];
  for (const area of FIXTURE_AREAS) {
    let entries: string[];
    try {
      entries = await readdir(join(repoPath(root), area));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith('.json')) files.push(posix.join(root, area, entry));
    }
  }
  return files.sort();
}

/**
 * Every file under `root`, at any depth and whatever its name, repo-relative and
 * sorted.
 *
 * The wider sibling of {@link listFixtureFiles}, and the two are wider and
 * narrower on purpose. The loader only wants files it can parse, so it looks
 * where fixtures are supposed to be. The secret scan wants the opposite
 * guarantee — that *nothing* under this tree carries a credential — and a scan
 * that only reads `<area>/*.json` cannot give it: an editor swapfile, a `.bak`
 * left by a hand-edit, a note in a typo'd directory would each be invisible to
 * it and committed all the same. A leak does not have to be well-formed.
 *
 * A missing directory yields no files rather than an error, for the same reason
 * as in {@link listFixtureFiles}: the tree does not exist until the first
 * sandbox pass.
 */
export async function walkFixtureTree(root: string = FIXTURE_ROOT): Promise<string[]> {
  const files: string[] = [];

  async function walk(relative: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(repoPath(relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(child);
      else files.push(child);
    }
  }

  await walk(root);
  return files.sort();
}

/** Read, parse and validate every fixture under `root`. */
export async function loadFixtures(
  root: string = FIXTURE_ROOT,
): Promise<LoadedFixture[]> {
  const loaded: LoadedFixture[] = [];
  for (const file of await listFixtureFiles(root)) {
    const text = await readFile(repoPath(file), 'utf8');
    loaded.push({ file, fixture: parseFixture(JSON.parse(text), file) });
  }
  return loaded;
}

// ---------------------------------------------------------------------------
// staleness
// ---------------------------------------------------------------------------

/**
 * Advisory only (TESTING.md): a fixture older than this is probably describing
 * an API that has moved, but failing the build on the calendar would turn a
 * green suite red without a single line of code changing.
 */
export const STALE_AFTER_DAYS = 180;

const DAY_MS = 86_400_000;

/** Whole days between `recordedAt` and `nowMs`; negative for a future stamp. */
export function ageInDays(recordedAt: string, nowMs: number): number {
  return Math.floor((nowMs - Date.parse(recordedAt)) / DAY_MS);
}

export function isStale(recordedAt: string, nowMs: number): boolean {
  return ageInDays(recordedAt, nowMs) > STALE_AFTER_DAYS;
}

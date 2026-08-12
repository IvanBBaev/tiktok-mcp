/**
 * OAuth 2.0 (Login Kit): PKCE, code exchange, refresh and revocation.
 *
 * Everything credential-shaped that crosses the network lives here. Four
 * behaviours are normative and are the reason this module exists as one piece
 * rather than as helpers spread across `cli/` and `api/`:
 *
 * 1. **PKCE is hand-rolled (CC-A13).** TikTok wants the `code_challenge` to be
 *    the **lowercase-hex** SHA-256 of the verifier, not RFC 7636's base64url. A
 *    stock PKCE library silently produces base64url and every exchange fails
 *    with `invalid_request`. The encoding exists in exactly one expression —
 *    `pkceChallenge` — so a flip is a one-line change if TikTok ever aligns
 *    with the RFC. AUTH.md § 2.1 pins the test vector.
 * 2. **Refresh is single-flight per profile, in-process and across processes**
 *    (CC-A2). TikTok rotates the refresh token on every use and the rotation
 *    grace window is unknown (probe P-3), so two concurrent refreshes with the
 *    same token must be assumed to brick one of them. In-process callers
 *    coalesce onto one promise; the winner takes `withEnvLock` for the *whole*
 *    critical section — re-read, network call, adopt, persist — per
 *    ARCHITECTURE § 7.3.
 * 3. **The rotated refresh token is persisted before the new access token is
 *    used** (CC-A1). `ensureFreshAccessToken` does not return until the write
 *    has been attempted, so the only loss window is a crash between the
 *    endpoint's answer and the `rename`.
 * 4. **Degradation, never data loss** (CC-H3). A lock timeout or a failed
 *    write is a warning plus a degraded in-memory session; a valid token is
 *    never discarded and a tool call is never failed because a credential
 *    could not be *persisted*.
 *
 * House rules this module obeys:
 *
 * - **Time** flows through the injected `Clock`; `Date.now` is never called.
 * - **Randomness** flows through the injected `randomBytes` seam, so the
 *   authorize URL is reproducible in tests (TESTING.md determinism rule 4).
 * - **`fetch`** is reached only through `core/http`'s `oauthRequest`, which
 *   decodes the **flat** OAuth shape and never the `{data,error}` envelope
 *   (CC-A12).
 * - **Tokens are never logged.** Every token this module sees is handed to
 *   `registerSecret` the moment it exists, so a later stack trace or body
 *   snippet cannot carry it (SECURITY.md § 2.5). Log fields stay inside
 *   `core/redact`'s allowlist.
 */

import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';

import { systemClock, type Clock } from './clock.js';
import {
  envKeyFor,
  normalizeProfileName,
  persistProfilePatch,
  readEnvFile,
  readProfile,
  resolveEnvFilePath,
  type ProfileCredentials,
} from './config.js';
import { withEnvLock } from './env-lock.js';
import { isTikTokError, TikTokError } from './errors.js';
import { oauthRequest, type LookupFn } from './http.js';
import { createLogger, type Logger } from './log.js';
import { registerSecret } from './redact.js';
import { loadSettings, type Settings } from './settings.js';

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------

/** The API origin every token/revoke call is pinned to (SECURITY.md § 2.5). */
const API_ORIGIN = 'https://open.tiktokapis.com';

/**
 * The consent screen. A **different host** from the API origin, and one this
 * process never fetches — the URL is handed to a browser, so it is outside the
 * egress allowlist by construction.
 */
const AUTHORIZE_ORIGIN = 'https://www.tiktok.com';

const AUTHORIZE_PATH = '/v2/auth/authorize/';
const TOKEN_PATH = '/v2/oauth/token/';
const REVOKE_PATH = '/v2/oauth/revoke/';

/** TikTok's label for its hex variant of PKCE (AUTH.md § 2). */
const CHALLENGE_METHOD = 'S256';

/** Bytes drawn for the PKCE verifier and for `state`; 32 → 43 base64url chars. */
const ENTROPY_BYTES = 32;

/** RFC 7636 § 4.1 — the verifier alphabet and length window. */
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * A loopback origin the test-only `TT_OAUTH_BASE_URL` override may name.
 * Anything else is **ignored** rather than rejected, exactly as
 * CONFIGURATION.md § Internal / test-only says: the variable is unsupported,
 * and a stray value in a real environment must not be able to redirect a token
 * exchange or to break one.
 */
const LOOPBACK_HOST_RE = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/;

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface TokenSet {
  accessToken: string;
  /** ISO-8601 UTC, computed as `received_at + expires_in` (CC-A4/CC-H2). */
  accessExpiresAt: string;
  refreshToken: string;
  /** ISO-8601 UTC, computed as `received_at + refresh_expires_in`. */
  refreshExpiresAt: string;
  openId: string;
  /** Scopes TikTok actually **granted** — a partial grant is normal (CC-A7). */
  scopes: string[];
}

/** Seams every network-facing entry point shares. Additive to CONTRACTS.md. */
interface CallSeams {
  clock?: Clock;
  logger?: Logger;
  signal?: AbortSignal;
  /** Per-attempt timeout; `core/http`'s 30 s default when absent. */
  timeoutMs?: number;
  lookup?: LookupFn;
  /** Resolved settings; `loadSettings()` when absent. */
  settings?: Settings;
}

export interface BuildAuthUrlOptions {
  clientKey: string;
  scopes: string[];
  redirectUri: string;

  // ---- additive options (documented deviations from CONTRACTS.md) ----

  /** Entropy seam: a seeded generator makes the URL reproducible in tests. */
  randomBytes?: (size: number) => Uint8Array;
  settings?: Settings;
}

export interface ExchangeCodeOptions extends CallSeams {
  clientKey: string;
  clientSecret: string;
  /** URL-decoded **exactly once** by the caller (AUTH.md § 1.1). */
  code: string;
  verifier: string;
  /** Byte-identical to the `redirect_uri` sent in the authorize URL. */
  redirectUri: string;
}

/** `ensureFreshAccessToken`'s dependency bag; only `clock` is in CONTRACTS.md. */
export interface RefreshDeps extends CallSeams {
  /**
   * Refresh even when the cached access token is outside the skew window. The
   * 401-replay path (ARCHITECTURE § 6) uses this for its one forced refresh.
   */
  force?: boolean;
  /** Overrides `process.env` for the credential read. Test seam. */
  env?: NodeJS.ProcessEnv;
  /**
   * `core/config`'s atomic-write seam, forwarded to `persistProfilePatch`. Test
   * seam: it is the only cross-platform way to exercise the "a valid token is
   * never discarded when the write fails" path (CC-H3).
   */
  rename?: (from: string, to: string) => Promise<void>;
}

export type RevokeDeps = CallSeams & {
  /** Overrides `process.env` for the credential read. Test seam. */
  env?: NodeJS.ProcessEnv;
  /** `core/config`'s atomic-write seam, as on `RefreshDeps`. Test seam. */
  rename?: (from: string, to: string) => Promise<void>;
};

// ---------------------------------------------------------------------------
// PKCE (CC-A13)
// ---------------------------------------------------------------------------

/**
 * The PKCE challenge for `verifier`: **lowercase hex** SHA-256, 64 characters.
 *
 * This is TikTok's documented deviation from RFC 7636 ("Create the code
 * challenge by hashing the code verifier using hex encoding of SHA256"), and
 * it is the only place in the codebase where the encoding is chosen. The
 * base64url form the RFC mandates — and every PKCE library produces by
 * default — is rejected by TikTok's token endpoint with `invalid_request`.
 *
 * @throws TikTokError `kind: "validation"` when the verifier is outside RFC
 *   7636's alphabet or length window. TikTok would answer such a verifier with
 *   an opaque `invalid_request` after a round trip; failing locally names the
 *   real problem.
 */
export function pkceChallenge(verifier: string): string {
  if (!VERIFIER_RE.test(verifier)) {
    throw new TikTokError({
      kind: 'validation',
      code: 'invalid_pkce_verifier',
      message:
        'The PKCE code verifier must be 43–128 characters from the RFC 7636 ' +
        'unreserved set (A-Z a-z 0-9 - . _ ~). No request was sent to TikTok.',
    });
  }
  return createHash('sha256').update(verifier, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// authorize URL
// ---------------------------------------------------------------------------

/** base64url without padding — RFC 7636's recommended verifier construction. */
function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Where the OAuth endpoints live. `TT_OAUTH_BASE_URL` (internal, unsupported)
 * redirects them to a local stub for the cross-process tests; a value that is
 * not a loopback origin is ignored, so the variable can never point a real
 * token exchange at someone else's host.
 */
function originFor(settings: Settings | undefined, fallback: string): string {
  const override = settings?.oauthBaseUrl;
  if (override === undefined || override === '') return fallback;
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    return fallback;
  }
  return LOOPBACK_HOST_RE.test(parsed.hostname) ? parsed.origin : fallback;
}

/** Whether a resolved origin is the loopback override rather than the pin. */
function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOST_RE.test(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * The consent URL plus the two secrets the caller must keep until the
 * exchange: the PKCE `verifier` and the CSRF `state`.
 *
 * `redirect_uri` is passed through byte-for-byte — it must match the token
 * exchange exactly, trailing slash included (AUTH.md § 1.1), so this function
 * deliberately does not normalize it.
 *
 * @throws TikTokError `kind: "validation"` for an empty scope list, or a
 *   `redirect_uri` that is not an absolute URL. Both would otherwise surface
 *   as an opaque consent-screen error after a browser round trip.
 */
export function buildAuthUrl(opts: BuildAuthUrlOptions): {
  url: string;
  state: string;
  verifier: string;
} {
  if (opts.clientKey.trim() === '') {
    throw new TikTokError({
      kind: 'validation',
      code: 'missing_client_key',
      message: 'TT_CLIENT_KEY is empty, so no authorization URL can be built.',
      remediation:
        'Set TT_CLIENT_KEY to the client key of your app at developers.tiktok.com.',
    });
  }
  if (opts.scopes.length === 0) {
    throw new TikTokError({
      kind: 'validation',
      code: 'invalid_params',
      message:
        'Invalid arguments: scopes: at least one scope must be requested. ' +
        'No request was sent to TikTok.',
    });
  }
  let redirect: URL | undefined;
  try {
    redirect = new URL(opts.redirectUri);
  } catch {
    redirect = undefined;
  }
  if (
    redirect === undefined ||
    (redirect.protocol !== 'http:' && redirect.protocol !== 'https:')
  ) {
    throw new TikTokError({
      kind: 'validation',
      code: 'invalid_params',
      message:
        'Invalid arguments: redirect_uri: expected an absolute http(s) URL such as ' +
        'http://127.0.0.1:8000/callback/. No request was sent to TikTok.',
    });
  }

  const random = opts.randomBytes ?? cryptoRandomBytes;
  const verifier = base64url(random(ENTROPY_BYTES));
  const state = base64url(random(ENTROPY_BYTES));

  const url = new URL(AUTHORIZE_PATH, originFor(opts.settings, AUTHORIZE_ORIGIN));
  url.searchParams.set('client_key', opts.clientKey);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', opts.scopes.join(','));
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkceChallenge(verifier));
  url.searchParams.set('code_challenge_method', CHALLENGE_METHOD);

  // The verifier is a credential until the exchange completes: it is what a
  // stolen authorization code would still need.
  registerSecret(verifier);
  return { url: url.toString(), state, verifier };
}

// ---------------------------------------------------------------------------
// token responses
// ---------------------------------------------------------------------------

/** The flat token-endpoint payload, before validation (TIKTOK-API § 1.2). */
interface RawTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  open_id?: unknown;
  refresh_expires_in?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
  token_type?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asSeconds(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** `now + seconds`, as the ISO-8601 UTC string the env file stores (CC-H2). */
function expiryAt(nowMs: number, seconds: number): string {
  return new Date(nowMs + seconds * 1_000).toISOString();
}

/**
 * Validate a token response and turn it into a `TokenSet`.
 *
 * A missing field is a hard failure rather than a silent `undefined`: half a
 * token set persisted over a working one is how a profile gets bricked. The
 * error names the fields, never the values.
 */
function toTokenSet(raw: RawTokenResponse, nowMs: number): TokenSet {
  const accessToken = asString(raw.access_token);
  const refreshToken = asString(raw.refresh_token);
  const openId = asString(raw.open_id);
  const expiresIn = asSeconds(raw.expires_in);
  const refreshExpiresIn = asSeconds(raw.refresh_expires_in);

  const missing: string[] = [];
  if (accessToken === undefined) missing.push('access_token');
  if (refreshToken === undefined) missing.push('refresh_token');
  if (openId === undefined) missing.push('open_id');
  if (expiresIn === undefined) missing.push('expires_in');
  if (refreshExpiresIn === undefined) missing.push('refresh_expires_in');
  if (
    accessToken === undefined ||
    refreshToken === undefined ||
    openId === undefined ||
    expiresIn === undefined ||
    refreshExpiresIn === undefined
  ) {
    throw new TikTokError({
      kind: 'auth',
      code: 'oauth_error',
      message:
        `The TikTok token endpoint answered without ${missing.join(', ')}. ` +
        'Nothing was stored.',
      retryable: false,
      remediation:
        'Try the login again; if it repeats, TikTok changed the response shape.',
    });
  }

  // Registered before anything can throw with them in scope (SECURITY.md § 2.5).
  registerSecret(accessToken);
  registerSecret(refreshToken);

  const scope = asString(raw.scope) ?? '';
  return {
    accessToken,
    accessExpiresAt: expiryAt(nowMs, expiresIn),
    refreshToken,
    refreshExpiresAt: expiryAt(nowMs, refreshExpiresIn),
    openId,
    scopes: scope
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  };
}

/** Options every token-endpoint POST shares, resolved from the seams. */
function requestOptions(
  seams: CallSeams,
  origin: string,
  path: string,
  body: Record<string, string>,
): Parameters<typeof oauthRequest>[0] {
  const allowLoopbackOrigin = isLoopbackOrigin(origin);
  return {
    method: 'POST',
    url: new URL(path, origin).toString(),
    body,
    ...(allowLoopbackOrigin ? { allowLoopbackOrigin } : {}),
    ...(seams.clock === undefined ? {} : { clock: seams.clock }),
    ...(seams.logger === undefined ? {} : { logger: seams.logger }),
    ...(seams.signal === undefined ? {} : { signal: seams.signal }),
    ...(seams.timeoutMs === undefined ? {} : { timeoutMs: seams.timeoutMs }),
    ...(seams.lookup === undefined ? {} : { lookup: seams.lookup }),
  };
}

// ---------------------------------------------------------------------------
// code exchange
// ---------------------------------------------------------------------------

/**
 * Trade an authorization code for a token set (AUTH.md § 1.2 step 3).
 *
 * Persisting is the caller's job — `cli/login` owns the "which profile, and is
 * it safe to overwrite" decision (CC-A11).
 *
 * @throws TikTokError `oauth_error` when TikTok rejects the exchange (the flat
 *   OAuth shape, decoded by `oauthRequest`, CC-A12), or when the response is
 *   missing a field the token set needs.
 */
export async function exchangeCode(opts: ExchangeCodeOptions): Promise<TokenSet> {
  // The authorization code shares its field name with the error-catalog `code`,
  // which is on the log allowlist — so the value is registered explicitly.
  registerSecret(opts.code);
  const clock = opts.clock ?? systemClock;
  const origin = originFor(opts.settings, API_ORIGIN);

  const raw = await oauthRequest<RawTokenResponse>(
    requestOptions(opts, origin, TOKEN_PATH, {
      client_key: opts.clientKey,
      client_secret: opts.clientSecret,
      code: opts.code,
      grant_type: 'authorization_code',
      redirect_uri: opts.redirectUri,
      code_verifier: opts.verifier,
    }),
  );
  return toTokenSet(raw, clock.now());
}

// ---------------------------------------------------------------------------
// in-memory credential state
// ---------------------------------------------------------------------------

/**
 * The adopted token set per profile. Replaced wholesale, never field by field,
 * so a reader can never observe a new access token paired with an old refresh
 * token (AUTH.md § 6).
 */
const adopted = new Map<string, TokenSet>();

/** In-flight refresh per profile — the in-process half of CC-A2. */
const inFlight = new Map<string, Promise<string>>();

/**
 * The refresh token this process last **spent**, per profile.
 *
 * TikTok rotates on every use, so a spent token is dead. That matters because
 * credential precedence is presence-based and the *process environment wins*
 * over the env file (CC-F2) — an MCP client config that pins `TT_REFRESH_TOKEN`
 * inline keeps handing back the original token no matter how many times this
 * process rotates it, and re-reading would spend a dead token on every refresh.
 * Remembering the last spent value lets the re-read prefer a token it has not
 * burned yet, without pretending to know which of two unknown tokens is newer.
 */
const lastSpent = new Map<string, string>();

/**
 * Drop every cached token set. Exported for tests and for `cli/login`, which
 * rewrites credentials underneath a running process.
 */
export function resetTokenCache(): void {
  adopted.clear();
  inFlight.clear();
  lastSpent.clear();
}

/** A credential record read from disk, as a `TokenSet` when it is complete. */
function toCachedSet(creds: ProfileCredentials): TokenSet | undefined {
  if (
    creds.accessToken === undefined ||
    creds.accessExpiresAt === undefined ||
    creds.refreshToken === undefined ||
    creds.refreshExpiresAt === undefined
  ) {
    return undefined;
  }
  registerSecret(creds.accessToken);
  registerSecret(creds.refreshToken);
  return {
    accessToken: creds.accessToken,
    accessExpiresAt: creds.accessExpiresAt,
    refreshToken: creds.refreshToken,
    refreshExpiresAt: creds.refreshExpiresAt,
    openId: creds.openId ?? '',
    scopes: [...(creds.scopes ?? [])],
  };
}

/** Whether `set`'s access token is still outside the proactive-refresh window. */
function isFresh(set: TokenSet, nowMs: number, skewS: number): boolean {
  const expiresAt = Date.parse(set.accessExpiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - nowMs > skewS * 1_000;
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/**
 * The terminal "re-run login" error (TOOLS.md § 3.0, CC-A5/CC-A6).
 *
 * `cause` is required: this error is only ever raised because TikTok rejected
 * something, and the rejection is what a `--verbose` run needs to show.
 */
function authExpired(profile: string, cause: unknown): TikTokError {
  return new TikTokError({
    kind: 'auth',
    code: 'auth_expired',
    message:
      `TikTok rejected the token for account '${profile}' and automatic refresh failed. ` +
      `Ask the user to run: npx tiktok-mcp-ai login --profile ${profile}. ` +
      'Do not retry this call until re-login completes.',
    retryable: false,
    cause,
  });
}

/** Whether an `oauthRequest` failure is TikTok saying "this token is dead". */
function isInvalidGrant(error: unknown): boolean {
  return isTikTokError(error) && error.apiCode === 'invalid_grant';
}

// ---------------------------------------------------------------------------
// refresh (ARCHITECTURE § 7.3)
// ---------------------------------------------------------------------------

/** Everything one refresh attempt needs, resolved once per call. */
interface RefreshState {
  readonly profile: string;
  readonly envFilePath: string;
  readonly settings: Settings;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly env: NodeJS.ProcessEnv;
  readonly deps: RefreshDeps;
}

/** Read this profile's credentials straight from disk + process env. */
async function readFromDisk(state: RefreshState): Promise<ProfileCredentials> {
  const snapshot = await readEnvFile(state.envFilePath);
  return readProfile(state.profile, snapshot, state.env);
}

/** POST `grant_type=refresh_token` and validate the answer. */
async function callRefresh(
  state: RefreshState,
  creds: ProfileCredentials,
  refreshToken: string,
): Promise<TokenSet> {
  const origin = originFor(state.settings, API_ORIGIN);
  const raw = await oauthRequest<RawTokenResponse>(
    requestOptions({ ...state.deps, settings: state.settings }, origin, TOKEN_PATH, {
      client_key: creds.clientKey,
      client_secret: creds.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  );
  return toTokenSet(raw, state.clock.now());
}

/**
 * Persist a rotated token set. A failure is a warning, never a throw: the
 * session continues on the in-memory token (CC-H3, AUTH.md § 3.2).
 */
async function persist(state: RefreshState, set: TokenSet): Promise<void> {
  try {
    const { persisted } = await persistProfilePatch(
      state.envFilePath,
      state.profile,
      {
        accessToken: set.accessToken,
        accessExpiresAt: set.accessExpiresAt,
        refreshToken: set.refreshToken,
        refreshExpiresAt: set.refreshExpiresAt,
        openId: set.openId,
        scopes: set.scopes,
      },
      {
        clock: state.clock,
        logger: state.logger,
        ...(state.deps.rename === undefined ? {} : { rename: state.deps.rename }),
      },
    );
    if (!persisted) {
      state.logger.warn(
        'the refreshed credentials could not be written to the env file; this process ' +
          'continues on the in-memory token, but the next process will refresh again',
        { profile: state.profile, path: state.envFilePath },
      );
    }
  } catch (error) {
    state.logger.warn(
      'the refreshed credentials could not be written to the env file; this process ' +
        'continues on the in-memory token',
      {
        profile: state.profile,
        path: state.envFilePath,
        reason: error instanceof Error ? error.message : 'unknown',
      },
    );
  }
}

/**
 * Which refresh token to spend, given a fresh read of the file and the process
 * environment.
 *
 * The file is preferred — that is how a sibling process's rotation is picked
 * up. It is *not* preferred when it hands back the exact token this process
 * already burned, which is what happens when the value is pinned in the process
 * environment (it wins over the file by CC-F2 and never changes). In that case
 * the in-memory token from our own last rotation is the only live one left.
 */
function pickRefreshToken(
  state: RefreshState,
  fromDisk: ProfileCredentials,
): string | undefined {
  const spent = lastSpent.get(state.profile);
  const candidates = [fromDisk.refreshToken, adopted.get(state.profile)?.refreshToken];
  return (
    candidates.find((token) => token !== undefined && token !== spent) ??
    candidates.find((token) => token !== undefined)
  );
}

/**
 * Whether a token found on the file can stand in for the refresh that was about
 * to happen.
 *
 * Freshness alone settles it in the ordinary case. Under `force` it does not:
 * the caller is here because TikTok rejected the token this process already
 * holds (the 401 replay, ARCHITECTURE § 6), so finding the *same* token on disk
 * proves nothing — only a token some other process has since rotated to is
 * worth adopting instead of refreshing.
 */
function isUsableFromDisk(state: RefreshState, onDisk: TokenSet, nowMs: number): boolean {
  if (!isFresh(onDisk, nowMs, state.settings.tokenRefreshSkewS)) return false;
  if (state.deps.force !== true) return true;
  return onDisk.accessToken !== adopted.get(state.profile)?.accessToken;
}

/**
 * The critical section, run while holding the env-file lock.
 *
 * Step 1 of ARCHITECTURE § 7.3 — re-read first — is what makes a sibling
 * process's rotation free: if the file already holds a fresh access token,
 * this returns without spending a network call *or* a refresh-token use.
 */
async function refreshUnderLock(state: RefreshState): Promise<string> {
  const nowMs = state.clock.now();
  const fromDisk = await readFromDisk(state);
  const onDisk = toCachedSet(fromDisk);

  if (onDisk !== undefined && isUsableFromDisk(state, onDisk, nowMs)) {
    adopted.set(state.profile, onDisk);
    state.logger.debug('adopted a token another process had already refreshed', {
      profile: state.profile,
    });
    return onDisk.accessToken;
  }

  const refreshToken = pickRefreshToken(state, fromDisk);
  if (refreshToken === undefined) {
    throw new TikTokError({
      kind: 'auth',
      code: 'auth_expired',
      message:
        `Account '${state.profile}' has no refresh token, so nothing can be refreshed. ` +
        `Ask the user to run: npx tiktok-mcp-ai login --profile ${state.profile}.`,
      retryable: false,
    });
  }

  let set: TokenSet;
  try {
    lastSpent.set(state.profile, refreshToken);
    set = await callRefresh(state, fromDisk, refreshToken);
  } catch (error) {
    if (!isInvalidGrant(error)) throw error;

    // Step 4: a sibling may have won a race that predates our acquisition. Its
    // rotated token is the only thing that can still work, so re-read once and
    // retry exactly once — never a loop (CC-A6).
    const retryCreds = await readFromDisk(state);
    const retryToken = retryCreds.refreshToken;
    if (retryToken === undefined || retryToken === refreshToken) {
      throw authExpired(state.profile, error);
    }
    state.logger.warn(
      'the refresh token was rejected; retrying once with the token another process rotated',
      { profile: state.profile },
    );
    try {
      lastSpent.set(state.profile, retryToken);
      set = await callRefresh(state, retryCreds, retryToken);
    } catch (retryError) {
      if (isInvalidGrant(retryError)) throw authExpired(state.profile, retryError);
      throw retryError;
    }
  }

  // Adopt, then persist, then return: the caller cannot use the new access
  // token before the rotated refresh token has been written (CC-A1).
  adopted.set(state.profile, set);
  await persist(state, set);
  state.logger.info('refreshed the TikTok access token', {
    profile: state.profile,
    access_expires_at: set.accessExpiresAt,
    refresh_expires_at: set.refreshExpiresAt,
  });
  return set.accessToken;
}

/**
 * `env_file_busy` fallback (TOOLS.md § 3.0 note): the lock never came free, so
 * re-read the file **once** — the holder may have finished writing between the
 * last wait slice and now — and adopt a usable token before surfacing the
 * error. Only a file that still has nothing usable makes the timeout real; a
 * forced refresh that finds nothing but the token it already holds surfaces the
 * (retryable) busy error rather than replaying a token TikTok just rejected.
 */
async function adoptAfterLockTimeout(
  state: RefreshState,
  busy: unknown,
): Promise<string> {
  let onDisk: TokenSet | undefined;
  try {
    onDisk = toCachedSet(await readFromDisk(state));
  } catch {
    onDisk = undefined;
  }
  if (onDisk !== undefined && isUsableFromDisk(state, onDisk, state.clock.now())) {
    adopted.set(state.profile, onDisk);
    state.logger.warn(
      'the credential file was locked, but it already held a token another process ' +
        'had refreshed; continuing with it',
      { profile: state.profile },
    );
    return onDisk.accessToken;
  }
  throw busy;
}

/** The lock knobs, mirrored from settings (CONFIGURATION.md § Env-file lock). */
function lockOptions(state: RefreshState): Parameters<typeof withEnvLock>[2] {
  return {
    waitMs: state.settings.envLockWaitMs,
    staleMs: state.settings.envLockStaleMs,
    heartbeatMs: state.settings.envLockHeartbeatMs,
    clock: state.clock,
    logger: state.logger,
  };
}

/**
 * The whole refresh attempt, from the cold-start read to the locked section.
 *
 * It lives behind the single-flight map, so the "maybe the file already holds a
 * usable token" read happens once per burst of callers rather than once per
 * caller.
 */
async function runRefresh(state: RefreshState, cold: boolean): Promise<string> {
  if (cold) {
    // Nothing adopted yet: the file (or the process env) may already hold a
    // token that needs no refresh at all, which is the startup case.
    const fromDisk = toCachedSet(await readFromDisk(state));
    if (fromDisk !== undefined) {
      adopted.set(state.profile, fromDisk);
      if (
        state.deps.force !== true &&
        isFresh(fromDisk, state.clock.now(), state.settings.tokenRefreshSkewS)
      ) {
        return fromDisk.accessToken;
      }
    }
  }
  try {
    return await withEnvLock(
      state.envFilePath,
      () => refreshUnderLock(state),
      lockOptions(state),
    );
  } catch (error) {
    if (isTikTokError(error) && error.code === 'env_file_busy') {
      return await adoptAfterLockTimeout(state, error);
    }
    throw error;
  }
}

/**
 * A valid access token for `profile`, refreshing it when it is inside the
 * `TT_TOKEN_REFRESH_SKEW_S` window (default 30 min) of its expiry.
 *
 * Concurrent callers for the same profile coalesce onto one refresh; callers
 * for *different* profiles do not block each other in process, but they do
 * serialize on the env-file lock, because they share one file.
 *
 * @throws TikTokError `auth_expired` (terminal, not retryable) when the
 *   refresh token is gone or TikTok rejects it with `invalid_grant`;
 *   `env_file_busy` (retryable) when another process held the credential file
 *   for the whole wait and left nothing usable behind.
 */
export async function ensureFreshAccessToken(
  profile: string,
  deps: RefreshDeps = {},
): Promise<string> {
  const name = normalizeProfileName(profile);
  const env = deps.env ?? process.env;
  const settings = deps.settings ?? loadSettings(env);
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? createLogger({ level: settings.logLevel, clock });

  // Everything up to `inFlight.set` stays synchronous: an `await` before the
  // map is written would let two concurrent callers both miss it and refresh
  // twice, which is exactly the rotation race single-flight exists to prevent.
  const cached = adopted.get(name);
  if (
    deps.force !== true &&
    cached !== undefined &&
    isFresh(cached, clock.now(), settings.tokenRefreshSkewS)
  ) {
    return cached.accessToken;
  }

  const pending = inFlight.get(name);
  if (pending !== undefined) return await pending;

  const state: RefreshState = {
    profile: name,
    envFilePath: resolveEnvFilePath(env),
    settings,
    clock,
    logger,
    env,
    deps,
  };
  const attempt = runRefresh(state, cached === undefined).finally(() => {
    inFlight.delete(name);
  });
  inFlight.set(name, attempt);
  return await attempt;
}

// ---------------------------------------------------------------------------
// revocation (AUTH.md § 4)
// ---------------------------------------------------------------------------

/** The token fields a revoke clears; writing an empty value reads as absent. */
const CLEARED: Partial<ProfileCredentials> = Object.freeze({
  accessToken: '',
  accessExpiresAt: '',
  refreshToken: '',
  refreshExpiresAt: '',
  openId: '',
  scopes: [],
});

/**
 * Revoke `profile`'s access token upstream and clear its keys locally.
 *
 * **The publish journal is untouched.** It is the only audit trail for "did it
 * post?", and destroying it on revoke would destroy exactly the record needed
 * most (SYNTHESIS § 2.10); purging is the separate, explicit `--purge-journal`
 * flag.
 *
 * An upstream failure does not stop the local clear: a token this machine can
 * no longer use is worse kept than dropped, and the user's next step is a fresh
 * `login` either way. The failure is logged.
 */
export async function revokeToken(profile: string, deps: RevokeDeps = {}): Promise<void> {
  const name = normalizeProfileName(profile);
  const env = deps.env ?? process.env;
  const settings = deps.settings ?? loadSettings(env);
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? createLogger({ level: settings.logLevel, clock });
  const envFilePath = resolveEnvFilePath(env);

  const creds = readProfile(name, await readEnvFile(envFilePath), env);
  const accessToken = creds.accessToken ?? adopted.get(name)?.accessToken;

  if (accessToken !== undefined) {
    try {
      await oauthRequest<unknown>(
        requestOptions(
          { ...deps, settings },
          originFor(settings, API_ORIGIN),
          REVOKE_PATH,
          {
            client_key: creds.clientKey,
            client_secret: creds.clientSecret,
            token: accessToken,
          },
        ),
      );
    } catch (error) {
      logger.warn(
        'TikTok did not confirm the revocation; clearing the local credentials anyway',
        {
          profile: name,
          reason: error instanceof Error ? error.message : 'unknown',
        },
      );
    }
  }

  adopted.delete(name);
  // The spent-token memo is only meaningful next to an adopted set; leaving it
  // behind would make a later login's first refresh look like a replay.
  lastSpent.delete(name);
  await withEnvLock(
    envFilePath,
    async () => {
      const { persisted } = await persistProfilePatch(envFilePath, name, CLEARED, {
        clock,
        logger,
        ...(deps.rename === undefined ? {} : { rename: deps.rename }),
      });
      if (!persisted) {
        logger.warn(
          'the credentials could not be cleared from the env file; remove them by hand',
          { profile: name, path: envFilePath, key: envKeyFor(name, 'accessToken') },
        );
      }
    },
    {
      waitMs: settings.envLockWaitMs,
      staleMs: settings.envLockStaleMs,
      heartbeatMs: settings.envLockHeartbeatMs,
      clock,
      logger,
    },
  );
}

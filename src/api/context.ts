/**
 * The per-call api-layer context (CONTRACTS.md § `api/* (shared context)`).
 *
 * Every api-layer function takes an `ApiContext` as its first argument instead
 * of reaching for module-level state: the resolved profile, the settings that
 * were loaded at startup, the logger already bound to that profile, and the
 * clock (so tests never wait on wall time). `getAccessToken()` is the single
 * door to a bearer token — it wraps `ensureFreshAccessToken`, so callers never
 * see, cache or pass a raw token around.
 *
 * Besides the type this module owns the two things every Display-API call
 * shares: {@link apiRequest} (URL composition, bearer injection, and the "one
 * forced refresh + one replay" rule of ARCHITECTURE § 6) and
 * {@link readCredentialSnapshot} (the per-call re-read of the credential store
 * that TOOLS.md § 6.2 makes authoritative over any cached description marker).
 *
 * Layering: `core ← api ← mcp ← tools`. This file may import from `core` only.
 */

import { systemClock, type Clock } from '../core/clock.js';
import {
  listProfiles,
  readEnvFile,
  readProfile,
  resolveEnvFilePath,
} from '../core/config.js';
import { isTikTokError, TikTokError } from '../core/errors.js';
import { ttRequest, type RetryClass } from '../core/http.js';
import type { Logger } from '../core/log.js';
import { ensureFreshAccessToken, type RefreshDeps } from '../core/oauth.js';
import type { Settings } from '../core/settings.js';

/** Options a caller may pass to {@link ApiContext.getAccessToken}. */
export interface AccessTokenOptions {
  /**
   * Refresh before answering, even when the cached token is still inside its
   * validity window. Only the 401-replay path of {@link apiRequest} sets this
   * (ARCHITECTURE § 6); an implementation that ignores it is still correct for
   * every other caller.
   */
  force?: boolean;
}

export interface ApiContext {
  /** Resolved profile name for this call — already normalized and known-good. */
  profile: string;

  /** Process-wide settings snapshot (TT_* environment, loaded once at startup). */
  settings: Settings;

  /** Logger bound to the call (profile, tool, request id are already attached). */
  log: Logger;

  /** Injected clock — `Date.now()` and bare timers are banned outside core/clock. */
  clock: Clock;

  /**
   * Resolve a valid access token for {@link profile}, refreshing it first when
   * it is expired or within the refresh skew. Rejects with a `TikTokError` of
   * kind `auth` when no usable credential exists. The returned string is a
   * registered secret: never log it, never put it in a result or an error.
   */
  getAccessToken(opts?: AccessTokenOptions): Promise<string>;
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

export interface CreateApiContextOptions {
  /** Profile the call runs against; already resolved by the mcp layer. */
  profile: string;
  settings: Settings;
  /** Process logger; the factory binds `profile` onto it. */
  log: Logger;
  clock?: Clock;
  /** Overrides `process.env` for the credential read. Test seam. */
  env?: NodeJS.ProcessEnv;
  /**
   * Token resolver. Test seam: the real one owns process-wide single-flight
   * state and touches the credential file, neither of which an api-layer test
   * has any business exercising.
   */
  refresh?: (profile: string, deps: RefreshDeps) => Promise<string>;
}

/**
 * Build the context every api function runs against.
 *
 * The token seam is the whole point: `getAccessToken` is the only path to a
 * bearer, it always goes through `ensureFreshAccessToken` (single-flight,
 * rotation-safe, secret-registering), and nothing above this layer ever holds
 * the string long enough to log it.
 */
export function createApiContext(opts: CreateApiContextOptions): ApiContext {
  const clock = opts.clock ?? systemClock;
  const refresh = opts.refresh ?? ensureFreshAccessToken;
  const log = opts.log.child({ profile: opts.profile });
  const env = opts.env;

  return {
    profile: opts.profile,
    settings: opts.settings,
    log,
    clock,
    getAccessToken: async (tokenOpts?: AccessTokenOptions): Promise<string> =>
      await refresh(opts.profile, {
        clock,
        logger: log,
        settings: opts.settings,
        ...(env === undefined ? {} : { env }),
        ...(tokenOpts?.force === true ? { force: true } : {}),
      }),
  };
}

// ---------------------------------------------------------------------------
// requests (ARCHITECTURE § 6, TIKTOK-API.md § 3)
// ---------------------------------------------------------------------------

/** The only origin the Display API is reachable on (`core/http` re-checks it). */
const API_ORIGIN = 'https://open.tiktokapis.com';

/** TIKTOK-API.md § 1.1 — the 401 that earns exactly one refresh + one replay. */
const TOKEN_REJECTED = 'access_token_invalid';

export interface ApiRequestOptions {
  method: 'GET' | 'POST';
  /** Absolute path on the TikTok API origin, e.g. `/v2/user/info/`. */
  path: string;
  /**
   * The `fields` query parameter every Display endpoint requires
   * (TIKTOK-API.md § 3.1–3.3). Values come from this package's own frozen
   * enums — plain `[a-z_]` identifiers — so joining them needs no escaping.
   *
   * Absent for the Content Posting API, which selects nothing and would read
   * an empty `?fields=` as a malformed request rather than as "no fields".
   */
  fields?: readonly string[];
  /**
   * Retry class (`core/http`); defaults to `read`. A publish init passes
   * `init`, which is terminal upstream *and* here: it also forfeits the
   * 401-refresh-and-replay below, because a replay of a call that may already
   * have created a post is exactly what the whole write contract exists to
   * prevent (TIKTOK-API.md § 4.2, probe P-12).
   */
  retryClass?: RetryClass;
  /** JSON request body; `GET` must not have one (`core/http` rejects it). */
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * TOOLS.md § 3.0 `auth_expired`. The same sentence `core/oauth` raises when a
 * refresh fails, raised here for the other half of the rule: the refresh
 * worked, the replay was rejected anyway, so the credential is dead in a way
 * only a re-login fixes.
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

/** Whether TikTok answered "this bearer is not valid" (TIKTOK-API.md § 1.1). */
function isTokenRejected(error: unknown): boolean {
  return isTikTokError(error) && error.apiCode === TOKEN_REJECTED;
}

/**
 * The response carried HTTP 200 and `error.code: "ok"` but not the payload the
 * endpoint documents. Reported as `upstream_error` rather than crashing on a
 * missing property — a shape change upstream must read as an upstream problem.
 */
export function malformedPayload(endpoint: string, expected: string): TikTokError {
  return new TikTokError({
    kind: 'api',
    code: 'upstream_error',
    message:
      `TikTok returned an error: ${endpoint} answered successfully but without ` +
      `the documented ${expected}. This is an upstream response-shape change, not a bad request.`,
    retryable: false,
    remediation: 'Retry later; if it persists, the endpoint contract has changed.',
  });
}

/**
 * One Display-API call for `ctx.profile`.
 *
 * ARCHITECTURE § 6: a rejected access token buys **exactly one** forced refresh
 * and **exactly one** replay, for the `read` class only. A second rejection is
 * terminal — looping on a credential TikTok keeps refusing is how a client
 * burns an account's rate budget for nothing.
 */
export async function apiRequest<T>(
  ctx: ApiContext,
  opts: ApiRequestOptions,
): Promise<T> {
  const retryClass = opts.retryClass ?? 'read';
  const query =
    opts.fields === undefined || opts.fields.length === 0
      ? ''
      : `?fields=${opts.fields.join(',')}`;
  const url = `${API_ORIGIN}${opts.path}${query}`;

  const send = async (force: boolean): Promise<T> =>
    await ttRequest<T>({
      method: opts.method,
      url,
      retryClass,
      bearer: await ctx.getAccessToken(force ? { force: true } : undefined),
      clock: ctx.clock,
      logger: ctx.log,
      timeoutMs: ctx.settings.timeoutMs,
      // `TT_MAX_RETRIES` is the read class's attempt cap (CONFIGURATION.md);
      // `core/http` clamps it to at least one attempt.
      maxAttempts: ctx.settings.maxRetries,
      ...(opts.body === undefined ? {} : { body: opts.body }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });

  try {
    return await send(false);
  } catch (error) {
    if (retryClass !== 'read' || !isTokenRejected(error)) throw error;
    ctx.log.info('access token rejected upstream; refreshing once and replaying', {
      path: opts.path,
    });
    try {
      return await send(true);
    } catch (replayError) {
      if (isTokenRejected(replayError)) throw authExpired(ctx.profile, replayError);
      throw replayError;
    }
  }
}

// ---------------------------------------------------------------------------
// credential snapshot (TOOLS.md § 6.2)
// ---------------------------------------------------------------------------

/** What the credential store knows about one profile — never any token material. */
export interface ProfileCredentialSummary {
  name: string;
  /** True for the profile a call with no `account` argument resolves to. */
  isDefault: boolean;
  /** Stable TikTok user id, when the profile has been logged in. */
  openId?: string;
  /** Scopes TikTok actually granted — a partial grant is normal (CC-A7). */
  scopes: readonly string[];
  /** ISO-8601 UTC access-token expiry, when one is stored. */
  tokenExpiresAt?: string;
  /** ISO-8601 UTC refresh-token expiry, when one is stored. */
  refreshExpiresAt?: string;
}

/**
 * Re-read the credential store and summarize every configured profile.
 *
 * Read on **every** call by contract (TOOLS.md § 6.2): a `login` in another
 * terminal changes the answer, and a cached snapshot would let a stale
 * `[UNAVAILABLE]` marker outlive the grant that fixed it. A profile whose
 * record cannot be read (no app credentials yet, a malformed expiry) is
 * reported with no scopes rather than failing the whole call — the same
 * degradation the bootstrap's `profiles()` applies.
 */
export async function readCredentialSnapshot(
  ctx: ApiContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly ProfileCredentialSummary[]> {
  const path = ctx.settings.envFile ?? resolveEnvFilePath(env);
  const snapshot = await readEnvFile(path);
  const active = ctx.settings.lockProfile ?? ctx.settings.activeProfile;

  return listProfiles(snapshot, env).map((name) => {
    const base: ProfileCredentialSummary = {
      name,
      isDefault: name === active,
      scopes: [],
    };
    try {
      const credentials = readProfile(name, snapshot, env);
      const summary: ProfileCredentialSummary = {
        ...base,
        scopes: credentials.scopes ?? [],
      };
      if (credentials.openId !== undefined) summary.openId = credentials.openId;
      if (credentials.accessExpiresAt !== undefined) {
        summary.tokenExpiresAt = credentials.accessExpiresAt;
      }
      if (credentials.refreshExpiresAt !== undefined) {
        summary.refreshExpiresAt = credentials.refreshExpiresAt;
      }
      return summary;
    } catch {
      // An unreadable profile is reported as "granted nothing", never as a
      // failed call: the other profiles' answers are still useful.
      return base;
    }
  });
}

/** The granted scopes of `ctx.profile`, or `[]` when the profile has none. */
export async function grantedScopes(
  ctx: ApiContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly string[]> {
  const profiles = await readCredentialSnapshot(ctx, env);
  return profiles.find((entry) => entry.name === ctx.profile)?.scopes ?? [];
}

/**
 * `open_id` rendered for a result (TOOLS.md § 3.1/§ 3.2 `open_id_masked`).
 *
 * `open_id` is not a secret — it is not a credential and `core/redact` allows
 * it in logs — but it is a stable cross-app user identifier, so results carry
 * only enough of it to tell two profiles apart. A value too short to keep ends
 * up fully elided rather than half-published.
 */
export function maskOpenId(openId: string): string {
  const keep = 4;
  if (openId.length <= keep * 2) return '…';
  return `${openId.slice(0, keep)}…${openId.slice(-keep)}`;
}

/**
 * `tiktok_get_auth_status` — the whole `auth` package (TOOLS.md § 3.1).
 *
 * This tool is the model's diagnostic entry point: it re-reads the credential
 * store on every call (TOOLS.md § 6.2 — the call-time read is authoritative,
 * a cached `[UNAVAILABLE: …]` description marker is not) and answers with the
 * per-profile × per-package availability matrix of § 6 item 4, so a scope
 * problem can be diagnosed without parsing description prefixes.
 *
 * It never returns token material (TOOLS.md § 2.5): only granted scopes,
 * expiry timestamps and a masked `open_id`.
 *
 * Layering: `core ← api ← mcp ← tools`; a tool module may import all three.
 */

import { z } from 'zod';

import {
  maskOpenId,
  readCredentialSnapshot,
  type ProfileCredentialSummary,
} from '../api/context.js';
import { getUserInfo } from '../api/user.js';
import { isTikTokError } from '../core/errors.js';
import { TOOL_PACKAGES, type ToolPackage } from '../core/settings.js';
import { defineTool, toolInput } from '../mcp/define.js';
import { toolErrorFrom } from '../mcp/errors.js';
import type { Hint, ToolResult } from '../mcp/result.js';

/** The exact CLI line hints tell the user to run (TOOLS.md § 5.3). */
const CLI = 'npx tiktok-mcp-ai';

/**
 * The scopes a profile must grant for a package to be fully usable — the union
 * of the `scopes` its tools declare, not the (wider) set the login CLI requests.
 *
 * `user` is the one place the two differ: `cli/login.ts` asks for all three
 * `user.info.*` scopes so the optional profile/stats fields work, while
 * `tiktok_get_user_info` requires only `user.info.basic` and reports the rest
 * through `meta.omitted_fields` (TOOLS.md § 3.2). Reporting that profile as
 * unusable would be false.
 *
 * The table is a deliberate copy: `tools/*` cannot import `cli/*` (it sits
 * outside the layer graph) and cannot import its own manifest (import cycle),
 * and deriving the matrix from the live specs would report the still-unbuilt
 * publish packages as "ok" because they contain no tools yet.
 */
const PACKAGE_SCOPES: Readonly<Record<ToolPackage, readonly string[]>> = Object.freeze({
  auth: [],
  user: ['user.info.basic'],
  video: ['video.list'],
  publish: ['video.publish'],
  'publish-write': ['video.publish', 'video.upload'],
});

/** Reason sentences for the `reauth` hint — server-owned templates (TOOLS.md § 5.2 rule 3). */
const NO_REFRESH =
  'that profile has no usable refresh token, so this server cannot renew it on its own';
const PROBE_REJECTED = 'TikTok rejected the stored token for that profile just now';

/** One profile's row of the availability matrix. */
export interface ProfileStatus {
  name: string;
  is_default: boolean;
  /** Absent for a profile that has never completed a login. */
  open_id_masked?: string;
  scopes: string[];
  token_expires_at?: string;
  refresh_expires_at?: string;
  /** `"ok"` or `"missing_scope:<first missing scope>"` per package. */
  packages: Record<ToolPackage, string>;
  /** Only on the probed profile, and only when `probe: true` was requested. */
  probe?: { ok: boolean; checked_at: string };
}

export interface AuthStatus {
  profiles: ProfileStatus[];
}

function packageStatus(pkg: ToolPackage, granted: readonly string[]): string {
  const missing = PACKAGE_SCOPES[pkg].find((scope) => !granted.includes(scope));
  return missing === undefined ? 'ok' : `missing_scope:${missing}`;
}

function packageMatrix(granted: readonly string[]): Record<ToolPackage, string> {
  return {
    auth: packageStatus('auth', granted),
    user: packageStatus('user', granted),
    video: packageStatus('video', granted),
    publish: packageStatus('publish', granted),
    'publish-write': packageStatus('publish-write', granted),
  };
}

function toRow(summary: ProfileCredentialSummary): ProfileStatus {
  const row: ProfileStatus = {
    name: summary.name,
    is_default: summary.isDefault,
    scopes: [...summary.scopes],
    packages: packageMatrix(summary.scopes),
  };
  if (summary.openId !== undefined) row.open_id_masked = maskOpenId(summary.openId);
  if (summary.tokenExpiresAt !== undefined) row.token_expires_at = summary.tokenExpiresAt;
  if (summary.refreshExpiresAt !== undefined) {
    row.refresh_expires_at = summary.refreshExpiresAt;
  }
  return row;
}

/**
 * A profile whose credential cannot heal itself: no refresh expiry on record
 * (never logged in, or a login that stored nothing), an unparseable one, or one
 * already in the past.
 *
 * An *access* token that merely expired is deliberately not included — renewing
 * it is exactly what `ensureFreshAccessToken` does on the next call, and a
 * `reauth` hint there would send the user to a browser for nothing.
 */
function needsLogin(summary: ProfileCredentialSummary, nowMs: number): boolean {
  const expiresAt = summary.refreshExpiresAt;
  if (expiresAt === undefined) return true;
  const parsed = Date.parse(expiresAt);
  return Number.isNaN(parsed) || parsed <= nowMs;
}

function reauthHint(profile: string, reason: string): Hint {
  return {
    type: 'reauth',
    profile,
    command: `${CLI} login --profile ${profile}`,
    text:
      `Ask the user to run: ${CLI} login --profile ${profile} — ${reason}. ` +
      'Then call tiktok_get_auth_status again to confirm.',
  };
}

/**
 * TOOLS.md § 3.1: `user_action` when a package is unavailable for *every*
 * profile; the text mirrors the § 6.1 `[UNAVAILABLE: …]` marker.
 *
 * Worst case (four packages, four distinct scopes) is ~260 characters, inside
 * the 300-character ceiling of § 5.2 by construction.
 */
function loginHint(packages: readonly ToolPackage[], scopes: readonly string[]): Hint {
  return {
    type: 'user_action',
    action: 'login',
    text:
      `No configured profile grants the scopes for tool package(s): ${packages.join(', ')}. ` +
      `Ask the user to run: ${CLI} login --scopes ${scopes.join(',')} — ` +
      'then call tiktok_get_auth_status again.',
  };
}

const DESCRIPTION =
  'Report authentication status for the configured TikTok profile(s): granted scopes, ' +
  'token expiry, and which tool packages are usable per profile. Local and instant by ' +
  'default; set probe: true to additionally verify the token against TikTok with a single ' +
  'user-info call. Call this first when any tool reports an auth or scope error, and again ' +
  'after the user re-runs the login CLI. Never returns token material.';

const INPUT = toolInput({
  probe: z
    .boolean()
    .optional()
    .describe(
      'true = make one live user-info request to confirm the token works. ' +
        'false (default) = report from local state only, no network.',
    ),
});

type AuthStatusInput = z.infer<typeof INPUT>;

export const getAuthStatusTool = defineTool<AuthStatusInput, AuthStatus>({
  name: 'tiktok_get_auth_status',
  title: 'TikTok auth status',
  description: DESCRIPTION,
  package: 'auth',
  // No scopes: the tool that diagnoses a missing scope must never be blocked by one.
  scopes: [],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    // Network only when `probe: true`; the tuple describes capability (§ 3.1).
    openWorldHint: true,
  },
  input: INPUT,
  handler: async (args, ctx): Promise<ToolResult<AuthStatus>> => {
    const summaries = await readCredentialSnapshot(ctx.api);
    const rows = summaries.map(toRow);
    const nowMs = ctx.api.clock.now();

    if (args.probe === true) {
      const checkedAt = new Date(nowMs).toISOString();
      try {
        // The cheapest authenticated call there is: one field, one round trip.
        await getUserInfo(
          ctx.api,
          ['open_id'],
          ctx.signal === undefined ? {} : { signal: ctx.signal },
        );
        const row = rows.find((entry) => entry.name === ctx.api.profile);
        if (row !== undefined) row.probe = { ok: true, checked_at: checkedAt };
      } catch (error) {
        // An auth-class rejection IS the answer the caller asked for, so it is
        // reported as the documented `auth_expired` failure (§ 3.1 "Errors")
        // rather than as a row flag. Anything else (network, upstream 500) is
        // not an authentication verdict and propagates to the wrapper.
        if (!isTikTokError(error) || error.kind !== 'auth') throw error;
        return {
          ok: false,
          error: toolErrorFrom(error),
          hints: [reauthHint(ctx.api.profile, PROBE_REJECTED)],
        };
      }
    }

    const hints: Hint[] = [];

    // Most actionable first (§ 5.2 rule 4): a dead credential blocks everything,
    // an ungranted package only blocks part of the surface.
    const stale = summaries.filter((summary) => needsLogin(summary, nowMs));
    const worst = stale.find((entry) => entry.name === ctx.api.profile) ?? stale[0];
    if (worst !== undefined) hints.push(reauthHint(worst.name, NO_REFRESH));

    const unavailable = TOOL_PACKAGES.filter(
      (pkg) =>
        PACKAGE_SCOPES[pkg].length > 0 &&
        !summaries.some((summary) =>
          PACKAGE_SCOPES[pkg].every((scope) => summary.scopes.includes(scope)),
        ),
    );
    if (unavailable.length > 0) {
      const scopes = [...new Set(unavailable.flatMap((pkg) => [...PACKAGE_SCOPES[pkg]]))];
      hints.push(loginHint(unavailable, scopes));
    }

    const result: ToolResult<AuthStatus> = { ok: true, data: { profiles: rows } };
    if (hints.length > 0) result.hints = hints;
    return result;
  },
});

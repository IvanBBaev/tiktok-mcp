/**
 * The shared part of the error catalog (TOOLS.md § 3.0) — the codes and
 * normative texts produced by the *registration wrapper* rather than by an
 * individual tool: `invalid_params`, `unknown_account`, `missing_scope`, plus
 * the uniform `TikTokError` → envelope mapping every tool call funnels into.
 *
 * The texts are normative: the test suite asserts them by substring, so they
 * are composed here once instead of being re-typed per tool. Placeholders are
 * server-filled; nothing upstream is ever interpolated into a message
 * (trust boundary, TOOLS.md § 5) — upstream detail lives in structured fields
 * (`log_id`, `details.api_code`).
 *
 * Layering: `core ← api ← mcp ← tools`.
 */

import type { z } from 'zod';

import { isTikTokError, type TikTokError } from '../core/errors.js';
import { redactText } from '../core/redact.js';
import type { ToolError } from './result.js';

/** Human-readable path of a zod issue, e.g. `post_info.title` or `ids[2]`. */
function issuePath(path: readonly (string | number)[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${String(segment)}]`;
    else out += out === '' ? segment : `.${segment}`;
  }
  return out;
}

/**
 * `<field>: <local validation reason>` for the first issue zod reported.
 *
 * Unknown keys are named explicitly (CC-G1): a typo has to point at itself,
 * otherwise a caller silently "fixes" the wrong argument.
 */
export function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'arguments: invalid';
  const path = issuePath(issue.path);
  if (issue.code === 'unrecognized_keys') {
    const keys = issue.keys
      .map((key) => (path === '' ? key : `${path}.${key}`))
      .join(', ');
    return `${keys}: unknown argument — check the spelling and the tool's input schema`;
  }
  return `${path === '' ? 'arguments' : path}: ${issue.message}`;
}

/** TOOLS.md § 3.0 — `invalid_params`. Nothing was sent upstream. */
export function invalidParamsError(detail: string): ToolError {
  return {
    code: 'invalid_params',
    message: `Invalid arguments: ${detail}. Fix the arguments and call again. No request was sent to TikTok.`,
    retryable: false,
  };
}

/** TOOLS.md § 3.0 — `unknown_account`. Resolved locally, before any network. */
export function unknownAccountError(
  name: string,
  configured: readonly string[],
  defaultProfile: string,
): ToolError {
  const list = configured.length > 0 ? configured.join(', ') : '(none configured)';
  return {
    code: 'unknown_account',
    message:
      `Unknown account '${name}'. Configured profiles: ${list}. ` +
      `Omit account to use the default profile ('${defaultProfile}').`,
    retryable: false,
    details: { configured: [...configured], default_profile: defaultProfile },
  };
}

/** TOOLS.md § 3.0 — `missing_scope`. Authoritative at call time (§ 6). */
export function missingScopeError(profile: string, scope: string): ToolError {
  return {
    code: 'missing_scope',
    message:
      `Account '${profile}' was authorized without scope ${scope}, which this tool requires. ` +
      `Ask the user to run: npx tiktok-mcp-ai login --profile ${profile} --scopes ${scope} — ` +
      'then verify with tiktok_get_auth_status.',
    retryable: false,
    details: { profile, missing_scope: scope },
  };
}

function fromTikTokError(error: TikTokError): ToolError {
  const message =
    error.remediation !== undefined && !error.message.includes(error.remediation)
      ? `${error.message} ${error.remediation}`
      : error.message;

  const details: Record<string, unknown> = { kind: error.kind };
  if (error.apiCode !== undefined) details['api_code'] = error.apiCode;

  const out: ToolError = {
    code: error.code,
    message,
    retryable: error.retryable,
    details,
  };
  if (error.logId !== undefined) out.log_id = error.logId;
  return out;
}

/**
 * Upstream code → catalog code for the publish endpoints (TOOLS.md § 3.0
 * "Upstream cap/verification codes are remapped"). The upstream spelling is
 * kept in `details.api_code`, so the remap loses nothing and gains a message
 * the model can act on: TikTok's own texts name internal quota systems and
 * say nothing about what the caller should do next.
 */
const PUBLISH_CODE_REMAP: ReadonlyMap<string, ToolError> = new Map([
  [
    'spam_risk_too_many_posts',
    {
      code: 'daily_post_cap',
      message:
        'TikTok reports this account reached its daily posting limit (~15 posts/24 h, shared ' +
        'across ALL apps posting via the API, not only this server). Do not retry today. ' +
        'Tell the user; posting resumes as the 24 h window rolls.',
      retryable: false,
    },
  ],
  [
    'reached_active_user_cap',
    {
      code: 'active_user_cap',
      message:
        'This app is unaudited and already served its maximum of 5 posting users in the last ' +
        '24 h (reached_active_user_cap). Do not retry today. The permanent fix is the developer ' +
        "passing TikTok's app audit.",
      retryable: false,
    },
  ],
  [
    'spam_risk_too_many_pending_share',
    {
      code: 'pending_share_cap',
      message:
        'TikTok blocked this draft: the account already has 5 unpublished API drafts from the ' +
        "last 24 h (spam_risk_too_many_pending_share). Ask the user to open TikTok's inbox " +
        'notifications and publish or discard pending drafts, then try again.',
      retryable: false,
    },
  ],
  [
    // The upstream twin of the local pre-flight check: the same failure, but
    // decided by TikTok because the prefix allow-list and the portal's verified
    // domains disagree. Same catalog code, so the caller reads one story.
    'url_ownership_unverified',
    {
      code: 'url_prefix_unverified',
      message:
        'TikTok refused to pull the media: the URL host is not a domain this app verified in ' +
        'the TikTok developer portal (url_ownership_unverified). Domain verification is a ' +
        'platform rule, not a server setting — TT_VERIFIED_URL_PREFIXES only mirrors it. Ask ' +
        'the user to host the media under a verified domain, then preview again.',
      retryable: false,
    },
  ],
  [
    'invalid_publish_id',
    {
      code: 'publish_not_found',
      message:
        'TikTok has no record of this publish_id — it may be expired (status is retained only ' +
        'for a limited window) or from another app. Check tiktok_list_publish_journal for the ' +
        'attempt and tiktok_list_videos for the result.',
      retryable: false,
    },
  ],
]);

/**
 * {@link toolErrorFrom} plus the publish-endpoint remaps. Publish tools funnel
 * their catch sites through this; every other tool keeps the plain mapping,
 * because these upstream codes only ever come back from `/post/publish/*`.
 */
export function publishToolError(error: unknown): ToolError {
  if (!isTikTokError(error)) return toolErrorFrom(error);
  const mapped = PUBLISH_CODE_REMAP.get(error.apiCode ?? '');
  if (mapped === undefined) return toolErrorFrom(error);
  const base = fromTikTokError(error);
  return {
    ...mapped,
    // `details` keeps the upstream spelling (`api_code`) and `log_id` survives,
    // so nothing is lost by presenting the mapped code.
    ...(base.log_id === undefined ? {} : { log_id: base.log_id }),
    ...(base.details === undefined ? {} : { details: base.details }),
  };
}

/**
 * The one catch-site mapping. A `TikTokError` carries its own catalog code; an
 * unexpected throw is a server bug and becomes `internal_error` with a message
 * that promises nothing about retrying. The thrown value's own text is kept
 * only in `details`, redacted, so a stack-trace string can never smuggle a
 * secret or upstream prose into the model-facing message.
 */
export function toolErrorFrom(error: unknown): ToolError {
  if (isTikTokError(error)) return fromTikTokError(error);
  const reason = error instanceof Error ? error.message : String(error);
  return {
    code: 'internal_error',
    message:
      'The server hit an unexpected internal error while running this tool. ' +
      'This is a bug in tiktok-mcp-ai, not in the request. Report it with the tool name; ' +
      'do not retry in a loop.',
    retryable: false,
    details: { reason: redactText(reason) },
  };
}

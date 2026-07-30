/**
 * Self-test worker: refresh the token against the parent's stub.
 *
 * Exists to prove three things about the harness itself, end to end across a
 * real process boundary — before any product code depends on them:
 *
 * - the children inherit the `TT_` variables the test set, *even though* this
 *   worker imports `helpers.js`, whose import-time sanitizer would otherwise
 *   strip them (`TIKTOK_MCP_TEST_INHERIT_ENV`);
 * - `TT_OAUTH_BASE_URL` really does reach a child's `fetch`;
 * - the token stub answers the flat OAuth shape, not the envelope.
 *
 * The real env-lock worker (TB-8) replaces the bare `fetch` here with the
 * locked refresh path; the barrier and reporting stay identical.
 */

// Imported for its side effect: this is the module whose sanitizer the
// `TIKTOK_MCP_TEST_INHERIT_ENV` opt-out has to survive.
import '../../helpers.js';

import type { ChildContext } from '../lock-child.js';

export default async function refreshWorker(ctx: ChildContext): Promise<unknown> {
  const baseUrl = process.env['TT_OAUTH_BASE_URL'];
  if (baseUrl === undefined) throw new Error('TT_OAUTH_BASE_URL did not reach the child');

  const response = await fetch(`${baseUrl}/v2/oauth/token/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: process.env['TT_CLIENT_KEY'] ?? '',
      grant_type: 'refresh_token',
      refresh_token: process.env['TT_REFRESH_TOKEN'] ?? '',
    }).toString(),
  });
  const body = (await response.json()) as Record<string, unknown>;

  return {
    index: ctx.index,
    args: ctx.args,
    status: response.status,
    accessToken: body['access_token'],
    // The flat shape has no `data` wrapper; if a decoder ever wrapped it, this
    // would come back undefined and the assertion would name the reason.
    hasDataWrapper: 'data' in body,
  };
}

/**
 * MCP argument completion — the mechanism behind `completion/complete`
 * (TOOLS.md § 7.3).
 *
 * A client that renders a prompt's argument form, or a resource template's
 * variables, asks the server what a half-typed value could be. The answer is
 * a list of strings, nothing more: the protocol has no notion of validation
 * here, and the server none of the client's UI. What this module adds is the
 * *sources* those strings come from and the one function that turns a source
 * plus the typed prefix into a `completion` result.
 *
 * Design notes:
 *
 * - **A source is data on the spec.** A prompt argument or a template
 *   variable declares `completion: { kind: … }`; nothing else about the spec
 *   changes, and an argument without one completes to nothing rather than
 *   failing — the client cannot tell "no source" from "no match", and should
 *   not have to.
 * - **Three sources, all local.** `profiles` reads the credential file's
 *   profile names (through the runtime seam, like every other handler);
 *   `values` is a fixed vocabulary such as the privacy levels; `publish_ids`
 *   folds the publish journal. None of them touches the network: a completion
 *   is a keystroke-rate request, and TikTok's per-minute budgets (§ 3) are
 *   not for keystrokes.
 * - **The account completes the same way everywhere.** A resource's
 *   `{?account}` variable is not on any spec — the server adds it to every
 *   template — so `mcp/resources` answers it from `profiles` without a
 *   declaration, and a prompt's `account` argument declares the same source.
 *   Under `TT_LOCK_PROFILE` both offer the locked name alone, because any
 *   other name is unknown to `resolveAccount` (§ 2.2).
 * - **Matching is a case-insensitive prefix.** Profile names are uppercase by
 *   construction and privacy levels are SCREAMING_SNAKE; a client that sends
 *   what the user typed should still get them.
 *
 * Layering: `mcp/` — the specs that carry sources live in `tools/`.
 */

import { canonicalProfileName } from '../core/config.js';
import type { Logger } from '../core/log.js';
import type { Settings } from '../core/settings.js';
import { foldedAttemptsCached, journalOptionsFor } from './journal.js';

/** The protocol's cap on `completion.values` ("must not exceed 100 items"). */
export const COMPLETION_MAX = 100;

/**
 * Where a completable argument's candidates come from. A discriminated union
 * so a spec states the source by name and the server holds the only code
 * that resolves one.
 */
export type CompletionSource =
  /** The configured profile names — or the locked one alone (§ 2.2). */
  | { readonly kind: 'profiles' }
  /** A fixed vocabulary, offered in the order given. */
  | { readonly kind: 'values'; readonly values: readonly string[] }
  /**
   * Every `publish_id` the journal recorded, newest first, each once. With an
   * `account` in the request context only that profile's attempts count —
   * the same filter `tiktok_list_publish_journal` applies (§ 3.7).
   */
  | { readonly kind: 'publish_ids' };

/**
 * What resolving a source needs from the outside world — the subset of
 * `mcp/server`'s `ServerRuntime`, stated structurally so this module does not
 * import the server that imports it.
 */
export interface CompletionRuntime {
  readonly settings: Settings;
  readonly log: Logger;
  profiles(): Promise<readonly { readonly name: string }[]>;
}

/** The `completion/complete` inputs a source sees. */
export interface CompletionRequest {
  /** What the user has typed so far; empty offers everything. */
  readonly value: string;
  /** The other arguments the client has already filled in, when it sent them. */
  readonly context?: Readonly<Record<string, string>> | undefined;
}

/** The `completion` member of a `completion/complete` result. */
export interface Completion {
  readonly values: readonly string[];
  /** Matches before the cap, so a client can say "and N more". */
  readonly total: number;
  readonly hasMore: boolean;
}

/**
 * The problem with a declared source, or `undefined` when it is sound. The
 * spec constructors wrap the text in their own error, so it names the fault
 * without the spec.
 */
export function completionSourceProblem(source: CompletionSource): string | undefined {
  if (source.kind !== 'values') return undefined;
  if (source.values.length === 0) return 'a "values" completion lists no values';
  const seen = new Set<string>();
  for (const value of source.values) {
    if (seen.has(value)) return `a "values" completion repeats "${value}"`;
    seen.add(value);
  }
  return undefined;
}

/**
 * Resolve a source against the typed prefix. `undefined` — an argument that
 * declares no source — completes to nothing, so the server has one call
 * shape for every declared argument.
 */
export async function complete(
  source: CompletionSource | undefined,
  runtime: CompletionRuntime,
  request: CompletionRequest,
): Promise<Completion> {
  const candidates =
    source === undefined ? [] : await candidatesOf(source, runtime, request.context);
  const needle = request.value.toLowerCase();
  const matches = candidates.filter((candidate) =>
    candidate.toLowerCase().startsWith(needle),
  );
  return {
    values: matches.slice(0, COMPLETION_MAX),
    total: matches.length,
    hasMore: matches.length > COMPLETION_MAX,
  };
}

async function candidatesOf(
  source: CompletionSource,
  runtime: CompletionRuntime,
  context: CompletionRequest['context'],
): Promise<readonly string[]> {
  switch (source.kind) {
    case 'profiles':
      return profileNames(runtime);
    case 'values':
      return source.values;
    case 'publish_ids':
      return publishIds(runtime, context?.['account']);
  }
}

async function profileNames(runtime: CompletionRuntime): Promise<readonly string[]> {
  const locked = runtime.settings.lockProfile;
  if (locked !== undefined) return [locked];
  return (await runtime.profiles()).map((profile) => profile.name);
}

/**
 * The journal's `publish_id`s, newest first and each once. Folded before it
 * is filtered, like the read tool, so an attempt's id is the one its outcome
 * recorded; a missing journal is simply no ids. The fold is cached while the
 * journal is unchanged, since completion asks on every keystroke. A blank `account` is no
 * filter — to the tool "not given" and "given nothing" are the same thing.
 */
async function publishIds(
  runtime: CompletionRuntime,
  account: string | undefined,
): Promise<readonly string[]> {
  const attempts = await foldedAttemptsCached(
    journalOptionsFor(runtime.settings, runtime.log),
  );
  const locked = runtime.settings.lockProfile;
  const ids = new Set<string>();
  for (const attempt of [...attempts].reverse()) {
    if (attempt.publish_id === undefined) continue;
    // The lock filters exactly as it does in the journal tool.
    if (locked !== undefined && attempt.profile !== locked) continue;
    if (
      account !== undefined &&
      account !== '' &&
      attempt.profile !== canonicalProfileName(account)
    ) {
      continue;
    }
    ids.add(attempt.publish_id);
  }
  return [...ids];
}

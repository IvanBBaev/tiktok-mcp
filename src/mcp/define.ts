/**
 * Tools-as-data (CONTRACTS.md § `mcp/define.ts`).
 *
 * A tool is a plain object, never a call into a registration API: name, title,
 * description, package, required scopes, all four annotation hints, an input
 * schema and a handler. Nothing in a `ToolSpec` reaches for a transport, a
 * server or global state, which is what lets the same array drive server
 * registration, the manifest snapshot test, README generation and
 * `server.json` generation (TOOLS.md § 1) from ONE source.
 *
 * `defineTool` is an identity function for the type system plus a set of
 * import-time assertions. The assertions are deliberately eager: a malformed
 * spec is a programming error that must surface when the manifest module is
 * loaded — in `npm run check`, not on a user's `tools/call`.
 *
 * Layering: `core ← api ← mcp ← tools`. This file may import from `core`/`api`.
 */

import { z } from 'zod';

import type { ApiContext } from '../api/context.js';
import { TikTokError } from '../core/errors.js';
import type { Logger } from '../core/log.js';
import { TOOL_PACKAGES, type ToolPackage } from '../core/settings.js';
import type { ToolResult } from './result.js';

/**
 * The five tool packages of TOOLS.md § 1. Kept as an alias of the core
 * `ToolPackage` union so the server, the settings parser (`TT_TOOL_PACKAGES`,
 * `TT_PACKAGES_DENY`) and the manifest all speak exactly one vocabulary.
 */
export type PackageName = ToolPackage;

export interface ToolCtx {
  /** Resolved api context for the profile this call runs against. */
  api: ApiContext;

  /** Logger already bound to profile + tool name. */
  log: Logger;

  /**
   * Cancellation for the whole call, derived from the MCP request. Handlers
   * that do I/O must forward it; handlers that loop must check it (CC-G4).
   */
  signal?: AbortSignal;

  /**
   * Progress reporter — a no-op unless the client sent a progress token.
   * Never called with a `done` greater than `total`.
   */
  progress?: (done: number, total: number) => void;
}

export interface ToolSpec<In, Out> {
  /** Wire name; the `tiktok_` prefix is part of the public surface. */
  name: `tiktok_${string}`;

  /** Short human label for tool pickers. */
  title: string;

  /** Model-facing description — the first sentence is what clients truncate to. */
  description: string;

  /** Package this tool belongs to; drives `TT_TOOL_PACKAGES` gating. */
  package: PackageName;

  /**
   * TikTok scopes the call needs. Checked against the granted scopes of the
   * resolved profile *before* the handler runs, so a missing scope costs no
   * network round trip (TOOLS.md § 3.0 `missing_scope`).
   */
  scopes: string[];

  /**
   * Scopes of which **any one** suffices, checked in addition to `scopes`
   * (which stays an AND). TikTok grants `video.publish` and `video.upload`
   * separately but answers `/publish/status/fetch/` for either, so
   * `tiktok_get_publish_status` must not claim to need both (TOOLS.md § 3.6).
   *
   * Omit unless the upstream genuinely accepts alternatives; an empty or
   * single-entry list is a spec error, because it would mean an AND written in
   * the wrong field.
   */
  scopesAnyOf?: readonly string[];

  /**
   * All four hints are required — an undecided annotation is a compile error
   * rather than a silent `false` (TOOLS.md § 1).
   */
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };

  /**
   * Input schema. MUST be a strict object (CC-G1): an unknown key is a typo
   * that has to fail loudly, not be silently ignored. Build it with
   * {@link toolInput} so the shared `account` argument and `.strict()` are
   * never forgotten.
   */
  input: z.ZodType<In>;

  /** The implementation. Returns an envelope; only crashes on real bugs. */
  handler(args: In, ctx: ToolCtx): Promise<ToolResult<Out>>;
}

/**
 * A spec with its type parameters erased, for containers that hold tools of
 * mixed shapes (the manifest, the registration loop).
 */
export type AnyToolSpec = ToolSpec<unknown, unknown>;

/** `tiktok_` + lowercase snake case. Matches every name in TOOLS.md § 1. */
const NAME_RE = /^tiktok_[a-z0-9]+(?:_[a-z0-9]+)*$/;

/** A key no real caller would send, used to probe `.strict()` behaviour. */
const STRICTNESS_PROBE = '__tiktok_mcp_strictness_probe__';

/**
 * Normative `.describe()` text for the auto-injected `account` argument
 * (TOOLS.md § 2.2). Client UIs render it verbatim, so it is a fixed string,
 * not a template.
 */
export const ACCOUNT_DESCRIPTION =
  'Profile name from the server configuration. Omit to use the default profile. ' +
  'Unknown names fail locally without contacting TikTok.';

/** The shared `account` argument, identical on every tool. */
export const accountArg = z.string().min(1).optional().describe(ACCOUNT_DESCRIPTION);

/**
 * Build a tool input schema: the caller's shape plus the auto-injected
 * `account` argument (TOOLS.md § 2.2), sealed with `.strict()` (CC-G1).
 *
 * A tool that needs different `account` semantics — `tiktok_list_publish_journal`
 * treats it as a filter — declares its own `account` in `shape` and wins the
 * spread, keeping the injection a default rather than a law.
 */
export function toolInput<Shape extends z.ZodRawShape>(
  shape: Shape,
): z.ZodObject<{ account: typeof accountArg } & Shape, 'strict'> {
  return z.object({ account: accountArg, ...shape }).strict();
}

/**
 * True when `schema` rejects unknown keys. Probed behaviourally rather than by
 * reading zod internals: `.strict()` objects report an `unrecognized_keys`
 * issue alongside any missing-field issues, wrappers (`.refine`, `.default`)
 * pass the inner issues through, and a stripping object simply succeeds or
 * fails without ever mentioning the probe key.
 */
function rejectsUnknownKeys(schema: z.ZodType<unknown>): boolean {
  const parsed = schema.safeParse({ [STRICTNESS_PROBE]: 1 });
  if (parsed.success) return false;
  return parsed.error.issues.some((issue) => issue.code === 'unrecognized_keys');
}

function specError(name: string, problem: string): TikTokError {
  return new TikTokError({
    kind: 'internal',
    code: 'invalid_tool_spec',
    message: `Tool spec "${name}" is invalid: ${problem}.`,
    retryable: false,
    remediation:
      'Fix the tool definition; this is a bug in the server, not in the request.',
  });
}

/**
 * Register a tool. Returns the spec unchanged (frozen), so a module can both
 * export the value and use it inline in the manifest.
 */
export function defineTool<In, Out>(spec: ToolSpec<In, Out>): ToolSpec<In, Out> {
  const { name } = spec;

  if (!NAME_RE.test(name)) {
    throw specError(
      name,
      'the name must be lowercase snake case prefixed with "tiktok_"',
    );
  }
  if (spec.title.trim() === '') throw specError(name, 'title is empty');
  if (spec.description.trim() === '') throw specError(name, 'description is empty');
  if (!TOOL_PACKAGES.includes(spec.package)) {
    throw specError(
      name,
      `package "${spec.package}" is not one of ${TOOL_PACKAGES.join(', ')}`,
    );
  }
  if (new Set(spec.scopes).size !== spec.scopes.length) {
    throw specError(name, 'scopes contains duplicates');
  }
  if (spec.scopes.some((scope) => scope.trim() === '')) {
    throw specError(name, 'scopes contains an empty entry');
  }
  const anyOf = spec.scopesAnyOf;
  if (anyOf !== undefined) {
    if (anyOf.length < 2) {
      throw specError(
        name,
        'scopesAnyOf needs at least two alternatives — one alternative is an AND and belongs in scopes',
      );
    }
    if (new Set(anyOf).size !== anyOf.length) {
      throw specError(name, 'scopesAnyOf contains duplicates');
    }
    if (anyOf.some((scope) => scope.trim() === '')) {
      throw specError(name, 'scopesAnyOf contains an empty entry');
    }
    const required = new Set(spec.scopes);
    if (anyOf.some((scope) => required.has(scope))) {
      throw specError(
        name,
        'scopesAnyOf overlaps scopes — an already-required scope makes the alternation vacuous',
      );
    }
  }
  if (!rejectsUnknownKeys(spec.input)) {
    throw specError(
      name,
      'the input schema accepts unknown keys — build it with toolInput()/.strict() (CC-G1)',
    );
  }
  if (spec.annotations.readOnlyHint && spec.annotations.destructiveHint) {
    throw specError(name, 'a read-only tool cannot also be destructive');
  }

  Object.freeze(spec.annotations);
  Object.freeze(spec.scopes);
  if (spec.scopesAnyOf !== undefined) Object.freeze(spec.scopesAnyOf);
  return Object.freeze(spec);
}

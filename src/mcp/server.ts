/**
 * The MCP server: `tools/list` and `tools/call` implemented directly on the
 * low-level `Server` (ARCHITECTURE.md §§ 2, 6; TOOLS.md §§ 2.1–2.4, 3.0, 6).
 *
 * ## Why not `McpServer.registerTool`
 *
 * The high-level helper installs its own `tools/call` handler which validates
 * the arguments against the registered zod schema and, on failure, throws an
 * `McpError` that the SDK renders as a bare text result with `isError: true`
 * and NO `structuredContent`. That breaks three normative promises at once:
 * the envelope of § 2.1 (which every result must carry, failures included),
 * the `invalid_params` catalog entry of § 3.0 (whose text is substring-tested)
 * and § 2.3 (locally checkable failures fail as data, not as protocol errors).
 * The validation step is private and has no opt-out, so this file owns both
 * handlers, and JSON Schema generation comes from `zod-to-json-schema` instead
 * of the SDK's internal converter.
 *
 * ## The call pipeline
 *
 * parse (`.strict()`, CC-G1) → resolve account (§ 2.2) → scope check (§ 6.2,
 * authoritative) → handler → uniform error mapping → redact + truncate
 * (CC-G2/G7) → `content` + `structuredContent` + `isError`. Every step that
 * fails produces the same envelope shape, so a client never has to special-case
 * *where* a call died.
 *
 * Layering: `core ← api ← mcp ← tools`. The manifest is passed in, never
 * imported, so this module stays testable with fixture tools.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { ApiContext } from '../api/context.js';
import type { Logger } from '../core/log.js';
import {
  resolveEnabledPackages,
  type Settings,
  type ToolPackage,
} from '../core/settings.js';
import type { AnyToolSpec, ToolCtx } from './define.js';
import {
  describeZodError,
  invalidParamsError,
  missingScopeError,
  toolErrorFrom,
  unknownAccountError,
} from './errors.js';
import {
  RESULT_JSON_SCHEMA,
  truncateResult,
  type Hint,
  type ToolResult,
} from './result.js';

/** A configured profile as the server sees it at call time. */
export interface ProfileInfo {
  name: string;
  /** Scopes TikTok actually granted (from the stored credential record). */
  scopes: readonly string[];
}

/**
 * Everything the request handlers need from the outside world, behind one
 * seam: tests substitute a fixture runtime, the bootstrap wires the real
 * credential store. `profiles()` is re-read per call on purpose — the marker
 * in a tool description may be stale, the call-time check may not (§ 6).
 */
export interface ServerRuntime {
  settings: Settings;
  log: Logger;
  profiles(): Promise<readonly ProfileInfo[]>;
  createContext(profile: string): Promise<ApiContext>;
}

export interface ToolPackageLike {
  name: ToolPackage;
  tools: readonly AnyToolSpec[];
}

/**
 * Tools where `account` filters the answer instead of selecting the profile to
 * call TikTok with (TOOLS.md § 2.2 exception, § 3.7). For these the wrapper
 * resolves the *default* profile and leaves the argument to the handler.
 */
const ACCOUNT_IS_FILTER: ReadonlySet<string> = new Set(['tiktok_list_publish_journal']);

/**
 * Which packages this process serves.
 *
 * The reduction itself lives in `core/settings` — `login` needs the same answer
 * without loading the MCP SDK — and is re-exported here under its contracted
 * name (CONTRACTS.md § `mcp/server.ts`) so no consumer has to move.
 */
export { resolveEnabledPackages };

/** The enabled tools, in manifest order. */
export function enabledTools(
  packages: readonly ToolPackageLike[],
  settings: Settings,
): readonly AnyToolSpec[] {
  const enabled = new Set(resolveEnabledPackages(settings));
  return packages.filter((pkg) => enabled.has(pkg.name)).flatMap((pkg) => [...pkg.tools]);
}

/**
 * The `[UNAVAILABLE: ...]` description prefix (TOOLS.md § 6.1), or `undefined`
 * when at least one configured profile covers the tool's scopes. Availability
 * is a union across profiles: a tool one profile can use is not unavailable.
 * The marker is advisory — the call-time check in {@link callTool} decides.
 */
export function unavailableMarker(
  spec: AnyToolSpec,
  profiles: readonly ProfileInfo[],
): string | undefined {
  const anyOf = spec.scopesAnyOf;
  if (spec.scopes.length === 0 && anyOf === undefined) return undefined;
  const covered = profiles.some(
    (profile) =>
      spec.scopes.every((scope) => profile.scopes.includes(scope)) &&
      (anyOf === undefined || anyOf.some((scope) => profile.scopes.includes(scope))),
  );
  if (covered) return undefined;
  // "a, b or c" — the alternation reads as one requirement, so it stays a
  // single comma-separated part rather than being flattened into the AND list.
  const list = [
    ...spec.scopes,
    ...(anyOf === undefined ? [] : [anyOf.join(' or ')]),
  ].join(', ');
  // The suggested command must be satisfiable, so it names the first
  // alternative rather than every one of them.
  const fix = [...spec.scopes, ...(anyOf === undefined ? [] : [anyOf[0]])].join(',');
  return (
    `[UNAVAILABLE: requires scope ${list}; no configured profile grants it. ` +
    `Fix: npx tiktok-mcp-ai login --scopes ${fix}]`
  );
}

/** JSON Schema object as the MCP `Tool` type wants it. */
type JsonObjectSchema = Tool['inputSchema'];

function toJsonSchema(spec: AnyToolSpec): JsonObjectSchema {
  const schema = zodToJsonSchema(spec.input, {
    $refStrategy: 'none',
    target: 'jsonSchema7',
  }) as Record<string, unknown>;
  // `$schema` is noise on the wire — the MCP schema already fixes the dialect.
  delete schema['$schema'];
  return schema as JsonObjectSchema;
}

/** The `tools/list` entry for one spec, marker included. */
export function describeTool(spec: AnyToolSpec, profiles: readonly ProfileInfo[]): Tool {
  const marker = unavailableMarker(spec, profiles);
  return {
    name: spec.name,
    title: spec.title,
    description:
      marker === undefined ? spec.description : `${marker} ${spec.description}`,
    inputSchema: toJsonSchema(spec),
    outputSchema: RESULT_JSON_SCHEMA as JsonObjectSchema,
    annotations: { title: spec.title, ...spec.annotations },
  };
}

function errorResult(
  error: ToolResult<never>['error'],
  hints?: Hint[],
): ToolResult<unknown> {
  const result: ToolResult<unknown> = { ok: false, error };
  if (hints !== undefined) result.hints = hints;
  return result;
}

/**
 * Resolve the profile a call runs against (TOOLS.md § 2.2). Returns either the
 * profile name or the envelope that must be returned instead — resolution
 * failures are data, not exceptions, because the model has to read them.
 */
function resolveAccount(
  spec: AnyToolSpec,
  requested: unknown,
  settings: Settings,
  profiles: readonly ProfileInfo[],
): { profile: string } | { result: ToolResult<unknown> } {
  const names = profiles.map((profile) => profile.name);
  const locked = settings.lockProfile;
  const fallback = locked ?? settings.activeProfile;

  if (
    typeof requested !== 'string' ||
    requested === '' ||
    ACCOUNT_IS_FILTER.has(spec.name)
  ) {
    return { profile: fallback };
  }
  if (locked !== undefined && requested !== locked) {
    // TT_LOCK_PROFILE pins the server to one account: any other name is
    // "unknown" from the caller's point of view, phrased identically.
    return { result: errorResult(unknownAccountError(requested, [locked], locked)) };
  }
  if (!names.includes(requested)) {
    return { result: errorResult(unknownAccountError(requested, names, fallback)) };
  }
  return { profile: requested };
}

/** Call-time scope check — authoritative even when no marker was shown (§ 6.2). */
function checkScopes(
  spec: AnyToolSpec,
  profile: string,
  profiles: readonly ProfileInfo[],
): ToolResult<unknown> | undefined {
  const anyOf = spec.scopesAnyOf;
  if (spec.scopes.length === 0 && anyOf === undefined) return undefined;
  const granted = profiles.find((entry) => entry.name === profile)?.scopes ?? [];
  const missing =
    spec.scopes.find((scope) => !granted.includes(scope)) ??
    // An alternation is missing only when NONE of its members is granted; the
    // first one is then what the remediation asks for.
    (anyOf !== undefined && !anyOf.some((scope) => granted.includes(scope))
      ? anyOf[0]
      : undefined);
  if (missing === undefined) return undefined;
  const hint: Hint = {
    type: 'reauth',
    text:
      `Ask the user to re-run the login command for profile '${profile}' with the ${missing} scope, ` +
      'then confirm with tiktok_get_auth_status before calling this tool again.',
    command: `npx tiktok-mcp-ai login --profile ${profile} --scopes ${missing}`,
    profile,
  };
  return errorResult(missingScopeError(profile, missing), [hint]);
}

/** `data.meta.account` echoes the resolved profile on every call (§ 2.1). */
function stampAccount(result: ToolResult<unknown>, profile: string): ToolResult<unknown> {
  const data = result.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return result;
  const record = data as Record<string, unknown>;
  const meta = record['meta'];
  const merged =
    typeof meta === 'object' && meta !== null && !Array.isArray(meta)
      ? { ...(meta as Record<string, unknown>) }
      : {};
  if (merged['account'] === undefined) merged['account'] = profile;
  return { ...result, data: { ...record, meta: merged } };
}

/** Progress reporter bound to the client's token, or `undefined` when it sent none. */
function progressReporter(
  token: string | number | undefined,
  send: (notification: {
    method: 'notifications/progress';
    params: { progressToken: string | number; progress: number; total?: number };
  }) => Promise<void>,
  log: Logger,
): ToolCtx['progress'] {
  if (token === undefined) return undefined;
  return (done: number, total: number): void => {
    void send({
      method: 'notifications/progress',
      params: { progressToken: token, progress: Math.min(done, total), total },
    }).catch((cause: unknown) => {
      // A dropped progress frame must never fail the call it describes.
      log.debug('progress notification failed', { reason: String(cause) });
    });
  };
}

export interface CallOptions {
  signal?: AbortSignal;
  progress?: ToolCtx['progress'];
}

/**
 * Run one tool end to end and return the envelope. Exported separately from
 * the request handler so tests (and a future HTTP transport) exercise the
 * pipeline without a transport.
 */
export async function callTool(
  spec: AnyToolSpec,
  args: unknown,
  runtime: ServerRuntime,
  opts: CallOptions = {},
): Promise<ToolResult<unknown>> {
  const profiles = await runtime.profiles();

  const parsed = spec.input.safeParse(args ?? {});
  if (!parsed.success) {
    return errorResult(invalidParamsError(describeZodError(parsed.error)));
  }

  // Read `account` from the parsed value, not the raw arguments: a schema may
  // trim or default it, and the profile actually used must be the parsed one.
  const validated = parsed.data as Record<string, unknown> | null;
  const resolved = resolveAccount(
    spec,
    validated?.['account'],
    runtime.settings,
    profiles,
  );
  if ('result' in resolved) return resolved.result;
  const { profile } = resolved;

  const denied = checkScopes(spec, profile, profiles);
  if (denied !== undefined) return denied;

  const log = runtime.log.child({ tool: spec.name, profile });
  try {
    const api = await runtime.createContext(profile);
    const ctx: ToolCtx = { api, log };
    if (opts.signal !== undefined) ctx.signal = opts.signal;
    if (opts.progress !== undefined) ctx.progress = opts.progress;
    const result = await spec.handler(parsed.data, ctx);
    return stampAccount(result, profile);
  } catch (cause) {
    log.warn('tool call failed', { code: toolErrorFrom(cause).code });
    return stampAccount(errorResult(toolErrorFrom(cause)), profile);
  }
}

/** Envelope → MCP result: mirrored text block, structured content, `isError`. */
export function toCallToolResult(
  result: ToolResult<unknown>,
  settings: Settings,
): CallToolResult {
  const { result: shaped, text } = truncateResult(result, settings.resultCharBudget, {
    pretty: settings.prettyJson,
  });
  return {
    content: [{ type: 'text', text }],
    structuredContent: shaped as unknown as Record<string, unknown>,
    isError: !shaped.ok,
  };
}

export interface ServerOptions {
  name: string;
  version: string;
  packages: readonly ToolPackageLike[];
  runtime: ServerRuntime;
}

export interface McpServerHandle {
  server: Server;
  /** Recompute descriptions and tell connected clients (TOOLS.md § 6.3). */
  notifyToolListChanged(): Promise<void>;
}

/**
 * Build the server and install both tool handlers.
 *
 * `capabilities.tools.listChanged` is declared up front: without it the
 * `notifications/tools/list_changed` emitted when credentials change is a dead
 * letter (§ 6.3). `logging` is declared because the server forwards nothing to
 * stdout — every diagnostic goes to stderr or to the client as a log message.
 */
export function createServer(opts: ServerOptions): McpServerHandle {
  const { packages, runtime } = opts;
  const server = new Server(
    { name: opts.name, version: opts.version },
    { capabilities: { tools: { listChanged: true }, logging: {} } },
  );

  const specsByName = new Map<string, AnyToolSpec>(
    enabledTools(packages, runtime.settings).map((spec) => [spec.name, spec]),
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const profiles = await runtime.profiles();
    return {
      tools: [...specsByName.values()].map((spec) => describeTool(spec, profiles)),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const spec = specsByName.get(request.params.name);
    if (spec === undefined) {
      // Not a tool failure but a protocol failure: the name does not exist.
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    }
    const callOpts: CallOptions = { signal: extra.signal };
    const progress = progressReporter(
      request.params._meta?.progressToken,
      extra.sendNotification,
      runtime.log,
    );
    if (progress !== undefined) callOpts.progress = progress;
    const result = await callTool(spec, request.params.arguments, runtime, callOpts);
    return toCallToolResult(result, runtime.settings);
  });

  return {
    server,
    notifyToolListChanged: async (): Promise<void> => {
      await server.sendToolListChanged();
    },
  };
}

/**
 * Serve over stdio. stdout carries JSON-RPC frames and nothing else (CC-G3):
 * logs go to stderr, and `no-console` keeps a stray `console.log` from ever
 * being written.
 */
export async function connectStdio(
  handle: McpServerHandle,
): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport();
  await handle.server.connect(transport);
  return transport;
}

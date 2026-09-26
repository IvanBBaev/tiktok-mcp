/**
 * The MCP server: `tools/list`, `tools/call`, the prompt and the resource
 * handlers implemented directly on the low-level `Server` (ARCHITECTURE.md
 * §§ 2, 6; TOOLS.md §§ 2.1–2.4, 3.0, 6, 7).
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
 * The validation step is private and has no opt-out, so this file owns every
 * handler itself, and JSON Schema generation comes from zod's own
 * `z.toJSONSchema` instead of the SDK's internal converter.
 *
 * ## The call pipeline
 *
 * parse (`.strict()`, CC-G1) → resolve account (§ 2.2) → scope check (§ 6.2,
 * authoritative) → handler → uniform error mapping → redact + truncate
 * (CC-G2/G7) → `content` + `structuredContent` + `isError`. Every step that
 * fails produces the same envelope shape, so a client never has to special-case
 * *where* a call died.
 *
 * ## Prompts and resources
 *
 * A prompt is server-authored steering the user invokes (`mcp/prompts`); a
 * resource is a read-only tool exposed at a `tiktok://` URI (`mcp/resources`),
 * and `resources/read` runs that tool through {@link callTool} — the pipeline
 * above, unchanged — so account resolution, the scope check and the redact +
 * truncate step cannot drift between the two surfaces. Both are gated with the
 * packages: a prompt is listed while its package is enabled, a resource while
 * its tool is, and a resource carries the tool's `[UNAVAILABLE: …]` marker. A
 * resource with a `{name}` path parameter (`tiktok://publish/{publish_id}/status`)
 * is a template: `resources/templates/list` advertises it, `resources/list`
 * does not, and a read resolves the requested path against the enabled specs
 * (`matchResource`). An unknown prompt name or resource URI is a protocol
 * error (`McpError` / `InvalidParams`), exactly like an unknown tool; the
 * bound tool's `ok: false` envelope is not — it is the data the resource holds.
 *
 * Layering: `core ← api ← mcp ← tools`. The manifests — tools, prompts,
 * resources — are passed in, never imported, so this module stays testable
 * with fixtures.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type CallToolResult,
  type RequestId,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { ApiContext } from '../api/context.js';
import type { Clock } from '../core/clock.js';
import { canonicalProfileName } from '../core/config.js';
import type { Logger } from '../core/log.js';
import {
  resolveEnabledPackages,
  type Settings,
  type ToolPackage,
} from '../core/settings.js';
import type { AnyToolSpec, ToolCtx } from './define.js';
import {
  argumentErrorMap,
  describeZodError,
  invalidParamsError,
  missingScopeError,
  unconfiguredProfileScopeError,
  toolErrorFrom,
  unknownAccountError,
} from './errors.js';
import { complete, type CompletionSource } from './completions.js';
import {
  describePrompt,
  getPrompt,
  promptCompletion,
  type PromptSpec,
} from './prompts.js';
import {
  describeResource,
  describeResourceTemplate,
  isResourceTemplate,
  matchResource,
  matchResourceRef,
  parseResourceUri,
  resourceArgs,
  resourceCompletion,
  resourceContents,
  type ResourceSpec,
} from './resources.js';
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
  /**
   * False when the profile stores neither an access nor a refresh token — it
   * was never logged in, or its record cannot be read. Absent means the caller
   * does not know, and the profile is treated as authorized.
   */
  authorized?: boolean;
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
/** JSON-RPC code for a request refused during the stdio drain (as http.ts's). */
const SHUTTING_DOWN = -32000;

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
 * The enabled prompts, in manifest order: a prompt follows its package and
 * every package it `requires`.
 */
export function enabledPrompts(
  prompts: readonly PromptSpec[],
  settings: Settings,
): readonly PromptSpec[] {
  const enabled = new Set(resolveEnabledPackages(settings));
  return prompts.filter(
    (spec) =>
      enabled.has(spec.package) && (spec.requires ?? []).every((pkg) => enabled.has(pkg)),
  );
}

/**
 * The enabled resources, in manifest order: a resource follows its tool, so it
 * is listed exactly when `tools/list` would list the tool it reads through.
 * Membership is by tool *name* — the same key `tools/call` resolves — so the
 * answer cannot depend on which module instance a spec was imported from.
 */
export function enabledResources(
  resources: readonly ResourceSpec[],
  tools: readonly AnyToolSpec[],
): readonly ResourceSpec[] {
  const names = new Set(tools.map((spec) => spec.name));
  return resources.filter((spec) => names.has(spec.tool.name));
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
  // `io: 'input'` describes what a caller sends — before transforms and with
  // defaulted fields optional — which is what a tool's input schema promises.
  const schema = z.toJSONSchema(spec.input, {
    target: 'draft-7',
    io: 'input',
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

  // Profile names are stored upper-cased (CC-F4); compare the caller's
  // spelling the same way, but echo it as given in any error. A whitespace-
  // only one (`"  "`) names no account, exactly like an absent one; `""`
  // never gets here, since `accountArg` is `min(1)`.
  if (typeof requested !== 'string' || ACCOUNT_IS_FILTER.has(spec.name)) {
    return { profile: fallback };
  }
  const wanted = canonicalProfileName(requested);
  if (wanted === '') return { profile: fallback };
  if (locked !== undefined && wanted !== locked) {
    // TT_LOCK_PROFILE pins the server to one account: any other name is
    // "unknown" from the caller's point of view, phrased identically.
    return { result: errorResult(unknownAccountError(requested, [locked], locked)) };
  }
  if (!names.includes(wanted)) {
    return { result: errorResult(unknownAccountError(requested, names, fallback)) };
  }
  return { profile: wanted };
}

/** Call-time scope check — authoritative even when no marker was shown (§ 6.2). */
function checkScopes(
  spec: AnyToolSpec,
  profile: string,
  profiles: readonly ProfileInfo[],
): ToolResult<unknown> | undefined {
  const anyOf = spec.scopesAnyOf;
  if (spec.scopes.length === 0 && anyOf === undefined) return undefined;
  const entry = profiles.find((candidate) => candidate.name === profile);
  const granted = entry?.scopes ?? [];
  const missing =
    spec.scopes.find((scope) => !granted.includes(scope)) ??
    // An alternation is missing only when NONE of its members is granted; the
    // first one is then what the remediation asks for.
    (anyOf !== undefined && !anyOf.some((scope) => granted.includes(scope))
      ? anyOf[0]
      : undefined);
  if (missing === undefined) return undefined;
  if (entry === undefined || entry.authorized === false) {
    const login: Hint = {
      type: 'reauth',
      text:
        `Ask the user to log in to profile '${profile}', then confirm with ` +
        'tiktok_get_auth_status before calling this tool again.',
      command: `npx tiktok-mcp-ai login --profile ${profile}`,
      profile,
    };
    return errorResult(unconfiguredProfileScopeError(profile, missing), [login]);
  }
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
  // Inside the envelope like every other failure: an unreadable credential
  // store is a tool error the model can act on, not a JSON-RPC fault.
  let profiles: readonly ProfileInfo[];
  try {
    profiles = await runtime.profiles();
  } catch (cause) {
    return errorResult(toolErrorFrom(cause));
  }

  const parsed = spec.input.safeParse(args ?? {}, { error: argumentErrorMap });
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
  /** The prompt manifest (TOOLS.md § 7.1); none when omitted. */
  prompts?: readonly PromptSpec[];
  /** The resource manifest (TOOLS.md § 7.2); none when omitted. */
  resources?: readonly ResourceSpec[];
  runtime: ServerRuntime;
}

export interface McpServerHandle {
  server: Server;
  /**
   * Tell connected clients to re-list the tools *and* the resources
   * (TOOLS.md § 6.3). One method for both because one cause moves both: the
   * credential-dependent `[UNAVAILABLE: …]` marker is prefixed to a resource
   * description exactly as to its tool's, so the same change stales both lists.
   */
  notifyListChanged(): Promise<void>;
}

/**
 * Build the server and install the tool, prompt, resource and completion
 * handlers.
 *
 * `tools.listChanged` and `resources.listChanged` are declared up front:
 * without them the notifications emitted when credentials change are dead
 * letters (§ 6.3). `prompts` is declared without `listChanged` because the
 * prompt list depends on the package selection alone, which is fixed for the
 * life of the process. `completions` is declared because the SDK refuses a
 * `completion/complete` handler without it. `logging` is declared because
 * the server forwards nothing to stdout — every diagnostic goes to stderr or
 * to the client as a log message.
 */
export function createServer(opts: ServerOptions): McpServerHandle {
  const { packages, runtime, prompts = [], resources = [] } = opts;
  const server = new Server(
    { name: opts.name, version: opts.version },
    {
      capabilities: {
        tools: { listChanged: true },
        prompts: {},
        resources: { listChanged: true },
        completions: {},
        logging: {},
      },
    },
  );

  const tools = enabledTools(packages, runtime.settings);
  const specsByName = new Map<string, AnyToolSpec>(
    tools.map((spec) => [spec.name, spec]),
  );
  const promptsByName = new Map<string, PromptSpec>(
    enabledPrompts(prompts, runtime.settings).map((spec) => [spec.name, spec]),
  );
  // An ordered list, not a map: a read resolves through `matchResource`, which
  // needs manifest order to let a concrete URI win over a template.
  const enabledResourceSpecs = enabledResources(resources, tools);

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

  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: [...promptsByName.values()].map((spec) => describePrompt(spec)),
  }));

  // The same failure as an unknown tool: the name does not exist here. A
  // prompt of a disabled package is unknown too — it was never listed.
  const requirePrompt = (name: string): PromptSpec => {
    const spec = promptsByName.get(name);
    if (spec === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
    }
    return spec;
  };

  server.setRequestHandler(GetPromptRequestSchema, (request) =>
    getPrompt(requirePrompt(request.params.name), request.params.arguments),
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const profiles = await runtime.profiles();
    // A template has no URI a client could read verbatim, so it is listed
    // only by `resources/templates/list`.
    return {
      resources: enabledResourceSpecs
        .filter((spec) => !isResourceTemplate(spec))
        .map((spec) => describeResource(spec, unavailableMarker(spec.tool, profiles))),
    };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const profiles = await runtime.profiles();
    return {
      resourceTemplates: enabledResourceSpecs.map((spec) =>
        describeResourceTemplate(spec, unavailableMarker(spec.tool, profiles)),
      ),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    const raw = request.params.uri;
    const parsed = parseResourceUri(raw);
    const match =
      parsed === undefined ? undefined : matchResource(enabledResourceSpecs, parsed.uri);
    if (parsed === undefined || match === undefined) {
      // Wrong scheme, a query this server does not serve, or a URI it never
      // listed: to the client these are one thing, "not here" — a protocol
      // error like an unknown tool, never an envelope.
      throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${raw}`);
    }
    // The client's abort reaches the tool (CC-G4); no progress reporter, since
    // a resource read has no token to report against.
    const result = await callTool(match.spec.tool, resourceArgs(match, parsed), runtime, {
      signal: extra.signal,
    });
    return resourceContents(raw, result, runtime.settings);
  });

  server.setRequestHandler(CompleteRequestSchema, async (request) => {
    const { ref, argument, context } = request.params;
    let source: CompletionSource | undefined;
    if (ref.type === 'ref/prompt') {
      source = promptCompletion(requirePrompt(ref.name), argument.name);
    } else {
      const spec = matchResourceRef(enabledResourceSpecs, ref.uri);
      if (spec === undefined) {
        // A reference is to a listed URI or template — anything else is the
        // same "not here" as an unknown read.
        throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${ref.uri}`);
      }
      source = resourceCompletion(spec, argument.name);
    }
    // A suggestion list is best-effort: an unreadable journal or profile
    // store is logged and completes to nothing, never a protocol error that
    // carries a local path to the client.
    try {
      const completion = await complete(source, runtime, {
        value: argument.value,
        context: context?.arguments,
      });
      return { completion };
    } catch (error) {
      runtime.log.warn('completion failed', {
        ref: ref.type === 'ref/prompt' ? ref.name : ref.uri,
        argument: argument.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return { completion: { values: [], total: 0, hasMore: false } };
    }
  });

  return {
    server,
    notifyListChanged: async (): Promise<void> => {
      // Both are attempted even when the first fails; the first failure wins.
      const sent = await Promise.allSettled([
        server.sendToolListChanged(),
        server.sendResourceListChanged(),
      ]);
      const failed = sent.find((outcome) => outcome.status === 'rejected');
      if (failed !== undefined) throw failed.reason;
    },
  };
}

/**
 * Serve over stdio. stdout carries JSON-RPC frames and nothing else (CC-G3):
 * logs go to stderr, and `no-console` keeps a stray `console.log` from ever
 * being written.
 */
export async function connectStdio(handle: McpServerHandle): Promise<StdioSession> {
  const transport = new StdioServerTransport();
  await handle.server.connect(transport);
  return { transport, drain: trackStdioCalls(transport) };
}

/** A connected stdio transport and the drain its shutdown awaits. */
export interface StdioSession {
  readonly transport: StdioServerTransport;
  /**
   * Resolve once every request received so far has been answered (or
   * cancelled), once `budgetMs` has passed on `clock`, or once `signal` aborts
   * (the client went away) — whichever is first. From the first call on, a new
   * request is refused with a JSON-RPC error instead of started, as the HTTP
   * transport answers 503 while draining. Closing the server aborts every
   * handler's signal, so a publish mid-upload would otherwise be cut into an
   * ambiguous attempt by a plain restart.
   */
  drain(budgetMs: number, clock: Clock, signal?: AbortSignal): Promise<void>;
}

/**
 * Count requests from arrival to answer, as the HTTP transport does for its
 * graceful close. Wrapped after `connect`, because the SDK installs its own
 * `onmessage` there; a cancellation settles its request, which gets no answer.
 * Counted per id: a client that reuses an id still in flight breaks JSON-RPC,
 * but the first answer must not let the drain end under the second call.
 */
function trackStdioCalls(transport: StdioServerTransport): StdioSession['drain'] {
  const open = new Map<RequestId, number>();
  let draining = false;
  let onIdle: (() => void) | undefined;
  const settle = (id: RequestId | undefined, all: boolean): void => {
    if (id === undefined) return;
    const count = open.get(id);
    if (count === undefined) return;
    if (!all && count > 1) {
      open.set(id, count - 1);
      return;
    }
    open.delete(id);
    if (open.size === 0) onIdle?.();
  };
  // `Server.connect` installs the SDK's handler before this wrapper goes on.
  const receive = transport.onmessage as NonNullable<typeof transport.onmessage>;
  const send = transport.send.bind(transport);
  transport.onmessage = (message) => {
    if (isJSONRPCRequest(message)) {
      if (draining) {
        void send({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: SHUTTING_DOWN,
            message: 'Service Unavailable: the server is shutting down',
          },
        }).catch(() => undefined);
        return;
      }
      open.set(message.id, (open.get(message.id) ?? 0) + 1);
    } else if (
      isJSONRPCNotification(message) &&
      message.method === 'notifications/cancelled'
    ) {
      // The SDK aborts every handler it holds under that id, so all of them go.
      settle(message.params?.['requestId'] as RequestId | undefined, true);
    }
    receive(message);
  };
  transport.send = (message) => {
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message))
      settle(message.id, false);
    return send(message);
  };

  return async (budgetMs, clock, signal) => {
    draining = true;
    if (open.size === 0 || signal?.aborted === true) return;
    const timer = new AbortController();
    const idle = new Promise<void>((resolve) => {
      onIdle = resolve;
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    await Promise.race([
      idle,
      clock.sleep(budgetMs, timer.signal).catch(() => undefined),
    ]);
    timer.abort();
    onIdle = undefined;
  };
}

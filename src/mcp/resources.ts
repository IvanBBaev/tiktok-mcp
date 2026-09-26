/**
 * MCP resources — the mechanism behind `resources/list`,
 * `resources/templates/list` and `resources/read` (TOOLS.md § 7.2).
 *
 * A resource here is a *read-only tool exposed at a URI*: `tiktok://videos/recent`
 * is `tiktok_list_videos` with fixed arguments, `tiktok://auth/status` is
 * `tiktok_get_auth_status`, and so on. Clients that attach resources to a
 * conversation (a snapshot the user picks from a list, rather than a call the
 * model decides to make) get exactly the envelope the tool would have returned,
 * as JSON text — redacted and truncated by the same code path (CC-G2/G7), so
 * there is no second surface to keep honest.
 *
 * Design notes:
 *
 * - **Nothing here calls anything.** This module describes resources and
 *   parses URIs; `mcp/server` runs the bound tool through its own `callTool`
 *   pipeline (account resolution, scope check, uniform error mapping) and
 *   hands the envelope back to {@link resourceContents}. That keeps the
 *   import graph acyclic and the read path identical to `tools/call`.
 * - **The account rides in the query.** `tiktok://videos/recent?account=work`
 *   reads through the `work` profile; the bare URI reads through the default
 *   one, exactly as a tool call without `account` would (TOOLS.md § 2.2).
 *   `resources/templates/list` advertises that form as `{?account}`.
 * - **A path parameter is a tool argument.** `tiktok://publish/{publish_id}/status`
 *   is `tiktok_get_publish_status` for one attempt; the `{name}` segment is
 *   the name of the argument the segment's value becomes. Such a spec is a
 *   *template*: it has no concrete URI to list, so it appears only in
 *   `resources/templates/list`, and `resources/read` finds it by matching the
 *   requested path against the template ({@link matchResource}). Concrete
 *   specs stay exact-match; a template never shadows one.
 * - **Gating and availability follow the tool.** A resource is listed only
 *   while its tool's package is enabled, and it carries the tool's
 *   `[UNAVAILABLE: …]` marker when no profile grants the scopes (§ 6.1).
 *
 * Layering: `mcp/` — the specs themselves live in `tools/resources.ts`.
 */

import {
  ErrorCode,
  McpError,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
} from '@modelcontextprotocol/sdk/types.js';

import { TikTokError } from '../core/errors.js';
import type { Settings } from '../core/settings.js';
import { completionSourceProblem, type CompletionSource } from './completions.js';
import type { AnyToolSpec } from './define.js';
import { truncateResult, type ToolResult } from './result.js';

/** Every resource URI starts with this; the SDK matches on the string. */
export const RESOURCE_SCHEME = 'tiktok://';

/** What every read returns: the tool's envelope, serialized. */
export const RESOURCE_MIME_TYPE = 'application/json';

/** The one query parameter a resource URI may carry. */
const ACCOUNT_PARAM = 'account';

export interface ResourceSpec {
  /**
   * Canonical URI: `tiktok://` + lowercase path segments, no query, no
   * trailing slash. The read form may append `?account=<profile>`. A segment
   * written `{name}` is a path parameter: the read supplies its value as the
   * tool argument `name`, and the spec is a template (see the module notes).
   */
  readonly uri: `tiktok://${string}`;

  /** Programmatic name, `tiktok_` + lowercase snake case — mirrors the URI. */
  readonly name: string;

  /** Short human label for resource pickers. */
  readonly title: string;

  /** What the snapshot contains — the first sentence is what clients truncate to. */
  readonly description: string;

  /**
   * The read-only tool whose envelope this resource is. Package gating,
   * scopes and the unavailability marker all follow it.
   */
  readonly tool: AnyToolSpec;

  /**
   * Fixed arguments for the read. Never `account`: that comes from the URI,
   * and a fixed one would make the `{?account}` template a lie. Never a path
   * parameter either, for the same reason.
   */
  readonly args: Readonly<Record<string, unknown>>;

  /**
   * Where `completion/complete` takes a path parameter's candidates from,
   * keyed by parameter name; a parameter without an entry completes to
   * nothing. Never `account`: the server answers the `{?account}` variable
   * of every template from the profiles ({@link resourceCompletion}).
   */
  readonly completions?: Readonly<Record<string, CompletionSource>>;
}

/** What `resources/read` resolved a requested path to. */
export interface ResourceMatch {
  readonly spec: ResourceSpec;
  /** The path-parameter values by name, percent-decoded; empty for a concrete URI. */
  readonly params: Readonly<Record<string, string>>;
}

/** The parts of a `resources/read` URI the server acts on. */
export interface ParsedResourceUri {
  /** The canonical URI the request addresses (query stripped). */
  readonly uri: string;
  /** The `account` query value, when one was given. */
  readonly account?: string;
}

/** One literal path segment: lowercase, `_`- or `-`-joined, nothing else. */
const SEGMENT = '[a-z0-9]+(?:[_-][a-z0-9]+)*';

/** One `{name}` segment: lowercase snake case, the argument-name grammar. */
const PARAM = '\\{[a-z][a-z0-9]*(?:_[a-z0-9]+)*\\}';

/** `tiktok://` + a literal host segment + `/`-joined literal or `{name}` segments. */
const URI_RE = new RegExp(`^tiktok://${SEGMENT}(?:/(?:${SEGMENT}|${PARAM}))*$`);

/** Every `{name}` segment of a URI; the capture is the name. */
const PARAM_SEGMENTS_RE = /\{([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\}/g;

/** `tiktok_` + lowercase snake case — the tool-name grammar, shared on purpose. */
const NAME_RE = /^tiktok_[a-z0-9]+(?:_[a-z0-9]+)*$/;

function specError(uri: string, problem: string): TikTokError {
  return new TikTokError({
    kind: 'internal',
    code: 'invalid_resource_spec',
    message: `Resource spec "${uri}" is invalid: ${problem}.`,
    retryable: false,
    remediation:
      'Fix the resource definition; this is a bug in the server, not in the request.',
  });
}

/**
 * Register a resource. Returns the spec unchanged (frozen), so a module can
 * both export the value and use it inline in the manifest — `defineTool`'s
 * shape.
 */
export function defineResource(spec: ResourceSpec): ResourceSpec {
  const { uri } = spec;

  if (!URI_RE.test(uri)) {
    throw specError(
      uri,
      'the URI must be "tiktok://" followed by lowercase path segments, with no query or trailing slash',
    );
  }
  if (!NAME_RE.test(spec.name)) {
    throw specError(uri, 'the name must be lowercase snake case prefixed with "tiktok_"');
  }
  if (spec.title.trim() === '') throw specError(uri, 'title is empty');
  if (spec.description.trim() === '') throw specError(uri, 'description is empty');
  if (!spec.tool.annotations.readOnlyHint) {
    throw specError(uri, `tool "${spec.tool.name}" is not read-only`);
  }
  if (ACCOUNT_PARAM in spec.args) {
    throw specError(uri, 'args fixes "account" — the account comes from the URI');
  }
  const params = resourceParams(spec);
  if (new Set(params).size !== params.length) {
    throw specError(uri, 'a path parameter is repeated');
  }
  for (const name of params) {
    if (name === ACCOUNT_PARAM) {
      throw specError(uri, 'a path parameter is named "account" — that is the query');
    }
    if (name in spec.args) {
      throw specError(uri, `args fixes "${name}", which the URI also carries`);
    }
  }
  for (const [name, source] of Object.entries(spec.completions ?? {})) {
    if (name === ACCOUNT_PARAM) {
      throw specError(uri, 'completions names "account" — the server completes that');
    }
    if (!params.includes(name)) {
      throw specError(uri, `completions names "${name}", which the URI does not carry`);
    }
    const problem = completionSourceProblem(source);
    if (problem !== undefined)
      throw specError(uri, `completion for "${name}": ${problem}`);
  }

  Object.freeze(spec.args);
  if (spec.completions !== undefined) Object.freeze(spec.completions);
  return Object.freeze(spec);
}

/** The path-parameter names of a spec, in URI order; empty for a concrete URI. */
export function resourceParams(spec: ResourceSpec): readonly string[] {
  // `slice(1)` is the one capture as a `string[]` — the pattern has exactly one
  // mandatory group, so there is no `undefined` to fall back from.
  return [...spec.uri.matchAll(PARAM_SEGMENTS_RE)].flatMap((match) => match.slice(1));
}

/** True when the spec has a path parameter and is therefore listed as a template only. */
export function isResourceTemplate(spec: ResourceSpec): boolean {
  return resourceParams(spec).length > 0;
}

/**
 * The description as listed: the tool's `[UNAVAILABLE: …]` marker first,
 * when there is one, so a client sees why the read would fail before it
 * tries — the same prefix convention as `tools/list` (TOOLS.md § 6.1).
 */
function listedDescription(spec: ResourceSpec, marker: string | undefined): string {
  return marker === undefined ? spec.description : `${marker} ${spec.description}`;
}

/**
 * The `resources/list` entry for one concrete spec. A template has no URI a
 * client could read verbatim, so the server never lists one here.
 */
export function describeResource(spec: ResourceSpec, marker?: string): Resource {
  return {
    uri: spec.uri,
    name: spec.name,
    title: spec.title,
    description: listedDescription(spec, marker),
    mimeType: RESOURCE_MIME_TYPE,
  };
}

/**
 * The `resources/templates/list` entry for one spec: the URI with `{?account}`
 * appended — for a template, after its `{name}` path parameters, so the
 * whole RFC 6570 form is `tiktok://publish/{publish_id}/status{?account}`.
 */
export function describeResourceTemplate(
  spec: ResourceSpec,
  marker?: string,
): ResourceTemplate {
  return {
    uriTemplate: `${spec.uri}{?${ACCOUNT_PARAM}}`,
    name: spec.name,
    title: spec.title,
    description: listedDescription(spec, marker),
    mimeType: RESOURCE_MIME_TYPE,
  };
}

/**
 * The spec a `completion/complete` reference names. A client refers to a
 * resource by the URI it was listed under — the canonical `spec.uri` for a
 * concrete resource, the `{?account}` form for a template — so both are
 * accepted; `undefined` for anything else.
 */
export function matchResourceRef(
  specs: readonly ResourceSpec[],
  uri: string,
): ResourceSpec | undefined {
  return specs.find(
    (spec) => spec.uri === uri || describeResourceTemplate(spec).uriTemplate === uri,
  );
}

/**
 * The completion source of one template variable: `account` — the query
 * variable every template carries — always completes from the profiles; a
 * path parameter completes from what the spec declares for it, or to
 * nothing. Any other name is not a variable of this template, which is the
 * same kind of typo `prompts/get` rejects, phrased the same way.
 */
export function resourceCompletion(
  spec: ResourceSpec,
  argument: string,
): CompletionSource | undefined {
  if (argument === ACCOUNT_PARAM) return { kind: 'profiles' };
  if (!resourceParams(spec).includes(argument)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid arguments for resource ${spec.uri}: unknown argument "${argument}"`,
    );
  }
  return spec.completions?.[argument];
}

/**
 * Split a requested URI into the canonical resource URI and the account.
 *
 * `undefined` means "not a resource URI this server could serve": a different
 * scheme, a query parameter other than `account`, a blank `account`, a
 * fragment, or anything `URL` refuses to parse. The caller turns that into
 * the same protocol error as an unknown URI, because to the client the
 * distinction is not actionable — the URI it asked for does not exist here.
 */
export function parseResourceUri(raw: string): ParsedResourceUri | undefined {
  if (!raw.startsWith(RESOURCE_SCHEME)) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  // Read raw: `URL` reports an empty fragment (a bare trailing `#`) as no
  // fragment at all, and the query below is sliced from the raw string.
  if (raw.includes('#')) return undefined;
  // `URL` repairs what a canonical URI never contains — userinfo and a port
  // dropped or kept, dot segments resolved, tabs and line breaks stripped —
  // so a repaired URI would be read as a different one. Refuse it instead.
  if (url.username !== '' || url.password !== '' || url.port !== '') return undefined;
  if (/[\t\n\r]/.test(raw)) return undefined;
  const queryAt = raw.indexOf('?');
  const rawPath = queryAt === -1 ? raw : raw.slice(0, queryAt);
  if (rawPath.split('/').some((segment) => DOT_SEGMENT_RE.test(segment)))
    return undefined;
  // The query is read raw as well: the key is compared as written (no escape
  // spells `account`) and the value is percent-decoded only (`+` is a plus).
  let account: string | undefined;
  const rawQuery = queryAt === -1 ? '' : raw.slice(queryAt + 1);
  for (const pair of rawQuery === '' ? [] : rawQuery.split('&')) {
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (key !== ACCOUNT_PARAM || account !== undefined || eq === -1) return undefined;
    const value = decodedOrUndefined(pair.slice(eq + 1));
    if (value === undefined || value === '') return undefined;
    account = value;
  }
  const uri = `${RESOURCE_SCHEME}${url.host}${url.pathname}`;
  return account === undefined ? { uri } : { uri, account };
}

/** A `.` or `..` path segment, written plain or percent-encoded. */
const DOT_SEGMENT_RE = /^(?:\.|%2e){1,2}$/i;

/** `decodeURIComponent`, with a malformed escape as `undefined`. */
function decodedOrUndefined(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/**
 * The parameter values a template yields for a canonical URI, or `undefined`
 * when the path does not have the template's shape. A parameter segment is
 * any non-empty segment; its value is percent-decoded, because `URL` encodes
 * what a client passes raw and the tool wants the client's value back. An
 * escape that does not decode is a path this server cannot address.
 */
function matchTemplate(
  spec: ResourceSpec,
  uri: string,
): Readonly<Record<string, string>> | undefined {
  const pattern = new RegExp(
    `^${spec.uri.replaceAll(PARAM_SEGMENTS_RE, '(?<$1>[^/]+)')}$`,
  );
  const groups = pattern.exec(uri)?.groups;
  if (groups === undefined) return undefined;
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(groups)) {
    const decoded = decodedOrUndefined(value);
    if (decoded === undefined) return undefined;
    values[name] = decoded;
  }
  return values;
}

/**
 * Resolve a canonical URI (the `uri` of {@link parseResourceUri}) to the spec
 * that serves it. A concrete spec wins by exact equality, in manifest order;
 * only then are the templates tried, again in manifest order, so a template
 * can never capture a URI a concrete spec owns.
 */
export function matchResource(
  specs: readonly ResourceSpec[],
  uri: string,
): ResourceMatch | undefined {
  const concrete = specs.find((spec) => spec.uri === uri);
  if (concrete !== undefined) return { spec: concrete, params: {} };
  for (const spec of specs.filter(isResourceTemplate)) {
    const params = matchTemplate(spec, uri);
    if (params !== undefined) return { spec, params };
  }
  return undefined;
}

/**
 * The tool arguments for one read: the fixed ones, the path parameters and
 * the URI's account. The three never overlap — `defineResource` forbids it —
 * so the spread order carries no precedence.
 */
export function resourceArgs(
  match: ResourceMatch,
  parsed: ParsedResourceUri,
): Record<string, unknown> {
  const args = { ...match.spec.args, ...match.params };
  return parsed.account === undefined
    ? args
    : { ...args, [ACCOUNT_PARAM]: parsed.account };
}

/**
 * Envelope → `resources/read` result: one JSON text content under the URI
 * the client asked for (query included — it is the client's key for the
 * snapshot), shaped by the same redact + truncate step as a tool result.
 */
export function resourceContents(
  uri: string,
  result: ToolResult<unknown>,
  settings: Settings,
): ReadResourceResult {
  const { text } = truncateResult(result, settings.resultCharBudget, {
    pretty: settings.prettyJson,
  });
  return { contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text }] };
}

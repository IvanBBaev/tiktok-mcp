/**
 * MCP prompts — the mechanism behind `prompts/list` and `prompts/get`
 * (TOOLS.md § 7.1).
 *
 * A prompt is server-authored steering the *user* invokes: a client lists them
 * as commands, the user picks one and fills in its arguments, and the rendered
 * messages enter the conversation as if the user had typed them. That makes a
 * prompt the one channel where the canonical flows of TOOLS.md § 4 can be
 * handed to the model up front instead of being reconstructed from hints one
 * call at a time. It is text, not behaviour: every safety property of the flow
 * it describes is still enforced by the tools it names (plan/execute, scope
 * checks, the duplicate guard), so a prompt that is ignored costs nothing.
 *
 * Design notes:
 *
 * - **Gated with the tools it steers to.** A prompt names a package, and any
 *   other packages its steps call into; when `TT_TOOL_PACKAGES` excludes any
 *   of them the prompt is not listed either,
 *   because a flow that ends in "call `tiktok_post_video`" is a lie on a server
 *   where that tool does not exist.
 * - **Arguments are strict.** An unknown argument is a typo (the same stance
 *   as CC-G1 for tools) and a missing required one cannot be rendered around.
 *   Prompts carry no envelope contract, so both fail as *protocol* errors
 *   (`McpError` / `InvalidParams`) — the way the SDK's own `McpServer` fails
 *   them — rather than as data.
 * - **Rendering is pure.** `render` sees only validated string arguments and
 *   returns messages; it never touches the network or the credential file.
 *
 * Layering: `mcp/` — the specs themselves live in `tools/prompts.ts`.
 */

import {
  ErrorCode,
  McpError,
  type GetPromptResult,
  type Prompt,
  type PromptMessage,
} from '@modelcontextprotocol/sdk/types.js';

import { TikTokError } from '../core/errors.js';
import { TOOL_PACKAGES, type ToolPackage } from '../core/settings.js';
import { completionSourceProblem, type CompletionSource } from './completions.js';

/** One declared argument, as `prompts/list` advertises it. */
export interface PromptArgumentSpec {
  readonly name: string;
  /** Client UIs render it verbatim next to the input field. */
  readonly description: string;
  readonly required: boolean;
  /**
   * Where `completion/complete` takes its candidates from; absent, the
   * argument completes to nothing (`mcp/completions`).
   */
  readonly completion?: CompletionSource;
}

/**
 * The arguments a renderer receives: every declared argument the client sent,
 * as the strings the protocol carries. Required ones are guaranteed present
 * and non-blank; optional ones are absent when not sent.
 */
export type PromptArgs = Readonly<Record<string, string>>;

export interface PromptSpec {
  /** Wire name; `tiktok_` + lowercase snake case, like a tool. */
  readonly name: `tiktok_${string}`;

  /** Short human label for prompt pickers. */
  readonly title: string;

  /** What the flow does — shown in the picker, so the first sentence carries it. */
  readonly description: string;

  /**
   * The package whose tools the rendered flow calls. Listing follows the
   * package: a prompt is advertised only while its package is enabled.
   */
  readonly package: ToolPackage;

  /**
   * Other packages whose tools the flow names — the read steps a write flow
   * starts and ends with. Listed only while every one of them is enabled too.
   */
  readonly requires?: readonly ToolPackage[];

  readonly arguments: readonly PromptArgumentSpec[];

  /** Renders the messages for validated `args`. */
  render(args: PromptArgs): readonly PromptMessage[];
}

/** `tiktok_` + lowercase snake case — the tool-name grammar, shared on purpose. */
const NAME_RE = /^tiktok_[a-z0-9]+(?:_[a-z0-9]+)*$/;

/** Argument names are lowercase snake case: they become form labels and keys. */
const ARGUMENT_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

function specError(name: string, problem: string): TikTokError {
  return new TikTokError({
    kind: 'internal',
    code: 'invalid_prompt_spec',
    message: `Prompt spec "${name}" is invalid: ${problem}.`,
    retryable: false,
    remediation:
      'Fix the prompt definition; this is a bug in the server, not in the request.',
  });
}

/**
 * Register a prompt. Returns the spec unchanged (frozen), so a module can both
 * export the value and use it inline in the manifest — `defineTool`'s shape.
 */
export function definePrompt(spec: PromptSpec): PromptSpec {
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
  for (const required of spec.requires ?? []) {
    if (!TOOL_PACKAGES.includes(required)) {
      throw specError(
        name,
        `requires "${required}", which is not one of ${TOOL_PACKAGES.join(', ')}`,
      );
    }
  }
  const seen = new Set<string>();
  for (const argument of spec.arguments) {
    if (!ARGUMENT_RE.test(argument.name)) {
      throw specError(name, `argument "${argument.name}" is not lowercase snake case`);
    }
    if (seen.has(argument.name)) {
      throw specError(name, `argument "${argument.name}" is declared twice`);
    }
    seen.add(argument.name);
    if (argument.description.trim() === '') {
      throw specError(name, `argument "${argument.name}" has an empty description`);
    }
    const problem =
      argument.completion === undefined
        ? undefined
        : completionSourceProblem(argument.completion);
    if (problem !== undefined) {
      throw specError(name, `argument "${argument.name}": ${problem}`);
    }
  }

  for (const argument of spec.arguments) Object.freeze(argument);
  Object.freeze(spec.arguments);
  return Object.freeze(spec);
}

/** The `prompts/list` entry for one spec. */
export function describePrompt(spec: PromptSpec): Prompt {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    arguments: spec.arguments.map((argument) => ({
      name: argument.name,
      description: argument.description,
      required: argument.required,
    })),
  };
}

function invalidArguments(spec: PromptSpec, problem: string): McpError {
  return new McpError(
    ErrorCode.InvalidParams,
    `Invalid arguments for prompt ${spec.name}: ${problem}`,
  );
}

/**
 * Check the raw `prompts/get` arguments against the declaration.
 *
 * Unknown names are rejected outright; a required argument must be present
 * *and* non-blank, because a flow rendered around an empty video path is a
 * flow that fails three tool calls later with less context than it has here.
 * Optional arguments sent blank are dropped, not passed through: to the
 * renderer "not given" and "given nothing" are the same thing.
 */
export function validatePromptArgs(
  spec: PromptSpec,
  raw: Readonly<Record<string, string>> | undefined,
): PromptArgs {
  const declared = new Map(spec.arguments.map((argument) => [argument.name, argument]));
  const args: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (!declared.has(name)) throw invalidArguments(spec, `unknown argument "${name}"`);
    const trimmed = value.trim();
    if (trimmed !== '') args[name] = trimmed;
  }
  for (const argument of spec.arguments) {
    if (argument.required && !(argument.name in args)) {
      throw invalidArguments(spec, `missing required argument "${argument.name}"`);
    }
  }
  return args;
}

/**
 * The completion source of one declared argument — `undefined` when it
 * declares none. An undeclared name is the same typo `prompts/get` rejects,
 * phrased the same way.
 */
export function promptCompletion(
  spec: PromptSpec,
  argument: string,
): CompletionSource | undefined {
  const declared = spec.arguments.find((entry) => entry.name === argument);
  if (declared === undefined) {
    throw invalidArguments(spec, `unknown argument "${argument}"`);
  }
  return declared.completion;
}

/** The `prompts/get` result for one spec: validate, render, wrap. */
export function getPrompt(
  spec: PromptSpec,
  raw: Readonly<Record<string, string>> | undefined,
): GetPromptResult {
  return {
    description: spec.description,
    messages: [...spec.render(validatePromptArgs(spec, raw))],
  };
}

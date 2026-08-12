/**
 * CLI dispatch — the one place that maps `argv` to a subcommand.
 *
 * Spec: ARCHITECTURE.md § 2 (bootstrap), AUTH.md § 1 (login), TOOLS.md § 2
 * (`--revoke` / `--purge-journal`), CONFIGURATION.md § Journal.
 *
 * Design notes:
 *
 * - **No process access.** Every side effect the subcommands need — argv, env,
 *   the two output streams, the clock, the logger, the browser, the loopback
 *   listener, entropy — arrives through {@link CliDeps}. `runCli` *returns* the
 *   exit code it wants; only `src/index.ts` may touch `process.exit`. That is
 *   what makes the whole login flow testable without a terminal, a browser, a
 *   socket, or a real `process`.
 * - **Subcommands are loaded lazily.** `login` pulls in `node:http`, the OAuth
 *   client and the env-file writer; `doctor` will pull in its own probes. The
 *   server path (no argv) must not pay for either, so both are reached through
 *   `await import(...)` rather than a top-level import.
 * - **Everything printed goes through `redactText`.** The CLI interpolates
 *   profile names, file paths and upstream error texts into human sentences; a
 *   registered secret that ever reaches one of those strings is masked at the
 *   sink rather than trusted not to be there (SECURITY.md § Redaction).
 */

import { readFile } from 'node:fs/promises';

import type { Clock } from '../core/clock.js';
import type { EnvFileSnapshot } from '../core/config.js';
import type { Logger } from '../core/log.js';
import { redactText } from '../core/redact.js';

// ---------------------------------------------------------------------------
// exit codes
// ---------------------------------------------------------------------------

/** The command did what it was asked to do. */
export const EXIT_OK = 0;

/** The command ran and failed (network, upstream refusal, denied consent). */
export const EXIT_FAILURE = 1;

/** The command was invoked wrongly (unknown subcommand, bad flag, no TTY). */
export const EXIT_USAGE = 2;

/** The published binary name, used in every usage/hint string. */
export const CLI_NAME = 'tiktok-mcp-ai';

// ---------------------------------------------------------------------------
// seams
// ---------------------------------------------------------------------------

/** One inbound request to the loopback callback server (CC-A8/CC-A9). */
export interface CallbackRequest {
  readonly method: string;
  /** Request target as sent, e.g. `/callback/?code=…&state=…`. */
  readonly url: string;
}

/** The page the callback server answers with. Always static HTML (no echo). */
export interface CallbackReply {
  readonly status: number;
  readonly body: string;
}

/**
 * The redirect handler `login` installs. Synchronous on purpose: the accept
 * decision (CC-A9 — exactly one response is consumed) must not interleave.
 */
export type CallbackHandler = (req: CallbackRequest) => CallbackReply;

/** A bound loopback listener. `port` is the *effective* port (0 → ephemeral). */
export interface LoopbackServer {
  readonly port: number;
  close(): Promise<void>;
}

/** Binds `handler` on `host:port`; rejects when the port cannot be bound. */
export type ListenFn = (
  handler: CallbackHandler,
  opts: { host: string; port: number },
) => Promise<LoopbackServer>;

/** Injectable process seams so the CLI is testable without a real terminal. */
export interface CliDeps {
  /** Args **after** the subcommand. When set, it wins over `runCli`'s `argv`. */
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /**
   * Overrides `process.platform`. `doctor`'s permission check branches on it
   * (POSIX `chmod` vs. the Windows `icacls` remediation *text*, CC-F3), and
   * `core/config`'s `resolveEnvFilePath` already takes the same seam — a branch
   * that only one CI leg can reach is a branch that only one CI leg tests.
   */
  platform?: NodeJS.Platform;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  /** Whether an interactive prompt is possible (stdin *and* stdout a TTY). */
  isTTY?: boolean;
  clock?: Clock;
  logger?: Logger;
  /** Reads one line of answer for `question`; used by CC-A10 and CC-A11. */
  prompt?: (question: string) => Promise<string>;
  /** Opens the consent URL. A rejection degrades to "open this URL yourself". */
  openBrowser?: (url: string) => Promise<void>;
  /** Binds the single-accept loopback callback server (CC-A8). */
  listen?: ListenFn;
  /** Entropy seam forwarded to `buildAuthUrl` (PKCE verifier + `state`). */
  randomBytes?: (size: number) => Uint8Array;
  /** `core/config`'s atomic-write seam, forwarded to `persistProfilePatch`. */
  rename?: (from: string, to: string) => Promise<void>;
}

/** The resolved output side of {@link CliDeps}. */
export interface CliIo {
  /** Human result output. */
  out(text: string): void;
  /** Diagnostics, prompts and errors. */
  err(text: string): void;
  /**
   * Diagnostics **without** redaction — for the consent URL and nothing else.
   *
   * `redactText` masks `state`, `code_challenge` and `client_key` by parameter
   * name (SECURITY.md secrets inventory), which is right for a logged URL and
   * fatal for one the operator has to open: the redacted form is not a working
   * authorization request. AUTH.md § 1 requires `login` to print that URL, so
   * this seam exists to print exactly it. Every other line — including anything
   * that came back from upstream — goes through {@link CliIo.err}.
   */
  errRaw(text: string): void;
  /** Whether `prompt` may be used at all. */
  readonly isTTY: boolean;
}

function writeStdout(chunk: string): void {
  process.stdout.write(chunk);
}

function writeStderr(chunk: string): void {
  process.stderr.write(chunk);
}

/**
 * Resolve the output seams once, wrapping both in `redactText`.
 *
 * The default `isTTY` requires *both* streams: a prompt needs stdin to read the
 * answer from and stdout to have shown the question on.
 */
export function cliIo(deps: CliDeps): CliIo {
  const stdout = deps.stdout ?? writeStdout;
  const stderr = deps.stderr ?? writeStderr;
  return {
    out: (text) => {
      stdout(redactText(text));
    },
    err: (text) => {
      stderr(redactText(text));
    },
    errRaw: stderr,
    isTTY: deps.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true),
  };
}

// ---------------------------------------------------------------------------
// env-file overlay
// ---------------------------------------------------------------------------

/**
 * The environment as the settings loader should see it: the env file first,
 * the process environment on top.
 *
 * `loadSettings` reads a flat `NodeJS.ProcessEnv`, but half of the settings it
 * knows about (`TT_REDIRECT_PORT`, `TT_LOGIN_SCOPES`, `TT_TOOL_PACKAGES`, …)
 * normally live in the env file. Precedence is presence-based (CC-F2): a key
 * that *exists* in the process environment wins even when its value is empty,
 * because "exported empty" is a deliberate statement — which is exactly what
 * `Object.assign` does with an own key whose value is `undefined`.
 *
 * Returns a copy; `process.env` is never mutated.
 */
export function overlayEnvFile(
  env: NodeJS.ProcessEnv,
  snapshot: EnvFileSnapshot,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {};
  for (const [key, value] of snapshot.values) merged[key] = value;
  return Object.assign(merged, env);
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

/**
 * Whether these args mean "run a command" rather than "start the server".
 *
 * Any argument at all counts: the server takes no positional arguments, so a
 * word on the command line is always meant as a command — and an unrecognized
 * one has to become a usage error, never a server that started while silently
 * ignoring what it was asked to do.
 */
export function isCliInvocation(argv: readonly string[]): boolean {
  return argv.length > 0;
}

/** The top-level usage text (also the unknown-subcommand error body). */
export function usageText(): string {
  return [
    `${CLI_NAME} — MCP server for the TikTok Content Posting and Display APIs`,
    '',
    'Usage:',
    `  ${CLI_NAME}                     start the MCP server on stdio`,
    `  ${CLI_NAME} login [options]     authorize a profile (OAuth 2.0 + PKCE)`,
    `  ${CLI_NAME} doctor              check the local configuration`,
    `  ${CLI_NAME} --help | --version`,
    '',
    `Run "${CLI_NAME} login --help" for the login options.`,
    '',
  ].join('\n');
}

const UNKNOWN_VERSION = '0.0.0-unknown';
let cachedVersion: string | undefined;

/**
 * The package version, read from `package.json` at runtime.
 *
 * Deliberately not an `import ... with { type: 'json' }`: that would emit a
 * copy of `package.json` into `build/` and make the published layout depend on
 * the compiler's JSON handling. A missing or malformed file degrades to
 * {@link UNKNOWN_VERSION} — `--version` must never crash the CLI.
 */
export async function packageVersion(): Promise<string> {
  if (cachedVersion !== undefined) return cachedVersion;
  let version = UNKNOWN_VERSION;
  try {
    const raw = await readFile(new URL('../../../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const declared = (parsed as { version?: unknown }).version;
      if (typeof declared === 'string' && declared !== '') version = declared;
    }
  } catch {
    version = UNKNOWN_VERSION;
  }
  cachedVersion = version;
  return version;
}

/**
 * Run one CLI invocation.
 *
 * @param argv Full command args, subcommand first (`process.argv.slice(2)`).
 * @returns The intended process exit code; this never calls `process.exit`.
 */
export async function runCli(
  argv: readonly string[],
  deps: CliDeps = {},
): Promise<number> {
  const io = cliIo(deps);
  const subcommand = argv[0];
  const rest: CliDeps = { ...deps, argv: deps.argv ?? argv.slice(1) };

  switch (subcommand) {
    case 'login': {
      const { runLogin } = await import('./login.js');
      return await runLogin(rest);
    }
    case 'doctor': {
      const { runDoctor } = await import('./doctor.js');
      return await runDoctor(rest);
    }
    case '--help':
    case '-h': {
      io.out(usageText());
      return EXIT_OK;
    }
    case '--version':
    case '-V': {
      io.out(`${await packageVersion()}\n`);
      return EXIT_OK;
    }
    default: {
      io.err(
        subcommand === undefined
          ? 'No subcommand given.\n\n'
          : `Unknown subcommand ${JSON.stringify(subcommand)}.\n\n`,
      );
      io.err(usageText());
      return EXIT_USAGE;
    }
  }
}

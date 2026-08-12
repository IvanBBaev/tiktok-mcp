/**
 * `tiktok-mcp-ai login` — the one interactive command: OAuth 2.0 authorization
 * code + PKCE against TikTok's Login Kit, and its inverse, `--revoke`.
 *
 * Spec: AUTH.md § 1 (the flow), § 2 (scopes), § 4 (revoke), CONFIGURATION.md
 * § Journal, CORNER-CASES.md CC-A8 (loopback redirect), CC-A9 (single accept),
 * CC-A10 (manual paste), CC-A11 (overwrite confirmation), CC-A13 (hex PKCE),
 * CC-F2 (presence-based env precedence).
 *
 * Design notes:
 *
 * - **The redirect is a wildcard-port loopback.** TikTok registers the shape
 *   `http://127.0.0.1:<any port>/callback/` once; every login binds an ephemeral
 *   port and sends that exact shape, trailing slash included, byte-identical in
 *   the authorize URL and in the token exchange. Nothing here ever invents
 *   another shape — an unregistered `redirect_uri` fails on TikTok's screen,
 *   minutes after the mistake was made (CC-A8).
 * - **Exactly one authorization response is consumed.** The callback server
 *   flips a latch on the first hit to `/callback/`; every later hit gets a
 *   static "already handled" page and is never exchanged — including when the
 *   first exchange failed. A replayed `code` is a spent `code` (CC-A9).
 * - **`state` is compared in constant time**, length-safely, with
 *   `crypto.timingSafeEqual` over the UTF-8 bytes.
 * - **Nothing secret is printed.** The authorization `code`, the PKCE verifier
 *   and every token are registered with `core/redact` the moment they exist;
 *   the success summary prints `open_id`, display name, scopes and expiries.
 *   `state` is registered too — but only *after* the authorize URL has been
 *   shown, because that URL legitimately contains it and must stay usable.
 * - **Progress goes to stderr, the result to stdout.** `login`'s stdout is the
 *   summary and nothing else, so it stays greppable when the prompts and the
 *   waiting notice are piped away.
 */

import { timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';

import { systemClock, type Clock } from '../core/clock.js';
import {
  normalizeProfileName,
  persistProfilePatch,
  readEnvFile,
  readProfile,
  resolveEnvFilePath,
  type ProfileCredentials,
} from '../core/config.js';
import { withEnvLock } from '../core/env-lock.js';
import { isTikTokError, TikTokError } from '../core/errors.js';
import { ttRequest } from '../core/http.js';
import { createLogger, type Logger } from '../core/log.js';
import {
  buildAuthUrl,
  exchangeCode,
  resetTokenCache,
  revokeToken,
  type TokenSet,
} from '../core/oauth.js';
import { registerSecret } from '../core/redact.js';
import {
  DEFAULT_PROFILE,
  loadSettings,
  resolveEnabledPackages,
  type Settings,
  type ToolPackage,
} from '../core/settings.js';
import {
  cliIo,
  CLI_NAME,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  overlayEnvFile,
  type CallbackHandler,
  type CallbackReply,
  type CliDeps,
  type CliIo,
  type ListenFn,
  type LoopbackServer,
} from './index.js';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** The only host a redirect may be served on (CC-A8). */
const LOOPBACK_HOST = '127.0.0.1';

/** The registered redirect path. The trailing slash is part of the contract. */
const CALLBACK_PATH = '/callback/';

/**
 * The port used in the printed `redirect_uri` when nothing is listening —
 * manual-paste mode with no `TT_REDIRECT_PORT` pin. Any port matches the
 * registered wildcard shape; a fixed one keeps the URL the user pastes into
 * the browser identical to the one the exchange sends.
 */
const MANUAL_FALLBACK_PORT = 8000;

/** Display-name probe (TIKTOK-API.md § 3.1 — `fields` is required). */
const USER_INFO_URL = 'https://open.tiktokapis.com/v2/user/info/?fields=display_name';

/** The scope every profile needs before any user-facing tool can work. */
const BASIC_SCOPE = 'user.info.basic';

/** The journal file name; it is a sibling of the env file (CONFIGURATION.md). */
const JOURNAL_FILE = 'journal.ndjson';

/**
 * Least-privilege scope set per tool package (TOOLS.md § 2 scope column).
 *
 * `TT_LOGIN_SCOPES`' documented default is "derived from the enabled packages",
 * and this is that derivation. `auth` needs nothing: its tools only read local
 * state. `user` takes the three read scopes its optional fields need, because a
 * profile that cannot answer `tiktok_get_user_info` in full is a re-login the
 * user did not expect.
 *
 * Exported for the drift gate in `test/manifest.test.ts`: a tool registered
 * with a scope this table does not grant would authorize a login that cannot
 * call it — a failure that only shows up against the live API, long after the
 * commit that caused it.
 */
export const PACKAGE_SCOPES: Readonly<Record<ToolPackage, readonly string[]>> =
  Object.freeze({
    auth: Object.freeze([]),
    user: Object.freeze(['user.info.basic', 'user.info.profile', 'user.info.stats']),
    video: Object.freeze(['video.list']),
    publish: Object.freeze(['video.publish']),
    'publish-write': Object.freeze(['video.publish', 'video.upload']),
  });

/**
 * Canonical scope order for everything this command prints or requests, so two
 * runs with the same selection produce byte-identical output. It is also the
 * closed set of scopes this server knows: the drift gate in
 * `test/manifest.test.ts` rejects anything outside it, which is what catches a
 * typo in a scope string — TikTok answers an unknown scope with a generic
 * authorization failure that looks like a dozen other problems.
 */
export const SCOPE_ORDER: readonly string[] = [
  'user.info.basic',
  'user.info.profile',
  'user.info.stats',
  'video.list',
  'video.publish',
  'video.upload',
];

// ---------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------

interface LoginFlags {
  profile?: string;
  scopes?: readonly string[];
  force: boolean;
  manual: boolean;
  noBrowser: boolean;
  revoke: boolean;
  purgeJournal: boolean;
  help: boolean;
}

type ParseResult =
  | { readonly ok: true; readonly flags: LoginFlags }
  | { readonly ok: false; readonly message: string };

export function loginUsage(): string {
  return [
    `Usage: ${CLI_NAME} login [options]`,
    '',
    'Options:',
    '  --profile <name>   profile to authorize (default: TT_ACTIVE_PROFILE, else DEFAULT)',
    '  --scopes <csv>     scopes to request (default: TT_LOGIN_SCOPES, else derived',
    '                     from TT_TOOL_PACKAGES)',
    '  --force            replace existing credentials without asking',
    '  --manual           skip the loopback listener and paste the redirect by hand',
    '  --no-browser       print the authorization URL instead of opening a browser',
    '  --revoke           revoke this profile and clear its tokens (keeps the journal)',
    '  --purge-journal    with --revoke: also delete the local publish journal',
    '  -h, --help         show this help',
    '',
  ].join('\n');
}

/**
 * Parse `login`'s arguments. Both `--flag value` and `--flag=value` are
 * accepted; an unknown flag is an error rather than something ignored, so a
 * typo can never silently request the wrong scopes.
 */
export function parseLoginArgs(argv: readonly string[]): ParseResult {
  const flags: LoginFlags = {
    force: false,
    manual: false,
    noBrowser: false,
    revoke: false,
    purgeJournal: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);

    const takesValue = name === '--profile' || name === '--scopes';
    let value: string | undefined;
    if (takesValue) {
      if (inline !== undefined) value = inline;
      else {
        i += 1;
        value = argv[i];
      }
      if (value === undefined || value === '') {
        return { ok: false, message: `${name} needs a value.` };
      }
    } else if (inline !== undefined) {
      return { ok: false, message: `${name} does not take a value.` };
    }

    switch (name) {
      case '--profile':
        flags.profile = value;
        break;
      case '--scopes':
        flags.scopes = splitScopes(value ?? '');
        break;
      case '--force':
        flags.force = true;
        break;
      case '--manual':
        flags.manual = true;
        break;
      case '--no-browser':
        flags.noBrowser = true;
        break;
      case '--revoke':
        flags.revoke = true;
        break;
      case '--purge-journal':
        flags.purgeJournal = true;
        break;
      case '-h':
      case '--help':
        flags.help = true;
        break;
      default:
        return { ok: false, message: `Unknown option ${JSON.stringify(arg)}.` };
    }
  }

  if (flags.scopes !== undefined && flags.scopes.length === 0) {
    return { ok: false, message: '--scopes needs at least one scope.' };
  }
  if (flags.purgeJournal && !flags.revoke) {
    return {
      ok: false,
      message: '--purge-journal only applies together with --revoke.',
    };
  }
  return { ok: true, flags };
}

function splitScopes(csv: string): readonly string[] {
  return [...new Set(csv.split(',').map((s) => s.trim()))].filter((s) => s !== '');
}

/** Scopes in canonical order; anything unrecognized keeps its relative order. */
function orderScopes(scopes: Iterable<string>): string[] {
  const set = new Set(scopes);
  const known = SCOPE_ORDER.filter((scope) => set.has(scope));
  const extra = [...set].filter((scope) => !SCOPE_ORDER.includes(scope));
  return [...known, ...extra];
}

/**
 * Which scopes to request: `--scopes` wins, then `TT_LOGIN_SCOPES`, else the
 * least-privilege union of the enabled packages (AUTH.md § 2).
 */
export function resolveScopes(
  flags: Pick<LoginFlags, 'scopes'>,
  settings: Settings,
): string[] {
  if (flags.scopes !== undefined) return orderScopes(flags.scopes);
  if (settings.loginScopes !== undefined && settings.loginScopes.length > 0) {
    return orderScopes(settings.loginScopes);
  }
  const derived = new Set<string>();
  for (const pkg of resolveEnabledPackages(settings)) {
    for (const scope of PACKAGE_SCOPES[pkg]) derived.add(scope);
  }
  if (derived.size === 0) {
    throw new TikTokError({
      kind: 'config',
      code: 'no_scopes_selected',
      message:
        'The enabled tool packages need no TikTok scopes, so there is nothing to ' +
        'authorize.',
      remediation: `Widen TT_TOOL_PACKAGES, or run ${CLI_NAME} login --scopes ${BASIC_SCOPE}.`,
    });
  }
  return orderScopes(derived);
}

// ---------------------------------------------------------------------------
// callback plumbing (CC-A8 / CC-A9)
// ---------------------------------------------------------------------------

type CallbackResult =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly message: string };

function page(status: number, title: string, text: string): CallbackReply {
  return {
    status,
    body:
      '<!doctype html><meta charset="utf-8">' +
      `<title>${title}</title>` +
      '<body style="font:16px system-ui;margin:3rem">' +
      `<p>${text}</p></body>`,
  };
}

/**
 * The four pages the callback server can answer with. All four are static: an
 * upstream `error` or a mismatched `state` is *described in the terminal*, never
 * echoed into a page, so nothing under TikTok's (or an attacker's) control is
 * ever reflected into the browser.
 */
const PAGE_OK = page(
  200,
  'Authorized',
  'Authorization complete — you can close this tab.',
);
const PAGE_ALREADY = page(
  200,
  'Already handled',
  'This authorization was already handled. Return to the terminal.',
);
const PAGE_FAILED = page(
  400,
  'Authorization failed',
  'Authorization failed. Return to the terminal for the reason.',
);
const PAGE_NOT_FOUND = page(404, 'Not found', 'Nothing is served here.');
const PAGE_BAD_METHOD = page(405, 'Method not allowed', 'Use a GET request.');

/** Constant-time, length-safe comparison of two UTF-8 strings. */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, so the lengths are compared
  // first — that leaks only the length, which the URL already reveals.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Sanitize an upstream OAuth error code before it reaches a human sentence. */
function safeErrorCode(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40);
  return cleaned === '' ? 'unspecified' : cleaned;
}

/**
 * Turn the query of a redirect into either the authorization code or the reason
 * it is unusable.
 *
 * `requireState` is the difference between the two entry paths: a callback the
 * loopback server received *must* carry a matching `state`, while a URL the user
 * pasted by hand is validated only when it carries one (CC-A10) — the user
 * vouching for a copy-pasted URL is the trust anchor there.
 */
export function parseCallbackQuery(
  params: URLSearchParams,
  expectedState: string,
  requireState: boolean,
): CallbackResult {
  const upstreamError = params.get('error');
  if (upstreamError !== null) {
    return {
      ok: false,
      message:
        `TikTok did not authorize this login (${safeErrorCode(upstreamError)}). ` +
        'Nothing was changed; run login again and approve the consent screen.',
    };
  }

  const state = params.get('state');
  if (state === null) {
    if (requireState) {
      return {
        ok: false,
        message:
          'The redirect carried no state parameter, so it cannot be tied to this ' +
          'login. Nothing was changed; run login again.',
      };
    }
  } else if (!constantTimeEquals(state, expectedState)) {
    return {
      ok: false,
      message:
        'The redirect state does not match the one this login generated — it ' +
        'belongs to a different (or older) login attempt. Nothing was changed; ' +
        'run login again.',
    };
  }

  const code = params.get('code');
  if (code === null || code === '') {
    return {
      ok: false,
      message: 'The redirect carried no authorization code. Run login again.',
    };
  }
  // `URLSearchParams` already percent-decoded exactly once (AUTH.md § 1.1).
  registerSecret(code);
  return { ok: true, code };
}

interface CallbackSink {
  readonly handler: CallbackHandler;
  /** Resolves once, with whatever the single accepted callback carried. */
  readonly received: Promise<CallbackResult>;
  /** Install the `state` to compare against; called right after `buildAuthUrl`. */
  arm(state: string): void;
}

/**
 * The single-accept redirect handler (CC-A9).
 *
 * The latch is flipped *before* the query is parsed, so a callback that fails
 * validation still consumes the attempt: an authorization code that reached this
 * process is spent whether or not the exchange succeeded.
 */
export function createCallbackSink(): CallbackSink {
  let settle: ((result: CallbackResult) => void) | undefined;
  const received = new Promise<CallbackResult>((resolve) => {
    settle = resolve;
  });
  let expectedState: string | undefined;
  let consumed = false;

  const handler: CallbackHandler = (req) => {
    let target: URL;
    try {
      target = new URL(req.url, `http://${LOOPBACK_HOST}`);
    } catch {
      return PAGE_NOT_FOUND;
    }
    if (target.pathname !== CALLBACK_PATH && target.pathname !== '/callback') {
      return PAGE_NOT_FOUND;
    }
    if (req.method !== 'GET') return PAGE_BAD_METHOD;
    if (consumed) return PAGE_ALREADY;
    consumed = true;

    const result: CallbackResult =
      expectedState === undefined
        ? {
            ok: false,
            message: 'A redirect arrived before this login asked for one.',
          }
        : parseCallbackQuery(target.searchParams, expectedState, true);
    settle?.(result);
    return result.ok ? PAGE_OK : PAGE_FAILED;
  };

  return {
    handler,
    received,
    arm(state: string) {
      expectedState = state;
    },
  };
}

/** The default listener: a `node:http` server, bound to loopback only. */
export function nodeListen(): ListenFn {
  return async (handler, opts) => {
    const server = createServer((req, res) => {
      const reply = handler({ method: req.method ?? 'GET', url: req.url ?? '/' });
      res.writeHead(reply.status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(reply.body);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port, opts.host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const address = server.address();
    const port =
      typeof address === 'object' && address !== null ? address.port : opts.port;
    return {
      port,
      close: () =>
        new Promise<void>((resolve) => {
          // Browsers keep the redirect connection alive; without this the close
          // would wait for the keep-alive timeout and the CLI would look hung.
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    };
  };
}

type BindOutcome =
  | { readonly kind: 'bound'; readonly server: LoopbackServer }
  | { readonly kind: 'manual'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Bind the callback listener (CC-A8).
 *
 * With `TT_REDIRECT_PORT` set the pin is a promise to the user — a busy port is
 * a hard failure naming the variable, never a silent move to another port. With
 * no pin the bind is ephemeral (port 0), and a failure degrades to manual paste
 * rather than ending the login.
 */
async function bindCallback(
  deps: CliDeps,
  settings: Settings,
  handler: CallbackHandler,
): Promise<BindOutcome> {
  const listen = deps.listen ?? nodeListen();
  const pinned = settings.redirectPort;
  try {
    const server = await listen(handler, { host: LOOPBACK_HOST, port: pinned ?? 0 });
    return { kind: 'bound', server };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (pinned !== undefined) {
      return {
        kind: 'failed',
        message:
          `TT_REDIRECT_PORT pins the redirect to ${LOOPBACK_HOST}:${String(pinned)}, ` +
          `but that port could not be bound (${reason}). Free the port, point ` +
          `TT_REDIRECT_PORT at a free one, or run "${CLI_NAME} login --manual" and ` +
          'paste the redirect by hand.',
      };
    }
    return {
      kind: 'manual',
      message:
        `No local port could be bound for the redirect (${reason}); ` +
        'falling back to manual paste.',
    };
  }
}

// ---------------------------------------------------------------------------
// manual paste (CC-A10)
// ---------------------------------------------------------------------------

/**
 * Percent-decode a pasted bare code exactly once, and only when it still looks
 * encoded: TikTok's codes routinely end in `%2A`, but a terminal paste out of a
 * browser's address bar is often already decoded, and decoding twice would
 * corrupt a code that legitimately contains a `%`.
 */
export function decodeOnce(raw: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(raw)) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Accept either the full redirect URL or the bare `code` value (CC-A10). Any
 * other paste — a fragment of a URL, a shell command, two values at once — is
 * rejected with the two shapes spelled out rather than half-parsed.
 */
export function parsePastedRedirect(
  input: string,
  expectedState: string,
): CallbackResult {
  const text = input.trim();
  if (text === '') {
    return { ok: false, message: 'Nothing was pasted. Run login again.' };
  }
  if (/^https?:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return {
        ok: false,
        message:
          'That is not a valid URL. Paste the full redirect URL, or just the code.',
      };
    }
    return parseCallbackQuery(url.searchParams, expectedState, false);
  }
  if (/[\s?&=#]/.test(text)) {
    return {
      ok: false,
      message:
        'That is neither a redirect URL nor a bare code. Paste the whole ' +
        `${LOOPBACK_HOST} URL the browser was sent to, or only the value of its ` +
        'code parameter.',
    };
  }
  const code = decodeOnce(text);
  registerSecret(code);
  return { ok: true, code };
}

/** The default prompt: one line from stdin, echoed nowhere. */
async function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function ask(deps: CliDeps, question: string): Promise<string> {
  return await (deps.prompt ?? defaultPrompt)(question);
}

// ---------------------------------------------------------------------------
// browser
// ---------------------------------------------------------------------------

/** The platform's "open this URL" command. Split out so it is testable. */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform,
): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}

/** Fire-and-forget browser open; a failure is never fatal to the login. */
async function defaultOpenBrowser(url: string): Promise<void> {
  const { command, args } = browserCommand(url, process.platform);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// journal (CONFIGURATION.md § Journal)
// ---------------------------------------------------------------------------

/**
 * The journal and its single rotation, both siblings of the resolved env file —
 * the same rule `--purge-journal` needs and the journal writer will use.
 */
export function journalPaths(envFilePath: string): readonly string[] {
  const dir = dirname(envFilePath);
  return [join(dir, JOURNAL_FILE), join(dir, `${JOURNAL_FILE}.1`)];
}

async function purgeJournal(envFilePath: string): Promise<string[]> {
  const removed: string[] = [];
  for (const path of journalPaths(envFilePath)) {
    try {
      await rm(path);
      removed.push(path);
    } catch {
      // Absent (the common case) or unreadable: either way there is nothing to
      // delete, and a revoke must not fail over a journal file.
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  if (isTikTokError(error)) {
    return error.remediation === undefined
      ? error.message
      : `${error.message}\n${error.remediation}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** How an existing profile is named in the overwrite prompt (CC-A11). */
function describeAccount(credentials: ProfileCredentials): string {
  const openId = credentials.openId;
  const scopes = credentials.scopes ?? [];
  const who =
    openId === undefined ? 'an account with no open_id on file' : `open_id ${openId}`;
  return scopes.length === 0 ? who : `${who}, scopes ${scopes.join(', ')}`;
}

/**
 * The display name behind the freshly issued token — one probe, best effort.
 *
 * It is cosmetic: a failure (no `user.info.basic` in the grant, a network hiccup)
 * costs the summary a friendly name and nothing else, so it also does not spend
 * the read-retry ladder.
 */
async function probeDisplayName(
  tokens: TokenSet,
  settings: Settings,
  clock: Clock,
  logger: Logger,
): Promise<string | undefined> {
  if (!tokens.scopes.includes(BASIC_SCOPE)) return undefined;
  try {
    const data = await ttRequest<{ user?: { display_name?: unknown } }>({
      method: 'GET',
      url: USER_INFO_URL,
      retryClass: 'read',
      maxAttempts: 1,
      bearer: tokens.accessToken,
      timeoutMs: settings.timeoutMs,
      clock,
      logger,
    });
    const name = data.user?.display_name;
    return typeof name === 'string' && name !== '' ? name : undefined;
  } catch (err) {
    logger.warn('the display-name probe after login failed; the summary omits the name', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Which tool packages this grant actually enables (TOOLS.md § 6 item 4).
 *
 * `tiktok_get_auth_status` reports the same availability and the
 * `[UNAVAILABLE: …]` description markers say it a third time, but the loop only
 * closes if `login` says it too: a partial grant is discovered at the one moment
 * the operator is still at the terminal and can re-run with the missing scope.
 *
 * Only the *enabled* packages are listed — a tool that is not registered is not
 * a gap anyone has — and the scopes named are the ones still missing, not the
 * whole requirement, so the line is the command to run next.
 */
function packageMatrix(settings: Settings, granted: readonly string[]): string[] {
  const enabled = resolveEnabledPackages(settings);
  if (enabled.length === 0) return [];

  const held = new Set(granted);
  const width = Math.max(...enabled.map((pkg) => pkg.length));

  return enabled.map((pkg) => {
    const missing = PACKAGE_SCOPES[pkg].filter((scope) => !held.has(scope));
    const state =
      missing.length === 0 ? 'ready' : `needs ${orderScopes(missing).join(', ')}`;
    return `    ${pkg.padEnd(width)}  ${state}`;
  });
}

function summary(
  profile: string,
  tokens: TokenSet,
  requested: readonly string[],
  displayName: string | undefined,
  envFilePath: string,
  settings: Settings,
): string {
  const granted = orderScopes(tokens.scopes);
  const missing = requested.filter((scope) => !tokens.scopes.includes(scope));
  const account =
    displayName === undefined
      ? `open_id ${tokens.openId}`
      : `${displayName} (open_id ${tokens.openId})`;
  const lines = [
    `Authorized profile ${profile}.`,
    `  account:        ${account}`,
    `  granted scopes: ${granted.join(', ')}`,
  ];
  if (missing.length > 0) {
    lines.push(`  not granted:    ${missing.join(', ')}`);
  }
  lines.push(
    `  access token:   expires ${tokens.accessExpiresAt}`,
    `  refresh token:  expires ${tokens.refreshExpiresAt}`,
    `  credentials:    ${envFilePath}`,
  );
  const matrix = packageMatrix(settings, granted);
  if (matrix.length > 0) {
    lines.push('  tool packages:', ...matrix);
  }
  if (missing.length > 0) {
    lines.push(
      '',
      'A partial grant is normal — TikTok lets the user deselect scopes on the',
      'consent screen. Tools needing the missing scopes stay unavailable until a',
      'later login grants them.',
    );
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

/** Everything both `login` and `login --revoke` resolve before they diverge. */
interface LoginContext {
  readonly envFilePath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly settings: Settings;
  readonly profile: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly existing: ProfileCredentials;
}

async function resolveContext(
  deps: CliDeps,
  profileFlag?: string,
): Promise<LoginContext> {
  const processEnv = deps.env ?? process.env;
  const envFilePath = resolveEnvFilePath(processEnv);
  const snapshot = await readEnvFile(envFilePath);
  const env = overlayEnvFile(processEnv, snapshot);
  const settings = loadSettings(env);
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? createLogger({ level: settings.logLevel, clock });
  const profile = normalizeProfileName(profileFlag ?? settings.activeProfile);

  // The app credentials are per installation, so they are read from the default
  // profile — which also produces the right `missing_credentials` error before a
  // browser is ever opened. A profile that does not exist yet is the normal
  // first-login case and carries no tokens.
  const app = readProfile(DEFAULT_PROFILE, snapshot, env);
  let existing = app;
  if (profile !== DEFAULT_PROFILE) {
    try {
      existing = readProfile(profile, snapshot, env);
    } catch (err) {
      if (!isTikTokError(err) || err.code !== 'unknown_profile') throw err;
      existing = { clientKey: app.clientKey, clientSecret: app.clientSecret };
    }
  }
  return { envFilePath, env, settings, profile, clock, logger, existing };
}

/** `login --revoke` (AUTH.md § 4): tokens go, the journal stays unless asked. */
async function runRevoke(
  ctx: LoginContext,
  flags: LoginFlags,
  deps: CliDeps,
  io: CliIo,
): Promise<number> {
  await revokeToken(ctx.profile, {
    clock: ctx.clock,
    logger: ctx.logger,
    env: ctx.env,
    settings: ctx.settings,
    timeoutMs: ctx.settings.timeoutMs,
    rename: deps.rename,
  });
  io.out(
    `Revoked profile ${ctx.profile}; its tokens were cleared from ${ctx.envFilePath}.\n`,
  );

  if (flags.purgeJournal) {
    const removed = await purgeJournal(ctx.envFilePath);
    io.out(
      removed.length === 0
        ? 'No publish journal was found; nothing to purge.\n'
        : `Purged the publish journal (${removed.join(', ')}).\n`,
    );
  } else {
    io.out(
      `The publish journal was kept (${journalPaths(ctx.envFilePath)[0] ?? JOURNAL_FILE}); ` +
        'add --purge-journal to delete it as well.\n',
    );
  }
  return EXIT_OK;
}

/** The CC-A11 guard: never replace credentials the user did not mean to lose. */
async function confirmOverwrite(
  ctx: LoginContext,
  flags: LoginFlags,
  deps: CliDeps,
  io: CliIo,
): Promise<boolean> {
  const { existing } = ctx;
  if (existing.accessToken === undefined && existing.refreshToken === undefined)
    return true;
  if (flags.force) return true;

  const who = describeAccount(existing);
  if (!io.isTTY) {
    io.err(
      `Profile ${ctx.profile} already holds credentials (${who}). ` +
        'Re-run with --force to replace them.\n',
    );
    return false;
  }
  const answer = await ask(
    deps,
    `Replace the credentials of profile ${ctx.profile} (${who})? [y/N] `,
  );
  if (/^y(es)?$/i.test(answer.trim())) return true;
  io.err('Aborted; nothing was changed.\n');
  return false;
}

/** The authorization half: consent, callback (or paste), exchange. */
async function authorize(
  ctx: LoginContext,
  flags: LoginFlags,
  deps: CliDeps,
  io: CliIo,
  scopes: readonly string[],
): Promise<{ readonly ok: true; readonly tokens: TokenSet } | { readonly ok: false }> {
  const sink = createCallbackSink();
  let server: LoopbackServer | undefined;
  let manual = flags.manual;

  if (!manual) {
    const outcome = await bindCallback(deps, ctx.settings, sink.handler);
    if (outcome.kind === 'failed') {
      io.err(`${outcome.message}\n`);
      return { ok: false };
    }
    if (outcome.kind === 'manual') {
      io.err(`${outcome.message}\n`);
      manual = true;
    } else {
      server = outcome.server;
    }
  }

  try {
    const port = server?.port ?? ctx.settings.redirectPort ?? MANUAL_FALLBACK_PORT;
    const redirectUri = `http://${LOOPBACK_HOST}:${String(port)}${CALLBACK_PATH}`;
    const { url, state, verifier } = buildAuthUrl({
      clientKey: ctx.existing.clientKey,
      scopes: [...scopes],
      redirectUri,
      settings: ctx.settings,
      randomBytes: deps.randomBytes,
    });

    // `state` is a secret from the moment it exists: any *other* line that ever
    // interpolates it — an error message, a log field — must come out masked.
    registerSecret(state);
    sink.arm(state);

    io.err(`Authorizing profile ${ctx.profile} for: ${scopes.join(', ')}\n`);
    // The one line that must survive redaction verbatim: a masked authorize URL
    // is not an authorize URL. See `CliIo.errRaw`.
    io.errRaw(`\nOpen this URL to authorize:\n\n  ${url}\n\n`);
    if (!manual && !flags.noBrowser) {
      try {
        await (deps.openBrowser ?? defaultOpenBrowser)(url);
      } catch {
        io.err('A browser could not be opened; open the URL above by hand.\n');
      }
    }

    const result = manual
      ? parsePastedRedirect(
          await ask(
            deps,
            `Paste the ${redirectUri} URL you were redirected to (or just the code): `,
          ),
          state,
        )
      : await waitForCallback(io, redirectUri, sink.received);

    if (!result.ok) {
      io.err(`${result.message}\n`);
      return { ok: false };
    }

    const tokens = await exchangeCode({
      clientKey: ctx.existing.clientKey,
      clientSecret: ctx.existing.clientSecret,
      code: result.code,
      verifier,
      redirectUri,
      settings: ctx.settings,
      timeoutMs: ctx.settings.timeoutMs,
      clock: ctx.clock,
      logger: ctx.logger,
    });
    return { ok: true, tokens };
  } finally {
    await server?.close();
  }
}

async function waitForCallback(
  io: CliIo,
  redirectUri: string,
  received: Promise<CallbackResult>,
): Promise<CallbackResult> {
  io.err(`Waiting for the redirect on ${redirectUri} … (Ctrl-C to abort)\n`);
  return await received;
}

/** Write the new token set, then drop the in-process cache so it is re-read. */
async function persist(
  ctx: LoginContext,
  tokens: TokenSet,
  deps: CliDeps,
): Promise<void> {
  const { settings } = ctx;
  const written = await withEnvLock(
    ctx.envFilePath,
    async () =>
      await persistProfilePatch(
        ctx.envFilePath,
        ctx.profile,
        {
          accessToken: tokens.accessToken,
          accessExpiresAt: tokens.accessExpiresAt,
          refreshToken: tokens.refreshToken,
          refreshExpiresAt: tokens.refreshExpiresAt,
          openId: tokens.openId,
          scopes: tokens.scopes,
        },
        { clock: ctx.clock, logger: ctx.logger, rename: deps.rename },
      ),
    {
      waitMs: settings.envLockWaitMs,
      staleMs: settings.envLockStaleMs,
      heartbeatMs: settings.envLockHeartbeatMs,
      clock: ctx.clock,
      logger: ctx.logger,
    },
  );
  if (!written.persisted) {
    throw new TikTokError({
      kind: 'config',
      code: 'env_write_failed',
      message:
        `The tokens were issued but could not be written to ${ctx.envFilePath}, so ` +
        'this login did not stick.',
      remediation:
        'Check that the file and its directory are writable by this user, then run ' +
        'login again.',
    });
  }
  // A cached token set for this profile is now stale by construction.
  resetTokenCache();
}

/**
 * Run `login`.
 *
 * @returns The intended exit code: 0 on success, 2 for a usage error, 1 for a
 *   login that ran and failed.
 */
export async function runLogin(deps: CliDeps = {}): Promise<number> {
  const io = cliIo(deps);
  const parsed = parseLoginArgs(deps.argv ?? []);
  if (!parsed.ok) {
    io.err(`${parsed.message}\n\n${loginUsage()}`);
    return EXIT_USAGE;
  }
  const flags = parsed.flags;
  if (flags.help) {
    io.out(loginUsage());
    return EXIT_OK;
  }

  try {
    const ctx = await resolveContext(deps, flags.profile);
    if (flags.revoke) return await runRevoke(ctx, flags, deps, io);
    if (!(await confirmOverwrite(ctx, flags, deps, io))) return EXIT_FAILURE;

    const scopes = resolveScopes(flags, ctx.settings);
    const result = await authorize(ctx, flags, deps, io, scopes);
    if (!result.ok) return EXIT_FAILURE;

    await persist(ctx, result.tokens, deps);
    const displayName = await probeDisplayName(
      result.tokens,
      ctx.settings,
      ctx.clock,
      ctx.logger,
    );
    io.out(
      summary(
        ctx.profile,
        result.tokens,
        scopes,
        displayName,
        ctx.envFilePath,
        ctx.settings,
      ),
    );
    return EXIT_OK;
  } catch (err) {
    io.err(`${describeError(err)}\n`);
    return EXIT_FAILURE;
  }
}

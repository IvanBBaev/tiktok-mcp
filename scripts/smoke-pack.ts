/**
 * Packed-tarball smoke test (IMPLEMENTATION-PLAN gap G-12, task TE-5).
 *
 * The `pack-audit` gate proves *what* is in the tarball; nothing in this repo
 * proves the tarball **runs**. Those are different failures. A published
 * artifact can carry a perfect file list and still be dead on arrival — a
 * relative import that resolves inside the repo and not inside
 * `node_modules/tiktok-mcp-ai/`, a `bin` mapping npm no longer links, a
 * `package.json` the CLI reads through `../../../` and cannot find once the
 * layout is `<prefix>/node_modules/<pkg>/build/src/cli/`. None of that shows up
 * in the unit suite, because the unit suite runs from the working tree.
 *
 * So this script buys the one thing the working tree cannot: it packs the repo,
 * installs the tarball into an empty directory outside it, and drives the
 * installed binary as a black box — the CLI surface first, then a real MCP
 * session over stdin/stdout.
 *
 * Design notes:
 *
 * - **Black box on purpose.** Expected strings and exit codes are duplicated
 *   here as literals rather than imported from `src/`. Importing them would
 *   compare the artifact against the working tree it was built from, which is
 *   the one comparison that cannot fail.
 * - **The child's environment is built from nothing** — see {@link childEnv}.
 *   A developer with real TikTok credentials in `~/.config/tiktok-mcp-ai/.env`
 *   must get exactly the same result as a clean CI runner, and a smoke that
 *   passed only because a token happened to be lying around is worse than no
 *   smoke at all.
 * - **Zero configured credentials is the state under test.** `listProfiles`
 *   always reports the implicit `DEFAULT` profile, so the server boots, serves,
 *   and answers `tools/list` with the full `core` package set — every entry
 *   whose scopes are unmet carries the `[UNAVAILABLE: ...]` description prefix
 *   (TOOLS.md § 6.1). The assertion below is therefore "a non-empty tool list",
 *   which is what the code actually does, not "no tools without credentials".
 * - **Nothing is spawned through a shell shim.** `node_modules/.bin/` holds a
 *   symlink on POSIX and a `.cmd` on Windows; asserting the shim *exists* is
 *   worth a check, but every run below goes through
 *   `node <prefix>/node_modules/<pkg>/bin/tiktok-mcp-ai.cjs`, which is byte
 *   identical on all three OS legs and keeps the test measuring the package
 *   rather than the shell.
 * - **It never hangs.** Every step carries its own deadline, every child is
 *   killed on the way out, and both temp trees are removed on success and on
 *   failure alike.
 *
 * It is deliberately **not** part of `npm run check`: the install reaches the
 * registry for the runtime dependencies, and the check chain has to stay
 * offline-safe and fast. CI runs it as its own 3-OS job.
 *
 * Usage: `node build/scripts/smoke-pack.js`
 */

import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { asRecord, asString, readRepoJson, REPO_ROOT } from './lib/repo.js';

const PACKAGE_JSON = 'package.json';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// deadlines and constants
// ---------------------------------------------------------------------------

/** `npm pack` reads the working tree only; a minute is already generous. */
const PACK_TIMEOUT_MS = 120_000;

/** `npm install` fetches the runtime dependencies from the registry. */
const INSTALL_TIMEOUT_MS = 300_000;

/** A CLI subcommand prints and exits; anything slower than this is a hang. */
const CLI_TIMEOUT_MS = 30_000;

/** One JSON-RPC round trip against a server that has already started. */
const RPC_TIMEOUT_MS = 30_000;

/** Grace given to a child between EOF, `SIGTERM` and `SIGKILL`. */
const KILL_GRACE_MS = 5_000;

/** The protocol revision this handshake declares (same as test/server.test.ts). */
const PROTOCOL_VERSION = '2025-06-18';

/** `EXIT_USAGE` in `src/cli/index.ts` — an unknown subcommand exits 2. */
const EXIT_USAGE = 2;

/** How much of a child's stderr a failure message quotes back. */
const STDERR_TAIL_LINES = 20;

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

interface Check {
  name: string;
  ok: boolean;
  /** Always populated: on a red CI leg this line is the whole diagnosis. */
  detail: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The last lines of a child's stderr, for a failure message. */
function stderrTail(stderr: string): string {
  const lines = stderr.split('\n').filter((line) => line.trim() !== '');
  const tail = lines.slice(-STDERR_TAIL_LINES);
  return tail.length === 0 ? '<no stderr>' : tail.join('\n    ');
}

/** One line per check, printed as it happens so a CI log streams in order. */
function record(checks: Check[], name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}\n`);
}

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------

/**
 * Quote one argument for `cmd.exe`.
 *
 * Only needed on the Windows branch below, where npm has to go through a shell
 * and the shell re-splits the command line: `os.tmpdir()` on a Windows runner
 * can sit under a path containing a space, and an unquoted `--pack-destination`
 * would then arrive as two arguments.
 */
function quoteForShell(argument: string): string {
  return /[\s"&|<>^]/.test(argument) ? `"${argument}"` : argument;
}

/**
 * Run npm and return its stdout.
 *
 * On Windows the npm shim is a `.cmd`, which Node refuses to exec directly,
 * hence the shell — the same idiom `gen-pack-manifest.ts` uses.
 */
async function runNpm(
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  const isWindows = process.platform === 'win32';
  try {
    const { stdout } = await execFileAsync(
      isWindows ? 'npm.cmd' : 'npm',
      isWindows ? args.map(quoteForShell) : [...args],
      { cwd, shell: isWindows, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout;
  } catch (err) {
    const detail = asRecord(err) ?? {};
    throw new Error(
      `\`npm ${args.join(' ')}\` failed in ${cwd}: ${message(err)}\n` +
        `  stderr: ${stderrTail(asString(detail['stderr']) ?? '')}`,
      { cause: err },
    );
  }
}

interface PackResult {
  filename?: string;
}

/**
 * `npm pack` the repository into `destination` and return the tarball path.
 *
 * `--pack-destination` is what keeps a stray `.tgz` out of the repo root, and
 * `--ignore-scripts` matches the pack audit: this package defines no
 * `prepack`/`prepare`, so packing is a pure read of the working tree.
 */
async function packTarball(destination: string): Promise<string> {
  const stdout = await runNpm(
    ['pack', '--json', '--ignore-scripts', '--pack-destination', destination],
    REPO_ROOT,
    PACK_TIMEOUT_MS,
  );
  const parsed = JSON.parse(stdout) as readonly PackResult[];
  const filename = parsed[0]?.filename;
  if (filename === undefined) {
    throw new Error('smoke-pack: `npm pack --json` named no tarball');
  }
  return join(destination, filename);
}

/**
 * Install `tarball` into `directory` as if it were a consumer's project.
 *
 * The minimal `package.json` written first is not cosmetic: without it npm
 * treats the temp directory as part of whatever project it can find above it,
 * and the install stops being a statement about the tarball.
 */
async function installTarball(tarball: string, directory: string): Promise<void> {
  await writeFile(
    join(directory, PACKAGE_JSON),
    `${JSON.stringify({ name: 'tiktok-mcp-smoke', version: '0.0.0', private: true }, null, 2)}\n`,
    'utf8',
  );
  await runNpm(
    ['install', tarball, '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'],
    directory,
    INSTALL_TIMEOUT_MS,
  );
}

// ---------------------------------------------------------------------------
// the child's environment
// ---------------------------------------------------------------------------

/**
 * The complete environment the installed binary is given — built from nothing
 * rather than spread over `process.env`.
 *
 * Every `TT_` variable is therefore absent by construction, which is the only
 * way this smoke means the same thing on a maintainer's laptop and on a CI
 * runner. `TT_ENV_FILE` points into the throwaway home, and `HOME`,
 * `USERPROFILE`, `XDG_CONFIG_HOME` and `LOCALAPPDATA` are redirected there too:
 * `resolveEnvFilePath` in `src/core/config.ts` consults all four when the
 * override is absent, and a smoke that leaned on the override alone would be
 * one refactor away from reading a real credential file.
 *
 * `PATH` is kept because the child is Node and Node is not hermetic; the win32
 * list is what a Node process needs on Windows to start at all.
 */
function childEnv(home: string, envFile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TT_ENV_FILE: envFile,
  };
  if (process.platform === 'win32') {
    for (const key of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// running the installed CLI
// ---------------------------------------------------------------------------

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the installed launcher with `args` and collect both streams.
 *
 * A non-zero exit is data here, not an error — one of the assertions below is
 * precisely that an unknown subcommand exits {@link EXIT_USAGE} — so this uses
 * `spawn` rather than `execFile`, which would reject on exactly that case.
 * stdin is `ignore`d: with no argv the same entry point starts a *server*, and
 * an inherited stdin would leave one of these runs waiting on a terminal.
 */
function runInstalledCli(
  entry: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<CliRun> {
  return new Promise<CliRun>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `\`tiktok-mcp-ai ${args.join(' ')}\` did not exit within ` +
            `${String(CLI_TIMEOUT_MS)} ms; stderr:\n    ${stderrTail(stderr)}`,
        ),
      );
    }, CLI_TIMEOUT_MS);
    timer.unref();
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`could not spawn ${entry}: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === null) {
        reject(new Error(`\`tiktok-mcp-ai ${args.join(' ')}\` was killed by ${signal}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// the MCP stdio session
// ---------------------------------------------------------------------------

interface StdioSession {
  /** Write one newline-delimited JSON-RPC frame to the server's stdin. */
  send(frame: Record<string, unknown>): void;
  /** The response frame carrying `id`; rejects on timeout or early exit. */
  awaitResponse(id: number, timeoutMs: number): Promise<Record<string, unknown>>;
  /** stdout lines that were not JSON-RPC frames — a CC-G3 violation each. */
  stray(): readonly string[];
  stderr(): string;
  /** EOF, then `SIGTERM`, then `SIGKILL`. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * Spawn the installed server on stdio and read its output as a frame stream.
 *
 * The mechanics mirror `test/server.test.ts`'s CC-G3 session, with one
 * difference that matters: every stdout line is classified rather than assumed.
 * A line that does not parse as JSON, or parses without `"jsonrpc": "2.0"`, is
 * collected as *stray* instead of throwing — the point of running against the
 * packed layout is to catch a dependency that prints a banner at import time,
 * and the failure message has to be able to quote that banner back.
 */
function openStdioSession(
  entry: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): StdioSession {
  const child = spawn(process.execPath, [entry], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const frames: Record<string, unknown>[] = [];
  const strayLines: string[] = [];
  const waiters = new Map<
    number,
    { resolve: (frame: Record<string, unknown>) => void; reject: (err: Error) => void }
  >();
  let stderrText = '';
  let buffered = '';
  let dead: string | undefined;
  let closing = false;

  const accept = (line: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      strayLines.push(line);
      return;
    }
    const frame = asRecord(parsed);
    if (frame === undefined || frame['jsonrpc'] !== '2.0') {
      strayLines.push(line);
      return;
    }
    frames.push(frame);
    const id = frame['id'];
    if (typeof id !== 'number') return;
    const waiter = waiters.get(id);
    if (waiter === undefined) return;
    waiters.delete(id);
    waiter.resolve(frame);
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrText += chunk;
  });
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    for (let index = buffered.indexOf('\n'); index >= 0; index = buffered.indexOf('\n')) {
      // The CRLF strip is for the Windows leg: the transport writes LF, but a
      // line that ever arrived as CRLF must not be misfiled as stray.
      const line = buffered.slice(0, index).replace(/\r$/, '');
      buffered = buffered.slice(index + 1);
      if (line.trim() !== '') accept(line);
    }
  });

  const die = (reason: string): void => {
    dead = reason;
    for (const waiter of waiters.values()) waiter.reject(new Error(reason));
    waiters.clear();
  };
  child.on('error', (err) => {
    die(`the server process failed to start: ${err.message}`);
  });
  child.on('exit', (code, signal) => {
    if (closing) return;
    die(
      `the server exited before answering (code ${String(code)}, signal ` +
        `${String(signal)}); stderr:\n    ${stderrTail(stderrText)}`,
    );
  });

  const waitForExit = (timeoutMs: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
      timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

  return {
    send(frame) {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    },
    awaitResponse(id, timeoutMs) {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const already = frames.find((frame) => frame['id'] === id);
        if (already !== undefined) {
          resolve(already);
          return;
        }
        if (dead !== undefined) {
          reject(new Error(dead));
          return;
        }
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(
            new Error(
              `no JSON-RPC response for id ${String(id)} within ` +
                `${String(timeoutMs)} ms; stderr:\n    ${stderrTail(stderrText)}`,
            ),
          );
        }, timeoutMs);
        timer.unref();
        waiters.set(id, {
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
      });
    },
    stray: () => strayLines,
    stderr: () => stderrText,
    async close() {
      closing = true;
      // EOF first: the server shuts down on stdin end, which is how a real
      // client disconnects. The signals below exist only for a server that
      // ignored it, so a hang here still terminates the run.
      child.stdin.end();
      if (await waitForExit(KILL_GRACE_MS)) return;
      child.kill();
      if (await waitForExit(KILL_GRACE_MS)) return;
      child.kill('SIGKILL');
      await waitForExit(KILL_GRACE_MS);
    },
  };
}

// ---------------------------------------------------------------------------
// the assertions
// ---------------------------------------------------------------------------

interface Installed {
  /** Package name from `package.json` — also the expected `serverInfo.name`. */
  name: string;
  version: string;
  /** The launcher inside the installed package. */
  entry: string;
  /** Where the install lives; every child runs with this as its cwd. */
  prefix: string;
  env: NodeJS.ProcessEnv;
}

/** One group of assertions against the installed package. */
type Stage = (checks: Check[], installed: Installed) => Promise<void>;

/** `--version`, `--help` and the unknown-subcommand exit code. */
async function checkCliSurface(checks: Check[], installed: Installed): Promise<void> {
  const version = await runInstalledCli(
    installed.entry,
    ['--version'],
    installed.env,
    installed.prefix,
  );
  record(
    checks,
    'cli-version',
    version.code === 0 && version.stdout.trim() === installed.version,
    version.code === 0 && version.stdout.trim() === installed.version
      ? `--version printed ${installed.version}`
      : `--version exited ${String(version.code)} and printed ` +
          `${JSON.stringify(version.stdout.trim())}; expected 0 and ${installed.version}`,
  );

  const help = await runInstalledCli(
    installed.entry,
    ['--help'],
    installed.env,
    installed.prefix,
  );
  // The usage text is matched loosely on purpose — wording is allowed to
  // change, the shape of the answer is not.
  const helpOk =
    help.code === 0 &&
    help.stdout.includes('Usage:') &&
    help.stdout.includes('start the MCP server on stdio');
  record(
    checks,
    'cli-help',
    helpOk,
    helpOk
      ? '--help exited 0 and printed the usage text'
      : `--help exited ${String(help.code)}; stdout:\n    ${help.stdout.trim() || '<empty>'}`,
  );

  const unknown = await runInstalledCli(
    installed.entry,
    ['definitely-not-a-subcommand'],
    installed.env,
    installed.prefix,
  );
  record(
    checks,
    'cli-usage-exit',
    unknown.code === EXIT_USAGE,
    unknown.code === EXIT_USAGE
      ? `an unknown subcommand exited ${String(EXIT_USAGE)}`
      : `an unknown subcommand exited ${String(unknown.code)}, expected ` +
          `${String(EXIT_USAGE)}; stderr:\n    ${stderrTail(unknown.stderr)}`,
  );
}

/**
 * The real value of this script: a genuine MCP session against the installed
 * package — `initialize`, `notifications/initialized`, `tools/list` — with the
 * initialize result awaited before the notification, exactly as a client does.
 */
async function checkMcpSession(checks: Check[], installed: Installed): Promise<void> {
  const session = openStdioSession(installed.entry, installed.env, installed.prefix);
  try {
    session.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'smoke-pack', version: '0.0.0' },
      },
    });
    const initialize = await session.awaitResponse(1, RPC_TIMEOUT_MS);
    const result = asRecord(initialize['result']);
    const serverInfo = asRecord(result?.['serverInfo']);
    const capabilities = asRecord(result?.['capabilities']);
    const initializeOk =
      result !== undefined &&
      asString(result['protocolVersion']) !== undefined &&
      capabilities?.['tools'] !== undefined &&
      asString(serverInfo?.['name']) === installed.name &&
      asString(serverInfo?.['version']) === installed.version;
    record(
      checks,
      'mcp-initialize',
      initializeOk,
      initializeOk
        ? `initialize answered ${installed.name}@${installed.version}, protocol ` +
            `${asString(result['protocolVersion']) ?? '?'}, tools capability advertised`
        : `initialize answered ${JSON.stringify(initialize)}`,
    );

    session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    session.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const listed = await session.awaitResponse(2, RPC_TIMEOUT_MS);
    const tools = asRecord(listed['result'])?.['tools'];
    const wellFormed =
      Array.isArray(tools) &&
      tools.length > 0 &&
      tools.every((tool) => {
        const entry = asRecord(tool);
        return (
          asString(entry?.['name']) !== undefined &&
          asRecord(entry?.['inputSchema']) !== undefined
        );
      });
    record(
      checks,
      'mcp-tools-list',
      wellFormed,
      wellFormed
        ? `tools/list returned ${String((tools as unknown[]).length)} tools with no ` +
            `credentials configured (every unmet scope carries the [UNAVAILABLE] marker)`
        : `tools/list answered ${JSON.stringify(listed)}`,
    );

    // The startup line proves the server reached "serving", and proves it said
    // so on stderr — the other half of CC-G3.
    const announced = session.stderr().includes('serving MCP on stdio');
    record(
      checks,
      'stderr-diagnostics',
      announced,
      announced
        ? 'the startup line went to stderr, where diagnostics belong'
        : `the server never logged that it is serving; stderr:\n    ${stderrTail(session.stderr())}`,
    );

    const stray = session.stray();
    record(
      checks,
      'stdout-purity',
      stray.length === 0,
      stray.length === 0
        ? 'every stdout line was a JSON-RPC frame (CC-G3)'
        : `${String(stray.length)} non-protocol line(s) on stdout, first: ` +
            `${JSON.stringify(stray[0])}`,
    );
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

/** Pack, install, assert. `root` is a temp tree the caller owns and removes. */
async function smoke(
  root: string,
  name: string,
  version: string,
  binName: string,
  binTarget: string,
): Promise<boolean> {
  const checks: Check[] = [];
  const packDir = join(root, 'pack');
  const prefix = join(root, 'install');
  const home = join(root, 'home');
  await Promise.all([
    mkdir(packDir),
    mkdir(prefix),
    mkdir(join(home, '.config'), { recursive: true }),
    mkdir(join(home, 'AppData', 'Local'), { recursive: true }),
  ]);

  const tarball = await packTarball(packDir);
  record(checks, 'npm-pack', true, `packed ${tarball}`);

  await installTarball(tarball, prefix);
  const installedRoot = join(prefix, 'node_modules', name);
  // The target package.json declares, not a path guessed from the bin key: a
  // renamed or mistyped target must fail here even while the old launcher
  // file is still in the tarball.
  const entry = join(installedRoot, binTarget);
  const shim = join(
    prefix,
    'node_modules',
    '.bin',
    binName + (process.platform === 'win32' ? '.cmd' : ''),
  );
  const [entryStat, shimStat] = await Promise.all([
    stat(entry).catch(() => undefined),
    stat(shim).catch(() => undefined),
  ]);
  record(
    checks,
    'install-layout',
    entryStat !== undefined,
    entryStat === undefined
      ? `${entry} is not in the installed package`
      : `installed to ${installedRoot}`,
  );
  record(
    checks,
    'bin-shim',
    shimStat !== undefined,
    shimStat === undefined ? `npm linked no ${shim}` : `npm linked ${shim}`,
  );
  if (entryStat === undefined) {
    process.stderr.write(
      'smoke-pack: the installed launcher is missing; nothing left to run.\n',
    );
    return false;
  }

  // Created rather than merely named: reading an existing (empty) env file is
  // the path a configured installation takes, and it is the one worth proving.
  const envFile = join(home, '.env');
  await writeFile(envFile, '', { encoding: 'utf8', mode: 0o600 });
  const installed: Installed = {
    name,
    version,
    entry,
    prefix,
    env: childEnv(home, envFile),
  };

  const stages: readonly { name: string; run: Stage }[] = [
    { name: 'cli-surface', run: checkCliSurface },
    { name: 'mcp-session', run: checkMcpSession },
  ];
  for (const stage of stages) {
    try {
      await stage.run(checks, installed);
    } catch (err) {
      // A stage that threw — a child that died during import, a request that
      // was never answered — is one failed check, not a lost report. What it
      // already recorded stays, the next stage still runs, and the summary
      // below names every problem rather than only the first fatal one.
      record(checks, stage.name, false, message(err));
    }
  }

  const failed = checks.filter((check) => !check.ok);
  const where = `${process.platform}, node ${process.versions.node}`;
  if (failed.length > 0) {
    process.stderr.write(
      `smoke-pack: ${String(failed.length)} of ${String(checks.length)} checks failed (${where}):\n` +
        `${failed.map((check) => `  x ${check.name} — ${check.detail}`).join('\n')}\n`,
    );
    return false;
  }
  process.stdout.write(
    `smoke-pack: ${name}@${version} packs, installs and serves MCP on stdio — ` +
      `${String(checks.length)} checks passed (${where}).\n`,
  );
  return true;
}

/**
 * Read the package identity, then run {@link smoke} inside a temp tree that is
 * removed either way. Both temp directories live under `os.tmpdir()`, never
 * inside the repo: a tarball or a `node_modules` left in the working tree would
 * be picked up by the very `npm pack` this script exists to exercise.
 */
export async function runSmokePack(): Promise<boolean> {
  const pkg = (await readRepoJson(PACKAGE_JSON)) ?? {};
  const name = asString(pkg['name']);
  const version = asString(pkg['version']);
  const bins = asRecord(pkg['bin']) ?? {};
  const binName = Object.keys(bins)[0];
  const binTarget = binName === undefined ? undefined : asString(bins[binName]);
  if (
    name === undefined ||
    version === undefined ||
    binName === undefined ||
    binTarget === undefined
  ) {
    process.stderr.write(
      'smoke-pack: package.json declares no name, version or bin — there is nothing to smoke.\n',
    );
    return false;
  }

  const root = await mkdtemp(join(tmpdir(), 'tiktok-mcp-smoke-'));
  try {
    return await smoke(root, name, version, binName, binTarget);
  } catch (err) {
    process.stderr.write(`smoke-pack: ${message(err)}\n`);
    return false;
  } finally {
    try {
      // Windows holds the freshly-run files briefly; the retries are cheaper
      // than a red leg caused by tidying up.
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      process.stderr.write(`smoke-pack: could not remove ${root} (${message(err)}).\n`);
    }
  }
}

if (process.argv[1]?.endsWith('smoke-pack.js') === true) {
  const ok = await runSmokePack();
  process.exitCode = ok ? 0 : 1;
}

/**
 * `cli/index.ts` — dispatch, output seams and the env-file overlay.
 *
 * The subcommands themselves are covered by `login.test.ts`; what is asserted
 * here is the contract every one of them depends on: `runCli` *returns* an exit
 * code and never touches `process`, stdout stays empty on every error path
 * (CC-G3), and everything printed is redacted unless it is the one line that
 * must not be (`CliIo.errRaw`).
 */

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import {
  cliIo,
  EXIT_OK,
  EXIT_USAGE,
  isCliInvocation,
  overlayEnvFile,
  packageVersion,
  runCli,
  usageText,
  versionAt,
  type CliDeps,
} from '../src/cli/index.js';
import type { EnvFileSnapshot } from '../src/core/config.js';
import { registerSecret } from '../src/core/redact.js';
import { fsSandbox } from './helpers.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

interface Captured {
  readonly deps: CliDeps;
  out(): string;
  err(): string;
}

/** A `CliDeps` whose two streams are strings, so both can be asserted on. */
function capture(over: CliDeps = {}): Captured {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    deps: {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
      isTTY: false,
      ...over,
    },
    out: () => stdout.join(''),
    err: () => stderr.join(''),
  };
}

function snapshotOf(values: Record<string, string>): EnvFileSnapshot {
  return {
    path: '/nowhere/.env',
    exists: true,
    mode: 0o600,
    values: new Map(Object.entries(values)),
    schema: 1,
    warnings: [],
    lines: [],
    eol: '\n',
  };
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

test('--help prints the usage on stdout and exits 0', async () => {
  const io = capture();
  assert.equal(await runCli(['--help'], io.deps), EXIT_OK);
  assert.equal(io.out(), usageText());
  assert.equal(io.err(), '');
});

test('-h is the same as --help', async () => {
  const io = capture();
  assert.equal(await runCli(['-h'], io.deps), EXIT_OK);
  assert.equal(io.out(), usageText());
});

test('--version prints the version from package.json', async () => {
  const raw = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
  const declared = (JSON.parse(raw) as { version: string }).version;

  const io = capture();
  assert.equal(await runCli(['--version'], io.deps), EXIT_OK);
  assert.equal(io.out(), `${declared}\n`);
  assert.equal(await packageVersion(), declared);
});

/** `cli/index.ts`'s own fallback, spelled out rather than imported: a test that
 *  reads the constant it asserts against cannot notice the constant changing. */
const FALLBACK = '0.0.0-unknown';

test('a package.json that cannot be read or made sense of yields the fallback', async () => {
  // The degradation `--version` promises, driven through the half of the seam a
  // test owns: the URL. Every shape that carries no usable version — missing
  // file, not JSON, JSON that is not an object, no `version`, an empty one, one
  // that is not a string — ends at the same fallback rather than throwing.
  const box = await fsSandbox();
  try {
    const at = async (name: string, body: string): Promise<string> => {
      const file = pathToFileURL(join(box.dir, name));
      await writeFile(file, body, 'utf8');
      return await versionAt(file);
    };

    assert.equal(await versionAt(pathToFileURL(join(box.dir, 'absent.json'))), FALLBACK);
    assert.equal(await at('malformed.json', '{not json'), FALLBACK);
    assert.equal(await at('array.json', '[]'), FALLBACK);
    assert.equal(await at('null.json', 'null'), FALLBACK);
    assert.equal(await at('bare.json', '{}'), FALLBACK);
    assert.equal(await at('empty.json', '{"version":""}'), FALLBACK);
    assert.equal(await at('number.json', '{"version":1}'), FALLBACK);
    // And the shape that does carry one, so the fallback is not the only answer
    // this function knows how to give.
    assert.equal(await at('good.json', '{"version":"9.9.9"}'), '9.9.9');
  } finally {
    await box.cleanup();
  }
});

test('-V is the same as --version', async () => {
  const io = capture();
  assert.equal(await runCli(['-V'], io.deps), EXIT_OK);
  assert.equal(io.out().trim(), await packageVersion());
});

test('an unknown subcommand is a usage error, not a server start', async () => {
  const io = capture();
  assert.equal(await runCli(['serve'], io.deps), EXIT_USAGE);
  assert.match(io.err(), /Unknown subcommand "serve"/);
  assert.match(io.err(), /Usage:/);
  // cc-g3: stdout carries results only — never a diagnostic.
  assert.equal(io.out(), '');
});

test('no subcommand at all is a usage error', async () => {
  const io = capture();
  assert.equal(await runCli([], io.deps), EXIT_USAGE);
  assert.match(io.err(), /No subcommand given/);
  assert.equal(io.out(), '');
});

test('doctor is dispatched with the args that follow it', async () => {
  const io = capture();
  assert.equal(await runCli(['doctor', '--help'], io.deps), EXIT_OK);
  assert.match(io.out(), /Usage: tiktok-mcp-ai doctor/);
});

test('doctor reports its own usage errors with exit code 2', async () => {
  const io = capture();
  assert.equal(await runCli(['doctor', '--nope'], io.deps), EXIT_USAGE);
  assert.match(io.err(), /Unknown option "--nope"/);
  assert.equal(io.out(), '');
});

test('login is dispatched with the args that follow it', async () => {
  const io = capture();
  assert.equal(await runCli(['login', '--help'], io.deps), EXIT_OK);
  assert.match(io.out(), /Usage: tiktok-mcp-ai login/);
});

test('login reports its own usage errors with exit code 2', async () => {
  const io = capture();
  assert.equal(await runCli(['login', '--nope'], io.deps), EXIT_USAGE);
  assert.match(io.err(), /Unknown option "--nope"/);
  assert.equal(io.out(), '');
});

test('an explicit deps.argv wins over the args after the subcommand', async () => {
  const io = capture({ argv: ['--help'] });
  assert.equal(await runCli(['login', '--force'], io.deps), EXIT_OK);
  assert.match(io.out(), /Usage: tiktok-mcp-ai login/);
});

test('isCliInvocation treats any argument as a command', () => {
  assert.equal(isCliInvocation([]), false);
  assert.equal(isCliInvocation(['login']), true);
  assert.equal(isCliInvocation(['--help']), true);
  // The decisive case: an unrecognized word must reach the dispatch (and become
  // a usage error) rather than silently starting the server.
  assert.equal(isCliInvocation(['serve']), true);
});

// ---------------------------------------------------------------------------
// output seams
// ---------------------------------------------------------------------------

test('everything printed through cliIo is redacted', () => {
  const secret = 'cli-test-registered-secret-value';
  registerSecret(secret);
  const io = capture();
  const sink = cliIo(io.deps);

  sink.out(`token ${secret}\n`);
  sink.err(`token ${secret}\n`);

  assert.equal(io.out(), 'token [REDACTED]\n');
  assert.equal(io.err(), 'token [REDACTED]\n');
});

test('cliIo masks credential-shaped query parameters by name', () => {
  const io = capture();
  cliIo(io.deps).err('http://127.0.0.1:8000/callback/?code=abc&state=def\n');
  assert.equal(
    io.err(),
    'http://127.0.0.1:8000/callback/?code=REDACTED&state=REDACTED\n',
  );
});

test('errRaw is the one sink that does not redact — the authorize URL', () => {
  const secret = 'cli-test-raw-sink-secret-value';
  registerSecret(secret);
  const io = capture();
  const url = `https://www.tiktok.com/v2/auth/authorize/?client_key=k&state=${secret}`;

  cliIo(io.deps).errRaw(`${url}\n`);

  // A masked authorize URL is not an authorize URL: this must come out verbatim.
  assert.equal(io.err(), `${url}\n`);
});

test('the default sinks are the real stdout and stderr, and still redact', () => {
  const secret = 'cli-test-default-sink-secret-value';
  registerSecret(secret);
  const seen: string[] = [];
  const tap =
    (tag: string) =>
    (chunk: unknown): boolean => {
      seen.push(`${tag}:${String(chunk)}`);
      return true;
    };

  // Deliberately synchronous end to end: the runner's own reporter writes to
  // these same streams, and nothing else may run while they are swapped out.
  // `write` is inherited from the stream prototype, so assigning only shadows
  // it and `delete` puts the real one back untouched.
  try {
    process.stdout.write = tap('out');
    process.stderr.write = tap('err');
    const sink = cliIo({});
    sink.out(`result ${secret}\n`);
    sink.err(`diagnostic ${secret}\n`);
    sink.errRaw(`raw ${secret}\n`);
  } finally {
    delete (process.stdout as Partial<NodeJS.WriteStream>).write;
    delete (process.stderr as Partial<NodeJS.WriteStream>).write;
  }

  // cc-g3: results go to stdout, everything else to stderr — and the wiring of
  // the two defaults is the only thing standing behind that split.
  assert.deepEqual(seen, [
    'out:result [REDACTED]\n',
    'err:diagnostic [REDACTED]\n',
    `err:raw ${secret}\n`,
  ]);
});

test('cliIo defaults isTTY to "both streams are a terminal"', () => {
  const expected = process.stdin.isTTY === true && process.stdout.isTTY === true;
  assert.equal(cliIo({}).isTTY, expected);
  assert.equal(cliIo({ isTTY: true }).isTTY, true);
  assert.equal(cliIo({ isTTY: false }).isTTY, false);
});

test('a terminal on one stream only is not interactive', () => {
  const realIn = process.stdin.isTTY;
  const realOut = process.stdout.isTTY;

  // Synchronous end to end, like the sink test above: the two flags are read
  // straight out of `process`, so nothing else may run while they are flipped.
  try {
    process.stdin.isTTY = true;
    process.stdout.isTTY = false;
    // `tiktok-mcp-ai login > out.txt` from a real terminal. A redirected stdout
    // is what says a script is driving, and a script has to get the CC-A11
    // refusal rather than a prompt nobody is there to answer.
    assert.equal(cliIo({}).isTTY, false);

    process.stdout.isTTY = true;
    assert.equal(cliIo({}).isTTY, true);

    process.stdin.isTTY = false;
    assert.equal(cliIo({}).isTTY, false);
  } finally {
    process.stdin.isTTY = realIn;
    process.stdout.isTTY = realOut;
  }
});

// ---------------------------------------------------------------------------
// env-file overlay (CC-F2)
// ---------------------------------------------------------------------------

test('cc-f2: the env file supplies keys the process environment lacks', () => {
  const merged = overlayEnvFile({}, snapshotOf({ TT_REDIRECT_PORT: '8000' }));
  assert.equal(merged['TT_REDIRECT_PORT'], '8000');
});

test('cc-f2: a key present in the process environment wins, even when empty', () => {
  const merged = overlayEnvFile(
    { TT_REDIRECT_PORT: '' },
    snapshotOf({ TT_REDIRECT_PORT: '8000' }),
  );
  // Presence-based precedence: "exported empty" is a deliberate statement.
  assert.equal(merged['TT_REDIRECT_PORT'], '');
});

test('the overlay copies — neither input is mutated', () => {
  const env: NodeJS.ProcessEnv = { TT_ACTIVE_PROFILE: 'WORK' };
  const snapshot = snapshotOf({ TT_LOGIN_SCOPES: 'user.info.basic' });

  const merged = overlayEnvFile(env, snapshot);
  merged['TT_ACTIVE_PROFILE'] = 'OTHER';

  assert.equal(env['TT_ACTIVE_PROFILE'], 'WORK');
  assert.equal(env['TT_LOGIN_SCOPES'], undefined);
  assert.equal(snapshot.values.get('TT_LOGIN_SCOPES'), 'user.info.basic');
});

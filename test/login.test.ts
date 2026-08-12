/**
 * `cli/login.ts` — the OAuth 2.0 login, revoke and their corner cases.
 *
 * Everything the flow touches is a seam: the loopback listener, the browser,
 * the prompt, `fetch`, the clock and both output streams. The only exception is
 * one test that binds the *real* `nodeListen()` on `127.0.0.1:0` and talks to
 * it over loopback — that is the only way to prove the default listener serves
 * the registered redirect shape, and it opens no socket to anything but itself.
 *
 * Corner cases covered: CC-A8 (redirect shape and port pinning), CC-A9 (exactly
 * one accepted authorization response), CC-A10 (manual paste), CC-A11
 * (overwrite confirmation).
 */

import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  type CallbackHandler,
  type CliDeps,
  type ListenFn,
} from '../src/cli/index.js';
import {
  browserCommand,
  constantTimeEquals,
  createCallbackSink,
  decodeOnce,
  journalPaths,
  loginUsage,
  nodeListen,
  parseCallbackQuery,
  parseLoginArgs,
  parsePastedRedirect,
  resolveScopes,
  runLogin,
} from '../src/cli/login.js';
import type { Logger } from '../src/core/log.js';
import { resetTokenCache } from '../src/core/oauth.js';
import { loadSettings, type Settings } from '../src/core/settings.js';
import {
  fsSandbox,
  mockClock,
  scriptFetch,
  ttEnvelope,
  withFetch,
  type MockClock,
  type RecordedCall,
  type RecordingFetchStub,
} from './helpers.js';

const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const REVOKE_URL = 'https://open.tiktokapis.com/v2/oauth/revoke/';
const USER_INFO_URL = 'https://open.tiktokapis.com/v2/user/info/?fields=display_name';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** A `Logger` that swallows everything — the CLI's own logging is not the subject. */
function silentLogger(): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  return logger;
}

interface Fixture {
  readonly dir: string;
  readonly envFile: string;
  readonly clock: MockClock;
  cleanup(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const box = await fsSandbox();
  // A login writes tokens; a leftover cache would leak into the next test.
  resetTokenCache();
  return {
    dir: box.dir,
    envFile: path.join(box.dir, '.env'),
    clock: mockClock(),
    cleanup: async () => {
      await box.cleanup();
    },
  };
}

/** The app credentials only — the "never logged in yet" starting point. */
function appEnv(f: Fixture, over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TT_ENV_FILE: f.envFile,
    TT_CLIENT_KEY: 'test-client-key',
    TT_CLIENT_SECRET: 'test-client-secret',
    ...over,
  };
}

/** Write an env file that already holds a complete DEFAULT token set. */
async function writeAuthorizedEnvFile(f: Fixture): Promise<void> {
  await writeFile(
    f.envFile,
    [
      'TT_CLIENT_KEY=test-client-key',
      'TT_CLIENT_SECRET=test-client-secret',
      'TT_ACCESS_TOKEN=act.old',
      'TT_REFRESH_TOKEN=rft.old',
      'TT_OPEN_ID=open-id-old',
      'TT_SCOPES=user.info.basic',
      'TT_TOKEN_EXPIRES_AT=2026-01-02T00:00:00.000Z',
      'TT_REFRESH_EXPIRES_AT=2027-01-01T00:00:00.000Z',
      '',
    ].join('\n'),
    'utf8',
  );
}

interface Harness {
  readonly deps: CliDeps;
  out(): string;
  err(): string;
  /** The authorize URL this run printed, parsed. Fails if nothing was printed. */
  authorizeUrl(): URL;
  /** The `state` the run generated, read back out of the printed URL. */
  state(): string;
  /** Every question the prompt seam was asked. */
  readonly questions: string[];
  /** Every URL handed to the browser seam. */
  readonly opened: string[];
}

function harness(f: Fixture, over: CliDeps = {}): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const questions: string[] = [];
  const opened: string[] = [];
  const err = (): string => stderr.join('');

  const authorizeUrl = (): URL => {
    const match = /https:\/\/\S+/.exec(err());
    assert.ok(match !== null, 'the run printed no authorize URL');
    return new URL(match[0]);
  };

  return {
    deps: {
      env: appEnv(f),
      clock: f.clock,
      logger: silentLogger(),
      isTTY: false,
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
      prompt: (question) => {
        questions.push(question);
        return Promise.resolve('');
      },
      openBrowser: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
      randomBytes: (size) => new Uint8Array(size).fill(7),
      ...over,
    },
    out: () => stdout.join(''),
    err,
    authorizeUrl,
    state: () => authorizeUrl().searchParams.get('state') ?? '',
    questions,
    opened,
  };
}

/** A `listen` seam that hands the bound handler back to the test. */
function fakeListen(port = 45_678): {
  listen: ListenFn;
  handler(): CallbackHandler;
  ports: number[];
  closed(): boolean;
} {
  let captured: CallbackHandler | undefined;
  const ports: number[] = [];
  let closed = false;
  return {
    listen: (handler, opts) => {
      captured = handler;
      ports.push(opts.port);
      return Promise.resolve({
        port: opts.port === 0 ? port : opts.port,
        close: () => {
          closed = true;
          return Promise.resolve();
        },
      });
    },
    handler: () => {
      assert.ok(captured !== undefined, 'nothing was ever bound');
      return captured;
    },
    ports,
    closed: () => closed,
  };
}

function tokenResponse(over: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      access_token: 'act.new',
      expires_in: 86_400,
      open_id: 'open-id-new',
      refresh_expires_in: 31_536_000,
      refresh_token: 'rft.new',
      scope: 'user.info.basic,video.publish',
      token_type: 'Bearer',
      ...over,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function form(call: RecordedCall): URLSearchParams {
  return new URLSearchParams(call.text());
}

function settingsOf(env: NodeJS.ProcessEnv): Settings {
  return loadSettings(env);
}

/**
 * Let the event loop turn until the consent URL has been printed.
 *
 * Not a sleep: `setImmediate` yields a macrotask so the awaited file reads in
 * `resolveContext` can land. A test that needs *time* to pass uses
 * `clock.advance` (determinism rule 1) — nothing here does.
 */
async function untilAuthorized(h: Harness): Promise<string> {
  for (let turn = 0; turn < 500; turn += 1) {
    if (/https:\/\/\S+/.test(h.err())) return h.state();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('the authorize URL was never printed');
}

/**
 * Run a login that is completed by the browser seam: as soon as the CLI opens
 * the consent URL, the callback the browser would have made is delivered.
 */
async function loginWithCallback(
  f: Fixture,
  stub: RecordingFetchStub,
  over: CliDeps = {},
  query: (state: string) => string = (state) => `code=the-code&state=${state}`,
): Promise<{ code: number; h: Harness }> {
  const listener = fakeListen();
  const h: Harness = harness(f, {
    listen: listener.listen,
    openBrowser: (url) => {
      h.opened.push(url);
      const state = new URL(url).searchParams.get('state') ?? '';
      listener.handler()({ method: 'GET', url: `/callback/?${query(state)}` });
      return Promise.resolve();
    },
    ...over,
  });
  const code = await withFetch(stub, async () => await runLogin(h.deps));
  assert.equal(listener.closed(), true, 'the listener was not closed');
  return { code, h };
}

// ---------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------

test('the flags parse in both --flag value and --flag=value form', () => {
  const spaced = parseLoginArgs(['--profile', 'work', '--scopes', 'a,b']);
  assert.ok(spaced.ok);
  assert.equal(spaced.flags.profile, 'work');
  assert.deepEqual(spaced.flags.scopes, ['a', 'b']);

  const inline = parseLoginArgs(['--profile=work', '--scopes=a,b']);
  assert.ok(inline.ok);
  assert.equal(inline.flags.profile, 'work');
  assert.deepEqual(inline.flags.scopes, ['a', 'b']);
});

test('the boolean flags are recognized', () => {
  const parsed = parseLoginArgs([
    '--force',
    '--manual',
    '--no-browser',
    '--revoke',
    '--purge-journal',
  ]);
  assert.ok(parsed.ok);
  assert.deepEqual(
    {
      force: parsed.flags.force,
      manual: parsed.flags.manual,
      noBrowser: parsed.flags.noBrowser,
      revoke: parsed.flags.revoke,
      purgeJournal: parsed.flags.purgeJournal,
    },
    { force: true, manual: true, noBrowser: true, revoke: true, purgeJournal: true },
  );
});

test('an unknown option is an error rather than something ignored', () => {
  const parsed = parseLoginArgs(['--scoops', 'a']);
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? '' : parsed.message, /Unknown option "--scoops"/);
});

test('a value flag without a value, and a boolean flag with one, both fail', () => {
  const missing = parseLoginArgs(['--profile']);
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? '' : missing.message, /--profile needs a value/);

  const extra = parseLoginArgs(['--force=yes']);
  assert.equal(extra.ok, false);
  assert.match(extra.ok ? '' : extra.message, /--force does not take a value/);
});

test('--purge-journal without --revoke is rejected', async () => {
  const f = await fixture();
  try {
    const h = harness(f, { argv: ['--purge-journal'] });
    assert.equal(await runLogin(h.deps), EXIT_USAGE);
    assert.match(h.err(), /--purge-journal only applies together with --revoke/);
    assert.match(h.err(), /Usage: tiktok-mcp-ai login/);
    assert.equal(h.out(), '');
  } finally {
    await f.cleanup();
  }
});

test('--help prints the login usage on stdout', async () => {
  const f = await fixture();
  try {
    const h = harness(f, { argv: ['--help'] });
    assert.equal(await runLogin(h.deps), EXIT_OK);
    assert.equal(h.out(), loginUsage());
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// scope selection (AUTH.md § 2)
// ---------------------------------------------------------------------------

test('the default scope set is derived from the enabled packages', () => {
  assert.deepEqual(resolveScopes({}, settingsOf({})), [
    'user.info.basic',
    'user.info.profile',
    'user.info.stats',
    'video.list',
    'video.publish',
  ]);
});

test('TT_TOOL_PACKAGES narrows the derived scopes', () => {
  assert.deepEqual(resolveScopes({}, settingsOf({ TT_TOOL_PACKAGES: 'video' })), [
    'video.list',
  ]);
  assert.deepEqual(resolveScopes({}, settingsOf({ TT_TOOL_PACKAGES: 'all' })), [
    'user.info.basic',
    'user.info.profile',
    'user.info.stats',
    'video.list',
    'video.publish',
    'video.upload',
  ]);
});

test('TT_LOGIN_SCOPES overrides the derivation, and --scopes overrides both', () => {
  const settings = settingsOf({ TT_LOGIN_SCOPES: 'video.list,user.info.basic' });
  assert.deepEqual(resolveScopes({}, settings), ['user.info.basic', 'video.list']);
  assert.deepEqual(resolveScopes({ scopes: ['video.publish'] }, settings), [
    'video.publish',
  ]);
});

test('a package set that needs no scopes is refused instead of asking for nothing', () => {
  assert.throws(() => resolveScopes({}, settingsOf({ TT_TOOL_PACKAGES: 'auth' })), {
    code: 'no_scopes_selected',
  });
});

// ---------------------------------------------------------------------------
// the callback listener (CC-A8 / CC-A9)
// ---------------------------------------------------------------------------

test('cc-a8: the redirect_uri is the registered loopback shape, trailing slash included', async () => {
  const f = await fixture();
  try {
    const stub = scriptFetch([
      tokenResponse(),
      ttEnvelope({ user: { display_name: 'Ivan' } }),
    ]);
    const { code, h } = await loginWithCallback(f, stub);
    assert.equal(code, EXIT_OK);

    const redirect = h.authorizeUrl().searchParams.get('redirect_uri');
    assert.equal(redirect, 'http://127.0.0.1:45678/callback/');

    // Byte-identical in the exchange, or TikTok rejects it (AUTH.md § 1.1).
    const exchange = stub.calls[0] as RecordedCall;
    assert.equal(exchange.url, TOKEN_URL);
    assert.equal(form(exchange).get('redirect_uri'), redirect);
  } finally {
    await f.cleanup();
  }
});

test('cc-a8: with no pin the listener asks for an ephemeral port', async () => {
  const f = await fixture();
  try {
    const listener = fakeListen();
    const h = harness(f, {
      listen: listener.listen,
      openBrowser: (url) => {
        const state = new URL(url).searchParams.get('state') ?? '';
        listener.handler()({ method: 'GET', url: `/callback/?code=c&state=${state}` });
        return Promise.resolve();
      },
    });
    await withFetch(
      scriptFetch([tokenResponse(), ttEnvelope({ user: {} })]),
      async () => await runLogin(h.deps),
    );
    assert.deepEqual(listener.ports, [0]);
  } finally {
    await f.cleanup();
  }
});

test('cc-a8: TT_REDIRECT_PORT is honoured as a pin', async () => {
  const f = await fixture();
  try {
    const listener = fakeListen();
    const h = harness(f, {
      env: appEnv(f, { TT_REDIRECT_PORT: '8123' }),
      listen: listener.listen,
      openBrowser: (url) => {
        const state = new URL(url).searchParams.get('state') ?? '';
        listener.handler()({ method: 'GET', url: `/callback/?code=c&state=${state}` });
        return Promise.resolve();
      },
    });
    await withFetch(
      scriptFetch([tokenResponse(), ttEnvelope({ user: {} })]),
      async () => await runLogin(h.deps),
    );
    assert.deepEqual(listener.ports, [8123]);
    assert.equal(
      h.authorizeUrl().searchParams.get('redirect_uri'),
      'http://127.0.0.1:8123/callback/',
    );
  } finally {
    await f.cleanup();
  }
});

test('cc-a8: a busy pinned port names TT_REDIRECT_PORT and offers manual paste', async () => {
  const f = await fixture();
  try {
    const stub = scriptFetch([]);
    const h = harness(f, {
      env: appEnv(f, { TT_REDIRECT_PORT: '8123' }),
      listen: () => Promise.reject(new Error('EADDRINUSE 127.0.0.1:8123')),
    });
    const code = await withFetch(stub, async () => await runLogin(h.deps));

    assert.equal(code, EXIT_FAILURE);
    assert.match(h.err(), /TT_REDIRECT_PORT/);
    assert.match(h.err(), /--manual/);
    // The pin is a promise: no other port is bound behind the user's back.
    assert.match(h.err(), /8123/);
    assert.equal(stub.calls.length, 0);
    assert.equal(h.out(), '');
  } finally {
    await f.cleanup();
  }
});

test('cc-a8: with no pin a bind failure degrades to manual paste', async () => {
  const f = await fixture();
  try {
    const stub = scriptFetch([tokenResponse(), ttEnvelope({ user: {} })]);
    const h: Harness = harness(f, {
      listen: () => Promise.reject(new Error('EPERM')),
      prompt: (question) => {
        h.questions.push(question);
        return Promise.resolve(
          `http://127.0.0.1:8000/callback/?code=pasted-code&state=${h.state()}`,
        );
      },
    });
    const code = await withFetch(stub, async () => await runLogin(h.deps));

    assert.equal(code, EXIT_OK);
    assert.match(h.err(), /falling back to manual paste/);
    // No listener means the printed redirect_uri is the fixed fallback port.
    assert.equal(
      h.authorizeUrl().searchParams.get('redirect_uri'),
      'http://127.0.0.1:8000/callback/',
    );
    assert.equal(form(stub.calls[0] as RecordedCall).get('code'), 'pasted-code');
  } finally {
    await f.cleanup();
  }
});

test('cc-a8: --manual never binds a port at all', async () => {
  const f = await fixture();
  try {
    const stub = scriptFetch([tokenResponse(), ttEnvelope({ user: {} })]);
    const h: Harness = harness(f, {
      argv: ['--manual'],
      listen: () => assert.fail('--manual must not bind a listener'),
      prompt: (question) => {
        h.questions.push(question);
        return Promise.resolve('pasted-code');
      },
    });
    assert.equal(await withFetch(stub, async () => await runLogin(h.deps)), EXIT_OK);
    assert.equal(h.opened.length, 0, '--manual must not open a browser');
    assert.match(h.questions.join(''), /Paste/);
  } finally {
    await f.cleanup();
  }
});

test('--no-browser prints the URL and opens nothing', async () => {
  const f = await fixture();
  try {
    const listener = fakeListen();
    const h = harness(f, { argv: ['--no-browser'], listen: listener.listen });
    const stub = scriptFetch([tokenResponse(), ttEnvelope({ user: {} })]);

    const running = withFetch(stub, async () => await runLogin(h.deps));
    const state = await untilAuthorized(h);
    listener.handler()({ method: 'GET', url: `/callback/?code=c&state=${state}` });

    assert.equal(await running, EXIT_OK);
    assert.equal(h.opened.length, 0);
    assert.match(h.err(), /Open this URL to authorize/);
  } finally {
    await f.cleanup();
  }
});

test('cc-a8: the default listener binds an ephemeral loopback port and serves the callback', async () => {
  const sink = createCallbackSink();
  sink.arm('the-state');
  const server = await nodeListen()(sink.handler, { host: '127.0.0.1', port: 0 });
  try {
    assert.ok(server.port > 0, 'port 0 must resolve to a real ephemeral port');
    const res = await fetch(
      `http://127.0.0.1:${String(server.port)}/callback/?code=abc&state=the-state`,
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.deepEqual(await sink.received, { ok: true, code: 'abc' });
  } finally {
    await server.close();
  }
});

test('cc-a9: a second callback hit is not exchanged', async () => {
  const sink = createCallbackSink();
  sink.arm('the-state');

  const first = sink.handler({
    method: 'GET',
    url: '/callback/?code=first&state=the-state',
  });
  const second = sink.handler({
    method: 'GET',
    url: '/callback/?code=second&state=the-state',
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.match(second.body, /already/i);
  // The promise settles once, with the first response only.
  assert.deepEqual(await sink.received, { ok: true, code: 'first' });
});

test('cc-a9: a failed callback still consumes the one accepted response', async () => {
  const sink = createCallbackSink();
  sink.arm('the-state');

  const bad = sink.handler({ method: 'GET', url: '/callback/?code=c&state=other' });
  const retry = sink.handler({
    method: 'GET',
    url: '/callback/?code=c&state=the-state',
  });

  assert.equal(bad.status, 400);
  assert.match(retry.body, /already/i);
  const result = await sink.received;
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.message, /state does not match/);
});

test('cc-a9: the state is compared in constant time', () => {
  assert.equal(constantTimeEquals('abcdef', 'abcdef'), true);
  assert.equal(constantTimeEquals('abcdef', 'abcdeg'), false);
  // Different lengths must not throw (timingSafeEqual requires equal lengths).
  assert.equal(constantTimeEquals('abc', 'abcdef'), false);
  assert.equal(constantTimeEquals('', ''), true);
});

test('cc-a9: a redirect that arrives before the login armed it is refused', async () => {
  const sink = createCallbackSink();
  const reply = sink.handler({ method: 'GET', url: '/callback/?code=c&state=s' });
  assert.equal(reply.status, 400);
  const result = await sink.received;
  assert.equal(result.ok, false);
});

test('the callback server answers only GET, and only on the callback path', () => {
  const sink = createCallbackSink();
  sink.arm('the-state');

  assert.equal(sink.handler({ method: 'GET', url: '/favicon.ico' }).status, 404);
  assert.equal(sink.handler({ method: 'POST', url: '/callback/' }).status, 405);
  // Neither of those consumed the single accepted response.
  assert.equal(
    sink.handler({ method: 'GET', url: '/callback/?code=c&state=the-state' }).status,
    200,
  );
});

test('the callback pages never echo what upstream sent', () => {
  const sink = createCallbackSink();
  sink.arm('the-state');
  const reply = sink.handler({
    method: 'GET',
    url: '/callback/?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
  });
  assert.equal(reply.status, 400);
  assert.equal(reply.body.includes('<script>'), false);
});

test('an upstream error in the redirect is reported with a sanitized code', () => {
  const denied = parseCallbackQuery(
    new URLSearchParams('error=access_denied&error_description=<b>no</b>'),
    'the-state',
    true,
  );
  assert.equal(denied.ok, false);
  assert.match(denied.ok ? '' : denied.message, /access_denied/);
  assert.equal(denied.ok ? '' : denied.message.includes('<b>'), false);
});

test('a callback without a state or without a code is refused', () => {
  const noState = parseCallbackQuery(new URLSearchParams('code=c'), 'the-state', true);
  assert.equal(noState.ok, false);
  assert.match(noState.ok ? '' : noState.message, /no state parameter/);

  const noCode = parseCallbackQuery(
    new URLSearchParams('state=the-state'),
    'the-state',
    true,
  );
  assert.equal(noCode.ok, false);
  assert.match(noCode.ok ? '' : noCode.message, /no authorization code/);
});

// ---------------------------------------------------------------------------
// manual paste (CC-A10)
// ---------------------------------------------------------------------------

test('cc-a10: a full redirect URL is accepted', () => {
  const result = parsePastedRedirect(
    '  http://127.0.0.1:8000/callback/?code=abc123&state=the-state  ',
    'the-state',
  );
  assert.deepEqual(result, { ok: true, code: 'abc123' });
});

test('cc-a10: a bare code is accepted', () => {
  assert.deepEqual(parsePastedRedirect('abc123', 'the-state'), {
    ok: true,
    code: 'abc123',
  });
});

test('cc-a10: a pasted URL carrying a wrong state is refused', () => {
  const result = parsePastedRedirect(
    'http://127.0.0.1:8000/callback/?code=abc&state=someone-elses',
    'the-state',
  );
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.message, /state does not match/);
});

test('cc-a10: a pasted URL with no state at all is still accepted', () => {
  // The user vouching for the paste is the trust anchor when there is nothing
  // to compare against; a *present* state is always compared (test above).
  assert.deepEqual(
    parsePastedRedirect('http://127.0.0.1:8000/callback/?code=abc', 'the-state'),
    { ok: true, code: 'abc' },
  );
});

test('cc-a10: a bare code is percent-decoded exactly once', () => {
  assert.deepEqual(parsePastedRedirect('abc%2A', 'the-state'), {
    ok: true,
    code: 'abc*',
  });
  // Already decoded: a code that legitimately contains `%` is not corrupted.
  assert.equal(decodeOnce('abc*'), 'abc*');
  assert.equal(decodeOnce('100%'), '100%');
  assert.equal(decodeOnce('%zz'), '%zz');
});

test('cc-a10: neither a URL nor a bare code is refused with both shapes named', () => {
  const junk = parsePastedRedirect('code=abc&state=s', 'the-state');
  assert.equal(junk.ok, false);
  assert.match(junk.ok ? '' : junk.message, /neither a redirect URL nor a bare code/);

  const empty = parsePastedRedirect('   ', 'the-state');
  assert.equal(empty.ok, false);
  assert.match(empty.ok ? '' : empty.message, /Nothing was pasted/);

  const broken = parsePastedRedirect('http://[::/callback', 'the-state');
  assert.equal(broken.ok, false);
  assert.match(broken.ok ? '' : broken.message, /not a valid URL/);
});

test('cc-a10: a paste the user gets wrong ends the login with exit code 1', async () => {
  const f = await fixture();
  try {
    const stub = scriptFetch([]);
    const h = harness(f, {
      argv: ['--manual'],
      prompt: () =>
        Promise.resolve('http://127.0.0.1:8000/callback/?error=access_denied'),
    });
    assert.equal(await withFetch(stub, async () => await runLogin(h.deps)), EXIT_FAILURE);
    assert.equal(stub.calls.length, 0, 'a refused paste must not be exchanged');
    assert.match(h.err(), /access_denied/);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// overwrite confirmation (CC-A11)
// ---------------------------------------------------------------------------

test('cc-a11: existing credentials without a TTY need --force', async () => {
  const f = await fixture();
  try {
    await writeAuthorizedEnvFile(f);
    const stub = scriptFetch([]);
    const h = harness(f, { isTTY: false });

    assert.equal(await withFetch(stub, async () => await runLogin(h.deps)), EXIT_FAILURE);
    assert.match(h.err(), /--force/);
    // The account being replaced is named, so the user can tell it is not theirs.
    assert.match(h.err(), /open_id open-id-old/);
    assert.match(h.err(), /user\.info\.basic/);
    assert.equal(stub.calls.length, 0);
    assert.equal(h.out(), '');
  } finally {
    await f.cleanup();
  }
});

test('cc-a11: a TTY is asked, and "no" changes nothing', async () => {
  const f = await fixture();
  try {
    await writeAuthorizedEnvFile(f);
    const before = await readFile(f.envFile, 'utf8');
    const stub = scriptFetch([]);
    const h = harness(f, { isTTY: true });

    assert.equal(await withFetch(stub, async () => await runLogin(h.deps)), EXIT_FAILURE);
    assert.match(h.questions.join(''), /Replace the credentials of profile DEFAULT/);
    assert.match(h.questions.join(''), /open_id open-id-old/);
    assert.match(h.err(), /Aborted/);
    assert.equal(await readFile(f.envFile, 'utf8'), before);
    assert.equal(stub.calls.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('cc-a11: "yes" proceeds with the login', async () => {
  const f = await fixture();
  try {
    await writeAuthorizedEnvFile(f);
    const stub = scriptFetch([tokenResponse(), ttEnvelope({ user: {} })]);
    const { code, h } = await loginWithCallback(f, stub, {
      isTTY: true,
      prompt: () => Promise.resolve('y'),
    });
    assert.equal(code, EXIT_OK);
    assert.match(await readFile(f.envFile, 'utf8'), /TT_ACCESS_TOKEN=act\.new/);
    assert.match(h.out(), /Authorized profile DEFAULT/);
  } finally {
    await f.cleanup();
  }
});

test('cc-a11: --force replaces without asking', async () => {
  const f = await fixture();
  try {
    await writeAuthorizedEnvFile(f);
    const stub = scriptFetch([tokenResponse(), ttEnvelope({ user: {} })]);
    const { code, h } = await loginWithCallback(f, stub, {
      argv: ['--force'],
      isTTY: true,
    });
    assert.equal(code, EXIT_OK);
    assert.deepEqual(h.questions, []);
  } finally {
    await f.cleanup();
  }
});

test('cc-a11: a profile that holds nothing yet is never confirmed', async () => {
  const f = await fixture();
  try {
    const stub = scriptFetch([tokenResponse(), ttEnvelope({ user: {} })]);
    const { code, h } = await loginWithCallback(f, stub, { isTTY: true });
    assert.equal(code, EXIT_OK);
    assert.deepEqual(h.questions, []);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// the happy path
// ---------------------------------------------------------------------------

test('a successful login exchanges the code and writes the token set', async () => {
  const f = await fixture();
  try {
    const stub = scriptFetch([
      tokenResponse(),
      ttEnvelope({ user: { display_name: 'Ivan' } }),
    ]);
    const { code, h } = await loginWithCallback(f, stub, {
      argv: ['--scopes', 'user.info.basic,video.publish'],
    });
    assert.equal(code, EXIT_OK);

    const exchange = stub.calls[0] as RecordedCall;
    assert.equal(exchange.method, 'POST');
    assert.equal(exchange.url, TOKEN_URL);
    const body = form(exchange);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'the-code');
    assert.equal(body.get('client_key'), 'test-client-key');
    assert.ok((body.get('code_verifier') ?? '').length > 0);

    // The display-name probe is the second and last call.
    assert.equal(stub.calls.length, 2);
    assert.equal((stub.calls[1] as RecordedCall).url, USER_INFO_URL);

    const written = await readFile(f.envFile, 'utf8');
    assert.match(written, /TT_ACCESS_TOKEN=act\.new/);
    assert.match(written, /TT_REFRESH_TOKEN=rft\.new/);
    assert.match(written, /TT_OPEN_ID=open-id-new/);

    assert.match(h.out(), /Authorized profile DEFAULT\./);
    assert.match(h.out(), /Ivan \(open_id open-id-new\)/);
    assert.match(h.out(), /granted scopes: user\.info\.basic, video\.publish/);
    assert.match(h.out(), new RegExp(f.envFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await f.cleanup();
  }
});

test('the consent URL carries the PKCE challenge and every requested scope', async () => {
  const f = await fixture();
  try {
    const stub = scriptFetch([tokenResponse(), ttEnvelope({ user: {} })]);
    const { h } = await loginWithCallback(f, stub, {
      argv: ['--scopes', 'user.info.basic,video.publish'],
    });
    const url = h.authorizeUrl();

    assert.equal(url.origin, 'https://www.tiktok.com');
    assert.equal(url.searchParams.get('client_key'), 'test-client-key');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('scope'), 'user.info.basic,video.publish');
    assert.ok((url.searchParams.get('code_challenge') ?? '').length > 0);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    // The URL the browser gets is the URL the user was shown.
    assert.deepEqual(h.opened, [url.toString()]);
  } finally {
    await f.cleanup();
  }
});

test('no secret ever reaches either stream', async () => {
  const f = await fixture();
  try {
    const stub = scriptFetch([tokenResponse(), ttEnvelope({ user: {} })]);
    const { h } = await loginWithCallback(f, stub);
    const printed = h.out() + h.err();

    for (const secret of ['act.new', 'rft.new', 'the-code']) {
      assert.equal(printed.includes(secret), false, `${secret} was printed`);
    }
  } finally {
    await f.cleanup();
  }
});

test('a partial grant is reported rather than treated as a failure', async () => {
  const f = await fixture();
  try {
    const stub = scriptFetch([
      tokenResponse({ scope: 'user.info.basic' }),
      ttEnvelope({ user: {} }),
    ]);
    const { code, h } = await loginWithCallback(f, stub, {
      argv: ['--scopes', 'user.info.basic,video.publish'],
    });
    assert.equal(code, EXIT_OK);
    assert.match(h.out(), /not granted: +video\.publish/);
    assert.match(h.out(), /A partial grant is normal/);
  } finally {
    await f.cleanup();
  }
});

test('the summary reports which tool packages the grant enables', async () => {
  const f = await fixture();
  try {
    const stub = scriptFetch([
      tokenResponse({ scope: 'user.info.basic,video.publish' }),
      ttEnvelope({ user: {} }),
    ]);
    const { code, h } = await loginWithCallback(f, stub, {
      argv: ['--scopes', 'user.info.basic,video.publish'],
    });
    assert.equal(code, EXIT_OK);

    // The default `core` selection — and each package is judged against what
    // was granted, not against what was asked for.
    assert.match(h.out(), /tool packages:/);
    assert.match(h.out(), /auth +ready/);
    assert.match(h.out(), /publish +ready/);
    assert.match(h.out(), /user +needs user\.info\.profile, user\.info\.stats/);
    assert.match(h.out(), /video +needs video\.list/);
    // `publish-write` is not served by default, so it is not a gap either.
    assert.equal(h.out().includes('publish-write'), false);
  } finally {
    await f.cleanup();
  }
});

test('the package report follows the enabled set, not the whole catalogue', async () => {
  const f = await fixture();
  try {
    const stub = scriptFetch([
      tokenResponse({ scope: 'user.info.basic,user.info.profile,user.info.stats' }),
      ttEnvelope({ user: {} }),
    ]);
    const { code, h } = await loginWithCallback(f, stub, {
      env: appEnv(f, { TT_TOOL_PACKAGES: 'user' }),
    });
    assert.equal(code, EXIT_OK);
    assert.match(h.out(), /tool packages:\n +user +ready/);
    assert.equal(h.out().includes('video'), false);
  } finally {
    await f.cleanup();
  }
});

test('a failed display-name probe costs the summary a name and nothing else', async () => {
  const f = await fixture();
  try {
    const stub = scriptFetch([
      tokenResponse(),
      ttEnvelope(null, { code: 'access_token_invalid', message: 'nope' }),
    ]);
    const { code, h } = await loginWithCallback(f, stub);
    assert.equal(code, EXIT_OK);
    assert.match(h.out(), /account: +open_id open-id-new/);
  } finally {
    await f.cleanup();
  }
});

test('the probe is skipped when the grant has no user.info.basic', async () => {
  const f = await fixture();
  try {
    const stub = scriptFetch([tokenResponse({ scope: 'video.publish' })]);
    const { code } = await loginWithCallback(f, stub, {
      argv: ['--scopes', 'video.publish'],
    });
    assert.equal(code, EXIT_OK);
    assert.equal(stub.calls.length, 1, 'no probe without user.info.basic');
  } finally {
    await f.cleanup();
  }
});

test('a rejected exchange fails the login and writes nothing', async () => {
  const f = await fixture();
  try {
    const stub = scriptFetch([
      new Response(JSON.stringify({ error: 'invalid_grant', log_id: 'x' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const { code, h } = await loginWithCallback(f, stub);
    assert.equal(code, EXIT_FAILURE);
    assert.equal(h.out(), '');
    await assert.rejects(stat(f.envFile));
  } finally {
    await f.cleanup();
  }
});

test('--profile authorizes a named profile and leaves DEFAULT alone', async () => {
  const f = await fixture();
  try {
    await writeAuthorizedEnvFile(f);
    const stub = scriptFetch([tokenResponse(), ttEnvelope({ user: {} })]);
    const { code, h } = await loginWithCallback(f, stub, {
      argv: ['--profile', 'work'],
    });
    assert.equal(code, EXIT_OK);
    assert.match(h.out(), /Authorized profile WORK/);

    const written = await readFile(f.envFile, 'utf8');
    assert.match(written, /TT_PROFILE_WORK_ACCESS_TOKEN=act\.new/);
    assert.match(written, /^TT_ACCESS_TOKEN=act\.old$/m);
  } finally {
    await f.cleanup();
  }
});

test('a missing client key fails before any browser is opened', async () => {
  const f = await fixture();
  try {
    const stub = scriptFetch([]);
    const h = harness(f, { env: { TT_ENV_FILE: f.envFile } });
    assert.equal(await withFetch(stub, async () => await runLogin(h.deps)), EXIT_FAILURE);
    assert.deepEqual(h.opened, []);
    assert.equal(stub.calls.length, 0);
    assert.equal(h.out(), '');
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// revoke (AUTH.md § 4)
// ---------------------------------------------------------------------------

test('--revoke clears the tokens but keeps the journal', async () => {
  const f = await fixture();
  try {
    await writeAuthorizedEnvFile(f);
    const journal = path.join(f.dir, 'journal.ndjson');
    await writeFile(journal, '{"kind":"publish"}\n', 'utf8');

    const stub = scriptFetch([
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const h = harness(f, { argv: ['--revoke'] });
    assert.equal(await withFetch(stub, async () => await runLogin(h.deps)), EXIT_OK);

    assert.equal((stub.calls[0] as RecordedCall).url, REVOKE_URL);
    assert.equal(form(stub.calls[0] as RecordedCall).get('token'), 'act.old');

    const written = await readFile(f.envFile, 'utf8');
    assert.equal(written.includes('act.old'), false);
    // The journal is publish history, not a credential (TOOLS.md § 2).
    assert.equal((await stat(journal)).isFile(), true);
    assert.match(h.out(), /journal was kept/);
    assert.match(h.out(), /--purge-journal/);
  } finally {
    await f.cleanup();
  }
});

test('--revoke --purge-journal deletes the journal and its rotation', async () => {
  const f = await fixture();
  try {
    await writeAuthorizedEnvFile(f);
    const [current, rotated] = journalPaths(f.envFile) as [string, string];
    await writeFile(current, '{}\n', 'utf8');
    await writeFile(rotated, '{}\n', 'utf8');

    const stub = scriptFetch([
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const h = harness(f, { argv: ['--revoke', '--purge-journal'] });
    assert.equal(await withFetch(stub, async () => await runLogin(h.deps)), EXIT_OK);

    await assert.rejects(stat(current));
    await assert.rejects(stat(rotated));
    assert.match(h.out(), /Purged the publish journal/);
  } finally {
    await f.cleanup();
  }
});

test('--revoke --purge-journal says so when there was no journal', async () => {
  const f = await fixture();
  try {
    await writeAuthorizedEnvFile(f);
    const stub = scriptFetch([
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const h = harness(f, { argv: ['--revoke', '--purge-journal'] });
    assert.equal(await withFetch(stub, async () => await runLogin(h.deps)), EXIT_OK);
    assert.match(h.out(), /No publish journal was found/);
  } finally {
    await f.cleanup();
  }
});

test('the journal is a sibling of the env file', () => {
  assert.deepEqual(journalPaths('/tmp/box/.env'), [
    path.join('/tmp/box', 'journal.ndjson'),
    path.join('/tmp/box', 'journal.ndjson.1'),
  ]);
});

// ---------------------------------------------------------------------------
// browser
// ---------------------------------------------------------------------------

test('the browser command is the platform opener', () => {
  assert.deepEqual(browserCommand('https://x/', 'darwin'), {
    command: 'open',
    args: ['https://x/'],
  });
  assert.deepEqual(browserCommand('https://x/', 'win32'), {
    command: 'cmd',
    args: ['/c', 'start', '', 'https://x/'],
  });
  assert.deepEqual(browserCommand('https://x/', 'linux'), {
    command: 'xdg-open',
    args: ['https://x/'],
  });
});

test('a browser that cannot be opened is not fatal', async () => {
  const f = await fixture();
  try {
    const listener = fakeListen();
    const h = harness(f, {
      listen: listener.listen,
      openBrowser: (url) => {
        const state = new URL(url).searchParams.get('state') ?? '';
        listener.handler()({ method: 'GET', url: `/callback/?code=c&state=${state}` });
        return Promise.reject(new Error('no display'));
      },
    });
    const stub = scriptFetch([tokenResponse(), ttEnvelope({ user: {} })]);
    assert.equal(await withFetch(stub, async () => await runLogin(h.deps)), EXIT_OK);
    assert.match(h.err(), /open the URL above by hand/);
  } finally {
    await f.cleanup();
  }
});

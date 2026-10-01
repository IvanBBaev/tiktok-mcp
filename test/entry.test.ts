/**
 * `src/index.ts` — the process entry, run as a real child.
 *
 * The entry is outside the coverage map (it owns `process.argv`, the signal
 * handlers and the exit code), so what is asserted here is behaviour only: the
 * wiring between the credential store and the MCP surface that no module test
 * can see, because it lives in the entry itself.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fsSandbox } from './helpers.js';

interface Frame {
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string };
}

test('a credential store that turns unreadable lists the scoped tools as unavailable instead of failing tools/list', async () => {
  const sandbox = await fsSandbox();
  try {
    const envFile = join(sandbox.dir, 'config', '.env');
    const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
    const child = spawn(process.execPath, [entry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // A clean environment: the parent's own TT_* settings and credentials
      // must not reach the server under test.
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: sandbox.dir,
        TT_ENV_FILE: envFile,
        TT_LOG_LEVEL: 'debug',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));

    const exited = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`the entry did not finish in time; stderr: ${stderr}`));
      }, 20_000);
      timer.unref();
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    // The store starts absent (a readable "no profiles yet"), so the server
    // starts; only then does it become a directory, which cannot be read.
    await new Promise<void>((resolve) => {
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.includes('serving MCP on stdio')) resolve();
      });
    });
    await mkdir(envFile, { recursive: true });

    // Answers are matched by id: the server handles requests concurrently, so
    // `resources/list` may answer before `tools/list`, and a list_changed
    // notification (no id) may land between them.
    const frames = new Promise<Map<number, Frame>>((resolve) => {
      child.stdout.on('data', () => {
        const byId = new Map<number, Frame>();
        for (const line of stdout.split('\n')) {
          if (line.trim() === '') continue;
          const frame = JSON.parse(line) as Frame;
          if (frame.id !== undefined) byId.set(frame.id, frame);
        }
        if (byId.size >= 3 && !child.stdin.writableEnded) {
          child.stdin.end();
          resolve(byId);
        }
      });
    });
    for (const request of [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'entry-test', version: '0.0.0' },
        },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'resources/list' },
    ]) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    }

    const answers = await frames;
    const [initialized, tools, resources] = [
      answers.get(1),
      answers.get(2),
      answers.get(3),
    ];
    assert.equal(await exited, 0, stderr);
    assert.equal(initialized?.id, 1);
    assert.equal(tools?.id, 2);
    assert.equal(tools?.error, undefined, JSON.stringify(tools?.error));
    const listed = (tools?.result?.['tools'] ?? []) as {
      name: string;
      description?: string;
    }[];
    const described = new Map(listed.map((tool) => [tool.name, tool.description ?? '']));
    // No profile could be read, so every scoped tool reads as unavailable; the
    // status tool needs no scope and stays usable, to say what went wrong.
    assert.match(described.get('tiktok_list_videos') ?? '', /^\[UNAVAILABLE/);
    assert.doesNotMatch(described.get('tiktok_auth_status') ?? '', /^\[UNAVAILABLE/);
    assert.equal(resources?.id, 3);
    assert.equal(resources?.error, undefined, JSON.stringify(resources?.error));
    // Nothing names the file's path; only the operator's log carries it.
    assert.ok(!JSON.stringify(tools).includes(envFile));
  } finally {
    await sandbox.cleanup();
  }
});

/** A port the OS just handed out and released, for a child that needs `TT_PORT`. */
function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

test('TT_HTTP_INSECURE on a loopback bind starts the http server without either insecure warning', async () => {
  const sandbox = await fsSandbox();
  try {
    const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
    const child = spawn(process.execPath, [entry], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: sandbox.dir,
        TT_ENV_FILE: join(sandbox.dir, 'config', '.env'),
        TT_LOG_LEVEL: 'debug',
        TT_TRANSPORT: 'http',
        TT_HTTP_HOST: '127.0.0.1',
        TT_HTTP_INSECURE: '1',
        TT_HTTP_TOKEN: 'entry-test-http-token-0123456789',
        TT_PORT: String(await freePort()),
      },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`the entry did not finish in time; stderr: ${stderr}`));
        }, 20_000);
        timer.unref();
        child.on('error', reject);
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      },
    );
    const serving = new Promise<void>((resolve, reject) => {
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.includes('serving MCP over http')) resolve();
      });
      child.on('close', () => {
        reject(new Error(`the entry exited before serving; stderr: ${stderr}`));
      });
    });

    await serving;
    child.kill('SIGTERM');
    // win32 has no signals to deliver: `kill` there is TerminateProcess whatever
    // the name, so the child never runs its SIGTERM handler and the close
    // reports the signal instead of an exit code. The graceful drain is only
    // observable on POSIX; on win32 the assertion is that nothing else killed it.
    const { code, signal } = await exited;
    if (process.platform === 'win32') {
      assert.deepEqual({ code, signal }, { code: null, signal: 'SIGTERM' }, stderr);
    } else {
      assert.equal(code, 0, stderr);
    }
    // The startup line is the proof the warnings had their chance: both are
    // logged after the bind and before it.
    assert.match(stderr, /serving MCP over http/);
    assert.doesNotMatch(stderr, /TT_HTTP_INSECURE=1/);
    assert.doesNotMatch(stderr, /TT_HTTP_ALLOWED_HOSTS is unset/);
    assert.ok(!stderr.includes('entry-test-http-token-0123456789'));
  } finally {
    await sandbox.cleanup();
  }
});

/** A profile record with a token that is good for decades of real time. */
function storeWith(accessToken: string): string {
  return [
    'TT_CLIENT_KEY=entry-test-client-key',
    'TT_CLIENT_SECRET=entry-test-client-secret',
    `TT_ACCESS_TOKEN=${accessToken}`,
    'TT_REFRESH_TOKEN=entry-test-refresh-token',
    'TT_SCOPES=user.info.basic',
    'TT_TOKEN_EXPIRES_AT=2099-01-01T00:00:00.000Z',
    'TT_REFRESH_EXPIRES_AT=2099-01-01T00:00:00.000Z',
    '',
  ].join('\n');
}

test('a token rotated in the env file after startup is the one later tool calls send', async () => {
  const sandbox = await fsSandbox();
  try {
    const configDir = join(sandbox.dir, 'config');
    const envFile = join(configDir, '.env');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(envFile, storeWith('entry-token-at-startup'), { mode: 0o600 });

    // The child's network is a preloaded `fetch` that records the bearer it was
    // handed and answers like /v2/user/info/ — no socket is ever opened.
    const bearers = join(sandbox.dir, 'bearers.log');
    const preload = join(sandbox.dir, 'fake-fetch.mjs');
    await writeFile(
      preload,
      [
        "import { appendFileSync } from 'node:fs';",
        'globalThis.fetch = async (input, init = {}) => {',
        "  const auth = new Headers(init.headers).get('authorization') ?? '<none>';",
        `  appendFileSync(${JSON.stringify(bearers)}, auth + '\\n');`,
        '  return new Response(',
        "    JSON.stringify({ data: { user: { open_id: 'entry-open-id-0000' } }, error: { code: 'ok', message: '', log_id: 'entry' } }),",
        "    { status: 200, headers: { 'content-type': 'application/json' } },",
        '  );',
        '};',
        '',
      ].join('\n'),
    );

    const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
    const child = spawn(
      process.execPath,
      ['--import', pathToFileURL(preload).href, entry],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: sandbox.dir,
          TT_ENV_FILE: envFile,
          TT_LOG_LEVEL: 'debug',
        },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));

    const exited = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`the entry did not finish in time; stderr: ${stderr}`));
      }, 20_000);
      timer.unref();
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    await new Promise<void>((resolve) => {
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.includes('serving MCP on stdio')) resolve();
      });
    });
    // Another process (a refresh, a fresh `login`) rotates the token after the
    // server read the file at startup.
    await writeFile(envFile, storeWith('entry-token-after-rotation'), { mode: 0o600 });

    const called = new Promise<Frame>((resolve) => {
      child.stdout.on('data', () => {
        for (const line of stdout.split('\n')) {
          if (line.trim() === '') continue;
          const frame = JSON.parse(line) as Frame;
          if (frame.id === 2 && !child.stdin.writableEnded) {
            child.stdin.end();
            resolve(frame);
          }
        }
      });
    });
    for (const request of [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'entry-test', version: '0.0.0' },
        },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'tiktok_get_auth_status', arguments: { probe: true } },
      },
    ]) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    }

    const answer = await called;
    assert.equal(await exited, 0, stderr);
    assert.equal(answer.error, undefined, JSON.stringify(answer.error));
    assert.equal(answer.result?.['isError'], false, JSON.stringify(answer.result));
    // The probe went out with the rotated token, never the one frozen at startup.
    const sent = (await readFile(bearers, 'utf8')).split('\n').filter((l) => l !== '');
    assert.deepEqual(sent, ['Bearer entry-token-after-rotation']);
  } finally {
    await sandbox.cleanup();
  }
});

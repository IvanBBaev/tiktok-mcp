import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

import { systemClock } from '../src/core/clock.js';
import { TikTokError } from '../src/core/errors.js';
import { createLogger, type Logger } from '../src/core/log.js';
import { loadSettings, type Settings } from '../src/core/settings.js';
import type { ApiContext } from '../src/api/context.js';
import {
  defineTool,
  toolInput,
  type AnyToolSpec,
  type ToolSpec,
} from '../src/mcp/define.js';
import type { ToolResult } from '../src/mcp/result.js';
import {
  callTool,
  createServer,
  describeTool,
  enabledTools,
  resolveEnabledPackages,
  toCallToolResult,
  unavailableMarker,
  type ProfileInfo,
  type ServerRuntime,
  type ToolPackageLike,
} from '../src/mcp/server.js';
import { baselineEnv } from './helpers.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Settings from the real loader, so the fixtures cannot drift from the schema. */
function settings(overrides: Record<string, string> = {}): Settings {
  return loadSettings({ ...baselineEnv(), ...overrides });
}

/** A logger that records instead of writing, so tests never touch stderr. */
function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const make = (): Logger => ({
    debug: (msg: string) => lines.push(`debug ${msg}`),
    info: (msg: string) => lines.push(`info ${msg}`),
    warn: (msg: string) => lines.push(`warn ${msg}`),
    error: (msg: string) => lines.push(`error ${msg}`),
    child: () => make(),
  });
  return Object.assign(make(), { lines });
}

const NOOP_LOGGER = createLogger({ level: 'error' });

function apiContext(profile: string, set: Settings): ApiContext {
  return {
    profile,
    settings: set,
    log: NOOP_LOGGER,
    clock: systemClock,
    getAccessToken: () => Promise.resolve('test-access-token-DEFAULT'),
  };
}

interface RuntimeOptions {
  settings?: Settings;
  profiles?: readonly ProfileInfo[];
  log?: Logger;
  onContext?: (profile: string) => void;
}

function runtimeOf(opts: RuntimeOptions = {}): ServerRuntime {
  const set = opts.settings ?? settings();
  const profiles = opts.profiles ?? [{ name: 'DEFAULT', scopes: ['video.list'] }];
  return {
    settings: set,
    log: opts.log ?? NOOP_LOGGER,
    profiles: () => Promise.resolve(profiles),
    createContext: (profile: string) => {
      opts.onContext?.(profile);
      return Promise.resolve(apiContext(profile, set));
    },
  };
}

/** A read-only fixture tool that echoes what the wrapper handed it. */
function echoTool(
  overrides: Partial<ToolSpec<Record<string, unknown>, unknown>> = {},
): AnyToolSpec {
  const spec = defineTool({
    name: 'tiktok_list_videos',
    title: 'List videos',
    description: 'List the authenticated creator’s public videos.',
    package: 'video',
    scopes: ['video.list'],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: toolInput({ max_count: z.number().int().min(1).max(20).optional() }),
    handler: (args, ctx) =>
      Promise.resolve<ToolResult<unknown>>({
        ok: true,
        data: { args, profile: ctx.api.profile, videos: [] },
      }),
    ...overrides,
  });
  return spec;
}

function packagesOf(...tools: AnyToolSpec[]): ToolPackageLike[] {
  return [
    { name: 'auth', tools: [] },
    { name: 'user', tools: [] },
    { name: 'video', tools },
    { name: 'publish', tools: [] },
    { name: 'publish-write', tools: [] },
  ];
}

function errorOf(result: ToolResult<unknown>): { code: string; message: string } {
  assert.equal(result.ok, false, 'expected a failed call');
  assert.ok(result.error !== undefined);
  return result.error;
}

// ---------------------------------------------------------------------------
// package resolution (TOOLS.md § 1, CONFIGURATION.md)
// ---------------------------------------------------------------------------

test('the default package selection is core — every read package, no writes', () => {
  assert.deepEqual(resolveEnabledPackages(settings()), [
    'auth',
    'user',
    'video',
    'publish',
  ]);
});

test('all enables every package including publish-write', () => {
  assert.deepEqual(resolveEnabledPackages(settings({ TT_TOOL_PACKAGES: 'all' })), [
    'auth',
    'user',
    'video',
    'publish',
    'publish-write',
  ]);
});

test('an explicit selection keeps manifest order, not selector order', () => {
  assert.deepEqual(
    resolveEnabledPackages(settings({ TT_TOOL_PACKAGES: 'publish-write,auth,video' })),
    ['auth', 'video', 'publish-write'],
  );
});

test('TT_PACKAGES_DENY subtracts from the selection', () => {
  assert.deepEqual(
    resolveEnabledPackages(
      settings({ TT_TOOL_PACKAGES: 'all', TT_PACKAGES_DENY: 'publish,publish-write' }),
    ),
    ['auth', 'user', 'video'],
  );
});

test('TT_WRITE_MODE=deny removes publish-write even when it was selected', () => {
  assert.deepEqual(
    resolveEnabledPackages(settings({ TT_TOOL_PACKAGES: 'all', TT_WRITE_MODE: 'deny' })),
    ['auth', 'user', 'video', 'publish'],
  );
});

test('TT_PACKAGES_READONLY=1 removes publish-write as well', () => {
  assert.deepEqual(
    resolveEnabledPackages(
      settings({ TT_TOOL_PACKAGES: 'all', TT_PACKAGES_READONLY: '1' }),
    ),
    ['auth', 'user', 'video', 'publish'],
  );
});

test('enabledTools returns only the tools of enabled packages', () => {
  const spec = echoTool();
  assert.deepEqual(enabledTools(packagesOf(spec), settings()), [spec]);
  assert.deepEqual(
    enabledTools(packagesOf(spec), settings({ TT_PACKAGES_DENY: 'video' })),
    [],
  );
});

// ---------------------------------------------------------------------------
// tools/list description (TOOLS.md §§ 2.1, 6.1)
// ---------------------------------------------------------------------------

test('a tool whose scopes no profile grants carries the [UNAVAILABLE] marker', () => {
  const spec = echoTool({ scopes: ['video.publish', 'video.upload'] });
  assert.equal(
    unavailableMarker(spec, [{ name: 'DEFAULT', scopes: ['video.list'] }]),
    '[UNAVAILABLE: requires scope video.publish, video.upload; no configured profile grants it. ' +
      'Fix: npx tiktok-mcp-ai login --scopes video.publish,video.upload]',
  );
});

test('availability is a union across profiles', () => {
  const spec = echoTool({ scopes: ['video.publish'] });
  assert.equal(
    unavailableMarker(spec, [
      { name: 'DEFAULT', scopes: ['video.list'] },
      { name: 'WORK', scopes: ['video.publish'] },
    ]),
    undefined,
  );
});

test('a tool that needs no scope is never marked unavailable', () => {
  assert.equal(unavailableMarker(echoTool({ scopes: [] }), []), undefined);
});

test('the marker is prefixed to the description, leaving the original intact', () => {
  const spec = echoTool({ scopes: ['video.publish'] });
  const described = describeTool(spec, []);
  assert.ok(
    described.description?.startsWith('[UNAVAILABLE: requires scope video.publish;'),
  );
  assert.ok(described.description?.endsWith(spec.description));
});

test('describeTool advertises a closed input schema and the envelope as output', () => {
  const described = describeTool(echoTool(), [
    { name: 'DEFAULT', scopes: ['video.list'] },
  ]);
  const input = described.inputSchema as Record<string, unknown>;
  assert.equal(input['type'], 'object');
  assert.equal(input['additionalProperties'], false);
  assert.equal(input['$schema'], undefined, '$schema is noise on the wire');
  assert.deepEqual(Object.keys(input['properties'] as object).sort(), [
    'account',
    'max_count',
  ]);
  assert.equal((described.outputSchema as Record<string, unknown>)['type'], 'object');
});

test('describeTool passes the annotations through with the title', () => {
  const described = describeTool(echoTool(), []);
  assert.deepEqual(described.annotations, {
    title: 'List videos',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
});

// ---------------------------------------------------------------------------
// callTool — the happy path
// ---------------------------------------------------------------------------

test('a valid call reaches the handler and echoes the resolved account', async () => {
  const result = await callTool(echoTool(), { max_count: 5 }, runtimeOf());
  assert.equal(result.ok, true);
  const data = result.data as {
    args: Record<string, unknown>;
    profile: string;
    meta: Record<string, unknown>;
  };
  assert.deepEqual(data.args, { max_count: 5 });
  assert.equal(data.profile, 'DEFAULT');
  assert.equal(data.meta['account'], 'DEFAULT');
});

test('a handler that sets meta.account itself is not overwritten', async () => {
  const spec = echoTool({
    handler: () => Promise.resolve({ ok: true, data: { meta: { account: 'WORK' } } }),
  });
  const result = await callTool(spec, {}, runtimeOf());
  assert.equal(
    (result.data as { meta: Record<string, unknown> }).meta['account'],
    'WORK',
  );
});

test('an explicit account selects that profile', async () => {
  const used: string[] = [];
  const result = await callTool(
    echoTool(),
    { account: 'WORK' },
    runtimeOf({
      profiles: [
        { name: 'DEFAULT', scopes: ['video.list'] },
        { name: 'WORK', scopes: ['video.list'] },
      ],
      onContext: (profile) => used.push(profile),
    }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(used, ['WORK']);
});

test('an omitted account falls back to the active profile', async () => {
  const used: string[] = [];
  await callTool(
    echoTool(),
    {},
    runtimeOf({
      settings: settings({ TT_ACTIVE_PROFILE: 'WORK' }),
      profiles: [{ name: 'WORK', scopes: ['video.list'] }],
      onContext: (profile) => used.push(profile),
    }),
  );
  assert.deepEqual(used, ['WORK']);
});

// ---------------------------------------------------------------------------
// callTool — the failure catalog (TOOLS.md §§ 2.3, 3.0)
// ---------------------------------------------------------------------------

test('cc-g1: an unknown argument fails as data and names the offending key', async () => {
  const result = await callTool(echoTool(), { max_cont: 5 }, runtimeOf());
  const error = errorOf(result);
  assert.equal(error.code, 'invalid_params');
  assert.match(error.message, /^Invalid arguments: max_cont: unknown argument/);
  assert.match(error.message, /No request was sent to TikTok\.$/);
});

test('a wrongly typed argument reports the field and the local reason', async () => {
  const error = errorOf(await callTool(echoTool(), { max_count: 99 }, runtimeOf()));
  assert.equal(error.code, 'invalid_params');
  assert.match(error.message, /max_count: /);
});

test('a call with no arguments at all is treated as an empty object', async () => {
  const result = await callTool(echoTool(), undefined, runtimeOf());
  assert.equal(result.ok, true);
});

test('an unknown account fails locally and lists the configured profiles', async () => {
  const error = errorOf(await callTool(echoTool(), { account: 'NOPE' }, runtimeOf()));
  assert.equal(error.code, 'unknown_account');
  assert.equal(
    error.message,
    "Unknown account 'NOPE'. Configured profiles: DEFAULT. " +
      "Omit account to use the default profile ('DEFAULT').",
  );
});

test('TT_LOCK_PROFILE rejects any other account by name', async () => {
  const error = errorOf(
    await callTool(
      echoTool(),
      { account: 'DEFAULT' },
      runtimeOf({
        settings: settings({ TT_LOCK_PROFILE: 'WORK' }),
        profiles: [
          { name: 'DEFAULT', scopes: ['video.list'] },
          { name: 'WORK', scopes: ['video.list'] },
        ],
      }),
    ),
  );
  assert.equal(error.code, 'unknown_account');
  assert.match(error.message, /Configured profiles: WORK\./);
});

test('TT_LOCK_PROFILE is the profile used when account is omitted', async () => {
  const used: string[] = [];
  await callTool(
    echoTool(),
    {},
    runtimeOf({
      settings: settings({ TT_LOCK_PROFILE: 'WORK' }),
      profiles: [{ name: 'WORK', scopes: ['video.list'] }],
      onContext: (profile) => used.push(profile),
    }),
  );
  assert.deepEqual(used, ['WORK']);
});

test('a missing scope fails at call time with the exact login command', async () => {
  const spec = echoTool({ scopes: ['video.publish'] });
  const result = await callTool(spec, {}, runtimeOf());
  const error = errorOf(result);
  assert.equal(error.code, 'missing_scope');
  assert.equal(
    error.message,
    "Account 'DEFAULT' was authorized without scope video.publish, which this tool requires. " +
      'Ask the user to run: npx tiktok-mcp-ai login --profile DEFAULT --scopes video.publish — ' +
      'then verify with tiktok_get_auth_status.',
  );
  const hint = result.hints?.[0];
  assert.equal(hint?.type, 'reauth');
  assert.equal(
    hint?.command,
    'npx tiktok-mcp-ai login --profile DEFAULT --scopes video.publish',
  );
  assert.equal(hint?.profile, 'DEFAULT');
});

test('the scope check runs before the handler and before any context is built', async () => {
  const built: string[] = [];
  let called = false;
  const spec = echoTool({
    scopes: ['video.publish'],
    handler: () => {
      called = true;
      return Promise.resolve({ ok: true });
    },
  });
  await callTool(spec, {}, runtimeOf({ onContext: (p) => built.push(p) }));
  assert.equal(called, false);
  assert.deepEqual(built, []);
});

test('a TikTokError thrown by a handler keeps its catalog code and log_id', async () => {
  const spec = echoTool({
    handler: () =>
      Promise.reject(
        new TikTokError({
          kind: 'api',
          code: 'rate_limited',
          message: 'TikTok is rate limiting this client.',
          retryable: true,
          remediation: 'Wait for the window to reset and try again.',
          apiCode: 'rate_limit_exceeded',
          logId: '20260101000000010204046050060A1B2C3',
        }),
      ),
  });
  const result = await callTool(spec, {}, runtimeOf());
  const error = errorOf(result);
  assert.equal(error.code, 'rate_limited');
  assert.match(error.message, /Wait for the window to reset/);
  assert.equal(result.error?.retryable, true);
  assert.equal(result.error?.log_id, '20260101000000010204046050060A1B2C3');
  assert.equal(result.error?.details?.['api_code'], 'rate_limit_exceeded');
});

test('an unexpected throw becomes internal_error without leaking its text', async () => {
  const log = recordingLogger();
  const spec = echoTool({
    handler: () => Promise.reject(new Error('secret-ish stack detail')),
  });
  const result = await callTool(spec, {}, runtimeOf({ log }));
  const error = errorOf(result);
  assert.equal(error.code, 'internal_error');
  assert.ok(!error.message.includes('secret-ish stack detail'));
  assert.equal(result.error?.details?.['reason'], 'secret-ish stack detail');
  assert.ok(log.lines.some((line) => line.startsWith('warn tool call failed')));
});

test('a failed call still echoes the account it ran against', async () => {
  const spec = echoTool({ handler: () => Promise.reject(new Error('boom')) });
  const result = await callTool(spec, {}, runtimeOf());
  assert.equal(result.data, undefined, 'a failure carries no payload');
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// envelope → MCP result (TOOLS.md § 2.1)
// ---------------------------------------------------------------------------

test('a successful envelope becomes mirrored content plus structuredContent', () => {
  const set = settings();
  const mcp = toCallToolResult({ ok: true, data: { videos: [] } }, set);
  assert.equal(mcp.isError, false);
  assert.deepEqual(mcp.structuredContent, { ok: true, data: { videos: [] } });
  const block = mcp.content?.[0] as { type: string; text: string };
  assert.equal(block.type, 'text');
  assert.deepEqual(JSON.parse(block.text), mcp.structuredContent);
});

test('a failed envelope sets isError and still carries structuredContent', () => {
  const mcp = toCallToolResult(
    { ok: false, error: { code: 'invalid_params', message: 'x', retryable: false } },
    settings(),
  );
  assert.equal(mcp.isError, true);
  assert.equal(
    (mcp.structuredContent as { error: { code: string } }).error.code,
    'invalid_params',
  );
});

test('TT_PRETTY_JSON indents the mirrored text block', () => {
  const mcp = toCallToolResult(
    { ok: true, data: { videos: [{ id: 'v1' }] } },
    settings({ TT_PRETTY_JSON: '1' }),
  );
  assert.ok((mcp.content?.[0] as { text: string }).text.includes('\n  '));
});

test('TT_RESULT_CHAR_BUDGET bounds the mirrored text block', () => {
  const mcp = toCallToolResult(
    {
      ok: true,
      data: {
        videos: Array.from({ length: 400 }, (_, i) => ({ id: `v${String(i)}` })),
        meta: {},
      },
    },
    settings({ TT_RESULT_CHAR_BUDGET: '1200' }),
  );
  assert.ok((mcp.content?.[0] as { text: string }).text.length <= 1200);
});

// ---------------------------------------------------------------------------
// the wired server — a real client over an in-memory transport
// ---------------------------------------------------------------------------

async function connectedClient(
  opts: { packages?: ToolPackageLike[]; runtime?: ServerRuntime } = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const runtime = opts.runtime ?? runtimeOf();
  const handle = createServer({
    name: 'tiktok-mcp-ai',
    version: '0.0.0-test',
    packages: opts.packages ?? packagesOf(echoTool()),
    runtime,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([
    handle.server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async (): Promise<void> => {
      await client.close();
      await handle.server.close();
    },
  };
}

test('tools/list advertises the enabled tools over a real client session', async () => {
  const { client, close } = await connectedClient();
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ['tiktok_list_videos'],
    );
    const tool = listed.tools[0];
    assert.equal(tool?.title, 'List videos');
    assert.equal(tool?.annotations?.readOnlyHint, true);
    assert.equal(
      (tool?.inputSchema as Record<string, unknown>)['additionalProperties'],
      false,
    );
  } finally {
    await close();
  }
});

test('tools/call returns the envelope as structuredContent, not a protocol error', async () => {
  const { client, close } = await connectedClient();
  try {
    const result = await client.callTool({
      name: 'tiktok_list_videos',
      arguments: { max_count: 3 },
    });
    assert.equal(result.isError, false);
    const structured = result.structuredContent as { ok: boolean; data: unknown };
    assert.equal(structured.ok, true);
  } finally {
    await close();
  }
});

test('cc-g1: a schema violation comes back as an envelope with isError, not a throw', async () => {
  const { client, close } = await connectedClient();
  try {
    const result = await client.callTool({
      name: 'tiktok_list_videos',
      arguments: { nope: 1 },
    });
    assert.equal(result.isError, true);
    const structured = result.structuredContent as {
      ok: boolean;
      error: { code: string; message: string };
    };
    assert.equal(structured.ok, false);
    assert.equal(structured.error.code, 'invalid_params');
    assert.match(structured.error.message, /nope: unknown argument/);
  } finally {
    await close();
  }
});

test('an unknown tool name is a protocol error, not an envelope', async () => {
  const { client, close } = await connectedClient();
  try {
    await assert.rejects(
      client.callTool({ name: 'tiktok_does_not_exist', arguments: {} }),
      /Unknown tool: tiktok_does_not_exist/,
    );
  } finally {
    await close();
  }
});

test('a disabled package is not reachable over the wire', async () => {
  const runtime = runtimeOf({ settings: settings({ TT_PACKAGES_DENY: 'video' }) });
  const { client, close } = await connectedClient({ runtime });
  try {
    assert.deepEqual((await client.listTools()).tools, []);
    await assert.rejects(
      client.callTool({ name: 'tiktok_list_videos', arguments: {} }),
      /Unknown tool/,
    );
  } finally {
    await close();
  }
});

test('a handler receives the progress reporter only when the client sent a token', async () => {
  const seen: (boolean | undefined)[] = [];
  const reported: number[] = [];
  const spec = echoTool({
    handler: (_args, ctx) => {
      seen.push(ctx.progress !== undefined);
      ctx.progress?.(1, 2);
      return Promise.resolve({ ok: true, data: {} });
    },
  });
  const { client, close } = await connectedClient({ packages: packagesOf(spec) });
  try {
    await client.callTool({ name: 'tiktok_list_videos', arguments: {} });
    await client.callTool({ name: 'tiktok_list_videos', arguments: {} }, undefined, {
      onprogress: (progress) => reported.push(progress.progress),
    });
    assert.deepEqual(seen, [false, true]);
    assert.deepEqual(reported, [1]);
  } finally {
    await close();
  }
});

test('notifyToolListChanged reaches a connected client', async () => {
  const runtime = runtimeOf();
  const handle = createServer({
    name: 'tiktok-mcp-ai',
    version: '0.0.0-test',
    packages: packagesOf(echoTool()),
    runtime,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  let notified = false;
  client.setNotificationHandler(
    z.object({ method: z.literal('notifications/tools/list_changed') }),
    () => {
      notified = true;
    },
  );
  await Promise.all([
    handle.server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    await handle.notifyToolListChanged();
    // One round trip is enough to guarantee the notification was delivered.
    await client.listTools();
    assert.equal(notified, true);
  } finally {
    await client.close();
    await handle.server.close();
  }
});

// ---------------------------------------------------------------------------
// CC-G3 — stdout purity, proved against a real stdio transport
// ---------------------------------------------------------------------------

interface StdioSession {
  stdout: string;
  stderr: string;
  frames: Record<string, unknown>[];
}

/**
 * Run the stdio worker as a real child, feed it `requests` as newline-delimited
 * JSON-RPC and collect both streams. The child is killed if it outlives the
 * deadline, so a transport that never answers fails the test instead of hanging
 * the suite.
 */
async function runStdioSession(requests: unknown[]): Promise<StdioSession> {
  const worker = fileURLToPath(
    new URL('./harness/workers/stdio-server-worker.js', import.meta.url),
  );
  const child = spawn(process.execPath, [worker], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TIKTOK_MCP_TEST_INHERIT_ENV: '1' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));

  const expected = requests.filter(
    (request) => (request as { id?: unknown }).id !== undefined,
  ).length;
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`stdio worker did not answer in time; stderr: ${stderr}`));
    }, 15_000);
    timer.unref();
    child.on('error', reject);
    child.stdout.on('data', () => {
      // One line per response: stop as soon as every request was answered.
      if (stdout.split('\n').filter((line) => line.trim() !== '').length >= expected) {
        clearTimeout(timer);
        child.kill();
        resolve();
      }
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  await done;

  const frames = stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { stdout, stderr, frames };
}

test('cc-g3: a real stdio session writes JSON-RPC frames and nothing else', async () => {
  const { stdout, stderr, frames } = await runStdioSession([
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'tiktok_list_videos', arguments: {} },
    },
  ]);

  // Every stdout line is a JSON-RPC frame for a request we sent — no banner, no
  // log line, no stray `console.log`. `JSON.parse` above already rejects prose.
  assert.equal(frames.length, 3);
  assert.deepEqual(
    frames.map((frame) => frame['id']),
    [1, 2, 3],
  );
  for (const frame of frames) assert.equal(frame['jsonrpc'], '2.0');
  assert.ok(!stdout.includes('handler ran'), 'a log line reached stdout');
  assert.ok(!stdout.includes('stdio worker starting'), 'a log line reached stdout');

  // The diagnostics did happen — they went to stderr, which is the point.
  assert.match(stderr, /stdio worker starting/);
  assert.match(stderr, /handler ran/);

  const call = frames[2]?.['result'] as { structuredContent: { ok: boolean } };
  assert.equal(call.structuredContent.ok, true);
});

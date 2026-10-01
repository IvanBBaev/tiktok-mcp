import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { systemClock } from '../src/core/clock.js';
import { TikTokError } from '../src/core/errors.js';
import { createLogger, type Logger } from '../src/core/log.js';
import { loadSettings, TOOL_PACKAGES, type Settings } from '../src/core/settings.js';
import type { ApiContext } from '../src/api/context.js';
import {
  defineTool,
  toolInput,
  type AnyToolSpec,
  type ToolSpec,
} from '../src/mcp/define.js';
import {
  appendIntent,
  appendOutcome,
  type IntentRecord,
  type OutcomeRecord,
} from '../src/mcp/journal.js';
import { definePrompt, type PromptSpec } from '../src/mcp/prompts.js';
import { defineResource, type ResourceSpec } from '../src/mcp/resources.js';
import type { ToolResult } from '../src/mcp/result.js';
import {
  callTool,
  createServer,
  describeTool,
  enabledPrompts,
  enabledResources,
  enabledTools,
  resolveEnabledPackages,
  toCallToolResult,
  unavailableMarker,
  type ProfileInfo,
  type ServerRuntime,
  type ToolPackageLike,
} from '../src/mcp/server.js';
import { deferred, flush } from './harness/deferred.js';
import { baselineEnv, fsSandbox } from './helpers.js';

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

/**
 * A fixture mirroring the one shipped tool that uses the scope alternation —
 * `tiktok_get_publish_status` (`src/tools/publish.ts`), whose `scopes` /
 * `scopesAnyOf` pair is pinned by the manifest snapshot in
 * `docs/tool-manifest.json`. Mirrored rather than imported: this module never
 * imports the real manifest, so the server stays testable with fixture tools.
 */
function anyOfTool(
  overrides: Partial<ToolSpec<Record<string, unknown>, unknown>> = {},
): AnyToolSpec {
  return echoTool({
    name: 'tiktok_get_publish_status',
    title: 'Get publish status',
    description: 'Check the status of a publish or upload started earlier.',
    package: 'publish',
    scopes: [],
    scopesAnyOf: ['video.publish', 'video.upload'],
    ...overrides,
  });
}

/** Every package of the manifest, each holding the fixtures that declare it. */
function packagesOf(...tools: AnyToolSpec[]): ToolPackageLike[] {
  return TOOL_PACKAGES.map((name) => ({
    name,
    tools: tools.filter((spec) => spec.package === name),
  }));
}

/**
 * A fixture prompt steering to `tiktok_list_videos`, so it is gated with the
 * `video` package like the shipped one is gated with `publish-write`. One
 * required and one optional argument cover both halves of the validation.
 */
function guidePrompt(overrides: Partial<PromptSpec> = {}): PromptSpec {
  return definePrompt({
    name: 'tiktok_list_videos_guided',
    title: 'List videos, guided',
    description: 'Walk the model through listing the creator’s recent videos.',
    package: 'video',
    arguments: [
      { name: 'max_count', description: 'How many videos to list.', required: true },
      { name: 'account', description: 'The profile to read through.', required: false },
    ],
    render: (args) => [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `Call tiktok_list_videos with max_count ${args['max_count'] ?? ''}` +
            (args['account'] === undefined ? '.' : ` for account ${args['account']}.`),
        },
      },
    ],
    ...overrides,
  });
}

/** A fixture resource: `tiktok://videos/recent` over the echo tool, one fixed page. */
function videosResource(overrides: Partial<ResourceSpec> = {}): ResourceSpec {
  return defineResource({
    uri: 'tiktok://videos/recent',
    name: 'tiktok_videos_recent',
    title: 'Recent videos',
    description:
      'The creator’s most recent public videos, as tiktok_list_videos returns them.',
    tool: echoTool(),
    args: { max_count: 5 },
    ...overrides,
  });
}

/**
 * A template fixture mirroring `tiktok://publish/{publish_id}/status`: the id
 * rides in the path, the poll is switched off by a fixed argument, and the
 * tool is the scope-alternation one, so the marker follows `scopesAnyOf`.
 */
function statusResource(overrides: Partial<ResourceSpec> = {}): ResourceSpec {
  return defineResource({
    uri: 'tiktok://publish/{publish_id}/status',
    name: 'tiktok_publish_status',
    title: 'Publish status',
    description: 'One publish attempt by id, as tiktok_get_publish_status returns it.',
    tool: anyOfTool({
      input: toolInput({
        publish_id: z.string().min(1),
        wait_for_completion: z.boolean().optional(),
      }),
    }),
    args: { wait_for_completion: false },
    ...overrides,
  });
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

test('enabledPrompts follows the package selection, in manifest order', () => {
  const video = guidePrompt();
  const write = guidePrompt({
    name: 'tiktok_post_video_guided',
    package: 'publish-write',
  });
  assert.deepEqual(enabledPrompts([write, video], settings()), [video]);
  assert.deepEqual(
    enabledPrompts([write, video], settings({ TT_TOOL_PACKAGES: 'all' })),
    [write, video],
  );
  assert.deepEqual(enabledPrompts([video], settings({ TT_PACKAGES_DENY: 'video' })), []);
});

test('enabledPrompts lists a prompt only while every package it requires is enabled too', () => {
  const write = guidePrompt({
    name: 'tiktok_post_video_guided',
    package: 'publish-write',
    requires: ['publish'],
  });
  const plain = guidePrompt();
  const all = settings({ TT_TOOL_PACKAGES: 'all' });
  assert.deepEqual(enabledPrompts([write, plain], all), [write, plain]);
  // Its own package is enabled but a required one is not: not listed.
  assert.deepEqual(
    enabledPrompts(
      [write, plain],
      settings({ TT_TOOL_PACKAGES: 'all', TT_PACKAGES_DENY: 'publish' }),
    ),
    [plain],
  );
  // An empty requires list is the same as none.
  const empty = guidePrompt({ requires: [] });
  assert.deepEqual(enabledPrompts([empty], settings()), [empty]);
});

test('enabledResources keeps a resource exactly when its tool is enabled, by name', () => {
  const tool = echoTool();
  const videos = videosResource();
  const status = videosResource({
    uri: 'tiktok://publish/status',
    name: 'tiktok_publish_status',
    tool: anyOfTool(),
  });
  assert.deepEqual(enabledResources([status, videos], [tool, anyOfTool()]), [
    status,
    videos,
  ]);
  // A different spec instance with the same name is the same tool: the key is
  // what `tools/call` resolves, not object identity.
  assert.deepEqual(enabledResources([videos], [echoTool()]), [videos]);
  assert.deepEqual(enabledResources([videos, status], [tool]), [videos]);
  assert.deepEqual(enabledResources([videos], []), []);
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

test('the marker states an alternation as one requirement, not as AND-ed scopes', () => {
  const marker = unavailableMarker(anyOfTool({ scopes: ['video.list'] }), [
    { name: 'DEFAULT', scopes: ['video.list'] },
  ]);
  assert.equal(
    marker,
    '[UNAVAILABLE: requires scope video.list, video.publish or video.upload; ' +
      'no configured profile grants it. ' +
      'Fix: npx tiktok-mcp-ai login --scopes video.list,video.publish]',
  );
  // The alternation is ONE comma-separated part of the requirement list: a
  // reader must not be able to mistake it for two separately required scopes.
  const required = /requires scope ([^;]+);/.exec(marker ?? '')?.[1]?.split(', ');
  assert.deepEqual(required, ['video.list', 'video.publish or video.upload']);
});

test('the suggested login command asks for one alternative, never the combination', () => {
  const marker = unavailableMarker(anyOfTool({ scopes: ['video.list'] }), [
    { name: 'DEFAULT', scopes: ['video.list'] },
  ]);
  const asked = /--scopes ([^\]]+)\]/.exec(marker ?? '')?.[1]?.split(',');
  // TikTok grants the two alternatives separately, so a command naming both
  // would be unsatisfiable — the fix must stay runnable as printed.
  assert.deepEqual(asked, ['video.list', 'video.publish']);
});

test('either alternative alone lifts the marker', () => {
  const spec = anyOfTool();
  assert.equal(
    unavailableMarker(spec, [{ name: 'DEFAULT', scopes: ['video.publish'] }]),
    undefined,
  );
  assert.equal(
    unavailableMarker(spec, [{ name: 'DEFAULT', scopes: ['video.upload'] }]),
    undefined,
  );
  assert.equal(
    unavailableMarker(spec, [{ name: 'DEFAULT', scopes: ['video.list'] }]),
    '[UNAVAILABLE: requires scope video.publish or video.upload; ' +
      'no configured profile grants it. ' +
      'Fix: npx tiktok-mcp-ai login --scopes video.publish]',
  );
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

test('a whitespace-only account counts as omitted and falls back to the active profile', async () => {
  // The empty string never gets this far: the shared schema requires min(1).
  for (const account of [' ', '   ', '\t', ' \n ']) {
    const used: string[] = [];
    const result = await callTool(
      echoTool(),
      { account },
      runtimeOf({
        settings: settings({ TT_ACTIVE_PROFILE: 'WORK' }),
        profiles: [
          { name: 'DEFAULT', scopes: ['video.list'] },
          { name: 'WORK', scopes: ['video.list'] },
        ],
        onContext: (profile) => used.push(profile),
      }),
    );
    assert.equal(result.ok, true, `${JSON.stringify(account)} is not an unknown account`);
    assert.deepEqual(
      used,
      ['WORK'],
      `${JSON.stringify(account)} runs as the active profile`,
    );
    const data = result.data as { meta: Record<string, unknown> };
    assert.equal(data.meta['account'], 'WORK');
  }
});

test('a blank account under TT_LOCK_PROFILE runs as the locked profile', async () => {
  const used: string[] = [];
  const result = await callTool(
    echoTool(),
    { account: '  ' },
    runtimeOf({
      settings: settings({ TT_LOCK_PROFILE: 'WORK' }),
      profiles: [{ name: 'WORK', scopes: ['video.list'] }],
      onContext: (profile) => used.push(profile),
    }),
  );
  assert.equal(result.ok, true);
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

test('an unreadable credential store is a tool error, not a thrown fault', async () => {
  const contexts: string[] = [];
  const runtime: ServerRuntime = {
    ...runtimeOf({ onContext: (profile) => contexts.push(profile) }),
    profiles: () =>
      Promise.reject(
        new TikTokError({
          kind: 'config',
          code: 'config_invalid',
          message: 'The env file could not be read.',
          retryable: false,
        }),
      ),
  };
  const result = await callTool(echoTool(), {}, runtime);
  const error = errorOf(result);
  assert.equal(error.code, 'config_invalid');
  assert.equal(error.message, 'The env file could not be read.');
  assert.deepEqual(contexts, []);
});

test('a plain Error from the profile lookup maps to internal_error', async () => {
  const runtime: ServerRuntime = {
    ...runtimeOf(),
    profiles: () => Promise.reject(new Error('EACCES: permission denied')),
  };
  const error = errorOf(await callTool(echoTool(), {}, runtime));
  assert.equal(error.code, 'internal_error');
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

test('cc-f4 an account is matched case- and space-insensitively and runs as the stored name', async () => {
  for (const account of ['work', ' Work ', 'WORK']) {
    const used: string[] = [];
    const result = await callTool(
      echoTool(),
      { account },
      runtimeOf({
        profiles: [
          { name: 'DEFAULT', scopes: ['video.list'] },
          { name: 'WORK', scopes: ['video.list'] },
        ],
        onContext: (profile) => used.push(profile),
      }),
    );
    assert.equal(result.ok, true, `${JSON.stringify(account)} resolves`);
    assert.deepEqual(used, ['WORK'], 'the context is built for the canonical name');
    const data = result.data as { profile: string; meta: Record<string, unknown> };
    assert.equal(data.profile, 'WORK');
    assert.equal(data.meta['account'], 'WORK');
  }
});

test('cc-f4 an unknown account echoes the caller spelling, not the canonical one', async () => {
  const error = errorOf(await callTool(echoTool(), { account: ' Nope ' }, runtimeOf()));
  assert.equal(error.code, 'unknown_account');
  assert.match(
    error.message,
    /^Unknown account ' Nope '\. Configured profiles: DEFAULT\./,
  );
});

test('cc-f4 TT_LOCK_PROFILE admits the locked account in any spelling', async () => {
  const used: string[] = [];
  const result = await callTool(
    echoTool(),
    { account: 'work' },
    runtimeOf({
      settings: settings({ TT_LOCK_PROFILE: 'WORK' }),
      profiles: [
        { name: 'DEFAULT', scopes: ['video.list'] },
        { name: 'WORK', scopes: ['video.list'] },
      ],
      onContext: (profile) => used.push(profile),
    }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(used, ['WORK']);

  // Another profile stays refused however it is spelled, echoed as given.
  const error = errorOf(
    await callTool(
      echoTool(),
      { account: 'default' },
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
  assert.match(error.message, /^Unknown account 'default'\. Configured profiles: WORK\./);
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

test('a tool that requires no scope at all is never denied at call time', async () => {
  const result = await callTool(echoTool({ scopes: [] }), {}, runtimeOf());
  assert.equal(result.ok, true);
});

test('an alternation is denied only when neither alternative is granted', async () => {
  const spec = anyOfTool();
  const denied = await callTool(spec, {}, runtimeOf());
  const error = errorOf(denied);
  assert.equal(error.code, 'missing_scope');
  assert.equal(
    error.message,
    "Account 'DEFAULT' was authorized without scope video.publish, which this tool requires. " +
      'Ask the user to run: npx tiktok-mcp-ai login --profile DEFAULT --scopes video.publish — ' +
      'then verify with tiktok_get_auth_status.',
  );
  const hint = denied.hints?.[0];
  assert.equal(hint?.type, 'reauth');
  assert.equal(
    hint?.command,
    'npx tiktok-mcp-ai login --profile DEFAULT --scopes video.publish',
  );
  assert.ok(
    hint?.command.includes(',') !== true,
    'the re-auth command must name a single alternative TikTok can grant',
  );

  // The second alternative is enough on its own — a draft-only installation
  // holds only video.upload and still reaches the handler.
  const allowed = await callTool(
    spec,
    {},
    runtimeOf({ profiles: [{ name: 'DEFAULT', scopes: ['video.upload'] }] }),
  );
  assert.equal(allowed.ok, true);
});

test('a profile that is configured but has no credentials yet grants nothing', async () => {
  const result = await callTool(
    anyOfTool(),
    {},
    runtimeOf({
      settings: settings({ TT_ACTIVE_PROFILE: 'GHOST' }),
      profiles: [{ name: 'DEFAULT', scopes: ['video.publish'] }],
    }),
  );
  const error = errorOf(result);
  assert.equal(error.code, 'missing_scope');
  // Not "authorized without scope": it was never authorized at all, and the
  // remediation is a plain login, which requests every enabled package's
  // scopes — `--scopes video.publish` would grant that one scope alone.
  assert.equal(
    error.message,
    "Account 'GHOST' has no stored credentials, so it grants no scopes; this tool " +
      'requires video.publish. Ask the user to run: npx tiktok-mcp-ai login --profile GHOST — ' +
      'then verify with tiktok_get_auth_status.',
  );
  assert.deepEqual(result.error?.details, {
    profile: 'GHOST',
    missing_scope: 'video.publish',
    configured: false,
  });
  const hint = result.hints?.[0];
  assert.equal(hint?.type, 'reauth');
  assert.equal(hint?.command, 'npx tiktok-mcp-ai login --profile GHOST');
  assert.equal(hint?.profile, 'GHOST');
  assert.match(hint?.text ?? '', /log in to profile 'GHOST'/);
  assert.equal(result.hints?.length, 1);
});

test('a plain scope list on a profile with no credentials asks for a plain login', async () => {
  const built: string[] = [];
  const result = await callTool(
    echoTool({ scopes: ['video.list', 'video.publish'] }),
    {},
    runtimeOf({
      settings: settings({ TT_ACTIVE_PROFILE: 'GHOST' }),
      profiles: [{ name: 'DEFAULT', scopes: ['video.list', 'video.publish'] }],
      onContext: (profile) => built.push(profile),
    }),
  );
  const error = errorOf(result);
  assert.equal(error.code, 'missing_scope');
  // The first required scope is the one named; the configured DEFAULT's grants
  // are never borrowed for GHOST.
  assert.match(error.message, /has no stored credentials/);
  assert.match(error.message, /requires video\.list\./);
  assert.deepEqual(result.error?.details, {
    profile: 'GHOST',
    missing_scope: 'video.list',
    configured: false,
  });
  assert.equal(result.hints?.[0]?.command, 'npx tiktok-mcp-ai login --profile GHOST');
  assert.deepEqual(built, [], 'no context is built for a denied call');
});

test('a listed profile with no stored token is treated as unconfigured', async () => {
  // Listed (its scopes line survived a half-finished login) but holding no
  // token: "authorized without scope X" would be false — it was never
  // authorized — so the remediation is the plain login, not `--scopes`.
  const result = await callTool(
    echoTool({ scopes: ['video.publish'] }),
    {},
    runtimeOf({
      profiles: [{ name: 'DEFAULT', scopes: ['video.list'], authorized: false }],
    }),
  );
  const error = errorOf(result);
  assert.equal(error.code, 'missing_scope');
  assert.match(error.message, /Account 'DEFAULT' has no stored credentials/);
  assert.doesNotMatch(error.message, /--scopes/);
  assert.deepEqual(result.error?.details, {
    profile: 'DEFAULT',
    missing_scope: 'video.publish',
    configured: false,
  });
  assert.equal(result.hints?.[0]?.command, 'npx tiktok-mcp-ai login --profile DEFAULT');
});

test('an authorized profile that lacks the scope keeps the --scopes remediation', async () => {
  const result = await callTool(
    echoTool({ scopes: ['video.publish'] }),
    {},
    runtimeOf({
      profiles: [{ name: 'DEFAULT', scopes: ['video.list'], authorized: true }],
    }),
  );
  const error = errorOf(result);
  assert.equal(error.code, 'missing_scope');
  assert.match(error.message, /was authorized without scope video\.publish/);
  assert.equal(
    result.hints?.[0]?.command,
    'npx tiktok-mcp-ai login --profile DEFAULT --scopes video.publish',
  );

  // And holding the scope, it reaches the handler.
  const allowed = await callTool(
    echoTool({ scopes: ['video.publish'] }),
    {},
    runtimeOf({
      profiles: [{ name: 'DEFAULT', scopes: ['video.publish'], authorized: true }],
    }),
  );
  assert.equal(allowed.ok, true);
});

test('a configured profile that lacks the scope keeps the --scopes remediation', async () => {
  const result = await callTool(
    echoTool({ scopes: ['video.publish'] }),
    {},
    runtimeOf({ profiles: [{ name: 'DEFAULT', scopes: ['video.list'] }] }),
  );
  const error = errorOf(result);
  assert.equal(error.code, 'missing_scope');
  assert.match(error.message, /was authorized without scope video\.publish/);
  assert.deepEqual(result.error?.details, {
    profile: 'DEFAULT',
    missing_scope: 'video.publish',
  });
  assert.equal(
    result.hints?.[0]?.command,
    'npx tiktok-mcp-ai login --profile DEFAULT --scopes video.publish',
  );
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
  opts: {
    packages?: ToolPackageLike[];
    prompts?: readonly PromptSpec[];
    resources?: readonly ResourceSpec[];
    runtime?: ServerRuntime;
  } = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const runtime = opts.runtime ?? runtimeOf();
  const handle = createServer({
    name: 'tiktok-mcp-ai',
    version: '0.0.0-test',
    packages: opts.packages ?? packagesOf(echoTool()),
    ...(opts.prompts === undefined ? {} : { prompts: opts.prompts }),
    ...(opts.resources === undefined ? {} : { resources: opts.resources }),
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

test('tools/list marks a tool whose alternation no profile covers', async () => {
  const { client, close } = await connectedClient({ packages: packagesOf(anyOfTool()) });
  try {
    const listed = await client.listTools();
    const tool = listed.tools.find((entry) => entry.name === 'tiktok_get_publish_status');
    assert.equal(
      tool?.description?.startsWith(
        '[UNAVAILABLE: requires scope video.publish or video.upload; ' +
          'no configured profile grants it. ' +
          'Fix: npx tiktok-mcp-ai login --scopes video.publish]',
      ),
      true,
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

test('tools/call with a blank account runs against the active profile', async () => {
  const used: string[] = [];
  const { client, close } = await connectedClient({
    runtime: runtimeOf({
      settings: settings({ TT_ACTIVE_PROFILE: 'WORK' }),
      profiles: [
        { name: 'DEFAULT', scopes: ['video.list'] },
        { name: 'WORK', scopes: ['video.list'] },
      ],
      onContext: (profile) => used.push(profile),
    }),
  });
  try {
    const result = await client.callTool({
      name: 'tiktok_list_videos',
      arguments: { account: '   ' },
    });
    assert.equal(result.isError, false, 'a blank account is not an unknown account');
    const structured = result.structuredContent as {
      ok: boolean;
      data: { meta: Record<string, unknown> };
    };
    assert.equal(structured.ok, true);
    assert.equal(structured.data.meta['account'], 'WORK');
    assert.deepEqual(used, ['WORK']);
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

/**
 * The server half of a linked pair with one fault injected: a progress
 * notification is refused, everything else is delivered untouched.
 *
 * A dropped frame cannot be staged any other way. `sendNotification` is handed
 * to the request handler by the SDK, so the only place a test can make it fail
 * is the transport underneath it — and `Transport` is the SDK's own seam for
 * exactly that, which keeps this a real session rather than a patched module.
 */
function refusingProgress(inner: Transport, reason: Error): Transport {
  return {
    start: () => inner.start(),
    close: () => inner.close(),
    send: (message, options) =>
      'method' in message && message.method === 'notifications/progress'
        ? Promise.reject(reason)
        : inner.send(message, options),
    get onclose() {
      return inner.onclose;
    },
    set onclose(handler) {
      inner.onclose = handler;
    },
    get onerror() {
      return inner.onerror;
    },
    set onerror(handler) {
      inner.onerror = handler;
    },
    get onmessage() {
      return inner.onmessage;
    },
    set onmessage(handler) {
      inner.onmessage = handler;
    },
  };
}

test('a progress frame the transport refuses is dropped, not raised at the tool', async () => {
  const log = recordingLogger();
  const reported: number[] = [];
  const spec = echoTool({
    handler: (_args, ctx) => {
      // Fire-and-forget by contract: the handler neither awaits the frame nor
      // is given anything to await, so a failed send must die where it lands.
      ctx.progress?.(1, 2);
      return Promise.resolve({ ok: true, data: { videos: [] } });
    },
  });
  const handle = createServer({
    name: 'tiktok-mcp-ai',
    version: '0.0.0-test',
    packages: packagesOf(spec),
    runtime: runtimeOf({ log }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([
    handle.server.connect(
      refusingProgress(serverTransport, new Error('client hung up mid-call')),
    ),
    client.connect(clientTransport),
  ]);

  try {
    const result = await client.callTool({ name: 'tiktok_list_videos' }, undefined, {
      onprogress: (progress) => reported.push(progress.progress),
    });

    // The call it described succeeded, and the client saw no progress at all —
    // a lost frame degrades the report, never the result.
    assert.equal(result.isError, false);
    assert.equal((result.structuredContent as { ok: boolean }).ok, true);
    assert.deepEqual(reported, []);

    // The rejection is swallowed one microtask later, so give it that turn.
    await flush();
    assert.ok(
      log.lines.includes('debug progress notification failed'),
      `the drop went unlogged: ${log.lines.join(' | ')}`,
    );
  } finally {
    await client.close();
    await handle.server.close();
  }
});

test('notifyListChanged reaches a connected client with both list_changed frames', async () => {
  const runtime = runtimeOf();
  const handle = createServer({
    name: 'tiktok-mcp-ai',
    version: '0.0.0-test',
    packages: packagesOf(echoTool()),
    resources: [videosResource()],
    runtime,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const notified: string[] = [];
  for (const method of [
    'notifications/tools/list_changed',
    'notifications/resources/list_changed',
  ] as const) {
    client.setNotificationHandler(z.object({ method: z.literal(method) }), () => {
      notified.push(method);
    });
  }
  await Promise.all([
    handle.server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    await handle.notifyListChanged();
    // One round trip is enough to guarantee both notifications were delivered.
    await client.listTools();
    // Tools first, then resources: a client that re-lists on the first frame
    // sees the tool markers the resource markers are derived from.
    assert.deepEqual(notified, [
      'notifications/tools/list_changed',
      'notifications/resources/list_changed',
    ]);
  } finally {
    await client.close();
    await handle.server.close();
  }
});

test('notifyListChanged still sends the resource frame when the tool frame fails, and rethrows the first failure', async () => {
  const handle = createServer({
    name: 'tiktok-mcp-ai',
    version: '0.0.0-test',
    packages: packagesOf(echoTool()),
    resources: [videosResource()],
    runtime: runtimeOf(),
  });
  const toolFailure = new Error('tools frame failed');
  const resourceFailure = new Error('resources frame failed');
  const attempted: string[] = [];
  handle.server.sendToolListChanged = () => {
    attempted.push('tools');
    return Promise.reject(toolFailure);
  };
  handle.server.sendResourceListChanged = () => {
    attempted.push('resources');
    return Promise.reject(resourceFailure);
  };
  await assert.rejects(handle.notifyListChanged(), (err: unknown) => err === toolFailure);
  assert.deepEqual(attempted, ['tools', 'resources']);

  // Only the second failing: that one is the failure reported.
  handle.server.sendToolListChanged = () => {
    attempted.push('tools');
    return Promise.resolve();
  };
  await assert.rejects(
    handle.notifyListChanged(),
    (err: unknown) => err === resourceFailure,
  );
  assert.deepEqual(attempted, ['tools', 'resources', 'tools', 'resources']);
});

// ---------------------------------------------------------------------------
// Prompts and resources over a real client session (TOOLS.md § 7)
// ---------------------------------------------------------------------------

/**
 * Rejects with a protocol error: an `McpError` of the given code whose message
 * matches. Matchers anchor at the end only — the client re-wraps the server's
 * `McpError`, whose message already carries the `MCP error <code>:` prefix.
 */
function protocolError(code: ErrorCode, message: RegExp): (err: unknown) => boolean {
  return (err: unknown): boolean => {
    assert.ok(err instanceof McpError, `expected an McpError, got ${String(err)}`);
    assert.equal(err.code, code);
    assert.match(err.message, message);
    return true;
  };
}

/** The envelope a `resources/read` result carries, parsed back from its text. */
function envelopeOf(
  result: Awaited<ReturnType<Client['readResource']>>,
  uri: string,
): { ok: boolean; data?: unknown; error?: unknown } {
  assert.equal(result.contents.length, 1);
  const [content] = result.contents;
  assert.equal(content?.uri, uri);
  assert.equal(content?.mimeType, 'application/json');
  assert.ok(content !== undefined && 'text' in content, 'expected a text content');
  return JSON.parse(content.text) as ReturnType<typeof envelopeOf>;
}

test('the server advertises prompts, resources, completions and the list_changed flags', async () => {
  const { client, close } = await connectedClient();
  try {
    const capabilities = client.getServerCapabilities();
    assert.deepEqual(capabilities?.tools, { listChanged: true });
    assert.deepEqual(capabilities?.prompts, {});
    assert.deepEqual(capabilities?.resources, { listChanged: true });
    assert.deepEqual(capabilities?.completions, {});
    assert.deepEqual(capabilities?.logging, {});
  } finally {
    await close();
  }
});

test('prompts/list advertises the prompts of enabled packages and omits the rest', async () => {
  const prompts = [
    guidePrompt({ name: 'tiktok_post_video_guided', package: 'publish-write' }),
    guidePrompt(),
  ];
  const { client, close } = await connectedClient({ prompts });
  try {
    const listed = await client.listPrompts();
    assert.deepEqual(
      listed.prompts.map((prompt) => prompt.name),
      ['tiktok_list_videos_guided'],
    );
    const [prompt] = listed.prompts;
    assert.equal(prompt?.title, 'List videos, guided');
    assert.deepEqual(prompt?.arguments, [
      { name: 'max_count', description: 'How many videos to list.', required: true },
      { name: 'account', description: 'The profile to read through.', required: false },
    ]);
  } finally {
    await close();
  }

  const all = await connectedClient({
    prompts,
    runtime: runtimeOf({ settings: settings({ TT_TOOL_PACKAGES: 'all' }) }),
  });
  try {
    assert.deepEqual(
      (await all.client.listPrompts()).prompts.map((prompt) => prompt.name),
      ['tiktok_post_video_guided', 'tiktok_list_videos_guided'],
    );
  } finally {
    await all.close();
  }
});

test('prompts/get renders the messages for validated arguments', async () => {
  const { client, close } = await connectedClient({ prompts: [guidePrompt()] });
  try {
    const bare = await client.getPrompt({
      name: 'tiktok_list_videos_guided',
      arguments: { max_count: '3' },
    });
    assert.equal(
      bare.description,
      'Walk the model through listing the creator’s recent videos.',
    );
    assert.deepEqual(bare.messages, [
      {
        role: 'user',
        content: { type: 'text', text: 'Call tiktok_list_videos with max_count 3.' },
      },
    ]);

    const scoped = await client.getPrompt({
      name: 'tiktok_list_videos_guided',
      arguments: { max_count: ' 5 ', account: 'work' },
    });
    assert.equal(
      (scoped.messages[0]?.content as { text: string }).text,
      'Call tiktok_list_videos with max_count 5 for account work.',
    );
  } finally {
    await close();
  }
});

test('prompts/get for an unknown or disabled prompt is a protocol error', async () => {
  const prompts = [
    guidePrompt(),
    guidePrompt({ name: 'tiktok_post_video_guided', package: 'publish-write' }),
  ];
  const { client, close } = await connectedClient({ prompts });
  try {
    await assert.rejects(
      client.getPrompt({ name: 'tiktok_nope', arguments: {} }),
      protocolError(ErrorCode.InvalidParams, /: Unknown prompt: tiktok_nope$/),
    );
    // Listed nowhere, so unknown — not "forbidden": the package gate leaves no
    // trace of what it removed.
    await assert.rejects(
      client.getPrompt({
        name: 'tiktok_post_video_guided',
        arguments: { video: 'a.mp4' },
      }),
      protocolError(ErrorCode.InvalidParams, /Unknown prompt: tiktok_post_video_guided/),
    );
  } finally {
    await close();
  }
});

test('cc-g1: prompts/get rejects unknown and missing arguments as protocol errors', async () => {
  const { client, close } = await connectedClient({ prompts: [guidePrompt()] });
  try {
    await assert.rejects(
      client.getPrompt({
        name: 'tiktok_list_videos_guided',
        arguments: { max_count: '3', maxcount: '4' },
      }),
      protocolError(
        ErrorCode.InvalidParams,
        /Invalid arguments for prompt tiktok_list_videos_guided: unknown argument "maxcount"/,
      ),
    );
    await assert.rejects(
      client.getPrompt({
        name: 'tiktok_list_videos_guided',
        arguments: { account: 'work' },
      }),
      protocolError(
        ErrorCode.InvalidParams,
        /Invalid arguments for prompt tiktok_list_videos_guided: missing required argument "max_count"/,
      ),
    );
    await assert.rejects(
      client.getPrompt({ name: 'tiktok_list_videos_guided' }),
      protocolError(ErrorCode.InvalidParams, /missing required argument "max_count"/),
    );
  } finally {
    await close();
  }
});

test('resources/list and resources/templates/list follow the tool gate', async () => {
  const videos = videosResource();
  const status = videosResource({
    uri: 'tiktok://publish/status',
    name: 'tiktok_publish_status',
    title: 'Publish status',
    tool: anyOfTool(),
  });
  const packages = packagesOf(echoTool(), anyOfTool());

  const both = await connectedClient({ packages, resources: [videos, status] });
  try {
    const listed = await both.client.listResources();
    assert.deepEqual(
      listed.resources.map((resource) => resource.uri),
      ['tiktok://videos/recent', 'tiktok://publish/status'],
    );
    assert.deepEqual(listed.resources[0], {
      uri: 'tiktok://videos/recent',
      name: 'tiktok_videos_recent',
      title: 'Recent videos',
      description:
        'The creator’s most recent public videos, as tiktok_list_videos returns them.',
      mimeType: 'application/json',
    });
    const templates = await both.client.listResourceTemplates();
    assert.deepEqual(
      templates.resourceTemplates.map((template) => template.uriTemplate),
      ['tiktok://videos/recent{?account}', 'tiktok://publish/status{?account}'],
    );
    assert.equal(templates.resourceTemplates[0]?.name, 'tiktok_videos_recent');
    assert.equal(templates.resourceTemplates[0]?.mimeType, 'application/json');
  } finally {
    await both.close();
  }

  // The publish package is denied: its tool is gone from tools/list, and the
  // resource that reads through it goes with it.
  const denied = await connectedClient({
    packages,
    resources: [videos, status],
    runtime: runtimeOf({ settings: settings({ TT_PACKAGES_DENY: 'publish' }) }),
  });
  try {
    assert.deepEqual(
      (await denied.client.listResources()).resources.map((resource) => resource.uri),
      ['tiktok://videos/recent'],
    );
    assert.deepEqual(
      (await denied.client.listResourceTemplates()).resourceTemplates.map(
        (template) => template.uriTemplate,
      ),
      ['tiktok://videos/recent{?account}'],
    );
  } finally {
    await denied.close();
  }
});

test('a resource whose tool no profile can call carries the [UNAVAILABLE] marker', async () => {
  const videos = videosResource();
  const queried = videosResource({
    uri: 'tiktok://videos/queried',
    name: 'tiktok_videos_queried',
    title: 'Queried videos',
    tool: echoTool({ name: 'tiktok_query_videos', scopes: ['video.publish'] }),
  });
  const { client, close } = await connectedClient({
    packages: packagesOf(echoTool(), queried.tool),
    resources: [videos, queried],
  });
  try {
    const marker =
      '[UNAVAILABLE: requires scope video.publish; no configured profile grants it. ' +
      'Fix: npx tiktok-mcp-ai login --scopes video.publish] ';
    const listed = await client.listResources();
    assert.deepEqual(
      listed.resources.map((resource) => resource.description),
      [videos.description, `${marker}${queried.description}`],
    );
    const templates = await client.listResourceTemplates();
    assert.deepEqual(
      templates.resourceTemplates.map((template) => template.description),
      [videos.description, `${marker}${queried.description}`],
    );
  } finally {
    await close();
  }
});

test('a template resource is listed by resources/templates/list only', async () => {
  const videos = videosResource();
  const status = statusResource();
  const { client, close } = await connectedClient({
    packages: packagesOf(echoTool(), status.tool),
    resources: [videos, status],
    runtime: runtimeOf({
      profiles: [{ name: 'DEFAULT', scopes: ['video.list', 'video.upload'] }],
    }),
  });
  try {
    // resources/list is concrete URIs only: a client cannot read a template verbatim.
    const listed = await client.listResources();
    assert.deepEqual(
      listed.resources.map((resource) => resource.uri),
      ['tiktok://videos/recent'],
    );
    // resources/templates/list carries both, the template with its path
    // parameter first and the account query after it.
    const templates = await client.listResourceTemplates();
    assert.deepEqual(
      templates.resourceTemplates.map((template) => template.uriTemplate),
      [
        'tiktok://videos/recent{?account}',
        'tiktok://publish/{publish_id}/status{?account}',
      ],
    );
    assert.deepEqual(templates.resourceTemplates[1], {
      uriTemplate: 'tiktok://publish/{publish_id}/status{?account}',
      name: 'tiktok_publish_status',
      title: 'Publish status',
      description: status.description,
      mimeType: 'application/json',
    });
  } finally {
    await close();
  }
});

test('a template resource carries the [UNAVAILABLE] marker of its scope alternation', async () => {
  const status = statusResource();
  const { client, close } = await connectedClient({
    packages: packagesOf(echoTool(), status.tool),
    resources: [status],
  });
  try {
    const templates = await client.listResourceTemplates();
    assert.equal(templates.resourceTemplates.length, 1);
    assert.match(
      templates.resourceTemplates[0]?.description ?? '',
      /^\[UNAVAILABLE: requires scope video\.publish or video\.upload; no configured profile grants it\. /,
    );
  } finally {
    await close();
  }
});

test('resources/read of a template uri hands the path parameter to the tool as an argument', async () => {
  const contexts: string[] = [];
  const status = statusResource();
  const { client, close } = await connectedClient({
    packages: packagesOf(echoTool(), status.tool),
    resources: [videosResource(), status],
    runtime: runtimeOf({
      profiles: [
        { name: 'DEFAULT', scopes: ['video.upload'] },
        { name: 'WORK', scopes: ['video.publish'] },
      ],
      onContext: (profile) => contexts.push(profile),
    }),
  });
  try {
    // The fixed argument and the path parameter both reach the tool; the
    // account defaults exactly as a bare tool call would.
    const bare = await client.readResource({ uri: 'tiktok://publish/v_abc-123/status' });
    const envelope = envelopeOf(bare, 'tiktok://publish/v_abc-123/status');
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.data, {
      args: { wait_for_completion: false, publish_id: 'v_abc-123' },
      profile: 'DEFAULT',
      videos: [],
      meta: { account: 'DEFAULT' },
    });

    // The query selects the profile, as on a concrete resource, and is matched
    // canonically: `work` runs as the stored WORK (CC-F4).
    const scoped = await client.readResource({
      uri: 'tiktok://publish/v_abc-123/status?account=work',
    });
    const other = envelopeOf(scoped, 'tiktok://publish/v_abc-123/status?account=work');
    assert.equal(other.ok, true);
    assert.deepEqual(other.data, {
      args: { wait_for_completion: false, publish_id: 'v_abc-123', account: 'work' },
      profile: 'WORK',
      videos: [],
      meta: { account: 'WORK' },
    });

    // A percent-encoded id reaches the tool decoded — the client's own value.
    const encoded = await client.readResource({ uri: 'tiktok://publish/v%2F1/status' });
    assert.deepEqual(
      (envelopeOf(encoded, 'tiktok://publish/v%2F1/status').data as { args: unknown })
        .args,
      { wait_for_completion: false, publish_id: 'v/1' },
    );
    assert.deepEqual(contexts, ['DEFAULT', 'WORK', 'DEFAULT']);
  } finally {
    await close();
  }
});

test('resources/read of a path no template matches is a protocol error', async () => {
  const status = statusResource();
  const { client, close } = await connectedClient({
    packages: packagesOf(echoTool(), status.tool),
    resources: [videosResource(), status],
    runtime: runtimeOf({ profiles: [{ name: 'DEFAULT', scopes: ['video.upload'] }] }),
  });
  try {
    for (const uri of [
      'tiktok://publish/status',
      'tiktok://publish//status',
      'tiktok://publish/a/b/status',
      'tiktok://publish/%E0%A4%A/status',
    ]) {
      await assert.rejects(
        client.readResource({ uri }),
        protocolError(
          ErrorCode.InvalidParams,
          /: Unknown resource: tiktok:\/\/publish\//,
        ),
        uri,
      );
    }
    // The template read verbatim is not special: `{publish_id}` is a non-empty
    // segment, so it is an id like any other and the tool, not the router,
    // answers for it.
    const verbatim = await client.readResource({
      uri: 'tiktok://publish/{publish_id}/status',
    });
    assert.deepEqual(
      (
        envelopeOf(verbatim, 'tiktok://publish/{publish_id}/status').data as {
          args: unknown;
        }
      ).args,
      { wait_for_completion: false, publish_id: '{publish_id}' },
    );
  } finally {
    await close();
  }
});

test('resources/read of a template uri follows the tool gate like a concrete one', async () => {
  const status = statusResource();
  const { client, close } = await connectedClient({
    packages: packagesOf(echoTool(), status.tool),
    resources: [videosResource(), status],
    runtime: runtimeOf({ settings: settings({ TT_PACKAGES_DENY: 'publish' }) }),
  });
  try {
    assert.deepEqual((await client.listResourceTemplates()).resourceTemplates.length, 1);
    await assert.rejects(
      client.readResource({ uri: 'tiktok://publish/v1/status' }),
      protocolError(
        ErrorCode.InvalidParams,
        /: Unknown resource: tiktok:\/\/publish\/v1\/status$/,
      ),
    );
  } finally {
    await close();
  }
});

test('resources/read returns the tool envelope as JSON text under the requested uri', async () => {
  const contexts: string[] = [];
  const { client, close } = await connectedClient({
    resources: [videosResource()],
    runtime: runtimeOf({
      profiles: [
        { name: 'DEFAULT', scopes: ['video.list'] },
        { name: 'WORK', scopes: ['video.list'] },
      ],
      onContext: (profile) => contexts.push(profile),
    }),
  });
  try {
    // The account is stamped into `data.meta` exactly as `tools/call` stamps it.
    const bare = await client.readResource({ uri: 'tiktok://videos/recent' });
    const envelope = envelopeOf(bare, 'tiktok://videos/recent');
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.data, {
      args: { max_count: 5 },
      profile: 'DEFAULT',
      videos: [],
      meta: { account: 'DEFAULT' },
    });

    // The query is the client's key for the snapshot, so it comes back verbatim.
    const scoped = await client.readResource({
      uri: 'tiktok://videos/recent?account=work',
    });
    const other = envelopeOf(scoped, 'tiktok://videos/recent?account=work');
    assert.equal(other.ok, true);
    // The query's account becomes the `account` argument the tool would take.
    assert.deepEqual(other.data, {
      args: { max_count: 5, account: 'work' },
      profile: 'WORK',
      videos: [],
      meta: { account: 'WORK' },
    });
    assert.deepEqual(contexts, ['DEFAULT', 'WORK']);
  } finally {
    await close();
  }
});

test('resources/read hands back an ok:false envelope as data, not as a protocol error', async () => {
  const { client, close } = await connectedClient({ resources: [videosResource()] });
  try {
    const result = await client.readResource({
      uri: 'tiktok://videos/recent?account=NOPE',
    });
    const envelope = envelopeOf(result, 'tiktok://videos/recent?account=NOPE');
    assert.equal(envelope.ok, false);
    assert.equal((envelope.error as { code: string }).code, 'unknown_account');
  } finally {
    await close();
  }
});

test('resources/read of a uri the server never listed is a protocol error', async () => {
  const { client, close } = await connectedClient({ resources: [videosResource()] });
  try {
    for (const uri of [
      'tiktok://videos/unknown',
      'tiktok://videos/recent/',
      'http://videos/recent',
      'tiktok://videos/recent?foo=bar',
    ]) {
      await assert.rejects(
        client.readResource({ uri }),
        protocolError(
          ErrorCode.InvalidParams,
          new RegExp(`: Unknown resource: ${uri.replaceAll('?', '\\?')}$`),
        ),
      );
    }
  } finally {
    await close();
  }
});

test('cc-g4: a resources/read forwards the client’s abort into the tool context', async () => {
  const entered = deferred<AbortSignal | undefined>();
  const released = deferred<ToolResult<unknown>>();
  const spec = echoTool({
    handler: (_args, ctx) => {
      entered.resolve(ctx.signal);
      ctx.signal?.addEventListener('abort', () => {
        released.resolve({ ok: true, data: { aborted: true } });
      });
      return released.promise;
    },
  });
  const { client, close } = await connectedClient({
    packages: packagesOf(spec),
    resources: [videosResource({ tool: spec })],
  });
  try {
    const controller = new AbortController();
    const pending = client.readResource(
      { uri: 'tiktok://videos/recent' },
      { signal: controller.signal },
    );
    const signal = await entered.promise;
    assert.ok(signal instanceof AbortSignal, 'the handler saw no signal');
    assert.equal(signal.aborted, false);

    controller.abort('the user closed the panel');
    await assert.rejects(pending, /the user closed the panel/);
    // The server-side signal is the SDK's per-request one, tripped by the
    // `notifications/cancelled` frame — with the client's reason, verbatim.
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason, 'the user closed the panel');
    assert.equal(released.settled, true);
  } finally {
    await close();
  }
});

test('a server built without prompts or resources answers empty lists', async () => {
  const { client, close } = await connectedClient();
  try {
    assert.deepEqual((await client.listPrompts()).prompts, []);
    assert.deepEqual((await client.listResources()).resources, []);
    assert.deepEqual((await client.listResourceTemplates()).resourceTemplates, []);
    await assert.rejects(
      client.readResource({ uri: 'tiktok://videos/recent' }),
      protocolError(
        ErrorCode.InvalidParams,
        /Unknown resource: tiktok:\/\/videos\/recent/,
      ),
    );
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// completion/complete (TOOLS.md § 7.3)
// ---------------------------------------------------------------------------

/** The three-profile runtime the completion tests read `account` from. */
function threeProfiles(overrides: Partial<RuntimeOptions> = {}): ServerRuntime {
  return runtimeOf({
    profiles: [
      { name: 'DEFAULT', scopes: ['video.list'] },
      { name: 'WORK', scopes: ['video.list'] },
      { name: 'DEMO', scopes: ['video.list'] },
    ],
    ...overrides,
  });
}

/** The status template with a fixed vocabulary behind `publish_id`. */
function completingStatusResource(): ResourceSpec {
  return statusResource({
    completions: { publish_id: { kind: 'values', values: ['v_pub_a', 'v_pub_b'] } },
  });
}

/** `tiktok://publish/{publish_id}/status` as `resources/templates/list` advertises it. */
const STATUS_TEMPLATE = 'tiktok://publish/{publish_id}/status{?account}';

test('completion/complete offers a prompt argument’s source, filtered by prefix', async () => {
  const prompt = guidePrompt({
    arguments: [
      {
        name: 'max_count',
        description: 'How many videos to list.',
        required: true,
        completion: { kind: 'values', values: ['5', '10', '20'] },
      },
      {
        name: 'account',
        description: 'The profile to read through.',
        required: false,
        completion: { kind: 'profiles' },
      },
    ],
  });
  const { client, close } = await connectedClient({
    prompts: [prompt],
    runtime: threeProfiles(),
  });
  try {
    const ref = { type: 'ref/prompt', name: 'tiktok_list_videos_guided' } as const;
    const accounts = await client.complete({
      ref,
      argument: { name: 'account', value: 'd' },
    });
    assert.deepEqual(accounts.completion, {
      values: ['DEFAULT', 'DEMO'],
      total: 2,
      hasMore: false,
    });
    const counts = await client.complete({
      ref,
      argument: { name: 'max_count', value: '1' },
    });
    assert.deepEqual(counts.completion, { values: ['10'], total: 1, hasMore: false });
    // prompts/list still shows the argument without its source.
    const listed = (await client.listPrompts()).prompts[0]?.arguments?.map((a) =>
      Object.keys(a),
    );
    assert.deepEqual(listed, [
      ['name', 'description', 'required'],
      ['name', 'description', 'required'],
    ]);
  } finally {
    await close();
  }
});

test('completion/complete answers nothing for a declared argument without a source', async () => {
  const { client, close } = await connectedClient({
    prompts: [guidePrompt()],
    runtime: threeProfiles(),
  });
  try {
    const result = await client.complete({
      ref: { type: 'ref/prompt', name: 'tiktok_list_videos_guided' },
      argument: { name: 'account', value: '' },
    });
    assert.deepEqual(result.completion, { values: [], total: 0, hasMore: false });
  } finally {
    await close();
  }
});

test('completion/complete rejects an undeclared prompt argument and an unknown or disabled prompt', async () => {
  const prompts = [
    guidePrompt(),
    guidePrompt({ name: 'tiktok_post_video_guided', package: 'publish-write' }),
  ];
  const { client, close } = await connectedClient({ prompts });
  try {
    await assert.rejects(
      client.complete({
        ref: { type: 'ref/prompt', name: 'tiktok_list_videos_guided' },
        argument: { name: 'x', value: '' },
      }),
      protocolError(
        ErrorCode.InvalidParams,
        /Invalid arguments for prompt tiktok_list_videos_guided: unknown argument "x"$/,
      ),
    );
    await assert.rejects(
      client.complete({
        ref: { type: 'ref/prompt', name: 'tiktok_nope' },
        argument: { name: 'account', value: '' },
      }),
      protocolError(ErrorCode.InvalidParams, /: Unknown prompt: tiktok_nope$/),
    );
    // Gated out with its package, so unknown — the same answer prompts/get gives.
    await assert.rejects(
      client.complete({
        ref: { type: 'ref/prompt', name: 'tiktok_post_video_guided' },
        argument: { name: 'account', value: '' },
      }),
      protocolError(
        ErrorCode.InvalidParams,
        /: Unknown prompt: tiktok_post_video_guided$/,
      ),
    );
  } finally {
    await close();
  }
});

test('completion/complete on a template completes account and its path parameter', async () => {
  const status = completingStatusResource();
  const { client, close } = await connectedClient({
    packages: packagesOf(echoTool(), status.tool),
    resources: [videosResource(), status],
    runtime: threeProfiles(),
  });
  try {
    const ref = { type: 'ref/resource', uri: STATUS_TEMPLATE } as const;
    const accounts = await client.complete({
      ref,
      argument: { name: 'account', value: 'w' },
    });
    assert.deepEqual(accounts.completion, { values: ['WORK'], total: 1, hasMore: false });
    const ids = await client.complete({
      ref,
      argument: { name: 'publish_id', value: 'V_PUB_B' },
    });
    assert.deepEqual(ids.completion, { values: ['v_pub_b'], total: 1, hasMore: false });
    // The template without its `{?account}` suffix names the same resource.
    const bare = await client.complete({
      ref: { type: 'ref/resource', uri: 'tiktok://publish/{publish_id}/status' },
      argument: { name: 'publish_id', value: '' },
    });
    assert.deepEqual(bare.completion.values, ['v_pub_a', 'v_pub_b']);
  } finally {
    await close();
  }
});

test('completion/complete on a concrete resource completes account and nothing else', async () => {
  const { client, close } = await connectedClient({
    resources: [videosResource()],
    runtime: threeProfiles(),
  });
  try {
    const ref = { type: 'ref/resource', uri: 'tiktok://videos/recent' } as const;
    const accounts = await client.complete({
      ref,
      argument: { name: 'account', value: '' },
    });
    assert.deepEqual(accounts.completion, {
      values: ['DEFAULT', 'WORK', 'DEMO'],
      total: 3,
      hasMore: false,
    });
    await assert.rejects(
      client.complete({ ref, argument: { name: 'max_count', value: '' } }),
      protocolError(
        ErrorCode.InvalidParams,
        /Invalid arguments for resource tiktok:\/\/videos\/recent: unknown argument "max_count"$/,
      ),
    );
  } finally {
    await close();
  }
});

test('completion/complete rejects an undeclared parameter and an unknown, read or disabled uri', async () => {
  const status = completingStatusResource();
  const { client, close } = await connectedClient({
    packages: packagesOf(echoTool(), status.tool),
    resources: [videosResource(), status],
    runtime: threeProfiles({ settings: settings({ TT_PACKAGES_DENY: 'publish' }) }),
  });
  try {
    // A fixed argument of the template is not a variable of the URI.
    await assert.rejects(
      client.complete({
        ref: { type: 'ref/resource', uri: 'tiktok://videos/recent' },
        argument: { name: 'wait_for_completion', value: '' },
      }),
      protocolError(
        ErrorCode.InvalidParams,
        /Invalid arguments for resource tiktok:\/\/videos\/recent: unknown argument "wait_for_completion"$/,
      ),
    );
    for (const uri of [
      'tiktok://nope',
      // A read uri names an instance, not the template.
      'tiktok://publish/v_pub_a/status',
      // Gated out with the publish package, so unknown.
      STATUS_TEMPLATE,
    ]) {
      await assert.rejects(
        client.complete({
          ref: { type: 'ref/resource', uri },
          argument: { name: 'account', value: '' },
        }),
        protocolError(
          ErrorCode.InvalidParams,
          new RegExp(`: Unknown resource: ${uri.replaceAll('?', '\\?')}$`),
        ),
      );
    }
  } finally {
    await close();
  }
});

test('completion/complete offers the locked profile alone under TT_LOCK_PROFILE', async () => {
  const { client, close } = await connectedClient({
    prompts: [
      guidePrompt({
        arguments: [
          { name: 'max_count', description: 'How many videos to list.', required: true },
          {
            name: 'account',
            description: 'The profile to read through.',
            required: false,
            completion: { kind: 'profiles' },
          },
        ],
      }),
    ],
    resources: [videosResource()],
    runtime: threeProfiles({ settings: settings({ TT_LOCK_PROFILE: 'work' }) }),
  });
  try {
    const viaPrompt = await client.complete({
      ref: { type: 'ref/prompt', name: 'tiktok_list_videos_guided' },
      argument: { name: 'account', value: '' },
    });
    assert.deepEqual(viaPrompt.completion, {
      values: ['WORK'],
      total: 1,
      hasMore: false,
    });
    const viaResource = await client.complete({
      ref: { type: 'ref/resource', uri: 'tiktok://videos/recent' },
      argument: { name: 'account', value: 'd' },
    });
    assert.deepEqual(viaResource.completion, { values: [], total: 0, hasMore: false });
  } finally {
    await close();
  }
});

test('completion/complete answers nothing and logs when a completion source fails', async () => {
  const warned: { msg: string; fields: Record<string, unknown> }[] = [];
  const make = (): Logger => ({
    debug: () => undefined,
    info: () => undefined,
    warn: (msg: string, fields: Record<string, unknown> = {}) => {
      warned.push({ msg, fields });
    },
    error: () => undefined,
    child: () => make(),
  });
  // Typed `unknown`: a runtime is caller-supplied, and nothing promises that
  // what it throws is an `Error`.
  let failure: unknown = new Error('the profile store is unreadable');
  const runtime: ServerRuntime = {
    ...runtimeOf({ log: make() }),
    profiles: () => {
      throw failure;
    },
  };
  const { client, close } = await connectedClient({
    prompts: [
      guidePrompt({
        arguments: [
          { name: 'max_count', description: 'How many videos to list.', required: true },
          {
            name: 'account',
            description: 'The profile to read through.',
            required: false,
            completion: { kind: 'profiles' },
          },
        ],
      }),
    ],
    resources: [videosResource()],
    runtime,
  });
  const empty = { values: [], total: 0, hasMore: false };
  try {
    const viaPrompt = await client.complete({
      ref: { type: 'ref/prompt', name: 'tiktok_list_videos_guided' },
      argument: { name: 'account', value: 'd' },
    });
    assert.deepEqual(viaPrompt.completion, empty);
    // A non-Error failure is logged by its string form.
    failure = 'EACCES';
    const viaResource = await client.complete({
      ref: { type: 'ref/resource', uri: 'tiktok://videos/recent' },
      argument: { name: 'account', value: '' },
    });
    assert.deepEqual(viaResource.completion, empty);
    assert.deepEqual(warned, [
      {
        msg: 'completion failed',
        fields: {
          ref: 'tiktok_list_videos_guided',
          argument: 'account',
          error: 'the profile store is unreadable',
        },
      },
      {
        msg: 'completion failed',
        fields: { ref: 'tiktok://videos/recent', argument: 'account', error: 'EACCES' },
      },
    ]);
  } finally {
    await close();
  }
});

test('completion/complete hands the context’s account to the journal-backed publish_id', async () => {
  const sandbox = await fsSandbox();
  const envFile = join(sandbox.dir, 'creds.env');
  const opts = { envFile };
  const intent = (attempt_id: string, profile: string): IntentRecord => ({
    v: 1,
    type: 'intent',
    ts: '2026-01-01T00:00:00.000Z',
    tool: 'tiktok_post_video',
    profile,
    open_id: 'open-1',
    plan_id: 'plan-1',
    payload_digest: 'digest-1',
    title_excerpt: 'A clip',
    source: 'FILE_UPLOAD',
    mode: 'direct',
    attempt_id,
  });
  const outcome = (attempt_id: string, publish_id: string): OutcomeRecord => ({
    v: 1,
    type: 'outcome',
    ts: '2026-01-01T00:00:01.000Z',
    result: 'ok',
    attempt_id,
    publish_id,
  });
  const status = statusResource({ completions: { publish_id: { kind: 'publish_ids' } } });
  const { client, close } = await connectedClient({
    packages: packagesOf(echoTool(), status.tool),
    resources: [status],
    runtime: threeProfiles({ settings: settings({ TT_ENV_FILE: envFile }) }),
  });
  try {
    for (const [id, profile, publishId] of [
      ['01JQ0000000000000000000001', 'DEFAULT', 'v_pub_a'],
      ['01JQ0000000000000000000002', 'WORK', 'v_pub_b'],
    ] as const) {
      assert.deepEqual(await appendIntent(intent(id, profile), opts), { ok: true });
      assert.deepEqual(await appendOutcome(outcome(id, publishId), opts), { ok: true });
    }
    const ref = { type: 'ref/resource', uri: STATUS_TEMPLATE } as const;
    const argument = { name: 'publish_id', value: 'v_' };
    const all = await client.complete({ ref, argument });
    assert.deepEqual(all.completion.values, ['v_pub_b', 'v_pub_a']);
    const work = await client.complete({
      ref,
      argument,
      context: { arguments: { account: 'WORK' } },
    });
    assert.deepEqual(work.completion, { values: ['v_pub_b'], total: 1, hasMore: false });
    const none = await client.complete({
      ref,
      argument,
      context: { arguments: { account: 'DEMO' } },
    });
    assert.deepEqual(none.completion, { values: [], total: 0, hasMore: false });
  } finally {
    await close();
    await sandbox.cleanup();
  }
});

test('completion/complete caps the answer at 100 values and says so', async () => {
  const values = Array.from(
    { length: 101 },
    (_, i) => `id_${String(i).padStart(3, '0')}`,
  );
  const { client, close } = await connectedClient({
    prompts: [
      guidePrompt({
        arguments: [
          {
            name: 'max_count',
            description: 'How many videos to list.',
            required: true,
            completion: { kind: 'values', values },
          },
        ],
      }),
    ],
  });
  try {
    const result = await client.complete({
      ref: { type: 'ref/prompt', name: 'tiktok_list_videos_guided' },
      argument: { name: 'max_count', value: 'ID_' },
    });
    assert.deepEqual(result.completion, {
      values: values.slice(0, 100),
      total: 101,
      hasMore: true,
    });
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// CC-G3 — stdout purity, proved against a real stdio transport
// ---------------------------------------------------------------------------

interface StdioSession {
  stdout: string;
  stderr: string;
  frames: Record<string, unknown>[];
  /** The child's own exit status; `null` when a signal ended it instead. */
  exitCode: number | null;
}

/**
 * Run the stdio worker as a real child, feed it `requests` as newline-delimited
 * JSON-RPC and collect both streams. The child is SIGKILLed if it outlives the
 * deadline, so a transport that never answers fails the test instead of hanging
 * the suite.
 *
 * Once every request has been answered the child's **stdin is closed** rather
 * than the child signalled. `StdioServerTransport` reads stdin and nothing else
 * holds the loop open, so EOF is this process's real end of life: it runs down
 * its own exit path and reports 0. Signalling it would prove the same thing
 * about stdout while skipping that exit — and a process that never exits never
 * writes its V8 coverage profile, which is why `connectStdio` read as uncovered
 * while this very test was exercising it.
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
  const done = new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`stdio worker did not answer in time; stderr: ${stderr}`));
    }, 15_000);
    timer.unref();
    child.on('error', reject);
    child.stdout.on('data', () => {
      // One line per response: hang up as soon as every request was answered.
      // `end()` is not idempotent, so the second frame must not repeat it.
      if (
        !child.stdin.writableEnded &&
        stdout.split('\n').filter((line) => line.trim() !== '').length >= expected
      ) {
        child.stdin.end();
      }
    });
    // `close`, not `exit`: it fires once the piped streams are drained too, so
    // the last frame cannot be lost to a race with the child's exit.
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  const exitCode = await done;

  const frames = stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { stdout, stderr, frames, exitCode };
}

test('cc-g3: a real stdio session writes JSON-RPC frames and nothing else', async () => {
  const { stdout, stderr, frames, exitCode } = await runStdioSession([
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

  // Nothing signalled it: `connectStdio` handed the session to stdin, so a
  // closed stdin is the whole shutdown and the worker leaves through the door.
  assert.equal(exitCode, 0, `the stdio worker did not exit cleanly; stderr: ${stderr}`);
});

// ---------------------------------------------------------------------------
// stdio drain: a signalled shutdown waits for the calls in flight
// ---------------------------------------------------------------------------

/** A live stdio drain worker the test converses with frame by frame. */
interface DrainChild {
  send(frame: unknown): void;
  /** Resolves once a stdout frame answers `id`. */
  frame(id: number): Promise<Record<string, unknown>>;
  /**
   * Resolves once `count` stdout frames answer `id`. stdout and stderr are
   * separate pipes, so a log line can reach the parent before a frame the
   * worker wrote ahead of it.
   */
  answers(id: number, count: number): Promise<Record<string, unknown>[]>;
  /** Resolves once a stderr log line has exactly this `msg`. */
  logged(msg: string): Promise<void>;
  /** The `msg` of every stderr log line, in the order they were written. */
  messages(): string[];
  frames(): Record<string, unknown>[];
  /** Closes stdin and resolves with the child's exit code. */
  end(): Promise<number | null>;
}

function startDrainWorker(scenario = 'calls'): DrainChild {
  const worker = fileURLToPath(
    new URL('./harness/workers/stdio-drain-worker.js', import.meta.url),
  );
  const child = spawn(process.execPath, [worker, scenario], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TIKTOK_MCP_TEST_INHERIT_ENV: '1' },
  });
  let stdout = '';
  let stderr = '';
  const waiters = new Set<() => void>();
  const wake = (): void => {
    for (const waiter of waiters) waiter();
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    wake();
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    wake();
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on('close', (code) => {
      resolve(code);
    });
  });
  const kill = setTimeout(() => {
    child.kill('SIGKILL');
  }, 15_000);
  kill.unref();

  const parse = (text: string): Record<string, unknown>[] =>
    text
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  const until = async <T>(find: () => T | undefined, what: string): Promise<T> =>
    await new Promise<T>((resolve, reject) => {
      const check = (): void => {
        const found = find();
        if (found !== undefined) {
          waiters.delete(check);
          resolve(found);
        }
      };
      waiters.add(check);
      void exited.then(() => {
        waiters.delete(check);
        reject(new Error(`the drain worker ended before ${what}; stderr: ${stderr}`));
      });
      check();
    });

  return {
    send: (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`),
    frame: async (id) =>
      await until(
        () => parse(stdout).find((frame) => frame['id'] === id),
        `frame ${String(id)}`,
      ),
    answers: async (id, count) =>
      await until(
        () => {
          const found = parse(stdout).filter((frame) => frame['id'] === id);
          return found.length >= count ? found : undefined;
        },
        `${String(count)} frames ${String(id)}`,
      ),
    logged: async (msg) =>
      await until(
        () => (parse(stderr).some((line) => line['msg'] === msg) ? true : undefined),
        `log "${msg}"`,
      ).then(() => undefined),
    messages: () => parse(stderr).map((line) => String(line['msg'])),
    frames: () => parse(stdout),
    end: async () => {
      child.stdin.end();
      const code = await exited;
      clearTimeout(kill);
      return code;
    },
  };
}

interface HoldOptions {
  drain?: 'start' | 'none' | 'signals';
  delayMs?: number;
  orphanError?: boolean;
}

function holdCall(
  id: number,
  label: string,
  mode: 'answer' | 'hold',
  budget: number,
  options: HoldOptions = {},
): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: 'tiktok_list_videos',
      arguments: {
        label,
        budget_ms: budget,
        mode,
        ...(options.drain === undefined ? {} : { drain: options.drain }),
        ...(options.delayMs === undefined ? {} : { delay_ms: options.delayMs }),
        ...(options.orphanError === undefined
          ? {}
          : { orphan_error: options.orphanError }),
      },
    },
  };
}

/** Start a drain worker for `scenario` and take it through the MCP handshake. */
async function initializedDrainWorker(scenario = 'calls'): Promise<DrainChild> {
  const child = startDrainWorker(scenario);
  await child.logged('worker ready');
  child.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    },
  });
  assert.ok('result' in (await child.frame(1)), 'initialize was not answered');
  child.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return child;
}

/** Assert `frame` is the drain's refusal of a new request. */
function assertRefused(frame: Record<string, unknown>, id: unknown): void {
  assert.deepEqual(frame, {
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message: 'Service Unavailable: the server is shutting down' },
  });
}

test('a stdio drain with nothing in flight returns at once and refuses every later request', async () => {
  const child = startDrainWorker('idle');
  let exitCode: number | null;
  try {
    // With nothing in flight the drain returns at once, whatever its budget.
    await child.logged('idle drain returned');
    await child.logged('worker ready');
    // Even the handshake is refused: the SDK never sees the request.
    child.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.0' },
      },
    });
    assertRefused(await child.frame(1), 1);
    // A notification is let through (and answered by nobody), a request whose
    // refusal cannot be written is dropped without an unhandled rejection, and
    // the next request is refused like the first.
    child.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    child.send({ jsonrpc: '2.0', id: 'reject-me', method: 'ping' });
    await child.logged('refusal write failed');
    child.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    assertRefused(await child.frame(2), 2);
    assert.deepEqual(
      child.frames().map((frame) => frame['id']),
      [1, 2],
      'something other than the two refusals was written',
    );
  } finally {
    exitCode = await child.end();
  }
  assert.equal(exitCode, 0, 'the drain worker did not exit cleanly');
});

test('a stdio drain waits for the answer in flight, then refuses new requests', async () => {
  const child = await initializedDrainWorker();
  let exitCode: number | null;
  try {
    // An answered call: the drain settles only after the handler has returned.
    child.send(holdCall(2, 'answer', 'answer', 600_000));
    await child.frame(2);
    await child.logged('drain settled: answer');
    const order = child.messages();
    assert.ok(
      order.indexOf('handler returning: answer') < order.indexOf('drain settled: answer'),
      `the drain settled before the answer: ${order.join(', ')}`,
    );
    // Draining: a new request gets the JSON-RPC refusal, not a result.
    child.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
    assertRefused(await child.frame(3), 3);
    child.send(holdCall(4, 'late', 'answer', 600_000, { drain: 'none' }));
    assertRefused(await child.frame(4), 4);
    assert.ok(
      !child.messages().includes('handler returning: late'),
      'a refused call reached its handler',
    );
  } finally {
    exitCode = await child.end();
  }
  assert.equal(exitCode, 0, 'the drain worker did not exit cleanly');
});

test('a stdio drain counts a reused in-flight id twice: the first answer does not end it', async () => {
  const child = await initializedDrainWorker();
  let exitCode: number | null;
  try {
    // The call that starts the drain goes last: a frame read after the drain
    // started would be refused, and stdin may deliver the two separately.
    child.send(holdCall(2, 'second', 'answer', 600_000, { drain: 'none', delayMs: 400 }));
    child.send(holdCall(2, 'first', 'answer', 600_000, { delayMs: 50 }));
    await child.logged('handler returning: first');
    await child.logged('drain settled: first');
    const order = child.messages();
    assert.ok(
      order.indexOf('handler returning: second') < order.indexOf('drain settled: first'),
      `the drain settled on the first of two answers to id 2: ${order.join(', ')}`,
    );
    // Both answers were written before the drain settled, but on stdout: wait
    // for them there rather than trusting the stderr line to arrive last.
    await child.answers(2, 2);
    assert.equal(
      child.frames().filter((frame) => frame['id'] === 2).length,
      2,
      'both calls under id 2 must be answered, and only once each',
    );
  } finally {
    exitCode = await child.end();
  }
  assert.equal(exitCode, 0, 'the drain worker did not exit cleanly');
});

test('a stdio drain is settled by a cancel of the call in flight, and only by that', async () => {
  const child = await initializedDrainWorker();
  let exitCode: number | null;
  try {
    // A call that is never answered: only its cancellation settles the drain.
    child.send(holdCall(3, 'cancel', 'hold', 600_000, { orphanError: true }));
    await child.logged('hold started: cancel');
    // An error response with no id answers nothing; cancellations that name
    // nothing in flight, and a request refused meanwhile, must not settle it.
    assert.ok(child.messages().includes('orphan error sent: cancel'));
    child.send({ jsonrpc: '2.0', method: 'notifications/cancelled' });
    child.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 999 },
    });
    child.send({ jsonrpc: '2.0', id: 4, method: 'ping' });
    assertRefused(await child.frame(4), 4);
    assert.ok(
      !child.messages().includes('drain settled: cancel'),
      'the drain settled with the held call still open',
    );
    // A cancel still passes through while draining: the handler is aborted.
    child.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 3, reason: 'test' },
    });
    await child.logged('drain settled: cancel');
    await child.logged('hold aborted: cancel');
    // Cancelled calls get no answer at all.
    const ids = child.frames().map((frame) => frame['id']);
    assert.ok(!ids.includes(3), `a cancelled call was answered: ${ids.join(',')}`);
  } finally {
    exitCode = await child.end();
  }
  assert.equal(exitCode, 0, 'the drain worker did not exit cleanly');
});

test('a stdio drain cancel clears every call under a reused id', async () => {
  const child = await initializedDrainWorker();
  let exitCode: number | null;
  try {
    child.send(holdCall(3, 'twice-a', 'hold', 600_000, { drain: 'none' }));
    child.send(holdCall(3, 'twice-b', 'hold', 600_000));
    await child.logged('hold started: twice-a');
    await child.logged('hold started: twice-b');
    // One cancel names the id both calls share: the drain is done with both.
    child.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 3 },
    });
    await child.logged('drain settled: twice-b');
  } finally {
    exitCode = await child.end();
  }
  assert.equal(exitCode, 0, 'the drain worker did not exit cleanly');
});

test('a stdio drain budget ends the wait, not the call', async () => {
  const child = await initializedDrainWorker();
  let exitCode: number | null;
  try {
    child.send(holdCall(5, 'budget', 'hold', 50));
    await child.logged('hold started: budget');
    await child.logged('drain settled: budget');
    assert.ok(
      !child.messages().includes('hold aborted: budget'),
      'the budget must end the wait, not the call',
    );
    child.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 5 },
    });
    await child.logged('hold aborted: budget');
    const ids = child.frames().map((frame) => frame['id']);
    assert.ok(!ids.includes(5), `a cancelled call was answered: ${ids.join(',')}`);
  } finally {
    exitCode = await child.end();
  }
  assert.equal(exitCode, 0, 'the drain worker did not exit cleanly');
});

test('a stdio drain ends when its signal aborts: already on entry, or on stdin EOF', async () => {
  const child = await initializedDrainWorker();
  let exitCode: number | null;
  try {
    // One call starts both drains: once the first has started, a second call
    // would be refused, and whether it arrived first depends on how stdin
    // happened to chunk the frames.
    child.send(holdCall(2, 'eof', 'hold', 600_000, { drain: 'signals' }));
    await child.logged('hold started: eof');
    // An aborted signal on entry returns at once, with the call still open.
    await child.logged('drain settled: pre-aborted');
    assert.ok(
      !child.messages().includes('drain settled: eof'),
      'the EOF drain settled before the client went away',
    );
  } finally {
    // The client hangs up: the 600 s drain must end now, and nothing else keeps
    // the worker alive — a drain that ignored its signal would hold the loop
    // open until the SIGKILL, which exits with no code.
    exitCode = await child.end();
  }
  assert.ok(
    child.messages().includes('drain settled: eof'),
    `the drain did not settle on EOF: ${child.messages().join(', ')}`,
  );
  assert.ok(
    !child.messages().includes('hold aborted: eof'),
    'EOF ends the drain, not the calls',
  );
  assert.equal(exitCode, 0, 'the drain worker did not exit cleanly');
});

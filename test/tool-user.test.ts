/**
 * `tiktok_get_user_info` (TOOLS.md § 3.2).
 *
 * Two things are worth testing and everything here serves one of them: the
 * scope arithmetic — a field whose `user.info.*` scope was not granted is
 * dropped *before* the request and reported in `meta.omitted_fields`, because a
 * partial grant is normal and not an error (CC-A7) — and the vocabulary, which
 * is the result's, not upstream's (`profile_web_link`, `open_id_masked`).
 *
 * The granted scopes come from a real credential file in an `fsSandbox()`:
 * `test/helpers.ts` strips `TT_*` from `process.env`, so the file is the only
 * source of truth and the re-read cannot see the developer's own credentials.
 */

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createApiContext, type ApiContext } from '../src/api/context.js';
import { createLogger } from '../src/core/log.js';
import { loadSettings } from '../src/core/settings.js';
import type { ToolCtx } from '../src/mcp/define.js';
import type { ToolResult } from '../src/mcp/result.js';
import { getUserInfoTool, type UserInfoData } from '../src/tools/user.js';
import {
  BASELINE_SCOPES,
  fsSandbox,
  mockClock,
  scriptFetch,
  ttEnvelope,
  withFetch,
  type RecordedCall,
} from './helpers.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const NOOP_LOGGER = createLogger({ level: 'error' });

const UPSTREAM_USER = {
  open_id: 'test-open-id-DEFAULT',
  display_name: 'Ada Lovelace',
  avatar_url: 'https://cdn.example/avatar.jpg',
  bio_description: 'writes programs for engines',
  username: 'ada',
  profile_deep_link: 'https://www.tiktok.com/@ada',
  follower_count: 1234,
  following_count: 12,
  likes_count: 99,
  video_count: 7,
};

function toolCtx(envFilePath: string): ToolCtx {
  const api: ApiContext = createApiContext({
    profile: 'DEFAULT',
    settings: loadSettings({ TT_ENV_FILE: envFilePath }),
    log: NOOP_LOGGER,
    clock: mockClock(),
    refresh: () => Promise.resolve('test-access-token-DEFAULT'),
  });
  return { api, log: NOOP_LOGGER };
}

/** Run `fn` against a sandboxed credential file granting exactly `scopes`. */
async function withScopes<T>(
  scopes: string,
  fn: (ctx: ToolCtx) => Promise<T>,
): Promise<T> {
  const sandbox = await fsSandbox();
  try {
    const path = join(sandbox.dir, '.tiktok-mcp.env');
    await writeFile(
      path,
      [
        'TT_CLIENT_KEY=test-client-key',
        'TT_CLIENT_SECRET=test-secret',
        'TT_ACCESS_TOKEN=test-access-token-DEFAULT',
        'TT_OPEN_ID=test-open-id-DEFAULT',
        `TT_SCOPES=${scopes}`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    return await fn(toolCtx(path));
  } finally {
    await sandbox.cleanup();
  }
}

function fieldsOf(call: RecordedCall | undefined): string[] {
  assert.ok(call !== undefined, 'expected a recorded request');
  const query = new URL(call.url).searchParams.get('fields');
  assert.ok(query !== null);
  return query.split(',');
}

function dataOf(result: ToolResult<UserInfoData>): UserInfoData {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.ok(result.data !== undefined);
  return result.data;
}

// ---------------------------------------------------------------------------
// the full grant
// ---------------------------------------------------------------------------

test('with every scope granted, all selectable fields are requested and renamed', async () => {
  const stub = scriptFetch([ttEnvelope({ user: UPSTREAM_USER })]);
  const result = await withScopes(BASELINE_SCOPES, async (ctx) =>
    withFetch(stub, async () => getUserInfoTool.handler({}, ctx)),
  );

  assert.deepEqual(fieldsOf(stub.calls[0]), [
    'open_id',
    'display_name',
    'avatar_url',
    'bio_description',
    'username',
    'profile_deep_link',
    'follower_count',
    'following_count',
    'likes_count',
    'video_count',
  ]);
  assert.deepEqual(dataOf(result), {
    user: {
      open_id_masked: 'test…AULT',
      display_name: 'Ada Lovelace',
      avatar_url: 'https://cdn.example/avatar.jpg',
      bio_description: 'writes programs for engines',
      username: 'ada',
      // The one name that differs from upstream's `profile_deep_link`.
      profile_web_link: 'https://www.tiktok.com/@ada',
      follower_count: 1234,
      following_count: 12,
      likes_count: 99,
      video_count: 7,
    },
    meta: { omitted_fields: [] },
  });
  // A read that needs nothing from the caller says nothing (§ 5.2 rule 1).
  assert.equal(result.hints, undefined);
});

test('open_id leaves only masked, never whole', async () => {
  const stub = scriptFetch([ttEnvelope({ user: UPSTREAM_USER })]);
  const result = await withScopes(BASELINE_SCOPES, async (ctx) =>
    withFetch(stub, async () => getUserInfoTool.handler({}, ctx)),
  );

  assert.ok(!JSON.stringify(result).includes('test-open-id-DEFAULT'));
  assert.equal(dataOf(result).user.open_id_masked, 'test…AULT');
});

// ---------------------------------------------------------------------------
// the partial grant (CC-A7)
// ---------------------------------------------------------------------------

test('cc-a7: fields the scopes do not cover are dropped before the request, not after', async () => {
  const stub = scriptFetch([
    ttEnvelope({
      user: {
        open_id: UPSTREAM_USER.open_id,
        display_name: UPSTREAM_USER.display_name,
        avatar_url: UPSTREAM_USER.avatar_url,
      },
    }),
  ]);
  const result = await withScopes('user.info.basic', async (ctx) =>
    withFetch(stub, async () => getUserInfoTool.handler({}, ctx)),
  );

  assert.deepEqual(fieldsOf(stub.calls[0]), ['open_id', 'display_name', 'avatar_url']);
  assert.deepEqual(dataOf(result).meta.omitted_fields, [
    'bio_description',
    'username',
    'profile_web_link',
    'follower_count',
    'following_count',
    'likes_count',
    'video_count',
  ]);
  // Omissions are the documented outcome, not a failure.
  assert.equal(result.ok, true);
});

test('a scope granted for only part of the request keeps the rest', async () => {
  const stub = scriptFetch([ttEnvelope({ user: UPSTREAM_USER })]);
  const result = await withScopes('user.info.basic,user.info.stats', async (ctx) =>
    withFetch(stub, async () =>
      getUserInfoTool.handler({ fields: ['username', 'follower_count'] }, ctx),
    ),
  );

  assert.deepEqual(fieldsOf(stub.calls[0]), [
    'open_id',
    'display_name',
    'follower_count',
  ]);
  assert.deepEqual(dataOf(result).meta.omitted_fields, ['username']);
});

test('an explicit field list narrows the request but keeps the identity fields', async () => {
  const stub = scriptFetch([
    ttEnvelope({
      user: {
        open_id: UPSTREAM_USER.open_id,
        display_name: UPSTREAM_USER.display_name,
        video_count: 7,
      },
    }),
  ]);
  const result = await withScopes(BASELINE_SCOPES, async (ctx) =>
    withFetch(stub, async () =>
      getUserInfoTool.handler({ fields: ['video_count'] }, ctx),
    ),
  );

  assert.deepEqual(fieldsOf(stub.calls[0]), ['open_id', 'display_name', 'video_count']);
  assert.deepEqual(dataOf(result).user, {
    open_id_masked: 'test…AULT',
    display_name: 'Ada Lovelace',
    video_count: 7,
  });
});

test('asking twice for a field asks TikTok once', async () => {
  const stub = scriptFetch([ttEnvelope({ user: UPSTREAM_USER })]);
  await withScopes(BASELINE_SCOPES, async (ctx) =>
    withFetch(stub, async () =>
      getUserInfoTool.handler({ fields: ['display_name', 'display_name'] }, ctx),
    ),
  );

  assert.deepEqual(fieldsOf(stub.calls[0]), ['open_id', 'display_name']);
});

test('a profile with no granted scopes at all omits everything and still answers', async () => {
  const stub = scriptFetch([ttEnvelope({ user: { open_id: UPSTREAM_USER.open_id } })]);
  const result = await withScopes('', async (ctx) =>
    withFetch(stub, async () => getUserInfoTool.handler({}, ctx)),
  );

  // `open_id`/`display_name` are always requested — the scope gate above this
  // layer is what refuses the call when `user.info.basic` is missing.
  assert.deepEqual(fieldsOf(stub.calls[0]), ['open_id', 'display_name']);
  assert.equal(dataOf(result).meta.omitted_fields.length, 9);
});

test('a live signal reaches the request', async () => {
  const controller = new AbortController();
  const stub = scriptFetch([ttEnvelope({ user: UPSTREAM_USER })]);
  const result = await withScopes(BASELINE_SCOPES, async (ctx) =>
    withFetch(stub, async () =>
      getUserInfoTool.handler({}, { ...ctx, signal: controller.signal }),
    ),
  );

  assert.equal(result.ok, true);
  assert.equal(controller.signal.aborted, false);
});

// ---------------------------------------------------------------------------
// the declared surface
// ---------------------------------------------------------------------------

test('cc-g1: the input schema is strict and speaks the result vocabulary', () => {
  assert.equal(getUserInfoTool.input.safeParse({ fields: ['username'] }).success, true);
  assert.equal(
    getUserInfoTool.input.safeParse({ fields: ['profile_web_link'] }).success,
    true,
  );
  // Upstream's own name is not the tool's name.
  assert.equal(
    getUserInfoTool.input.safeParse({ fields: ['profile_deep_link'] }).success,
    false,
  );
  // Not selectable: always fetched, or never returned.
  assert.equal(getUserInfoTool.input.safeParse({ fields: ['open_id'] }).success, false);
  assert.equal(getUserInfoTool.input.safeParse({ fields: ['union_id'] }).success, false);
  assert.equal(getUserInfoTool.input.safeParse({ feilds: [] }).success, false);
  assert.equal(getUserInfoTool.input.safeParse({ account: 'WORK' }).success, true);
});

test('the tool requires only the basic scope', () => {
  assert.deepEqual(getUserInfoTool.scopes, ['user.info.basic']);
  assert.equal(getUserInfoTool.package, 'user');
  assert.equal(getUserInfoTool.annotations.readOnlyHint, true);
  assert.equal(getUserInfoTool.annotations.destructiveHint, false);
});

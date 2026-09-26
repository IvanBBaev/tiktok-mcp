import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ErrorCode,
  McpError,
  type ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { isTikTokError, TikTokError } from '../src/core/errors.js';
import { loadSettings, type Settings } from '../src/core/settings.js';
import {
  defineTool,
  toolInput,
  type AnyToolSpec,
  type ToolSpec,
} from '../src/mcp/define.js';
import {
  RESOURCE_MIME_TYPE,
  RESOURCE_SCHEME,
  defineResource,
  describeResource,
  describeResourceTemplate,
  isResourceTemplate,
  matchResource,
  matchResourceRef,
  parseResourceUri,
  resourceArgs,
  resourceCompletion,
  resourceContents,
  resourceParams,
  type ResourceMatch,
  type ResourceSpec,
} from '../src/mcp/resources.js';
import { truncateResult, type ToolResult } from '../src/mcp/result.js';
import { baselineEnv } from './helpers.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Settings from the real loader, so the fixtures cannot drift from the schema. */
function settings(overrides: Record<string, string> = {}): Settings {
  return loadSettings({ ...baselineEnv(), ...overrides });
}

/** A read-only fixture tool — the shape a resource may bind to. */
function readOnlyTool(
  overrides: Partial<ToolSpec<Record<string, unknown>, unknown>> = {},
): AnyToolSpec {
  return defineTool({
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
}

/** A spec that satisfies every rule, so each case can break exactly one thing. */
function validSpec(overrides: Partial<ResourceSpec> = {}): ResourceSpec {
  return {
    uri: 'tiktok://videos/recent',
    name: 'tiktok_videos_recent',
    title: 'Recent videos',
    description: 'The newest page of public videos, as tiktok_list_videos returns it.',
    tool: readOnlyTool(),
    args: {},
    ...overrides,
  };
}

/** A read-only fixture tool that needs an id — the shape a template binds to. */
function statusTool(): AnyToolSpec {
  return readOnlyTool({
    name: 'tiktok_get_publish_status',
    title: 'Get publish status',
    package: 'publish',
    scopes: [],
    input: toolInput({
      publish_id: z.string().min(1),
      wait_for_completion: z.boolean().optional(),
    }),
  });
}

/** A template spec: one `{publish_id}` segment, one fixed argument. */
function templateSpec(overrides: Partial<ResourceSpec> = {}): ResourceSpec {
  return {
    uri: 'tiktok://publish/{publish_id}/status',
    name: 'tiktok_publish_status',
    title: 'Publish status',
    description: 'One publish attempt by id, as tiktok_get_publish_status returns it.',
    tool: statusTool(),
    args: { wait_for_completion: false },
    ...overrides,
  };
}

/** The match a concrete spec resolves to: itself, with no parameters. */
function concreteMatch(spec: ResourceSpec): ResourceMatch {
  return { spec, params: {} };
}

/** The `TikTokError` a bad spec must throw, or a failure if it was accepted. */
function specError(overrides: Partial<ResourceSpec>): TikTokError {
  try {
    defineResource(validSpec(overrides));
  } catch (err) {
    assert.ok(isTikTokError(err), `expected a TikTokError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected defineResource to reject the spec');
}

const MARKER = '[UNAVAILABLE: no configured profile grants video.list]';

/** The one text content a read must carry — a blob or a second entry is a failure. */
function textOf(read: ReadResourceResult): string {
  assert.equal(read.contents.length, 1);
  const [content] = read.contents;
  assert.ok(content !== undefined && 'text' in content, 'expected a text content');
  return content.text;
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

test('the scheme and the mime type are the documented literals', () => {
  assert.equal(RESOURCE_SCHEME, 'tiktok://');
  assert.equal(RESOURCE_MIME_TYPE, 'application/json');
});

// ---------------------------------------------------------------------------
// defineResource — import-time assertions
// ---------------------------------------------------------------------------

test('defineResource returns the spec unchanged for a valid definition', () => {
  const spec = validSpec();
  assert.equal(defineResource(spec), spec);
});

test('defineResource freezes the spec and its args', () => {
  const spec = defineResource(validSpec({ args: { max_count: 5 } }));
  assert.ok(Object.isFrozen(spec));
  assert.ok(Object.isFrozen(spec.args));
});

test('defineResource rejects a URI with a query, a trailing slash, uppercase or another scheme', () => {
  const bad = [
    'tiktok://videos/recent?account=work',
    'tiktok://videos/recent/',
    'tiktok://Videos/Recent',
    'https://videos/recent',
    'tiktok://',
    'tiktok://videos//recent',
    'tiktok://videos/recent#top',
    'tiktok://videos/recent_',
    'tiktok://videos/re cent',
  ];
  for (const uri of bad) {
    const err = specError({ uri: uri as ResourceSpec['uri'] });
    assert.equal(err.code, 'invalid_resource_spec', uri);
    assert.equal(err.kind, 'internal', uri);
    assert.match(err.message, /no query or trailing slash/, uri);
    assert.ok(err.message.includes(`"${uri}"`), uri);
  }
});

test('defineResource rejects a name outside the tiktok_ snake-case grammar', () => {
  for (const name of [
    'videos_recent',
    'tiktok_VideosRecent',
    'tiktok_',
    'tiktok_videos__recent',
    'tiktok_videos_recent ',
  ]) {
    const err = specError({ name });
    assert.equal(err.code, 'invalid_resource_spec', name);
    assert.match(err.message, /lowercase snake case prefixed with "tiktok_"/, name);
  }
});

test('defineResource rejects a blank title or description', () => {
  const title = specError({ title: '  ' });
  assert.equal(title.code, 'invalid_resource_spec');
  assert.match(title.message, /title is empty/);
  const description = specError({ description: '' });
  assert.equal(description.code, 'invalid_resource_spec');
  assert.match(description.message, /description is empty/);
});

test('defineResource rejects a tool that is not read-only', () => {
  const writer = readOnlyTool({
    name: 'tiktok_post_video',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  });
  const err = specError({ tool: writer });
  assert.equal(err.code, 'invalid_resource_spec');
  assert.match(err.message, /tool "tiktok_post_video" is not read-only/);
});

test('defineResource rejects args that fix the account', () => {
  const err = specError({ args: { account: 'work' } });
  assert.equal(err.code, 'invalid_resource_spec');
  assert.match(err.message, /args fixes "account"/);
  // An explicitly undefined account is still the key being fixed.
  assert.equal(specError({ args: { account: undefined } }).code, 'invalid_resource_spec');
});

test('defineResource accepts {name} path segments after the host segment', () => {
  const spec = templateSpec();
  assert.equal(defineResource(spec), spec);
  assert.ok(Object.isFrozen(spec));
  const two = defineResource(
    templateSpec({ uri: 'tiktok://publish/{publish_id}/part/{index}', args: {} }),
  );
  assert.deepEqual(resourceParams(two), ['publish_id', 'index']);
});

test('defineResource rejects a {name} segment outside the argument-name grammar, or in the host', () => {
  const bad = [
    'tiktok://{publish_id}/status',
    'tiktok://publish/{Publish_id}/status',
    'tiktok://publish/{publish-id}/status',
    'tiktok://publish/{}/status',
    'tiktok://publish/{_id}/status',
    'tiktok://publish/{1id}/status',
    'tiktok://publish/{publish_id}x/status',
    'tiktok://publish/x{publish_id}/status',
    'tiktok://publish/{publish_id/status',
    'tiktok://publish/{publish__id}/status',
  ];
  for (const uri of bad) {
    const err = specError({ ...templateSpec(), uri: uri as ResourceSpec['uri'] });
    assert.equal(err.code, 'invalid_resource_spec', uri);
    assert.match(err.message, /no query or trailing slash/, uri);
  }
});

test('defineResource rejects a repeated path parameter', () => {
  const err = specError({
    ...templateSpec(),
    uri: 'tiktok://publish/{publish_id}/{publish_id}',
  });
  assert.equal(err.code, 'invalid_resource_spec');
  assert.match(err.message, /a path parameter is repeated/);
});

test('defineResource rejects a path parameter named account', () => {
  const err = specError({ ...templateSpec(), uri: 'tiktok://publish/{account}/status' });
  assert.equal(err.code, 'invalid_resource_spec');
  assert.match(err.message, /a path parameter is named "account"/);
});

test('defineResource rejects args that fix a path parameter', () => {
  const err = specError({
    ...templateSpec(),
    args: { wait_for_completion: false, publish_id: 'fixed' },
  });
  assert.equal(err.code, 'invalid_resource_spec');
  assert.match(err.message, /args fixes "publish_id", which the URI also carries/);
  // The account rule still fires first on a template, with its own message.
  const account = specError({ ...templateSpec(), args: { account: 'work' } });
  assert.match(account.message, /args fixes "account"/);
});

test('defineResource rejects completions for a name the URI does not carry', () => {
  const err = specError({
    ...templateSpec(),
    completions: { wait_for_completion: { kind: 'values', values: ['true'] } },
  });
  assert.equal(err.code, 'invalid_resource_spec');
  assert.match(
    err.message,
    /completions names "wait_for_completion", which the URI does not carry/,
  );
});

test('defineResource rejects completions for account — the server completes that', () => {
  const err = specError({
    ...templateSpec(),
    completions: { account: { kind: 'profiles' } },
  });
  assert.match(err.message, /completions names "account" — the server completes that/);
});

test('defineResource rejects a "values" completion that lists nothing or repeats', () => {
  const empty = specError({
    ...templateSpec(),
    completions: { publish_id: { kind: 'values', values: [] } },
  });
  assert.match(
    empty.message,
    /completion for "publish_id": a "values" completion lists no values/,
  );
  const twice = specError({
    ...templateSpec(),
    completions: { publish_id: { kind: 'values', values: ['a', 'a'] } },
  });
  assert.match(
    twice.message,
    /completion for "publish_id": a "values" completion repeats "a"/,
  );
});

test('defineResource accepts and freezes completions for a path parameter', () => {
  const spec = defineResource(
    templateSpec({ completions: { publish_id: { kind: 'publish_ids' } } }),
  );
  assert.ok(Object.isFrozen(spec.completions));
  assert.deepEqual(spec.completions, { publish_id: { kind: 'publish_ids' } });
});

test('resourceCompletion: account from the profiles, a parameter from the spec, else nothing', () => {
  const declared = defineResource(
    templateSpec({ completions: { publish_id: { kind: 'publish_ids' } } }),
  );
  assert.deepEqual(resourceCompletion(declared, 'account'), { kind: 'profiles' });
  assert.deepEqual(resourceCompletion(declared, 'publish_id'), { kind: 'publish_ids' });
  const bare = defineResource(templateSpec());
  assert.equal(resourceCompletion(bare, 'publish_id'), undefined);
  // A concrete resource has the account variable too — every template lists it.
  assert.deepEqual(resourceCompletion(defineResource(validSpec()), 'account'), {
    kind: 'profiles',
  });
});

test('resourceCompletion rejects a name that is not a variable of the template', () => {
  const spec = defineResource(templateSpec());
  for (const name of ['wait_for_completion', 'publish', 'id']) {
    assert.throws(
      () => resourceCompletion(spec, name),
      (err: unknown) => {
        assert.ok(err instanceof McpError);
        assert.equal(err.code, ErrorCode.InvalidParams);
        assert.match(
          err.message,
          new RegExp(
            `Invalid arguments for resource tiktok://publish/\\{publish_id\\}/status: unknown argument "${name}"$`,
          ),
        );
        return true;
      },
    );
  }
});

test('matchResourceRef finds a spec by its canonical URI or by its listed template', () => {
  const concrete = defineResource(validSpec());
  const template = defineResource(templateSpec());
  const specs = [concrete, template];
  assert.equal(matchResourceRef(specs, 'tiktok://videos/recent'), concrete);
  assert.equal(matchResourceRef(specs, 'tiktok://videos/recent{?account}'), concrete);
  assert.equal(matchResourceRef(specs, 'tiktok://publish/{publish_id}/status'), template);
  assert.equal(
    matchResourceRef(specs, 'tiktok://publish/{publish_id}/status{?account}'),
    template,
  );
  // A read URI is not a reference: the template is named by its variables.
  assert.equal(matchResourceRef(specs, 'tiktok://publish/v_pub_1/status'), undefined);
  assert.equal(matchResourceRef(specs, 'tiktok://videos/recent?account=WORK'), undefined);
  assert.equal(matchResourceRef([], 'tiktok://videos/recent'), undefined);
});

test('resourceParams and isResourceTemplate tell a template from a concrete spec', () => {
  const concrete = defineResource(validSpec());
  const template = defineResource(templateSpec());
  assert.deepEqual(resourceParams(concrete), []);
  assert.equal(isResourceTemplate(concrete), false);
  assert.deepEqual(resourceParams(template), ['publish_id']);
  assert.equal(isResourceTemplate(template), true);
});

test('a spec error carries the remediation that points at the server, not the request', () => {
  const err = specError({ title: '' });
  assert.equal(err.retryable, false);
  assert.match(err.remediation ?? '', /bug in the server, not in the request/);
});

// ---------------------------------------------------------------------------
// describeResource / describeResourceTemplate — the list entries
// ---------------------------------------------------------------------------

test('describeResource lists the spec verbatim under the JSON mime type', () => {
  const spec = defineResource(validSpec());
  assert.deepEqual(describeResource(spec), {
    uri: 'tiktok://videos/recent',
    name: 'tiktok_videos_recent',
    title: 'Recent videos',
    description: spec.description,
    mimeType: 'application/json',
  });
});

test('describeResource prefixes the unavailability marker with exactly one space', () => {
  const spec = defineResource(validSpec());
  const listed = describeResource(spec, MARKER);
  assert.equal(listed.description, `${MARKER} ${spec.description}`);
  assert.equal(listed.uri, spec.uri);
  assert.equal(listed.mimeType, RESOURCE_MIME_TYPE);
});

test('describeResourceTemplate advertises the account query as {?account}', () => {
  const spec = defineResource(validSpec());
  const template = describeResourceTemplate(spec);
  assert.deepEqual(template, {
    uriTemplate: 'tiktok://videos/recent{?account}',
    name: 'tiktok_videos_recent',
    title: 'Recent videos',
    description: spec.description,
    mimeType: 'application/json',
  });
  assert.ok(template.uriTemplate.endsWith('{?account}'));
  assert.ok(!('uri' in template), 'a template has no concrete uri');
});

test('describeResourceTemplate puts {?account} after the path parameters of a template', () => {
  const spec = defineResource(templateSpec());
  const template = describeResourceTemplate(spec, MARKER);
  assert.equal(template.uriTemplate, 'tiktok://publish/{publish_id}/status{?account}');
  assert.equal(template.name, 'tiktok_publish_status');
  assert.equal(template.description, `${MARKER} ${spec.description}`);
  assert.equal(template.mimeType, RESOURCE_MIME_TYPE);
});

test('describeResourceTemplate carries the same marker as the concrete entry', () => {
  const spec = defineResource(validSpec());
  assert.equal(
    describeResourceTemplate(spec, MARKER).description,
    describeResource(spec, MARKER).description,
  );
});

// ---------------------------------------------------------------------------
// parseResourceUri — the read-side grammar
// ---------------------------------------------------------------------------

test('parseResourceUri returns the bare URI with no account key at all', () => {
  const parsed = parseResourceUri('tiktok://videos/recent');
  assert.deepEqual(parsed, { uri: 'tiktok://videos/recent' });
  assert.ok(parsed !== undefined && !('account' in parsed));
});

test('parseResourceUri splits ?account= off into the account', () => {
  assert.deepEqual(parseResourceUri('tiktok://videos/recent?account=work'), {
    uri: 'tiktok://videos/recent',
    account: 'work',
  });
  // The value is percent-decoded like any query value; the server, not the
  // parser, decides whether such a profile exists.
  assert.deepEqual(parseResourceUri('tiktok://auth/status?account=w%20ork'), {
    uri: 'tiktok://auth/status',
    account: 'w ork',
  });
});

test('parseResourceUri refuses another scheme, including http(s)', () => {
  for (const raw of [
    'tiktak://videos/recent',
    'http://videos/recent',
    'https://videos/recent',
    'tiktok:/videos/recent',
    'TIKTOK://videos/recent',
    'videos/recent',
    '',
  ]) {
    assert.equal(parseResourceUri(raw), undefined, raw);
  }
});

test('parseResourceUri refuses any query key other than account', () => {
  for (const raw of [
    'tiktok://videos/recent?profile=work',
    'tiktok://videos/recent?ACCOUNT=work',
    'tiktok://videos/recent?account=work&max_count=5',
    'tiktok://videos/recent?max_count=5&account=work',
    'tiktok://videos/recent?fetch_all',
  ]) {
    assert.equal(parseResourceUri(raw), undefined, raw);
  }
});

test('parseResourceUri refuses a blank or repeated account', () => {
  for (const raw of [
    'tiktok://videos/recent?account=',
    'tiktok://videos/recent?account',
    'tiktok://videos/recent?account=a&account=b',
    'tiktok://videos/recent?account=a&account=a',
    'tiktok://videos/recent?account=a&account=',
  ]) {
    assert.equal(parseResourceUri(raw), undefined, raw);
  }
});

test('parseResourceUri refuses a fragment', () => {
  assert.equal(parseResourceUri('tiktok://videos/recent#top'), undefined);
  assert.equal(parseResourceUri('tiktok://videos/recent?account=work#top'), undefined);
});

test('parseResourceUri refuses an empty trailing fragment, which URL reports as none', () => {
  for (const raw of [
    'tiktok://creator/info#',
    'tiktok://creator/info?account=a#',
    'tiktok://videos/recent#',
    'tiktok://creator/info?#',
  ]) {
    assert.equal(new URL(raw).hash, '', raw);
    assert.equal(parseResourceUri(raw), undefined, raw);
  }
  // The same URIs without the `#` are accepted, so the `#` is what refuses them.
  assert.notEqual(parseResourceUri('tiktok://creator/info'), undefined);
  assert.notEqual(parseResourceUri('tiktok://creator/info?account=a'), undefined);
});

test('parseResourceUri refuses what URL cannot parse', () => {
  for (const raw of ['tiktok://vid eos/recent', 'tiktok://[', 'tiktok://a|b/c']) {
    assert.equal(parseResourceUri(raw), undefined, raw);
  }
});

test('parseResourceUri keeps a trailing slash, so the canonical lookup misses', () => {
  const spec = defineResource(validSpec());
  const parsed = parseResourceUri('tiktok://videos/recent/');
  assert.deepEqual(parsed, { uri: 'tiktok://videos/recent/' });
  assert.notEqual(parsed.uri, spec.uri);
});

test('parseResourceUri does not fold case into a canonical URI', () => {
  // It parses — it is a well-formed URI — but it is not a spec's uri, so the
  // server answers "Unknown resource" rather than serving a lookalike.
  assert.deepEqual(parseResourceUri('tiktok://Videos/Recent'), {
    uri: 'tiktok://Videos/Recent',
  });
  assert.deepEqual(parseResourceUri('tiktok://'), { uri: 'tiktok://' });
});

test('parseResourceUri refuses a dot segment in any spelling instead of resolving it', () => {
  // `URL` would resolve each of these to a different, possibly served, path.
  for (const raw of [
    'tiktok://videos/../auth/status',
    'tiktok://videos/./recent',
    'tiktok://videos/recent/..',
    'tiktok://videos/%2e/recent',
    'tiktok://videos/%2E%2e/auth/status',
    'tiktok://videos/.%2E/auth/status',
    'tiktok://videos/%2e./auth/status?account=work',
  ]) {
    assert.equal(parseResourceUri(raw), undefined, raw);
  }
  // A segment that merely contains dots is an ordinary segment.
  assert.deepEqual(parseResourceUri('tiktok://videos/.../recent'), {
    uri: 'tiktok://videos/.../recent',
  });
  assert.deepEqual(parseResourceUri('tiktok://publish/v.1/status'), {
    uri: 'tiktok://publish/v.1/status',
  });
});

test('parseResourceUri refuses userinfo, a password and a port rather than dropping them', () => {
  for (const raw of [
    'tiktok://user@videos/recent',
    'tiktok://user:pw@videos/recent',
    'tiktok://:pw@videos/recent',
    'tiktok://videos:8080/recent',
    'tiktok://videos:1/recent?account=work',
  ]) {
    assert.equal(parseResourceUri(raw), undefined, raw);
  }
});

test('parseResourceUri refuses a tab or a line break that URL would strip', () => {
  for (const raw of [
    'tiktok://videos/re\tcent',
    'tiktok://videos/re\ncent',
    'tiktok://videos/re\rcent',
    'tiktok://videos/recent?account=wo\nrk',
  ]) {
    assert.equal(parseResourceUri(raw), undefined, JSON.stringify(raw));
  }
});

test('parseResourceUri refuses a malformed escape in the account and reads + as a plus', () => {
  for (const raw of [
    'tiktok://videos/recent?account=%',
    'tiktok://videos/recent?account=%zz',
    'tiktok://videos/recent?account=%E0%A4%A',
  ]) {
    assert.equal(parseResourceUri(raw), undefined, raw);
  }
  // Only percent-decoding: `+` is not a space here.
  assert.deepEqual(parseResourceUri('tiktok://videos/recent?account=a+b'), {
    uri: 'tiktok://videos/recent',
    account: 'a+b',
  });
  // No escape spells the key: `acc%6Funt` is not `account`.
  assert.equal(parseResourceUri('tiktok://videos/recent?acc%6Funt=work'), undefined);
});

// ---------------------------------------------------------------------------
// matchResource — which spec a canonical URI addresses
// ---------------------------------------------------------------------------

test('matchResource resolves a concrete URI to its spec with no parameters', () => {
  const videos = defineResource(validSpec());
  const auth = defineResource(
    validSpec({ uri: 'tiktok://auth/status', name: 'tiktok_auth_status' }),
  );
  assert.deepEqual(matchResource([videos, auth], 'tiktok://auth/status'), {
    spec: auth,
    params: {},
  });
  assert.equal(matchResource([videos, auth], 'tiktok://videos/recent')?.spec, videos);
});

test('matchResource binds each {name} segment to the segment in its place', () => {
  const template = defineResource(templateSpec());
  assert.deepEqual(matchResource([template], 'tiktok://publish/v_abc-123/status'), {
    spec: template,
    params: { publish_id: 'v_abc-123' },
  });
  const two = defineResource(
    templateSpec({ uri: 'tiktok://publish/{publish_id}/part/{index}', args: {} }),
  );
  assert.deepEqual(matchResource([two], 'tiktok://publish/p1/part/3')?.params, {
    publish_id: 'p1',
    index: '3',
  });
});

test('matchResource percent-decodes a parameter, as parseResourceUri encoded it', () => {
  const template = defineResource(templateSpec());
  const parsed = parseResourceUri('tiktok://publish/v.1 2+3/status');
  assert.ok(parsed !== undefined);
  assert.equal(parsed.uri, 'tiktok://publish/v.1%202+3/status');
  assert.deepEqual(matchResource([template], parsed.uri)?.params, {
    publish_id: 'v.1 2+3',
  });
  assert.deepEqual(matchResource([template], 'tiktok://publish/a%2Fb/status')?.params, {
    publish_id: 'a/b',
  });
});

test('matchResource returns undefined for a malformed escape in a parameter', () => {
  const template = defineResource(templateSpec());
  assert.equal(matchResource([template], 'tiktok://publish/%E0%A4%A/status'), undefined);
  assert.equal(matchResource([template], 'tiktok://publish/%/status'), undefined);
});

test('matchResource never matches an empty segment, an extra segment or another path', () => {
  const template = defineResource(templateSpec());
  for (const uri of [
    'tiktok://publish//status',
    'tiktok://publish/status',
    'tiktok://publish/a/b/status',
    'tiktok://publish/a/status/x',
    'tiktok://publish/a/state',
    'tiktok://videos/a/status',
    'tiktok://publish/a/status?account=work',
    'publish/a/status',
  ]) {
    assert.equal(matchResource([template], uri), undefined, uri);
  }
  assert.equal(matchResource([], 'tiktok://publish/a/status'), undefined);
});

test('matchResource lets a concrete URI win over a template listed before it', () => {
  const template = defineResource(templateSpec());
  const latest = defineResource(
    validSpec({
      uri: 'tiktok://publish/latest/status',
      name: 'tiktok_publish_latest_status',
      tool: statusTool(),
      args: { publish_id: 'latest' },
    }),
  );
  const match = matchResource([template, latest], 'tiktok://publish/latest/status');
  assert.deepEqual(match, { spec: latest, params: {} });
  // Any other id still reaches the template.
  assert.equal(
    matchResource([template, latest], 'tiktok://publish/v1/status')?.spec,
    template,
  );
});

test('matchResource tries templates in manifest order', () => {
  const first = defineResource(templateSpec());
  const second = defineResource(
    templateSpec({
      uri: 'tiktok://publish/{attempt}/status',
      name: 'tiktok_attempt_status',
    }),
  );
  assert.equal(matchResource([first, second], 'tiktok://publish/v1/status')?.spec, first);
  assert.equal(
    matchResource([second, first], 'tiktok://publish/v1/status')?.spec,
    second,
  );
});

// ---------------------------------------------------------------------------
// resourceArgs — what the bound tool is called with
// ---------------------------------------------------------------------------

test('resourceArgs merges the fixed args with the account from the URI', () => {
  const spec = defineResource(validSpec({ args: { max_count: 5 } }));
  const match = concreteMatch(spec);
  assert.deepEqual(resourceArgs(match, { uri: spec.uri }), { max_count: 5 });
  assert.deepEqual(resourceArgs(match, { uri: spec.uri, account: 'work' }), {
    max_count: 5,
    account: 'work',
  });
});

test('resourceArgs merges the path parameters of a template match', () => {
  const spec = defineResource(templateSpec());
  const match = matchResource([spec], 'tiktok://publish/v1/status');
  assert.ok(match !== undefined);
  assert.deepEqual(resourceArgs(match, { uri: 'tiktok://publish/v1/status' }), {
    wait_for_completion: false,
    publish_id: 'v1',
  });
  assert.deepEqual(
    resourceArgs(match, { uri: 'tiktok://publish/v1/status', account: 'work' }),
    { wait_for_completion: false, publish_id: 'v1', account: 'work' },
  );
});

test('resourceArgs hands out a fresh object and never mutates spec.args', () => {
  const spec = defineResource(validSpec({ args: { max_count: 5 } }));
  const match = concreteMatch(spec);
  const bare = resourceArgs(match, { uri: spec.uri });
  assert.notEqual(bare, spec.args);
  bare['max_count'] = 1;
  bare['account'] = 'mutated';
  assert.deepEqual(spec.args, { max_count: 5 });
  assert.deepEqual(resourceArgs(match, { uri: spec.uri, account: 'work' }), {
    max_count: 5,
    account: 'work',
  });
  assert.deepEqual(spec.args, { max_count: 5 });
});

test('resourceArgs with empty fixed args yields exactly the account, or nothing', () => {
  const spec = defineResource(validSpec());
  const match = concreteMatch(spec);
  assert.deepEqual(resourceArgs(match, { uri: spec.uri }), {});
  assert.deepEqual(resourceArgs(match, { uri: spec.uri, account: 'work' }), {
    account: 'work',
  });
});

// ---------------------------------------------------------------------------
// resourceContents — the read result
// ---------------------------------------------------------------------------

test('resourceContents returns one JSON text content under the requested URI, query included', () => {
  const set = settings();
  const result: ToolResult<unknown> = {
    ok: true,
    data: { videos: [{ id: 'v1' }], meta: { next_cursor: 'c2' } },
    hints: [{ type: 'note', text: 'one page' }],
  };
  const requested = 'tiktok://videos/recent?account=work';
  const read = resourceContents(requested, result, set);
  const text = textOf(read);
  assert.equal(read.contents[0]?.uri, requested);
  assert.equal(read.contents[0]?.mimeType, 'application/json');
  assert.equal(
    text,
    truncateResult(result, set.resultCharBudget, { pretty: set.prettyJson }).text,
  );
  assert.deepEqual(JSON.parse(text), result);
});

test('an ok: false envelope is the resource text, not a protocol error', () => {
  const result: ToolResult<unknown> = {
    ok: false,
    error: {
      code: 'unknown_account',
      message: 'Unknown account "NOPE".',
      retryable: false,
    },
  };
  const read = resourceContents(
    'tiktok://videos/recent?account=NOPE',
    result,
    settings(),
  );
  assert.ok(!('isError' in read));
  assert.deepEqual(JSON.parse(textOf(read)), result);
});

test('cc-g2: resourceContents honours TT_RESULT_CHAR_BUDGET and stays valid JSON', () => {
  const set = settings({ TT_RESULT_CHAR_BUDGET: '1200' });
  const result: ToolResult<unknown> = {
    ok: true,
    data: {
      videos: Array.from({ length: 400 }, (_, i) => ({ id: `v${String(i)}` })),
      meta: {},
    },
  };
  const text = textOf(resourceContents('tiktok://videos/recent', result, set));
  assert.ok(text.length <= 1200, `text is ${String(text.length)} chars`);
  const parsed = JSON.parse(text) as ToolResult<{ videos: unknown[] }>;
  assert.equal(parsed.ok, true);
  assert.ok(parsed.data !== undefined && parsed.data.videos.length < 400);
  assert.equal(text, truncateResult(result, 1200, { pretty: false }).text);
});

test('TT_PRETTY_JSON indents the resource text', () => {
  const set = settings({ TT_PRETTY_JSON: '1' });
  const result: ToolResult<unknown> = { ok: true, data: { videos: [{ id: 'v1' }] } };
  const text = textOf(resourceContents('tiktok://videos/recent', result, set));
  assert.ok(text.includes('\n  '));
  assert.equal(text, truncateResult(result, set.resultCharBudget, { pretty: true }).text);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import type { z } from 'zod';

import {
  RESOURCE_SCHEME,
  isResourceTemplate,
  matchResource,
  resourceCompletion,
  resourceParams,
  type ResourceSpec,
} from '../src/mcp/resources.js';
import { allTools } from '../src/tools/index.js';
import {
  RESOURCES,
  authStatusResource,
  creatorInfoResource,
  publishJournalResource,
  publishStatusResource,
  recentVideosResource,
  userInfoResource,
} from '../src/tools/resources.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** The value every path parameter takes in a probe read. */
const PROBE = 'probe';

/** The argument names the bound tool accepts — every input is a strict object (CC-G1). */
function inputKeys(spec: ResourceSpec): Set<string> {
  return new Set(Object.keys((spec.tool.input as z.ZodObject<z.ZodRawShape>).shape));
}

/** The path segments after `tiktok://`, `{name}` segments included. */
function segments(spec: ResourceSpec): string[] {
  return spec.uri.slice(RESOURCE_SCHEME.length).split('/');
}

/** A template's URI with {@link PROBE} in every parameter slot — a URI a client could read. */
function probeUri(spec: ResourceSpec): string {
  return `${RESOURCE_SCHEME}${segments(spec)
    .map((segment) => (segment.startsWith('{') ? PROBE : segment))
    .join('/')}`;
}

// ---------------------------------------------------------------------------
// the resource manifest (TOOLS.md § 7.2)
// ---------------------------------------------------------------------------

/** The documented table, in `resources/list` order, with each row's fixed arguments. */
const EXPECTED = [
  {
    uri: 'tiktok://auth/status',
    name: 'tiktok_auth_status',
    tool: 'tiktok_get_auth_status',
    args: {},
    spec: authStatusResource,
  },
  {
    uri: 'tiktok://user/info',
    name: 'tiktok_user_info',
    tool: 'tiktok_get_user_info',
    args: {},
    spec: userInfoResource,
  },
  {
    uri: 'tiktok://videos/recent',
    name: 'tiktok_videos_recent',
    tool: 'tiktok_list_videos',
    args: {},
    spec: recentVideosResource,
  },
  {
    uri: 'tiktok://creator/info',
    name: 'tiktok_creator_info',
    tool: 'tiktok_get_creator_info',
    args: {},
    spec: creatorInfoResource,
  },
  {
    uri: 'tiktok://publish/journal',
    name: 'tiktok_publish_journal',
    tool: 'tiktok_list_publish_journal',
    args: {},
    spec: publishJournalResource,
  },
  {
    uri: 'tiktok://publish/{publish_id}/status',
    name: 'tiktok_publish_status',
    tool: 'tiktok_get_publish_status',
    args: { wait_for_completion: false },
    spec: publishStatusResource,
  },
] as const;

test('the manifest lists exactly the six documented resources, in order', () => {
  assert.equal(RESOURCES.length, 6);
  assert.deepEqual(
    RESOURCES.map((spec) => ({ uri: spec.uri, name: spec.name, tool: spec.tool.name })),
    EXPECTED.map(({ uri, name, tool }) => ({ uri, name, tool })),
  );
});

test('the manifest entries are the exported specs themselves', () => {
  for (const [index, expected] of EXPECTED.entries()) {
    assert.equal(RESOURCES[index], expected.spec, expected.uri);
  }
});

test('the manifest and every spec in it are frozen', () => {
  assert.ok(Object.isFrozen(RESOURCES));
  for (const spec of RESOURCES) {
    assert.ok(Object.isFrozen(spec), spec.uri);
    assert.ok(Object.isFrozen(spec.args), spec.uri);
  }
});

test('every resource binds a tool from the tool manifest', () => {
  const manifest = new Set(allTools());
  for (const spec of RESOURCES) {
    assert.ok(manifest.has(spec.tool), `${spec.uri} binds a tool outside PACKAGES`);
  }
});

test('every bound tool is read-only', () => {
  for (const spec of RESOURCES) {
    assert.equal(spec.tool.annotations.readOnlyHint, true, spec.uri);
    assert.equal(spec.tool.annotations.destructiveHint, false, spec.uri);
  }
});

test('every resource fixes exactly its documented arguments', () => {
  for (const expected of EXPECTED) {
    assert.deepEqual(expected.spec.args, expected.args, expected.uri);
  }
});

test('args never fixes account — the profile always comes from the URI', () => {
  for (const spec of RESOURCES) {
    assert.ok(!('account' in spec.args), spec.uri);
  }
});

test('URIs and names are unique across the manifest', () => {
  const uris = RESOURCES.map((spec) => spec.uri);
  assert.deepEqual(uris, [...new Set(uris)]);
  const names = RESOURCES.map((spec) => spec.name);
  assert.deepEqual(names, [...new Set(names)]);
});

test('a resource name is tiktok_ plus the literal URI segments in snake case', () => {
  for (const spec of RESOURCES) {
    const literal = segments(spec).filter((segment) => !segment.startsWith('{'));
    assert.equal(spec.name, `tiktok_${literal.join('_')}`, spec.uri);
  }
});

test('every path parameter and every fixed argument is an input of the bound tool', () => {
  for (const spec of RESOURCES) {
    const keys = inputKeys(spec);
    for (const name of resourceParams(spec)) {
      assert.ok(
        keys.has(name),
        `${spec.uri}: {${name}} is not an argument of ${spec.tool.name}`,
      );
    }
    for (const name of Object.keys(spec.args)) {
      assert.ok(
        keys.has(name),
        `${spec.uri}: ${name} is not an argument of ${spec.tool.name}`,
      );
    }
  }
});

test('every concrete URI resolves to its own spec, never to a template', () => {
  for (const spec of RESOURCES.filter((entry) => !isResourceTemplate(entry))) {
    const match = matchResource(RESOURCES, spec.uri);
    assert.equal(match?.spec, spec, spec.uri);
    assert.deepEqual(match?.params, {}, spec.uri);
  }
});

test('every template resolves a probe read to itself with the probe in params', () => {
  for (const spec of RESOURCES.filter(isResourceTemplate)) {
    const uri = probeUri(spec);
    const match = matchResource(RESOURCES, uri);
    assert.equal(
      match?.spec,
      spec,
      `${uri} is captured by ${match?.spec.uri ?? 'nothing'}`,
    );
    assert.deepEqual(
      match?.params,
      Object.fromEntries(resourceParams(spec).map((name) => [name, PROBE])),
      uri,
    );
  }
});

test('the publish status resource is the only template', () => {
  assert.deepEqual(RESOURCES.filter(isResourceTemplate), [publishStatusResource]);
  assert.deepEqual(resourceParams(publishStatusResource), ['publish_id']);
});

test('the journal resource says ?account= is a filter', () => {
  assert.match(publishJournalResource.description, /filter/i);
});

test('the status resource fixes wait_for_completion: false so a read never blocks', () => {
  assert.deepEqual(publishStatusResource.args, { wait_for_completion: false });
  assert.match(publishStatusResource.description, /wait_for_completion: false/);
});

test('every description names the mirrored tool and the ?account=<profile> selector', () => {
  for (const spec of RESOURCES) {
    assert.ok(spec.description.includes(spec.tool.name), spec.uri);
    assert.ok(spec.description.includes('?account=<profile>'), spec.uri);
    assert.notEqual(spec.title.trim(), '', spec.uri);
  }
});

test('no two resources share a tool', () => {
  const tools = RESOURCES.map((spec) => spec.tool.name);
  assert.deepEqual(tools, [...new Set(tools)]);
});

test('the status template completes publish_id from the journal and account from the profiles', () => {
  assert.deepEqual(resourceCompletion(publishStatusResource, 'publish_id'), {
    kind: 'publish_ids',
  });
  assert.deepEqual(resourceCompletion(publishStatusResource, 'account'), {
    kind: 'profiles',
  });
});

test('every path parameter of every resource declares a completion source', () => {
  for (const spec of RESOURCES) {
    for (const name of resourceParams(spec)) {
      assert.notEqual(
        resourceCompletion(spec, name),
        undefined,
        `${spec.uri} leaves {${name}} without a completion source`,
      );
    }
  }
});

/**
 * The zod contract as the wire sees it.
 *
 * `tools/list` input schemas are produced by `z.toJSONSchema` and every
 * `invalid_params` message by `describeZodError`. Both lean on zod internals
 * that shifted between majors (a zod-3 converter fed zod-4 schemas returned
 * `{}`; issue paths may now carry symbols; message wording changed), so this
 * file pins the observable result rather than the implementation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { createLogger } from '../src/core/log.js';
import { loadSettings } from '../src/core/settings.js';
import { defineTool, toolInput, type AnyToolSpec } from '../src/mcp/define.js';
import { argumentErrorMap, describeZodError } from '../src/mcp/errors.js';
import type { ToolResult } from '../src/mcp/result.js';
import { callTool, describeTool, type ServerRuntime } from '../src/mcp/server.js';
import { allTools } from '../src/tools/index.js';
import { baselineEnv } from './helpers.js';

type Json = Record<string, unknown>;

/** The advertised input schema of a spec, as a plain record. */
function inputSchemaOf(spec: AnyToolSpec): Json {
  return describeTool(spec, []).inputSchema;
}

/** One advertised property of a spec's input schema, or a failure. */
function propertyOf(spec: AnyToolSpec, key: string): Json {
  const properties = inputSchemaOf(spec)['properties'] as Json;
  const property = properties[key];
  assert.ok(property !== undefined, `${spec.name} advertises no '${key}'`);
  return property as Json;
}

/** The shipped spec with this wire name, or a failure. */
function shippedTool(name: string): AnyToolSpec {
  const spec = allTools().find((candidate) => candidate.name === name);
  assert.ok(spec !== undefined, `no shipped tool named ${name}`);
  return spec;
}

/** Every object key anywhere in a JSON value, with the path it was found at. */
function* keysDeep(value: unknown, path = '$'): Generator<[string, string]> {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      yield* keysDeep(item, `${path}[${String(index)}]`);
    }
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    yield [key, path];
    yield* keysDeep(child, `${path}.${key}`);
  }
}

/** A spec around an arbitrary input schema, built the way the manifest builds one. */
function probeTool(input: z.ZodType): AnyToolSpec {
  return defineTool({
    name: 'tiktok_probe',
    title: 'Probe',
    description: 'A probe tool for the zod contract tests.',
    package: 'auth',
    scopes: [],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input,
    handler: () => Promise.resolve<ToolResult<unknown>>({ ok: true, data: {} }),
  });
}

/** The `ZodError` a parse must produce, or a failure if it succeeded. */
function zodErrorOf(schema: z.ZodType, value: unknown): z.ZodError {
  const parsed = schema.safeParse(value);
  assert.equal(parsed.success, false, 'expected the parse to fail');
  assert.ok(parsed.error !== undefined);
  return parsed.error;
}

// ---------------------------------------------------------------------------
// tools/list — every shipped tool advertises a real, closed, flat schema
// ---------------------------------------------------------------------------

test('every shipped tool advertises a closed object schema with an account string', () => {
  const tools = allTools();
  assert.ok(tools.length > 0, 'the manifest must not be empty');
  for (const spec of tools) {
    const schema = inputSchemaOf(spec);
    assert.equal(schema['type'], 'object', `${spec.name}: type`);
    assert.equal(schema['additionalProperties'], false, `${spec.name}: closed`);
    assert.equal(schema['$schema'], undefined, `${spec.name}: no $schema`);
    const properties = schema['properties'] as Json | undefined;
    assert.ok(properties !== undefined, `${spec.name}: properties`);
    const account = properties['account'] as Json | undefined;
    assert.equal(account?.['type'], 'string', `${spec.name}: account is a string`);
  }
});

test('no shipped input schema carries a $schema, $ref, $defs or definitions anywhere', () => {
  const forbidden = new Set(['$schema', '$ref', '$defs', 'definitions']);
  for (const spec of allTools()) {
    for (const [key, path] of keysDeep(inputSchemaOf(spec))) {
      assert.ok(!forbidden.has(key), `${spec.name}: ${key} at ${path}`);
    }
  }
});

test('every required entry of a shipped input schema names an advertised property', () => {
  for (const spec of allTools()) {
    const schema = inputSchemaOf(spec);
    const properties = Object.keys(schema['properties'] as Json);
    const required = (schema['required'] as string[] | undefined) ?? [];
    for (const name of required) {
      assert.ok(properties.includes(name), `${spec.name}: required '${name}'`);
    }
    assert.ok(!required.includes('account'), `${spec.name}: account stays optional`);
  }
});

// ---------------------------------------------------------------------------
// io: 'input' — the schema describes what a caller sends
// ---------------------------------------------------------------------------

test('a defaulted argument is advertised as optional, with its default', () => {
  const schema = inputSchemaOf(
    probeTool(
      toolInput({
        mode: z.enum(['fast', 'slow']).default('fast'),
        name: z.string(),
      }),
    ),
  );
  assert.deepEqual(schema['required'], ['name']);
  const mode = (schema['properties'] as Json)['mode'] as Json;
  assert.equal(mode['default'], 'fast');
  assert.deepEqual(mode['enum'], ['fast', 'slow']);
});

test('a transformed argument advertises its input type, not its output type', () => {
  const schema = inputSchemaOf(
    probeTool(
      toolInput({
        count: z.string().pipe(z.transform((value) => Number(value))),
      }),
    ),
  );
  const count = (schema['properties'] as Json)['count'] as Json;
  assert.equal(count['type'], 'string');
  assert.deepEqual(schema['required'], ['count']);
});

// ---------------------------------------------------------------------------
// integer bounds — .int() is `integer`, and a declared bound wins
// ---------------------------------------------------------------------------

test('a declared integer range is advertised exactly, not widened to the safe range', () => {
  assert.deepEqual(propertyOf(shippedTool('tiktok_list_publish_journal'), 'limit'), {
    description: 'Newest entries to return.',
    type: 'integer',
    minimum: 1,
    maximum: 100,
  });
});

test('an undeclared integer bound falls back to the safe-integer range', () => {
  const maxCount = propertyOf(shippedTool('tiktok_list_videos'), 'max_count');
  assert.equal(maxCount['type'], 'integer');
  assert.equal(maxCount['minimum'], Number.MIN_SAFE_INTEGER);
  assert.equal(maxCount['maximum'], Number.MAX_SAFE_INTEGER);

  const cover = propertyOf(shippedTool('tiktok_post_video'), 'video_cover_timestamp_ms');
  assert.equal(cover['type'], 'integer');
  assert.equal(cover['minimum'], 0, 'nonnegative() declares the lower bound');
  assert.equal(cover['maximum'], Number.MAX_SAFE_INTEGER);
});

test('array length bounds are advertised as minItems/maxItems', () => {
  const ids = propertyOf(shippedTool('tiktok_query_videos'), 'video_ids');
  assert.equal(ids['type'], 'array');
  assert.equal(ids['minItems'], 1);
  assert.equal(ids['maxItems'], 20);
  assert.deepEqual(ids['items'], { type: 'string', minLength: 1 });
});

// ---------------------------------------------------------------------------
// describeZodError — the exact zod-4 wording callers read
// ---------------------------------------------------------------------------

test('without the argument map, a missing string keeps the zod-4 default wording', () => {
  const schema = toolInput({ video_id: z.string() });
  assert.equal(
    describeZodError(zodErrorOf(schema, {})),
    'video_id: Invalid input: expected string, received undefined',
  );
});

test('an unknown key on a toolInput schema is named with the normative remedy', () => {
  const schema = toolInput({ max_count: z.number().int().optional() });
  assert.equal(
    describeZodError(zodErrorOf(schema, { max_cont: 3 })),
    "max_cont: unknown argument — check the spelling and the tool's input schema",
  );
});

test('nested and array paths render as dotted fields and bracketed indexes', () => {
  const schema = toolInput({
    post_info: z.object({ title: z.string() }).strict().optional(),
    ids: z.array(z.string()).optional(),
  });
  assert.equal(
    describeZodError(zodErrorOf(schema, { post_info: { title: 7 } })),
    'post_info.title: Invalid input: expected string, received number',
  );
  assert.equal(
    describeZodError(zodErrorOf(schema, { ids: ['a', 'b', 3] })),
    'ids[2]: Invalid input: expected string, received number',
  );
});

test('a symbol path segment is rendered with String() instead of throwing', () => {
  const error = new z.ZodError([
    { code: 'custom', message: 'm', path: [Symbol('s'), 'x'], input: undefined },
  ]);
  assert.equal(describeZodError(error), 'Symbol(s).x: m');
});

// ---------------------------------------------------------------------------
// argumentErrorMap — an absent argument reads as missing, not as a type error
// ---------------------------------------------------------------------------

/** The issue shape the map sees, minus the fields it never reads. */
type MapIssue = Parameters<typeof argumentErrorMap>[0];

test('the argument map names an absent value as a missing argument', () => {
  const issue = {
    code: 'invalid_type',
    expected: 'string',
    input: undefined,
    path: ['video_id'],
  } as unknown as MapIssue;
  assert.equal(argumentErrorMap(issue), 'required argument is missing');
});

test('the argument map defers to zod for a present value of the wrong type', () => {
  const issue = {
    code: 'invalid_type',
    expected: 'string',
    input: 7,
    path: ['video_id'],
  } as unknown as MapIssue;
  assert.equal(argumentErrorMap(issue), undefined);
});

test('the argument map defers to zod for every other issue code', () => {
  const issue = {
    code: 'too_small',
    origin: 'string',
    minimum: 1,
    inclusive: true,
    input: undefined,
    path: ['video_id'],
  } as unknown as MapIssue;
  assert.equal(argumentErrorMap(issue), undefined);
});

test('a missing nested field is named by its dotted path with the missing wording', () => {
  const schema = z.object({ outer: z.object({ inner: z.string() }) });
  const parsed = schema.safeParse({ outer: {} }, { error: argumentErrorMap });
  assert.equal(parsed.success, false);
  assert.ok(parsed.error !== undefined);
  assert.equal(
    describeZodError(parsed.error),
    'outer.inner: required argument is missing',
  );
});

// ---------------------------------------------------------------------------
// callTool — the wording a caller actually reads in `invalid_params`
// ---------------------------------------------------------------------------

/** A runtime that fails the test if a call ever gets past validation. */
function validationOnlyRuntime(): ServerRuntime {
  return {
    settings: loadSettings(baselineEnv()),
    log: createLogger({ level: 'error' }),
    profiles: () => Promise.resolve([{ name: 'DEFAULT', scopes: ['video.publish'] }]),
    createContext: () =>
      Promise.reject(new Error('validation must fail before any context')),
  };
}

/** The `{ code, message }` of a failed call, or a failure. */
function errorOf(result: ToolResult<unknown>): { code: string; message: string } {
  assert.equal(result.ok, false, 'expected a failed call');
  assert.ok(result.error !== undefined);
  return result.error;
}

test('an omitted required argument fails as invalid_params saying it is missing', async () => {
  const error = errorOf(
    await callTool(shippedTool('tiktok_get_publish_status'), {}, validationOnlyRuntime()),
  );
  assert.equal(error.code, 'invalid_params');
  assert.equal(
    error.message,
    'Invalid arguments: publish_id: required argument is missing. ' +
      'Fix the arguments and call again. No request was sent to TikTok.',
  );
});

test('a wrongly typed argument keeps the zod wording and is not called missing', async () => {
  const error = errorOf(
    await callTool(
      shippedTool('tiktok_get_publish_status'),
      { publish_id: 42 },
      validationOnlyRuntime(),
    ),
  );
  assert.equal(error.code, 'invalid_params');
  assert.ok(
    error.message.includes('publish_id: Invalid input: expected string, received number'),
    error.message,
  );
  assert.ok(!error.message.includes('required argument is missing'), error.message);
});

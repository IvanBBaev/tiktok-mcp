/**
 * Tests for mcp/prompts.ts — the mechanism behind `prompts/list` and
 * `prompts/get` (TOOLS.md § 7.1), taken on a fixture spec so each case can
 * break exactly one rule.
 *
 * The cases follow the module's three promises:
 *
 * - a bad spec fails at import time as a `TikTokError` naming the rule it
 *   broke, and a good one comes back frozen to the last argument;
 * - `prompts/get` arguments are strict the way tool arguments are (the CC-G1
 *   stance): an unknown name, a missing required one and a blank required one
 *   are *protocol* errors (`McpError` / `InvalidParams`), while a blank optional
 *   one is simply dropped and every value reaches the renderer trimmed;
 * - `getPrompt` is validate → render → wrap, with the renderer seeing only the
 *   validated arguments.
 *
 * The real prompt lives in `tools/prompts.ts` and is tested in
 * `test/tool-prompts.test.ts`; nothing here depends on it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { isTikTokError, TikTokError } from '../src/core/errors.js';
import {
  definePrompt,
  describePrompt,
  getPrompt,
  promptCompletion,
  type PromptArgs,
  type PromptArgumentSpec,
  type PromptSpec,
  validatePromptArgs,
} from '../src/mcp/prompts.js';

/** A spec that satisfies every rule: one required and one optional argument. */
function validSpec(): PromptSpec {
  return {
    name: 'tiktok_fixture_flow',
    title: 'Fixture flow',
    description: 'A fixture prompt for the mechanism tests.',
    package: 'auth',
    arguments: [
      { name: 'video', description: 'The video to post.', required: true },
      { name: 'title', description: 'An optional caption.', required: false },
    ],
    render: (args) => [
      { role: 'user', content: { type: 'text', text: JSON.stringify(args) } },
    ],
  };
}

/** The `TikTokError` a bad spec must throw, or a failure if it was accepted. */
function specError(mutate: (spec: PromptSpec) => void): TikTokError {
  const spec = validSpec();
  mutate(spec);
  try {
    definePrompt(spec);
  } catch (err) {
    assert.ok(isTikTokError(err), `expected a TikTokError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected definePrompt to reject the spec');
}

/** The `McpError` bad arguments must throw, or a failure if they were accepted. */
function argsError(
  spec: PromptSpec,
  raw: Readonly<Record<string, string>> | undefined,
): McpError {
  try {
    validatePromptArgs(spec, raw);
  } catch (err) {
    assert.ok(err instanceof McpError, `expected an McpError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected validatePromptArgs to reject the arguments');
}

/** The spec's arguments as a mutable list, for the cases that add or break one. */
function argumentsOf(spec: PromptSpec): PromptArgumentSpec[] {
  return spec.arguments as PromptArgumentSpec[];
}

// ---------------------------------------------------------------------------
// definePrompt — import-time assertions
// ---------------------------------------------------------------------------

test('definePrompt returns the spec unchanged for a valid definition', () => {
  const spec = validSpec();
  assert.equal(definePrompt(spec), spec);
});

test('definePrompt freezes the spec, its argument list and every argument', () => {
  const spec = definePrompt(validSpec());
  assert.ok(Object.isFrozen(spec));
  assert.ok(Object.isFrozen(spec.arguments));
  for (const argument of spec.arguments) assert.ok(Object.isFrozen(argument));
});

test('definePrompt accepts a prompt with no arguments at all', () => {
  const spec = definePrompt({ ...validSpec(), arguments: [] });
  assert.deepEqual(spec.arguments, []);
});

test('definePrompt rejects a name outside the tiktok_ namespace', () => {
  const err = specError((spec) => {
    (spec as { name: string }).name = 'post_video_guided';
  });
  assert.equal(err.code, 'invalid_prompt_spec');
  assert.equal(err.kind, 'internal');
  assert.equal(err.retryable, false);
  assert.match(err.message, /Prompt spec "post_video_guided" is invalid/);
  assert.match(err.message, /lowercase snake case prefixed with "tiktok_"/);
});

test('definePrompt rejects camelCase and trailing separators in a name', () => {
  for (const name of ['tiktok_postVideo', 'tiktok_', 'tiktok_post__video', 'tiktok_x_']) {
    const err = specError((spec) => {
      (spec as { name: string }).name = name;
    });
    assert.equal(err.code, 'invalid_prompt_spec', name);
  }
});

test('definePrompt rejects a blank title or description', () => {
  assert.match(
    specError((spec) => {
      (spec as { title: string }).title = '  ';
    }).message,
    /title is empty/,
  );
  assert.match(
    specError((spec) => {
      (spec as { description: string }).description = '';
    }).message,
    /description is empty/,
  );
});

test('definePrompt rejects a package outside the five of TOOLS.md § 1', () => {
  const err = specError((spec) => {
    (spec as { package: string }).package = 'publish-read';
  });
  assert.equal(err.code, 'invalid_prompt_spec');
  assert.match(
    err.message,
    /package "publish-read" is not one of auth, user, video, publish, publish-write/,
  );
});

test('definePrompt rejects a required package outside the five, and accepts the five', () => {
  const err = specError((spec) => {
    (spec as { requires?: readonly string[] }).requires = ['video', 'photos'];
  });
  assert.equal(err.code, 'invalid_prompt_spec');
  assert.match(
    err.message,
    /requires "photos", which is not one of auth, user, video, publish, publish-write/,
  );
  const spec = validSpec();
  (spec as { requires?: readonly string[] }).requires = ['publish', 'publish-write'];
  assert.deepEqual(definePrompt(spec).requires, ['publish', 'publish-write']);
});

test('definePrompt rejects an argument name that is not lowercase snake case', () => {
  for (const name of ['Video', 'video-path', '_video', 'video_', '1video', '']) {
    const err = specError((spec) => {
      argumentsOf(spec).push({ name, description: 'Bad name.', required: false });
    });
    assert.equal(err.code, 'invalid_prompt_spec', name);
    assert.match(err.message, /is not lowercase snake case/, name);
  }
});

test('definePrompt rejects an argument declared twice', () => {
  const err = specError((spec) => {
    argumentsOf(spec).push({ name: 'video', description: 'Again.', required: false });
  });
  assert.match(err.message, /argument "video" is declared twice/);
});

test('definePrompt rejects an argument with a blank description', () => {
  const err = specError((spec) => {
    argumentsOf(spec).push({ name: 'note', description: '   ', required: false });
  });
  assert.match(err.message, /argument "note" has an empty description/);
});

test('definePrompt rejects a "values" completion that lists nothing', () => {
  const err = specError((spec) => {
    argumentsOf(spec).push({
      name: 'level',
      description: 'A level.',
      required: false,
      completion: { kind: 'values', values: [] },
    });
  });
  assert.match(err.message, /argument "level": a "values" completion lists no values/);
});

test('definePrompt rejects a "values" completion that repeats a value', () => {
  const err = specError((spec) => {
    argumentsOf(spec).push({
      name: 'level',
      description: 'A level.',
      required: false,
      completion: { kind: 'values', values: ['A', 'B', 'A'] },
    });
  });
  assert.match(err.message, /argument "level": a "values" completion repeats "A"/);
});

test('definePrompt accepts the other sources without a vocabulary to check', () => {
  const spec = validSpec();
  argumentsOf(spec).push(
    {
      name: 'account',
      description: 'A profile.',
      required: false,
      completion: { kind: 'profiles' },
    },
    {
      name: 'id',
      description: 'An id.',
      required: false,
      completion: { kind: 'publish_ids' },
    },
  );
  assert.equal(definePrompt(spec), spec);
});

test('definePrompt names the fix in the remediation: the server, not the request', () => {
  const err = specError((spec) => {
    (spec as { title: string }).title = '';
  });
  assert.equal(
    err.remediation,
    'Fix the prompt definition; this is a bug in the server, not in the request.',
  );
});

// ---------------------------------------------------------------------------
// describePrompt — the `prompts/list` entry
// ---------------------------------------------------------------------------

test('describePrompt is exactly the wire shape: name, title, description, arguments', () => {
  const spec = definePrompt(validSpec());
  assert.deepEqual(describePrompt(spec), {
    name: 'tiktok_fixture_flow',
    title: 'Fixture flow',
    description: 'A fixture prompt for the mechanism tests.',
    arguments: [
      { name: 'video', description: 'The video to post.', required: true },
      { name: 'title', description: 'An optional caption.', required: false },
    ],
  });
});

test('describePrompt never leaks the package or the renderer onto the wire', () => {
  const described = describePrompt(definePrompt(validSpec())) as Record<string, unknown>;
  assert.equal('package' in described, false);
  assert.equal('render' in described, false);
});

// ---------------------------------------------------------------------------
// validatePromptArgs — strict, the CC-G1 stance
// ---------------------------------------------------------------------------

test('cc-g1: validatePromptArgs rejects an unknown argument as InvalidParams', () => {
  const err = argsError(definePrompt(validSpec()), { video: 'a.mp4', vidoe: 'b.mp4' });
  assert.equal(err.code, ErrorCode.InvalidParams);
  assert.match(
    err.message,
    /Invalid arguments for prompt tiktok_fixture_flow: unknown argument "vidoe"/,
  );
});

test('validatePromptArgs rejects a missing required argument', () => {
  const err = argsError(definePrompt(validSpec()), { title: 'Hello' });
  assert.equal(err.code, ErrorCode.InvalidParams);
  assert.match(
    err.message,
    /Invalid arguments for prompt tiktok_fixture_flow: missing required argument "video"/,
  );
});

test('validatePromptArgs treats a blank required argument as missing', () => {
  const err = argsError(definePrompt(validSpec()), { video: '   ' });
  assert.equal(err.code, ErrorCode.InvalidParams);
  assert.match(err.message, /missing required argument "video"/);
});

test('validatePromptArgs rejects absent arguments when one is required', () => {
  const err = argsError(definePrompt(validSpec()), undefined);
  assert.match(err.message, /missing required argument "video"/);
});

test('validatePromptArgs drops a blank optional argument instead of passing it on', () => {
  const args = validatePromptArgs(definePrompt(validSpec()), {
    video: 'a.mp4',
    title: '  ',
  });
  assert.deepEqual(args, { video: 'a.mp4' });
});

test('describePrompt never puts the completion source on the wire', () => {
  const spec = validSpec();
  argumentsOf(spec).push({
    name: 'account',
    description: 'A profile.',
    required: false,
    completion: { kind: 'profiles' },
  });
  const listed = describePrompt(definePrompt(spec)).arguments?.at(-1);
  assert.deepEqual(listed, {
    name: 'account',
    description: 'A profile.',
    required: false,
  });
});

test('promptCompletion returns the declared source, or undefined without one', () => {
  const spec = validSpec();
  argumentsOf(spec).push({
    name: 'account',
    description: 'A profile.',
    required: false,
    completion: { kind: 'profiles' },
  });
  const defined = definePrompt(spec);
  assert.deepEqual(promptCompletion(defined, 'account'), { kind: 'profiles' });
  assert.equal(promptCompletion(defined, 'video'), undefined);
});

test('promptCompletion rejects an undeclared argument the way prompts/get does', () => {
  const spec = definePrompt(validSpec());
  assert.throws(
    () => promptCompletion(spec, 'caption'),
    (err: unknown) => {
      assert.ok(err instanceof McpError);
      assert.equal(err.code, ErrorCode.InvalidParams);
      assert.match(
        err.message,
        /Invalid arguments for prompt tiktok_fixture_flow: unknown argument "caption"$/,
      );
      return true;
    },
  );
});

test('validatePromptArgs trims every value it keeps', () => {
  const args = validatePromptArgs(definePrompt(validSpec()), {
    video: '  a.mp4 ',
    title: '\tHello world\n',
  });
  assert.deepEqual(args, { video: 'a.mp4', title: 'Hello world' });
});

test('validatePromptArgs returns {} for absent arguments when none is required', () => {
  const spec = definePrompt({
    ...validSpec(),
    arguments: [{ name: 'note', description: 'Optional.', required: false }],
  });
  assert.deepEqual(validatePromptArgs(spec, undefined), {});
  assert.deepEqual(validatePromptArgs(spec, {}), {});
});

// ---------------------------------------------------------------------------
// getPrompt — validate → render → wrap
// ---------------------------------------------------------------------------

test('getPrompt returns the description and the rendered messages', () => {
  const result = getPrompt(definePrompt(validSpec()), { video: 'a.mp4' });
  assert.deepEqual(result, {
    description: 'A fixture prompt for the mechanism tests.',
    messages: [{ role: 'user', content: { type: 'text', text: '{"video":"a.mp4"}' } }],
  });
});

test('getPrompt hands the renderer the validated arguments, not the raw ones', () => {
  let seen: PromptArgs | undefined;
  const spec = definePrompt({
    ...validSpec(),
    render: (args) => {
      seen = args;
      return [];
    },
  });
  getPrompt(spec, { video: ' a.mp4 ', title: '' });
  assert.deepEqual(seen, { video: 'a.mp4' });
});

test('getPrompt copies the rendered list so a frozen renderer output stays frozen', () => {
  const rendered = Object.freeze([
    { role: 'user' as const, content: { type: 'text' as const, text: 'fixed' } },
  ]);
  const spec = definePrompt({ ...validSpec(), render: () => rendered });
  const result = getPrompt(spec, { video: 'a.mp4' });
  assert.deepEqual(result.messages, [...rendered]);
  assert.notEqual(result.messages, rendered);
  assert.equal(Object.isFrozen(result.messages), false);
});

test('getPrompt fails before rendering when the arguments are invalid', () => {
  let rendered = 0;
  const spec = definePrompt({
    ...validSpec(),
    render: () => {
      rendered += 1;
      return [];
    },
  });
  assert.throws(() => getPrompt(spec, { video: 'a.mp4', extra: 'x' }), McpError);
  assert.equal(rendered, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { isTikTokError, TikTokError } from '../src/core/errors.js';
import {
  ACCOUNT_DESCRIPTION,
  defineTool,
  toolInput,
  type ToolSpec,
} from '../src/mcp/define.js';

/** A spec that satisfies every rule, so each case can break exactly one thing. */
function validSpec(): ToolSpec<{ account?: string }, { echoed: boolean }> {
  return {
    name: 'tiktok_get_auth_status',
    title: 'Get auth status',
    description: 'Report authentication status for the configured TikTok profile(s).',
    package: 'auth',
    scopes: [],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: toolInput({}),
    handler: () => Promise.resolve({ ok: true, data: { echoed: true } }),
  };
}

/** The `TikTokError` a bad spec must throw, or a failure if it was accepted. */
function specError(mutate: (spec: ReturnType<typeof validSpec>) => void): TikTokError {
  const spec = validSpec();
  mutate(spec);
  try {
    defineTool(spec);
  } catch (err) {
    assert.ok(isTikTokError(err), `expected a TikTokError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected defineTool to reject the spec');
}

// ---------------------------------------------------------------------------
// toolInput — the auto-injected `account` argument (TOOLS.md § 2.2)
// ---------------------------------------------------------------------------

test('toolInput injects an optional account argument on every tool', () => {
  const schema = toolInput({ probe: z.boolean().optional() });
  assert.deepEqual(schema.parse({}), {});
  assert.deepEqual(schema.parse({ account: 'WORK' }), { account: 'WORK' });
});

test('the injected account carries the normative describe() text', () => {
  const schema = toolInput({});
  assert.equal(schema.shape.account.description, ACCOUNT_DESCRIPTION);
  assert.equal(
    ACCOUNT_DESCRIPTION,
    'Profile name from the server configuration. Omit to use the default profile. ' +
      'Unknown names fail locally without contacting TikTok.',
  );
});

test('a tool may redefine account when the parameter is a filter (§ 2.2 exception)', () => {
  const schema = toolInput({ account: z.string().default('ALL') });
  assert.deepEqual(schema.parse({}), { account: 'ALL' });
});

test('cc-g1: toolInput rejects an unknown key instead of stripping it', () => {
  const schema = toolInput({ probe: z.boolean().optional() });
  const parsed = schema.safeParse({ prob: true });
  assert.equal(parsed.success, false);
  assert.ok(
    parsed.error?.issues.some((issue) => issue.code === 'unrecognized_keys'),
    'the failure must name the unrecognized key',
  );
});

// ---------------------------------------------------------------------------
// defineTool — import-time assertions
// ---------------------------------------------------------------------------

test('defineTool returns the spec unchanged for a valid definition', () => {
  const spec = validSpec();
  assert.equal(defineTool(spec), spec);
});

test('defineTool freezes the spec, its scopes and its annotations', () => {
  const spec = defineTool(validSpec());
  assert.ok(Object.isFrozen(spec));
  assert.ok(Object.isFrozen(spec.scopes));
  assert.ok(Object.isFrozen(spec.annotations));
});

test('defineTool rejects a name outside the tiktok_ namespace', () => {
  const err = specError((spec) => {
    (spec as { name: string }).name = 'get_auth_status';
  });
  assert.equal(err.code, 'invalid_tool_spec');
  assert.match(err.message, /lowercase snake case/);
});

test('defineTool rejects camelCase and trailing separators in a name', () => {
  for (const name of ['tiktok_getAuthStatus', 'tiktok_', 'tiktok_get__status']) {
    const err = specError((spec) => {
      (spec as { name: string }).name = name;
    });
    assert.equal(err.code, 'invalid_tool_spec', name);
  }
});

test('defineTool rejects an empty title or description', () => {
  assert.match(
    specError((spec) => {
      spec.title = '  ';
    }).message,
    /title is empty/,
  );
  assert.match(
    specError((spec) => {
      spec.description = '';
    }).message,
    /description is empty/,
  );
});

test('defineTool rejects a package outside the five of TOOLS.md § 1', () => {
  const err = specError((spec) => {
    (spec as { package: string }).package = 'publish-read';
  });
  assert.match(err.message, /is not one of auth, user, video, publish, publish-write/);
});

test('defineTool rejects duplicate or empty scopes', () => {
  assert.match(
    specError((spec) => {
      spec.scopes = ['video.list', 'video.list'];
    }).message,
    /duplicates/,
  );
  assert.match(
    specError((spec) => {
      spec.scopes = ['video.list', ' '];
    }).message,
    /empty entry/,
  );
});

test('cc-g1: defineTool rejects an input schema that accepts unknown keys', () => {
  const err = specError((spec) => {
    (spec as { input: z.ZodTypeAny }).input = z.object({
      account: z.string().optional(),
    });
  });
  assert.match(err.message, /accepts unknown keys/);
});

test('cc-g1: defineTool rejects a passthrough schema as well', () => {
  const err = specError((spec) => {
    (spec as { input: z.ZodTypeAny }).input = z.object({}).passthrough();
  });
  assert.match(err.message, /accepts unknown keys/);
});

test('cc-g1: a strict schema wrapped in a refinement is still accepted', () => {
  const spec = validSpec();
  (spec as { input: z.ZodTypeAny }).input = toolInput({
    max_count: z.number().int().optional(),
  }).refine((value) => value.max_count !== 0, { message: 'max_count must not be 0' });
  assert.doesNotThrow(() => defineTool(spec));
});

test('defineTool rejects a tool that is both read-only and destructive', () => {
  const err = specError((spec) => {
    spec.annotations.destructiveHint = true;
  });
  assert.match(err.message, /cannot also be destructive/);
});

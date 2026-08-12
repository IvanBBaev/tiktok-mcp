import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { TOOL_PACKAGES } from '../src/core/settings.js';
import { defineTool, toolInput, type AnyToolSpec } from '../src/mcp/define.js';
import { PACKAGES, allTools, type ToolPackageSpec } from '../src/tools/index.js';

/** A minimal valid spec, so manifest tests do not depend on real tools. */
function fixtureTool(name: `tiktok_${string}`): AnyToolSpec {
  return defineTool({
    name,
    title: 'Fixture',
    description: 'A fixture tool used only by the manifest tests.',
    package: 'video',
    scopes: [],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: toolInput({ probe: z.boolean().optional() }),
    handler: () => Promise.resolve({ ok: true as const, data: {} }),
  });
}

// ---------------------------------------------------------------------------
// the manifest (TOOLS.md § 1)
// ---------------------------------------------------------------------------

test('the manifest lists exactly the five documented packages, in order', () => {
  assert.deepEqual(
    PACKAGES.map((pkg) => pkg.name),
    ['auth', 'user', 'video', 'publish', 'publish-write'],
  );
});

test('the manifest and the package-name union cannot drift apart', () => {
  assert.deepEqual(
    [...PACKAGES.map((pkg) => pkg.name)].sort(),
    [...TOOL_PACKAGES].sort(),
  );
});

test('the manifest and its tool arrays are frozen', () => {
  assert.ok(Object.isFrozen(PACKAGES));
  for (const pkg of PACKAGES) {
    assert.ok(Object.isFrozen(pkg.tools), pkg.name);
  }
});

test('every tool declares the package it is filed under', () => {
  for (const pkg of PACKAGES) {
    for (const tool of pkg.tools) {
      assert.equal(tool.package, pkg.name, tool.name);
    }
  }
});

test('tool names are unique across the whole manifest', () => {
  const names = allTools().map((tool) => tool.name);
  assert.deepEqual(names, [...new Set(names)]);
});

// ---------------------------------------------------------------------------
// allTools
// ---------------------------------------------------------------------------

test('allTools flattens in manifest order, not in package-name order', () => {
  const packages: ToolPackageSpec[] = [
    { name: 'video', tools: [fixtureTool('tiktok_list_videos')] },
    { name: 'auth', tools: [fixtureTool('tiktok_get_auth_status')] },
  ];
  assert.deepEqual(
    allTools(packages).map((tool) => tool.name),
    ['tiktok_list_videos', 'tiktok_get_auth_status'],
  );
});

test('allTools defaults to the real manifest', () => {
  assert.deepEqual(allTools(), allTools(PACKAGES));
});

test('allTools skips empty packages without producing holes', () => {
  const packages: ToolPackageSpec[] = [
    { name: 'auth', tools: [] },
    { name: 'video', tools: [fixtureTool('tiktok_list_videos')] },
    { name: 'publish', tools: [] },
  ];
  assert.equal(allTools(packages).length, 1);
});

test('allTools returns a fresh array — the manifest cannot be mutated through it', () => {
  const flattened = allTools();
  assert.notEqual(flattened, PACKAGES[0]?.tools);
  assert.ok(!Object.isFrozen(flattened));
});

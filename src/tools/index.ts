/**
 * The manifest in code (TOOLS.md § 1, CONTRACTS.md § `mcp/define.ts`).
 *
 * `PACKAGES` is the ONE ordered source consumed by (1) server registration,
 * (2) the manifest snapshot test, (3) README generation and (4) `server.json`
 * generation. Order is part of the surface: it fixes the order of `tools/list`
 * and of the generated documentation, so tools are appended within a package,
 * never re-sorted.
 *
 * The array is intentionally exhaustive over the five packages even while some
 * are still empty — an empty package is a visible hole in the roadmap, whereas
 * a missing key is indistinguishable from an oversight.
 *
 * Layering: `core ← api ← mcp ← tools`. This is the top layer; nothing imports
 * from it except the bootstrap.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import type { AnyToolSpec, PackageName } from '../mcp/define.js';
import { describeTool, type ProfileInfo } from '../mcp/server.js';
import { getAuthStatusTool } from './auth.js';
import {
  getCreatorInfoTool,
  getPublishStatusTool,
  listPublishJournalTool,
} from './publish.js';
import { postPhotosTool, uploadPhotosDraftTool } from './publish-photos.js';
import { postVideoTool, uploadVideoDraftTool } from './publish-write.js';
import { getUserInfoTool } from './user.js';
import { listVideosTool, queryVideosTool } from './video.js';

export interface ToolPackageSpec {
  /** Package name as used by `TT_TOOL_PACKAGES` / `TT_PACKAGES_DENY`. */
  name: PackageName;
  /** Tools in registration order. */
  tools: readonly AnyToolSpec[];
}

export const PACKAGES: readonly ToolPackageSpec[] = Object.freeze([
  { name: 'auth', tools: Object.freeze([getAuthStatusTool]) },
  { name: 'user', tools: Object.freeze([getUserInfoTool]) },
  { name: 'video', tools: Object.freeze([listVideosTool, queryVideosTool]) },
  {
    name: 'publish',
    tools: Object.freeze([
      getCreatorInfoTool,
      getPublishStatusTool,
      listPublishJournalTool,
    ]),
  },
  {
    name: 'publish-write',
    tools: Object.freeze([
      postVideoTool,
      uploadVideoDraftTool,
      postPhotosTool,
      uploadPhotosDraftTool,
    ]),
  },
] as const);

/** Every tool of every package, in manifest order. */
export function allTools(
  packages: readonly ToolPackageSpec[] = PACKAGES,
): readonly AnyToolSpec[] {
  return packages.flatMap((pkg) => [...pkg.tools]);
}

/** One tool as the manifest describes it: its package, its scopes, its wire form. */
export interface ManifestEntry {
  package: PackageName;
  /** Scopes the tool needs — the union per package is what `login` requests. */
  scopes: readonly string[];
  /** Scopes of which any one suffices; omitted when the tool has none. */
  scopesAnyOf?: readonly string[];
  /** Exactly what `tools/list` returns for a fully authorized installation. */
  tool: Tool;
}

/**
 * The manifest as data, for the three consumers that are not the server:
 * the snapshot test, the README table and `server.json`.
 *
 * The full grant is deliberate. `describeTool` prefixes an `[UNAVAILABLE: …]`
 * marker onto a tool whose scopes no configured profile holds, so a description
 * taken from the ambient credential store says one thing on a developer's
 * machine and another on CI — a snapshot of that is nondeterministic by
 * construction (qa-review F-13). Describing against a synthetic profile that
 * grants every scope the manifest asks for removes the ambient input entirely,
 * and the marker logic keeps its own tests in `test/server.test.ts`.
 */
export function describeAllTools(
  packages: readonly ToolPackageSpec[] = PACKAGES,
): readonly ManifestEntry[] {
  const tools = allTools(packages);
  const everyScope = [
    ...new Set(tools.flatMap((spec) => [...spec.scopes, ...(spec.scopesAnyOf ?? [])])),
  ].sort();
  const fullyAuthorized: readonly ProfileInfo[] = [
    { name: 'MANIFEST', scopes: everyScope },
  ];
  return packages.flatMap((pkg) =>
    pkg.tools.map((spec) => ({
      package: pkg.name,
      scopes: [...spec.scopes],
      ...(spec.scopesAnyOf === undefined ? {} : { scopesAnyOf: [...spec.scopesAnyOf] }),
      tool: describeTool(spec, fullyAuthorized),
    })),
  );
}

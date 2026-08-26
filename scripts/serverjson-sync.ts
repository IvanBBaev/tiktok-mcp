/**
 * serverjson-sync (TESTING.md § Sync gates and repo meta).
 *
 * `server.json` is how the MCP registry — and every client that installs from
 * it — sees this server, but it restates facts that already exist in code:
 * the package name, the transport, the environment variables `core/settings`
 * understands, the tool count. Nothing recomputes it, and the failure mode is
 * quiet: an install that sets a variable this build ignores, or that never
 * gets told about a variable it needs, looks like a broken server rather than a
 * stale manifest.
 *
 * Unlike the other gates this one never regenerates its file. `server.json` is
 * hand-curated prose in the places that matter (the descriptions a human reads
 * while choosing what to install), and the registry treats it as the submitted
 * document — generating it would move an editorial decision into a script.
 * `--write` therefore reports exactly what `--check` reports.
 *
 * Deliberately NOT checked here, so the gate's silence is not read as more than
 * it is:
 *  - schema validity — `mcp-publisher` validates against the published schema at
 *    publish time, and the publish-blocking limits it enforces are in
 *    `scripts/release-guard.ts`;
 *  - completeness of the variable list — `server.json` lists the install
 *    minimum on purpose, not all ~30 `TT_` settings;
 *  - the wording of any description;
 *  - secrecy of non-credential variables — `SECRET_VARS` is private to
 *    `core/settings`, so only the two credentials can be asserted from here.
 *
 * Usage: `node build/scripts/serverjson-sync.js`
 */

import { envKeyFor } from '../src/core/config.js';
import { DEFAULT_PROFILE, knownSettingVars, loadSettings } from '../src/core/settings.js';
import { allTools } from '../src/tools/index.js';
import { asRecord, asString, readRepoJson } from './lib/repo.js';

const SERVER_JSON = 'server.json';
const PACKAGE_JSON = 'package.json';

/** A count claim in the description — "11 tools" — that the code can settle. */
const TOOL_COUNT_CLAIM = /(\d+)\s+tools\b/;

/** What the running build says, as opposed to what `server.json` claims. */
export interface LiveFacts {
  /** The transport a default install actually starts with. */
  transport: string;
  /** Every non-credential `TT_` variable this build understands. */
  knownVars: ReadonlySet<string>;
  /** The two app credentials, which live in `core/config`, not in `Settings`. */
  credentials: readonly string[];
  toolCount: number;
}

export function liveFacts(): LiveFacts {
  return {
    transport: loadSettings({}).transport,
    knownVars: knownSettingVars(),
    credentials: [
      envKeyFor(DEFAULT_PROFILE, 'clientKey'),
      envKeyFor(DEFAULT_PROFILE, 'clientSecret'),
    ],
    toolCount: allTools().length,
  };
}

/** `git+https://…/repo.git` and `https://…/repo` are the same repository. */
function normalizeRepoUrl(url: string): string {
  return url.replace(/^git\+/, '').replace(/\.git$/, '');
}

function checkEnvironment(
  variables: readonly unknown[],
  live: LiveFacts,
  problems: string[],
): void {
  const seen = new Set<string>();
  for (const entry of variables) {
    const record = asRecord(entry) ?? {};
    const name = asString(record['name']);
    if (name === undefined) {
      problems.push(`${SERVER_JSON} declares an environment variable with no name`);
      continue;
    }
    if (seen.has(name)) {
      problems.push(`${SERVER_JSON} declares ${name} twice`);
      continue;
    }
    seen.add(name);
    const isCredential = live.credentials.includes(name);
    if (!isCredential && !live.knownVars.has(name)) {
      problems.push(
        `${SERVER_JSON} declares ${name}, which this build does not read ` +
          `(core/settings knownSettingVars) — an operator setting it gets silence`,
      );
      continue;
    }
    if (isCredential) {
      // Without these the server cannot obtain a token at all, and both are
      // secrets: a client that renders them in plain text is a leak.
      if (record['isRequired'] !== true)
        problems.push(`${SERVER_JSON} does not mark the credential ${name} isRequired`);
      if (record['isSecret'] !== true)
        problems.push(`${SERVER_JSON} does not mark the credential ${name} isSecret`);
    } else if (record['isRequired'] === true) {
      // `loadSettings` defaults every non-credential setting; a client that
      // demands one before install is asking for a value nobody has.
      problems.push(
        `${SERVER_JSON} marks ${name} isRequired, but this build starts without it`,
      );
    }
  }
  for (const credential of live.credentials) {
    if (!seen.has(credential)) {
      problems.push(
        `${SERVER_JSON} omits ${credential}, without which no install can authorize`,
      );
    }
  }
}

/** Every disagreement between `server.json`, `package.json` and the build. */
export function checkServerJson(
  server: Record<string, unknown>,
  pkg: Record<string, unknown>,
  live: LiveFacts,
): string[] {
  const problems: string[] = [];

  // The registry verifies ownership by matching this against the published
  // tarball's `mcpName`; a mismatch fails after npm has already published.
  const mcpName = asString(pkg['mcpName']);
  if (asString(server['name']) !== mcpName) {
    problems.push(
      `${SERVER_JSON} name ${String(server['name'])} != ${PACKAGE_JSON} mcpName ${String(mcpName)}`,
    );
  }

  const version = asString(pkg['version']);
  if (asString(server['version']) !== version) {
    problems.push(
      `${SERVER_JSON} version ${String(server['version'])} != ${PACKAGE_JSON} version ${String(version)}`,
    );
  }

  const repository = asRecord(server['repository']) ?? {};
  const pkgRepository = asString(asRecord(pkg['repository'])?.['url']);
  const declared = asString(repository['url']);
  if (
    declared === undefined ||
    pkgRepository === undefined ||
    normalizeRepoUrl(declared) !== normalizeRepoUrl(pkgRepository)
  ) {
    problems.push(
      `${SERVER_JSON} repository.url ${String(declared)} != ${PACKAGE_JSON} repository.url ${String(pkgRepository)}`,
    );
  }

  const description = asString(server['description']) ?? '';
  const claim = TOOL_COUNT_CLAIM.exec(description);
  if (claim !== null && claim[1] !== String(live.toolCount)) {
    problems.push(
      `${SERVER_JSON} description claims ${String(claim[1])} tools, but the server registers ${String(live.toolCount)}`,
    );
  }

  const packages = Array.isArray(server['packages']) ? server['packages'] : [];
  if (packages.length !== 1) {
    // One published artifact, one entry: a second one would be a distribution
    // this repo does not build, and the registry would advertise it anyway.
    problems.push(
      `${SERVER_JSON} lists ${String(packages.length)} package entries; this repo publishes exactly one npm package`,
    );
    return problems;
  }
  const entry = asRecord(packages[0]) ?? {};
  if (entry['registryType'] !== 'npm') {
    problems.push(
      `${SERVER_JSON} package registryType ${String(entry['registryType'])} != npm`,
    );
  }
  if (asString(entry['identifier']) !== asString(pkg['name'])) {
    problems.push(
      `${SERVER_JSON} package identifier ${String(entry['identifier'])} != ${PACKAGE_JSON} name ${String(pkg['name'])}`,
    );
  }
  if (asString(entry['version']) !== version) {
    problems.push(
      `${SERVER_JSON} package version ${String(entry['version'])} != ${PACKAGE_JSON} version ${String(version)}`,
    );
  }
  const transport = asString(asRecord(entry['transport'])?.['type']);
  if (transport !== live.transport) {
    problems.push(
      `${SERVER_JSON} package transport ${String(transport)} != the default transport ${live.transport}`,
    );
  }
  const variables = entry['environmentVariables'];
  checkEnvironment(Array.isArray(variables) ? variables : [], live, problems);
  return problems;
}

export async function syncServerJson(): Promise<boolean> {
  const server = await readRepoJson(SERVER_JSON);
  const pkg = await readRepoJson(PACKAGE_JSON);
  if (server === undefined || pkg === undefined) {
    process.stderr.write(
      `serverjson-sync: ${SERVER_JSON} or ${PACKAGE_JSON} is unreadable.\n`,
    );
    return false;
  }
  const problems = checkServerJson(server, pkg, liveFacts());
  if (problems.length === 0) return true;
  process.stderr.write(
    `serverjson-sync: ${SERVER_JSON} disagrees with the code it describes — ` +
      `edit it by hand (\`npm run sync:write\` never rewrites it):\n` +
      `${problems.map((problem) => `  x ${problem}`).join('\n')}\n` +
      `  note: schema validity, variable-list completeness and description ` +
      `wording are not checked here.\n`,
  );
  return false;
}

if (process.argv[1]?.endsWith('serverjson-sync.js') === true) {
  const ok = await syncServerJson();
  process.exitCode = ok ? 0 : 1;
}

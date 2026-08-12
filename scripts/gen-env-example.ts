/**
 * env-docs-sync, generation half (TESTING.md § Sync gates and repo meta):
 * `.env.example` is rendered from the live settings module, never hand-edited.
 *
 * Two properties make this worth generating. First, **every default shown is
 * read from `loadSettings`** — a changed default updates the example in the same
 * commit instead of leaving a confident, wrong number in the file operators copy
 * from. Second, the gate below asserts the spec covers *exactly* the known
 * settings variables plus the credential keys, so a new `TT_` variable cannot
 * land undocumented and a deleted one cannot linger.
 *
 * What stays hand-written is the prose: section order, the comment above each
 * variable, and which variables are shown uncommented. That is editorial, and a
 * generator that invented it would produce a file nobody wants to read.
 *
 * The sibling gate — `.env.example` ⇄ CONFIGURATION.md ⇄ `Settings` — lives in
 * `test/settings.test.ts` as `env-docs-sync`.
 *
 * Usage: `node build/scripts/gen-env-example.js [--check]`
 */

import { envKeyFor } from '../src/core/config.js';
import {
  DEFAULT_PROFILE,
  knownSettingVars,
  loadSettings,
  settingVarName,
  type Settings,
} from '../src/core/settings.js';
import { firstDifference, readRepoText, syncFile } from './lib/repo.js';

const ENV_EXAMPLE = '.env.example';

/** How one variable's line is rendered. */
type Render =
  /** Uncommented and empty — the operator must fill it in. */
  | 'required'
  /** Commented out with no value: optional, and no meaningful default. */
  | 'optional'
  /** Commented out, showing the value `loadSettings` would produce. */
  | 'default';

interface VarDoc {
  name: string;
  /** Comment lines rendered above the variable, without the leading `# `. */
  comment?: readonly string[];
  render: Render;
}

interface Section {
  title: string;
  /** Free-form comment lines closing the section (examples, warnings). */
  trailer?: readonly string[];
  vars: readonly VarDoc[];
}

const HEADER: readonly string[] = [
  'tiktok-mcp-ai — example environment file',
  '',
  'Copy the values you need into your real env file and fill them in. The server',
  'resolves the env file in this order:',
  '  1. TT_ENV_FILE (explicit path)',
  '  2. $XDG_CONFIG_HOME/tiktok-mcp-ai/.env  (fallback ~/.config/tiktok-mcp-ai/.env)  [POSIX]',
  '  3. %LOCALAPPDATA%\\tiktok-mcp-ai\\.env                                             [Windows]',
  'Real environment variables always take precedence over the file.',
  '',
  'The file holds secrets — it is written owner-only (0600) on POSIX and should',
  'never be committed. Only the two variables at the top are required; everything',
  'else is optional tuning shown with its default. Token values are written by',
  '`login` / refresh — do NOT set them by hand.',
  'This file is GENERATED — run `npm run docs:env` after changing a default.',
  'Full reference: docs/CONFIGURATION.md',
];

/** The app credentials and the default profile's token sextet (`core/config`). */
const CLIENT_KEY = envKeyFor(DEFAULT_PROFILE, 'clientKey');
const CLIENT_SECRET = envKeyFor(DEFAULT_PROFILE, 'clientSecret');
const TOKEN_KEYS: readonly string[] = [
  envKeyFor(DEFAULT_PROFILE, 'accessToken'),
  envKeyFor(DEFAULT_PROFILE, 'refreshToken'),
  envKeyFor(DEFAULT_PROFILE, 'openId'),
  envKeyFor(DEFAULT_PROFILE, 'scopes'),
  envKeyFor(DEFAULT_PROFILE, 'accessExpiresAt'),
  envKeyFor(DEFAULT_PROFILE, 'refreshExpiresAt'),
];

export const SECTIONS: readonly Section[] = [
  {
    title: 'Required: TikTok app credentials',
    vars: [
      { name: CLIENT_KEY, render: 'required' },
      { name: CLIENT_SECRET, render: 'required' },
    ],
  },
  {
    title: 'Media (needed to post LOCAL files; omit for URL-based posting only)',
    vars: [
      {
        name: 'TT_MEDIA_ROOT',
        comment: [
          'The only directory FILE_UPLOAD tools may read from; unset => source:"file" is',
          'rejected locally (fail-closed). Use a dedicated media folder, never $HOME.',
        ],
        render: 'optional',
      },
      {
        name: 'TT_VERIFIED_URL_PREFIXES',
        comment: [
          'Comma-separated https:// prefixes verified in the developer portal, so the plan',
          'phase can flag unverifiable PULL_FROM_URL domains early. Advisory only.',
        ],
        render: 'optional',
      },
    ],
  },
  {
    title: 'Tool surface & write policy',
    vars: [
      {
        name: 'TT_TOOL_PACKAGES',
        comment: [
          'Packages/profile to register: auth,user,video,publish,publish-write — or a',
          'profile: core (all reads, default) | all (reads + write tools).',
        ],
        render: 'default',
      },
      {
        name: 'TT_PACKAGES_DENY',
        comment: ['Packages forced off even if enabled above (deny always wins).'],
        render: 'default',
      },
      {
        name: 'TT_PACKAGES_READONLY',
        comment: ['1 registers only read-only tools (drops publish-write).'],
        render: 'default',
      },
      {
        name: 'TT_WRITE_MODE',
        comment: [
          'Write behavior: plan (preview then plan_id, default) | apply (trusted',
          'automation only — NO injection resistance) | deny (publish-write not registered).',
        ],
        render: 'default',
      },
      {
        name: 'TT_PLAN_TTL_S',
        comment: ['Lifetime (seconds) of a minted plan_id before it expires.'],
        render: 'default',
      },
      {
        name: 'TT_PLAN_MAX_OUTSTANDING',
        comment: ['Cap on outstanding previews kept in memory (oldest evicted first).'],
        render: 'default',
      },
      {
        name: 'TT_DEFAULT_AIGC_LABEL',
        comment: ['Default for the AIGC (is_aigc) label on posts; on by default.'],
        render: 'default',
      },
    ],
  },
  {
    title: 'Accounts / profiles',
    trailer: [
      'Extra account profiles are written by `login --profile <name>`, e.g.:',
      'TT_PROFILE_BRAND_ACCESS_TOKEN=...',
    ],
    vars: [
      {
        name: 'TT_ACTIVE_PROFILE',
        comment: ['Profile used when a tool call has no `account` argument.'],
        render: 'default',
      },
      {
        name: 'TT_LOCK_PROFILE',
        comment: [
          'Pin the session to one profile: an explicit `account` for any other fails locally.',
        ],
        render: 'optional',
      },
    ],
  },
  {
    title: 'OAuth / login',
    vars: [
      {
        name: 'TT_REDIRECT_PORT',
        comment: [
          'Optional fixed-port pin for the login loopback server; unset binds 127.0.0.1:0.',
        ],
        render: 'optional',
      },
      {
        name: 'TT_LOGIN_SCOPES',
        comment: [
          'Scopes requested by `login`; default is least-privilege from TT_TOOL_PACKAGES.',
        ],
        render: 'optional',
      },
      {
        name: 'TT_TOKEN_REFRESH_SKEW_S',
        comment: ['Refresh the access token this many seconds before its expiry.'],
        render: 'default',
      },
    ],
  },
  {
    title: 'Tokens (written by `login`/refresh — DO NOT set by hand; secret)',
    vars: TOKEN_KEYS.map((name) => ({ name, render: 'optional' as const })),
  },
  {
    title: 'Transport',
    vars: [
      {
        name: 'TT_TRANSPORT',
        comment: [
          'stdio (default, no socket) | http (Streamable HTTP for remote/agent clients).',
        ],
        render: 'default',
      },
      {
        name: 'TT_HTTP_HOST',
        comment: ['Bind host for the http transport (loopback by default).'],
        render: 'default',
      },
      {
        name: 'TT_PORT',
        comment: ['TCP port for the http transport.'],
        render: 'default',
      },
      {
        name: 'TT_HTTP_TOKEN',
        comment: [
          'Bearer token — REQUIRED whenever TT_TRANSPORT=http (loopback included); secret.',
        ],
        render: 'optional',
      },
      {
        name: 'TT_HTTP_INSECURE',
        comment: ['1 acknowledges a non-loopback bind without TLS termination in front.'],
        render: 'default',
      },
    ],
  },
  {
    title: 'HTTP client, limits & output',
    vars: [
      {
        name: 'TT_TIMEOUT_MS',
        comment: ['Per-request timeout (ms).'],
        render: 'default',
      },
      {
        name: 'TT_UPLOAD_TIMEOUT_MS',
        comment: ['Upload request timeout (ms).'],
        render: 'default',
      },
      {
        name: 'TT_MAX_RETRIES',
        comment: [
          'Retry cap for the idempotent read class (publish inits are never retried).',
        ],
        render: 'default',
      },
      {
        name: 'TT_CHUNK_RETRIES',
        comment: ['Per-chunk upload retry cap (identical Content-Range on replay).'],
        render: 'default',
      },
      {
        name: 'TT_MAX_CONCURRENT',
        comment: ['Per-host concurrency semaphore.'],
        render: 'default',
      },
      {
        name: 'TT_PUBLISH_RPM',
        comment: ['Local token bucket for publish inits, per profile.'],
        render: 'default',
      },
      {
        name: 'TT_FETCH_ALL_CAP',
        comment: [
          'Item cap for fetch_all pagination; a capped read surfaces `truncated`.',
        ],
        render: 'default',
      },
      {
        name: 'TT_RESULT_CHAR_BUDGET',
        comment: ['Truncation budget for tool results (always valid JSON).'],
        render: 'default',
      },
      {
        name: 'TT_PRETTY_JSON',
        comment: ['1 pretty-prints results (costs tokens).'],
        render: 'default',
      },
      {
        name: 'TT_STATUS_POLL_INTERVAL_MS',
        comment: ['Bounded polling for publish status (ms).'],
        render: 'default',
      },
      { name: 'TT_STATUS_POLL_TIMEOUT_MS', render: 'default' },
      {
        name: 'TT_LOG_LEVEL',
        comment: [
          'stderr log level: error | warn | info | debug (never logs secret-bearing bodies).',
        ],
        render: 'default',
      },
    ],
  },
  {
    title: 'Env file, journal & cross-process lock',
    vars: [
      {
        name: 'TT_ENV_FILE',
        comment: [
          'Explicit path to the env file to read/write; the journal and lock follow it.',
        ],
        render: 'optional',
      },
      {
        name: 'TT_CONFIG_SCHEMA',
        comment: [
          'Layout version of the env file; written by the server, bumped by a migration.',
        ],
        render: 'default',
      },
      {
        name: 'TT_JOURNAL_MAX_BYTES',
        comment: ['Max size of journal.ndjson before rotation.'],
        render: 'default',
      },
      {
        name: 'TT_ENV_LOCK_HEARTBEAT_MS',
        comment: ['Env-file lock timings (ms): heartbeat, stale threshold, max wait.'],
        render: 'default',
      },
      { name: 'TT_ENV_LOCK_STALE_MS', render: 'default' },
      { name: 'TT_ENV_LOCK_WAIT_MS', render: 'default' },
    ],
  },
  {
    title: 'Internal / test-only',
    vars: [
      {
        name: 'TT_OAUTH_BASE_URL',
        comment: [
          'Origin the OAuth calls go to. Exists so the test suite can point them at a',
          'local stub; leave it unset against the real TikTok.',
        ],
        render: 'optional',
      },
    ],
  },
];

/**
 * The env-file spelling of a default value. An env file holds strings, so a
 * setting whose default is an object has no spelling at all — stringifying it
 * would ship `[object Object]` as documentation, so it fails the generator
 * instead and the new shape gets a rendering rule here.
 */
export function renderDefault(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (Array.isArray(value))
    return (value as readonly unknown[]).map(renderDefault).join(',');
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  throw new Error(`no env-file spelling for a default of type ${typeof value}`);
}

function defaultsByVar(): ReadonlyMap<string, string> {
  // The two required credentials are the only env a default load needs; every
  // other value below is therefore the documented default, not a local setting.
  const settings: Settings = loadSettings({
    [CLIENT_KEY]: 'example',
    [CLIENT_SECRET]: 'example',
  });
  return new Map(
    Object.entries(settings).map(([field, value]) => [
      settingVarName(field),
      renderDefault(value),
    ]),
  );
}

export function renderEnvExample(): string {
  const defaults = defaultsByVar();
  const lines: string[] = HEADER.map((line) => (line === '' ? '#' : `# ${line}`));

  for (const section of SECTIONS) {
    lines.push('', `# --- ${section.title} ---`);
    for (const doc of section.vars) {
      for (const comment of doc.comment ?? []) lines.push(`# ${comment}`);
      if (doc.render === 'required') {
        lines.push(`${doc.name}=`);
        continue;
      }
      const value = doc.render === 'default' ? (defaults.get(doc.name) ?? '') : '';
      lines.push(`# ${doc.name}=${value}`);
    }
    for (const trailer of section.trailer ?? []) lines.push(`# ${trailer}`);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Every variable the settings module knows, plus the credential keys, must
 * appear exactly once. This is the half that catches an *addition*: a new
 * setting with no entry here would otherwise render a complete-looking example
 * file that silently omits it.
 */
export function specCoverage(): {
  missing: string[];
  extra: string[];
  duplicate: string[];
} {
  const documented: string[] = SECTIONS.flatMap((section) =>
    section.vars.map((doc) => doc.name),
  );
  const seen = new Set<string>();
  const duplicate = documented.filter((name) => {
    if (seen.has(name)) return true;
    seen.add(name);
    return false;
  });
  const expected = new Set<string>([
    CLIENT_KEY,
    CLIENT_SECRET,
    ...TOKEN_KEYS,
    ...knownSettingVars(),
  ]);
  return {
    missing: [...expected].filter((name) => !seen.has(name)).sort(),
    extra: [...seen].filter((name) => !expected.has(name)).sort(),
    duplicate: [...new Set(duplicate)].sort(),
  };
}

export async function syncEnvExample(check: boolean): Promise<boolean> {
  const coverage = specCoverage();
  let ok = true;
  for (const [label, names] of Object.entries(coverage)) {
    if (names.length === 0) continue;
    ok = false;
    process.stderr.write(
      `env-example: ${label} variables in scripts/gen-env-example.ts: ${names.join(', ')}\n`,
    );
  }

  const next = renderEnvExample();
  const { drifted } = await syncFile(ENV_EXAMPLE, next, check);
  if (drifted && !check) {
    process.stdout.write(`env-example: ${ENV_EXAMPLE} regenerated.\n`);
  } else if (drifted) {
    const current = await readRepoText(ENV_EXAMPLE).catch(() => '');
    process.stderr.write(
      `env-example: ${ENV_EXAMPLE} is stale — run \`npm run docs:env\`.\n` +
        `${firstDifference(next, current)}\n`,
    );
    ok = false;
  }
  return ok;
}

if (process.argv[1]?.endsWith('gen-env-example.js') === true) {
  const ok = await syncEnvExample(process.argv.includes('--check'));
  process.exitCode = ok ? 0 : 1;
}

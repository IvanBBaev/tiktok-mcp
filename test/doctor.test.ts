/**
 * `cli/doctor.ts` — the health report.
 *
 * Doctor is the command people run when nothing works, so what is asserted here
 * is that it keeps reporting when things are broken: a rejected settings
 * environment, an unreadable profile or a check that throws must each become one
 * row and leave the other twelve checks running. The exit code is decided by
 * `fail` alone — a readiness gate that trips on "TT_MEDIA_ROOT is not set" is a
 * gate nobody keeps (README § "Verify your setup").
 *
 * Every run is driven through injected seams: `TT_ENV_FILE` points at a sandbox,
 * the clock is virtual, `deps.platform` picks the CC-F3 branch, and the one
 * online check is fed by a scripted `fetch`. Nothing here touches the network,
 * the real config directory or a terminal.
 */

import assert from 'node:assert/strict';
import { chmod, mkdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DOCTOR_CHECKS,
  doctorUsage,
  parseDoctorArgs,
  renderFinding,
  renderSummary,
  runDoctor,
  type Check,
  type DoctorContext,
  type Finding,
} from '../src/cli/doctor.js';
import {
  cliIo,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  type CliDeps,
} from '../src/cli/index.js';
import { createLogger } from '../src/core/log.js';
import { resetTokenCache } from '../src/core/oauth.js';
import {
  BASELINE_NOW_MS,
  BASELINE_REFRESH_EXPIRES_AT,
  BASELINE_TOKEN_EXPIRES_AT,
  fsSandbox,
  mockClock,
  scriptFetch,
  ttEnvelope,
  withFetch,
  type MockClock,
} from './helpers.js';

/** POSIX modes are not a thing on Windows: `chmod` there only moves the read-only bit. */
const POSIX_ONLY = process.platform === 'win32' ? 'POSIX file modes only' : false;

const DAY_MS = 24 * 60 * 60 * 1000;

const NOOP_LOGGER = createLogger({ level: 'error' });

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

interface Fixture {
  readonly dir: string;
  readonly envFile: string;
  readonly clock: MockClock;
  cleanup(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const box = await fsSandbox();
  // A token cached by an earlier test would answer for this profile too.
  resetTokenCache();
  return {
    dir: box.dir,
    envFile: join(box.dir, '.env'),
    clock: mockClock(),
    cleanup: () => box.cleanup(),
  };
}

/** A profile that has completed a login and can run every registered tool. */
function authorizedLines(over: Record<string, string> = {}): string[] {
  const values: Record<string, string> = {
    TT_CLIENT_KEY: 'test-client-key',
    TT_CLIENT_SECRET: 'test-client-secret',
    TT_ACCESS_TOKEN: 'act.doctor',
    TT_TOKEN_EXPIRES_AT: BASELINE_TOKEN_EXPIRES_AT,
    TT_REFRESH_TOKEN: 'rft.doctor',
    TT_REFRESH_EXPIRES_AT: BASELINE_REFRESH_EXPIRES_AT,
    TT_OPEN_ID: 'open-id-doctor-1234',
    TT_SCOPES: 'user.info.basic,video.list,video.publish',
    ...over,
  };
  return Object.entries(values)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${value}`);
}

async function writeEnvFile(f: Fixture, lines: readonly string[]): Promise<void> {
  await writeFile(f.envFile, `${lines.join('\n')}\n`, 'utf8');
  // The permissions row is the subject of its own tests; everywhere else it
  // should be quiet, so the file starts out at the mode CC-F3 wants.
  await chmod(f.envFile, 0o600);
}

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** One full `runDoctor` invocation with both streams captured. */
async function run(
  f: Fixture,
  argv: readonly string[] = ['--offline'],
  over: CliDeps = {},
  env: Record<string, string> = {},
): Promise<Run> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runDoctor({
    argv,
    env: { TT_ENV_FILE: f.envFile, ...env },
    clock: f.clock,
    logger: NOOP_LOGGER,
    stdout: (chunk) => stdout.push(chunk),
    stderr: (chunk) => stderr.push(chunk),
    isTTY: false,
    ...over,
  });
  return { code, out: stdout.join(''), err: stderr.join('') };
}

/** The row a check produced, without the label — `[ ok ] tokens: …` → the text. */
function row(out: string, title: string): string | undefined {
  return out.split('\n').find((line) => line.includes(`] ${title}: `));
}

function checkById(id: string): Check {
  const found = DOCTOR_CHECKS.find((check) => check.id === id);
  assert.ok(found !== undefined, `no check with id ${id}`);
  return found;
}

/** A context assembled by hand, for branches the CLI path cannot reach. */
function doctorContext(over: Partial<DoctorContext> = {}): DoctorContext {
  const base: DoctorContext = {
    deps: {},
    io: cliIo({ stdout: () => undefined, stderr: () => undefined, isTTY: false }),
    platform: 'linux',
    clock: mockClock(),
    logger: NOOP_LOGGER,
    envFilePath: '/nowhere/.env',
    snapshot: {
      path: '/nowhere/.env',
      exists: false,
      values: new Map(),
      schema: 1,
      warnings: [],
      lines: [],
      eol: '\n',
    },
    env: {},
    profile: 'DEFAULT',
    offline: true,
  };
  return { ...base, ...over };
}

// ---------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------

test('--help prints the usage on stdout and checks nothing', async () => {
  const f = await fixture();
  try {
    const r = await run(f, ['--help']);
    assert.equal(r.code, EXIT_OK);
    assert.equal(r.out, doctorUsage());
    assert.equal(r.err, '');
  } finally {
    await f.cleanup();
  }
});

test('an unknown option is a usage error and leaves stdout empty', async () => {
  const f = await fixture();
  try {
    const r = await run(f, ['--nope']);
    assert.equal(r.code, EXIT_USAGE);
    assert.match(r.err, /Unknown option "--nope"\./);
    assert.match(r.err, /Usage: tiktok-mcp-ai doctor/);
    // cc-g3: diagnostics never share the results stream.
    assert.equal(r.out, '');
  } finally {
    await f.cleanup();
  }
});

test('parseDoctorArgs accepts both spellings and rejects the malformed ones', () => {
  assert.deepEqual(parseDoctorArgs(['--profile', 'WORK']), {
    ok: true,
    flags: { offline: false, help: false, profile: 'WORK' },
  });
  assert.deepEqual(parseDoctorArgs(['--profile=WORK']), {
    ok: true,
    flags: { offline: false, help: false, profile: 'WORK' },
  });
  assert.deepEqual(parseDoctorArgs(['--offline', '-h']), {
    ok: true,
    flags: { offline: true, help: true },
  });
  assert.deepEqual(parseDoctorArgs([]), {
    ok: true,
    flags: { offline: false, help: false },
  });

  assert.deepEqual(parseDoctorArgs(['--profile']), {
    ok: false,
    message: '--profile needs a value.',
  });
  assert.deepEqual(parseDoctorArgs(['--profile=']), {
    ok: false,
    message: '--profile needs a value.',
  });
  assert.deepEqual(parseDoctorArgs(['--offline=1']), {
    ok: false,
    message: '--offline does not take a value.',
  });
});

// ---------------------------------------------------------------------------
// the healthy run
// ---------------------------------------------------------------------------

test('a fully configured profile passes every local check', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    const r = await run(f);

    assert.equal(r.code, EXIT_OK);
    assert.equal(r.err, '');
    assert.match(r.out, /^tiktok-mcp-ai doctor — profile DEFAULT\n\n/);
    assert.ok(!r.out.includes('[FAIL]'), r.out);

    assert.equal(row(r.out, 'env file'), `[ ok ] env file: found at ${f.envFile}`);
    assert.match(r.out, /\[ ok \] config schema: version 1\n/);
    assert.match(r.out, /\[ ok \] settings: write mode plan, log level /);
    assert.match(r.out, /\[ ok \] env lock: not held\n/);
    assert.match(
      r.out,
      /\[ ok \] app credentials: TT_CLIENT_KEY and TT_CLIENT_SECRET are set\n/,
    );
    assert.match(r.out, /\[ ok \] profiles: DEFAULT \(active\)\n/);
    // The open_id is masked even though the whole report is local (SECURITY.md).
    assert.match(r.out, /\[ ok \] tokens: open_id open…1234\n/);
    assert.match(
      r.out,
      /\[ ok \] tokens: refresh token valid until 2027-01-01T00:00:00\.000Z\n/,
    );
    assert.match(
      r.out,
      /\[ ok \] tokens: access token valid until 2026-01-02T00:00:00\.000Z\n/,
    );
    assert.match(
      r.out,
      /\[ ok \] scopes: granted: user\.info\.basic, video\.list, video\.publish\n/,
    );
    // The count tracks the manifest and moves with every new tool; what this
    // check owns is the "all … are usable" verdict, not the arithmetic —
    // `test/manifest.test.ts` pins the manifest itself.
    assert.match(
      r.out,
      /\[ ok \] scopes: all \d+ tools of the enabled packages are usable\n/,
    );
    assert.match(r.out, /\[info\] api probe: skipped \(--offline\)\n/);
    assert.match(r.out, /\[info\] media root: TT_MEDIA_ROOT is not set/);
    assert.match(r.out, /\[ ok \] publish journal: no publish has been recorded yet\n/);
    assert.match(r.out, /\[ ok \] transport: stdio\n/);
    // The ok/info split moves by one on Windows (the permissions row is an info
    // line there); what must hold everywhere is that nothing warned or failed.
    assert.match(
      r.out,
      /\n\d+ checks passed, \d+ informational, 0 warnings, 0 failures\n$/,
    );
  } finally {
    await f.cleanup();
  }
});

test('the report keeps its order — infrastructure, identity, probe, runtime', () => {
  assert.deepEqual(
    DOCTOR_CHECKS.map((check) => check.id),
    [
      'env-file',
      'permissions',
      'config-schema',
      'settings',
      'env-lock',
      'app-credentials',
      'profiles',
      'tokens',
      'scopes',
      'api-probe',
      'media-root',
      'publish-journal',
      'transport',
    ],
  );
  assert.ok(Object.isFrozen(DOCTOR_CHECKS));
  assert.equal(
    new Set(DOCTOR_CHECKS.map((check) => check.id)).size,
    DOCTOR_CHECKS.length,
  );
});

test('an installation with nothing configured fails on the app credentials', async () => {
  const f = await fixture();
  try {
    const r = await run(f);

    assert.equal(r.code, EXIT_FAILURE);
    // cc-f1: a missing env file is legal — the process environment may carry it all.
    assert.match(r.out, /\[info\] env file: no file at /);
    assert.match(r.out, /\[FAIL\] app credentials: missing TikTok app credentials: /);
    assert.match(r.out, /TT_CLIENT_KEY, TT_CLIENT_SECRET/);
    assert.match(r.out, /→ Create an app at developers\.tiktok\.com/);
    // The rows after the failure still ran: the whole point is the full picture.
    assert.match(r.out, /\[ ok \] transport: stdio\n/);
    assert.match(r.out, /1 failure\n$/);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// CC-F3 — permissions drift
// ---------------------------------------------------------------------------

test('cc-f3: mode 0600 is what the check wants', { skip: POSIX_ONLY }, async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    const r = await run(f);
    assert.equal(row(r.out, 'permissions'), '[ ok ] permissions: mode 0600');
  } finally {
    await f.cleanup();
  }
});

test(
  'cc-f3: a world-readable env file warns with the chmod that fixes it',
  { skip: POSIX_ONLY },
  async () => {
    const f = await fixture();
    try {
      await writeEnvFile(f, authorizedLines());
      await chmod(f.envFile, 0o644);

      const r = await run(f);
      assert.equal(r.code, EXIT_OK, 'a warning is not a failure');
      assert.match(
        r.out,
        /\[warn\] permissions: mode 0644 — this file holds refresh tokens/,
      );
      // The path is quoted, so a copy-pasted fix survives a space in it.
      assert.ok(r.out.includes(`→ chmod 600 ${JSON.stringify(f.envFile)}\n`), r.out);
      // Nothing was changed behind the user's back on a non-interactive run.
      assert.equal((await stat(f.envFile)).mode & 0o777, 0o644);
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'cc-f3: on a terminal doctor offers the fix and applies it',
  { skip: POSIX_ONLY },
  async () => {
    const f = await fixture();
    try {
      await writeEnvFile(f, authorizedLines());
      await chmod(f.envFile, 0o640);

      const asked: string[] = [];
      const r = await run(f, ['--offline'], {
        isTTY: true,
        prompt: (question) => {
          asked.push(question);
          return Promise.resolve('y');
        },
      });

      assert.match(asked.join(''), /Fix it now with chmod 600\? \[y\/N\] $/);
      assert.match(r.out, /\[ ok \] permissions: mode fixed to 0600 \(was 0640\)\n/);
      assert.equal((await stat(f.envFile)).mode & 0o777, 0o600);
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'cc-f3: declining the offer leaves the file alone',
  { skip: POSIX_ONLY },
  async () => {
    const f = await fixture();
    try {
      await writeEnvFile(f, authorizedLines());
      await chmod(f.envFile, 0o644);

      const r = await run(f, ['--offline'], {
        isTTY: true,
        prompt: () => Promise.resolve('\n'),
      });
      assert.match(r.out, /\[warn\] permissions: mode 0644/);
      assert.equal((await stat(f.envFile)).mode & 0o777, 0o644);
    } finally {
      await f.cleanup();
    }
  },
);

test('cc-f3: on Windows the icacls line is remediation text, never a command that runs', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    await chmod(f.envFile, 0o644);

    const r = await run(f, ['--offline'], { platform: 'win32' });
    assert.match(r.out, /\[info\] permissions: not checked on Windows/);
    assert.match(
      r.out,
      /→ Optional hardening: icacls .* \/inheritance:r \/grant:r "%USERNAME%":F\n/,
    );
    assert.ok(!r.out.includes('chmod 600'), 'chmod is meaningless on Windows');
    if (POSIX_ONLY === false) {
      assert.equal((await stat(f.envFile)).mode & 0o777, 0o644);
    }
  } finally {
    await f.cleanup();
  }
});

test('a missing env file has no permissions row at all', async () => {
  const f = await fixture();
  try {
    const r = await run(f);
    assert.equal(row(r.out, 'permissions'), undefined);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// schema, warnings and leftovers
// ---------------------------------------------------------------------------

test('a newer schema warns that writes are refused, and names the backups', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, [...authorizedLines(), 'TT_CONFIG_SCHEMA=99']);
    await writeFile(`${f.envFile}.pre-schema1`, 'TT_CLIENT_KEY=old\n', 'utf8');

    const r = await run(f);
    assert.match(
      r.out,
      /\[warn\] config schema: TT_CONFIG_SCHEMA=99 was written by a newer version/,
    );
    assert.match(
      r.out,
      /this build understands 1\); reads still work, writes are refused/,
    );
    assert.match(r.out, /→ npm install -g tiktok-mcp-ai@latest\n/);
    assert.match(
      r.out,
      /\[info\] config schema: leftover pre-migration backup\(s\): \.env\.pre-schema1\n/,
    );
    assert.equal(r.code, EXIT_OK);
  } finally {
    await f.cleanup();
  }
});

test('cc-f1: a duplicate key and an unknown TT_ key are reported as env-file warnings', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, [
      ...authorizedLines(),
      'TT_SCOPES=user.info.basic',
      'TT_NOT_A_SETTING=1',
    ]);
    const r = await run(f);

    const warnings = r.out
      .split('\n')
      .filter((line) => line.startsWith('[warn] env file: '));
    assert.equal(warnings.length, 2);
    assert.ok(
      warnings.some((line) => line.includes('TT_SCOPES')),
      warnings.join('\n'),
    );
    assert.ok(
      warnings.some((line) => line.includes('TT_NOT_A_SETTING')),
      warnings.join('\n'),
    );
    // Last-wins: the second TT_SCOPES is the one the scopes row reports on.
    assert.match(r.out, /\[ ok \] scopes: granted: user\.info\.basic\n/);
    assert.equal(r.code, EXIT_OK);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// CC-F6 / CC-F4 — a broken environment still produces a report
// ---------------------------------------------------------------------------

test('cc-f6: an invalid settings environment is one row, and the rest still run', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    // Not `--offline`: the probe has to skip itself because the configuration is
    // unusable, which is the branch that keeps a broken run off the network.
    const r = await run(f, [], {}, { TT_MAX_RETRIES: 'nope', TT_PLAN_TTL_S: '-1' });

    assert.equal(r.code, EXIT_FAILURE);
    const settings = row(r.out, 'settings');
    assert.ok(settings !== undefined && settings.startsWith('[FAIL]'), r.out);
    // Aggregated: both bad variables are named by the single error.
    assert.match(r.out, /TT_MAX_RETRIES/);
    assert.match(r.out, /TT_PLAN_TTL_S/);
    // Everything that does not depend on settings kept reporting.
    assert.match(r.out, /\[ ok \] app credentials: /);
    assert.match(r.out, /\[ ok \] tokens: refresh token valid until /);
    assert.match(
      r.out,
      /\[info\] api probe: skipped — the local configuration has to be fixed first\n/,
    );
    // Settings-derived rows fall silent rather than guessing.
    assert.equal(row(r.out, 'scopes'), undefined);
    assert.equal(row(r.out, 'transport'), undefined);
  } finally {
    await f.cleanup();
  }
});

test('cc-f4: an active profile that does not exist fails and lists the ones that do', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    const r = await run(f, ['--profile', 'work', '--offline']);

    assert.equal(r.code, EXIT_FAILURE);
    // Profile names are upper-cased on read.
    assert.match(r.out, /^tiktok-mcp-ai doctor — profile WORK\n/);
    assert.match(
      r.out,
      /\[FAIL\] profiles: unknown profile WORK; profiles that exist: DEFAULT\n/,
    );
    assert.match(r.out, /→ Set TT_ACTIVE_PROFILE to one of those/);
    assert.equal(row(r.out, 'tokens'), undefined);
  } finally {
    await f.cleanup();
  }
});

test('a second profile is listed beside the active one', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, [
      ...authorizedLines(),
      'TT_PROFILE_WORK_REFRESH_TOKEN=rft.work',
      `TT_PROFILE_WORK_REFRESH_EXPIRES_AT=${BASELINE_REFRESH_EXPIRES_AT}`,
    ]);
    const r = await run(f);
    assert.match(r.out, /\[ ok \] profiles: DEFAULT \(active\), WORK\n/);
  } finally {
    await f.cleanup();
  }
});

test('an invalid --profile name is refused before any check runs', async () => {
  const f = await fixture();
  try {
    const r = await run(f, ['--profile', 'no spaces please']);
    assert.equal(r.code, EXIT_FAILURE);
    assert.match(
      r.err,
      /invalid profile name "no spaces please": expected \[A-Z0-9_\]\+/,
    );
    assert.equal(r.out, '', 'a run that produced no report prints no report');
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// CC-A5 — token expiry
// ---------------------------------------------------------------------------

test('cc-a5: a refresh token inside the 30-day horizon is a warning, not a failure', async () => {
  const f = await fixture();
  try {
    const soon = new Date(BASELINE_NOW_MS + 10 * DAY_MS).toISOString();
    await writeEnvFile(f, authorizedLines({ TT_REFRESH_EXPIRES_AT: soon }));

    const r = await run(f);
    assert.equal(r.code, EXIT_OK);
    assert.match(
      r.out,
      new RegExp(`\\[warn\\] tokens: the refresh token expires in 10 days \\(${soon}\\)`),
    );
    assert.match(
      r.out,
      /→ Re-run npx tiktok-mcp-ai login --profile DEFAULT before then\.\n/,
    );
  } finally {
    await f.cleanup();
  }
});

test('cc-a5: an expired refresh token is terminal and names the login command', async () => {
  const f = await fixture();
  try {
    const gone = new Date(BASELINE_NOW_MS - 3 * DAY_MS).toISOString();
    await writeEnvFile(f, authorizedLines({ TT_REFRESH_EXPIRES_AT: gone }));

    const r = await run(f);
    assert.equal(r.code, EXIT_FAILURE);
    assert.match(r.out, /\[FAIL\] tokens: the refresh token expired 3 days ago /);
    assert.match(r.out, /this server cannot renew it on its own\n/);
    assert.match(r.out, /→ npx tiktok-mcp-ai login --profile DEFAULT\n/);
  } finally {
    await f.cleanup();
  }
});

test('a profile that never completed a login fails on the tokens row', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, [
      'TT_CLIENT_KEY=test-client-key',
      'TT_CLIENT_SECRET=test-client-secret',
    ]);
    const r = await run(f);

    assert.equal(r.code, EXIT_FAILURE);
    assert.match(r.out, /\[ ok \] app credentials: /);
    assert.match(
      r.out,
      /\[FAIL\] tokens: profile DEFAULT has no stored token — it has never completed a login\n/,
    );
    assert.match(
      r.out,
      /\[warn\] scopes: profile DEFAULT has no granted scopes on record\n/,
    );
  } finally {
    await f.cleanup();
  }
});

test('a stored refresh expiry is not required, only better', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines({ TT_REFRESH_EXPIRES_AT: '' }));
    const r = await run(f);

    assert.equal(r.code, EXIT_OK);
    assert.match(r.out, /\[warn\] tokens: no refresh-token expiry on record/);
    assert.match(
      r.out,
      /→ Re-run npx tiktok-mcp-ai login --profile DEFAULT to store one\.\n/,
    );
  } finally {
    await f.cleanup();
  }
});

test('an expired access token is information — refreshing it is routine', async () => {
  const f = await fixture();
  try {
    const stale = new Date(BASELINE_NOW_MS - 2 * 60 * 60 * 1000).toISOString();
    await writeEnvFile(f, authorizedLines({ TT_TOKEN_EXPIRES_AT: stale }));

    const r = await run(f);
    assert.equal(r.code, EXIT_OK);
    assert.match(
      r.out,
      /\[info\] tokens: the access token expired 2 hours ago; it is renewed automatically on the next call\n/,
    );
  } finally {
    await f.cleanup();
  }
});

test('cc-h2: a refresh expiry that is not a timestamp fails rather than comparing NaN', async () => {
  const findings = await checkById('tokens').run(
    doctorContext({
      credentials: {
        clientKey: 'k',
        clientSecret: 's',
        refreshToken: 'rft',
        refreshExpiresAt: 'the day after tomorrow',
      },
    }),
  );
  assert.deepEqual(findings, [
    {
      severity: 'fail',
      text: 'the stored refresh expiry the day after tomorrow is not a valid timestamp',
      remediation: 'npx tiktok-mcp-ai login --profile DEFAULT',
    } satisfies Finding,
  ]);
});

// ---------------------------------------------------------------------------
// scopes — read from the live manifest, never from a third copy of the table
// ---------------------------------------------------------------------------

test('the tools a missing scope blocks are named, with the login that unblocks them', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines({ TT_SCOPES: 'user.info.basic' }));
    // `all` so the write package is in scope too.
    const r = await run(f, ['--offline'], {}, { TT_TOOL_PACKAGES: 'all' });

    assert.equal(r.code, EXIT_OK, 'a narrower grant is a choice, not a fault');
    assert.match(
      r.out,
      /\[warn\] scopes: \d+ tools stay unavailable for want of video\.list, video\.publish, video\.upload: /,
    );
    // Every blocked tool is named, so the user can weigh the re-login.
    for (const name of [
      'tiktok_list_videos',
      'tiktok_query_videos',
      'tiktok_get_creator_info',
      'tiktok_post_video',
      'tiktok_upload_video_draft',
      'tiktok_post_photos',
      'tiktok_upload_photos_draft',
    ]) {
      assert.ok(r.out.includes(name), `${name} missing from:\n${r.out}`);
    }
    assert.match(
      r.out,
      /→ npx tiktok-mcp-ai login --profile DEFAULT --scopes user\.info\.basic,video\.list,video\.publish,video\.upload\n/,
    );
    // A package that ships no tools yet is reported as exactly that, never
    // "ok". `publish-write` left that list when tiktok_post_video landed
    // (TD-4), so with every package enabled the row has no subject left.
    assert.ok(!r.out.includes('enabled but not implemented in this build'), r.out);
  } finally {
    await f.cleanup();
  }
});

test('a single blocked tool is counted in the singular', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines({ TT_SCOPES: 'video.list,video.publish' }));
    const r = await run(f);
    assert.match(
      r.out,
      /\[warn\] scopes: 1 tool stays unavailable for want of user\.info\.basic: tiktok_get_user_info\n/,
    );
  } finally {
    await f.cleanup();
  }
});

test('an installation that enables no package at all is a warning worth making', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    const r = await run(
      f,
      ['--offline'],
      {},
      { TT_TOOL_PACKAGES: 'publish-write', TT_WRITE_MODE: 'deny' },
    );

    assert.match(
      r.out,
      /\[warn\] settings: no tool package is enabled, so the server would expose no tools at all\n/,
    );
    assert.match(
      r.out,
      /→ Widen TT_TOOL_PACKAGES \(default: core\), or shorten TT_PACKAGES_DENY\.\n/,
    );
    assert.equal(r.code, EXIT_OK);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// CC-F5 — the env-file lock
// ---------------------------------------------------------------------------

test('cc-f5: a lock older than TT_ENV_LOCK_STALE_MS is reported as stale', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    const lockDir = `${f.envFile}.lock`;
    await mkdir(lockDir);
    const long_ago = new Date(BASELINE_NOW_MS - 5 * 60 * 1000);
    await utimes(lockDir, long_ago, long_ago);

    const r = await run(f);
    assert.equal(r.code, EXIT_OK, 'the next writer breaks it by itself');
    assert.match(
      r.out,
      /\[warn\] env lock: a stale lock has been held for 5 minutes at /,
    );
    assert.match(r.out, /its writer is gone and the next writer will break it\n/);
    assert.match(r.out, /→ If nothing is writing right now you may remove it: rm -rf /);
  } finally {
    await f.cleanup();
  }
});

test('cc-f5: a fresh lock means a login is running right now', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    const lockDir = `${f.envFile}.lock`;
    await mkdir(lockDir);
    const justNow = new Date(BASELINE_NOW_MS - 2000);
    await utimes(lockDir, justNow, justNow);

    const r = await run(f);
    assert.match(
      r.out,
      /\[info\] env lock: held right now \(2 seconds old\) — a login or token refresh is running\n/,
    );
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// media root, journal, transport
// ---------------------------------------------------------------------------

test('TT_MEDIA_ROOT is reported when it is a directory and failed when it is not', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());

    const good = await run(f, ['--offline'], {}, { TT_MEDIA_ROOT: f.dir });
    assert.equal(good.code, EXIT_OK);
    assert.equal(row(good.out, 'media root'), `[ ok ] media root: ${f.dir}`);

    const bad = await run(f, ['--offline'], {}, { TT_MEDIA_ROOT: f.envFile });
    assert.equal(bad.code, EXIT_FAILURE);
    assert.match(bad.out, /\[FAIL\] media root: TT_MEDIA_ROOT=.* is not a directory\n/);

    const missing = await run(
      f,
      ['--offline'],
      {},
      { TT_MEDIA_ROOT: join(f.dir, 'nope') },
    );
    assert.equal(missing.code, EXIT_FAILURE);
    assert.match(missing.out, /\[FAIL\] media root: TT_MEDIA_ROOT=.* cannot be read: /);
    assert.match(missing.out, /→ Create the directory, or unset TT_MEDIA_ROOT/);
  } finally {
    await f.cleanup();
  }
});

test('an existing journal is reported by size until TD-3 can reconcile it', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    await writeFile(join(f.dir, 'journal.ndjson'), '{}\n', 'utf8');

    const r = await run(f);
    assert.match(r.out, /\[info\] publish journal: .*journal\.ndjson — 3 bytes; /);
    assert.match(
      r.out,
      /intent\/outcome reconciliation arrives with the publish tools\n/,
    );
  } finally {
    await f.cleanup();
  }
});

test('a transport this build cannot serve fails the report', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    const r = await run(
      f,
      ['--offline'],
      {},
      { TT_TRANSPORT: 'http', TT_HTTP_TOKEN: 'doctor-test-http-token-0123456789' },
    );

    assert.equal(r.code, EXIT_FAILURE);
    assert.match(
      r.out,
      /\[FAIL\] transport: TT_TRANSPORT=http is not implemented in this build, so the server would refuse to start\n/,
    );
    assert.match(r.out, /→ Unset TT_TRANSPORT, or set it to stdio\.\n/);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// the online probe
// ---------------------------------------------------------------------------

test('the probe reports whose token TikTok accepted', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    const stub = scriptFetch([
      ttEnvelope({ user: { open_id: 'open-id-doctor-1234', display_name: 'Ada' } }),
    ]);

    const r = await withFetch(stub, async () => run(f, []));

    assert.equal(r.code, EXIT_OK);
    assert.equal(
      row(r.out, 'api probe'),
      "[ ok ] api probe: TikTok accepted Ada's token",
    );
    assert.equal(
      stub.calls[0]?.url,
      'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name',
    );
  } finally {
    await f.cleanup();
  }
});

test('a probe against a token without a display name still passes', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    const stub = scriptFetch([ttEnvelope({ user: { open_id: 'open-id-doctor-1234' } })]);

    const r = await withFetch(stub, async () => run(f, []));
    assert.equal(
      row(r.out, 'api probe'),
      '[ ok ] api probe: TikTok accepted the stored token',
    );
  } finally {
    await f.cleanup();
  }
});

test('an unreachable TikTok is a warning — a flaky network is not a broken install', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    // TT_MAX_RETRIES=0: the retry backoff sleeps on the injected clock, which
    // only moves when a test advances it.
    const r = await withFetch(
      () => Promise.reject(new TypeError('fetch failed')),
      async () => run(f, [], {}, { TT_MAX_RETRIES: '0' }),
    );

    assert.equal(r.code, EXIT_OK);
    assert.match(r.out, /\[warn\] api probe: could not reach TikTok: /);
    assert.match(
      r.out,
      /→ This is a connectivity problem, not a credential one — try again\.\n/,
    );
  } finally {
    await f.cleanup();
  }
});

test('a rejected refresh token fails the probe and names the login command', async () => {
  const f = await fixture();
  try {
    // An access token that is already stale forces the refresh the probe needs
    // to trip over; the refresh token itself is what TikTok rejects.
    await writeEnvFile(
      f,
      authorizedLines({
        TT_TOKEN_EXPIRES_AT: new Date(BASELINE_NOW_MS - 60_000).toISOString(),
      }),
    );
    const stub = scriptFetch([
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'the invalid_grant case, as TikTok words it',
          log_id: '2026010100000000000000000000000000',
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    ]);

    const r = await withFetch(stub, async () => run(f, []));

    assert.equal(r.code, EXIT_FAILURE);
    assert.match(
      r.out,
      /\[FAIL\] api probe: TikTok rejected the token for account 'DEFAULT'/,
    );
    assert.match(r.out, /→ npx tiktok-mcp-ai login --profile DEFAULT\n/);
    // Nothing secret reached the report.
    assert.ok(!r.out.includes('rft.doctor'), r.out);
    assert.ok(!r.out.includes('act.doctor'), r.out);
  } finally {
    await f.cleanup();
  }
});

test('a temporary upstream error is a warning, and an unexpected one is a failure', async () => {
  const okScopes = await fixture();
  try {
    await writeEnvFile(okScopes, authorizedLines());

    const rateLimited = await withFetch(
      scriptFetch([
        new Response('{}', {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
      ]),
      async () => run(okScopes, [], {}, { TT_MAX_RETRIES: '0' }),
    );
    assert.equal(rateLimited.code, EXIT_OK);
    assert.match(
      rateLimited.out,
      /\[warn\] api probe: TikTok answered with a temporary error: /,
    );
    assert.match(rateLimited.out, /→ Try again later\.\n/);

    // A 200 whose payload is not the documented shape is a bug, not weather.
    const malformed = await withFetch(scriptFetch([ttEnvelope({})]), async () =>
      run(okScopes, []),
    );
    assert.equal(malformed.code, EXIT_FAILURE);
    assert.match(malformed.out, /\[FAIL\] api probe: /);
  } finally {
    await okScopes.cleanup();
  }
});

test('the probe is skipped when the profile cannot read anything', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines({ TT_SCOPES: 'video.list' }));
    const r = await run(f, []);
    assert.match(
      r.out,
      /\[info\] api probe: skipped — profile DEFAULT has not granted user\.info\.basic, so there is no read to probe with\n/,
    );
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// the runner
// ---------------------------------------------------------------------------

test('a check that throws becomes one row and the rest still run', async () => {
  const f = await fixture();
  try {
    // A profile literally named DEFAULT collides with the implicit one, and
    // `listProfiles` throws on it — which is a check throwing mid-report, not a
    // finding it returned.
    await writeEnvFile(f, [
      ...authorizedLines(),
      'TT_PROFILE_DEFAULT_REFRESH_TOKEN=rft.x',
    ]);
    const r = await run(f);

    assert.equal(r.code, EXIT_FAILURE);
    assert.match(
      r.out,
      /\[FAIL\] profiles: TT_PROFILE_DEFAULT_REFRESH_TOKEN declares a profile named DEFAULT/,
    );
    assert.match(r.out, /→ Remove the TT_PROFILE_DEFAULT_\* keys/);
    // Everything registered after the thrower still reported.
    assert.match(r.out, /\[ ok \] transport: stdio\n/);
    assert.match(r.out, /\n\d+ checks passed, .*1 failure\n$/);
  } finally {
    await f.cleanup();
  }
});

test('renderFinding lines the four labels up and indents the remediation', () => {
  const check: Check = { id: 'x', title: 'thing', run: () => Promise.resolve([]) };
  assert.equal(
    renderFinding(check, { severity: 'ok', text: 'fine' }),
    '[ ok ] thing: fine\n',
  );
  assert.equal(
    renderFinding(check, { severity: 'info', text: 'noted' }),
    '[info] thing: noted\n',
  );
  assert.equal(
    renderFinding(check, { severity: 'warn', text: 'soon', remediation: 'do this' }),
    '[warn] thing: soon\n       → do this\n',
  );
  assert.equal(
    renderFinding(check, { severity: 'fail', text: 'broken' }),
    '[FAIL] thing: broken\n',
  );
});

test('renderSummary counts in the singular when there is one of something', () => {
  assert.equal(
    renderSummary({ ok: 1, info: 0, warn: 2, fail: 1 }),
    '1 check passed, 0 informational, 2 warnings, 1 failure\n',
  );
  assert.equal(
    renderSummary({ ok: 0, info: 3, warn: 0, fail: 0 }),
    '0 checks passed, 3 informational, 0 warnings, 0 failures\n',
  );
});

test('an unreadable env file ends the run before any check', async () => {
  const f = await fixture();
  try {
    // A directory where the env file should be: readable(2) fails with EISDIR.
    await mkdir(f.envFile);
    const r = await run(f);

    assert.equal(r.code, EXIT_FAILURE);
    assert.equal(r.out, '');
    assert.match(r.err, /cannot be read \(EISDIR\)/);
    assert.match(r.err, /Check TT_ENV_FILE and the file itself, then retry\./);
  } finally {
    await f.cleanup();
  }
});

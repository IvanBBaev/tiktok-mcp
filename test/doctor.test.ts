/**
 * `cli/doctor.ts` — the health report.
 *
 * Doctor is the command people run when nothing works, so what is asserted here
 * is that it keeps reporting when things are broken: a rejected settings
 * environment, an unreadable profile or a check that throws must each become one
 * row and leave the other thirteen checks running. The exit code is decided by
 * `fail` alone — a readiness gate that trips on "TT_MEDIA_ROOT is not set" is a
 * gate nobody keeps (README § "Verify your setup").
 *
 * Every run is driven through injected seams: `TT_ENV_FILE` points at a sandbox,
 * the clock is virtual, `deps.platform` picks the CC-F3 branch, and the one
 * online check is fed by a scripted `fetch`. Nothing here touches the network,
 * the real config directory or a terminal.
 */

import assert from 'node:assert/strict';
import {
  appendFile,
  chmod,
  mkdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  DOCTOR_CHECKS,
  doctorUsage,
  parseDoctorArgs,
  renderFinding,
  renderJsonReport,
  renderSummary,
  resolveModulePath,
  runDoctor,
  type Check,
  type DoctorContext,
  type DoctorReport,
  type Finding,
} from '../src/cli/doctor.js';
import {
  cliIo,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  type CliDeps,
} from '../src/cli/index.js';
import { DEFAULT_STALE_MS, envLockDir } from '../src/core/env-lock.js';
import { createLogger } from '../src/core/log.js';
import { resetTokenCache } from '../src/core/oauth.js';
import { registerSecret } from '../src/core/redact.js';
import { loadSettings } from '../src/core/settings.js';
import { appendIntent, appendOutcome, type OutcomeResult } from '../src/mcp/journal.js';
import type { ToolPackageSpec } from '../src/tools/index.js';
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
    modulePath: '/opt/app/node_modules/tiktok-mcp-ai/build/src/cli/doctor.js',
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
    flags: { offline: false, json: false, help: false, profile: 'WORK' },
  });
  assert.deepEqual(parseDoctorArgs(['--profile=WORK']), {
    ok: true,
    flags: { offline: false, json: false, help: false, profile: 'WORK' },
  });
  // The profile name is normalized where it is parsed, like every other entry
  // point spells it.
  assert.deepEqual(parseDoctorArgs(['--profile', ' work ']), {
    ok: true,
    flags: { offline: false, json: false, help: false, profile: 'WORK' },
  });
  // `--profile --json` is a forgotten value, not a profile named "--json": the
  // run is refused rather than silently spending `--json` as the name.
  assert.deepEqual(parseDoctorArgs(['--profile', '--json']), {
    ok: false,
    message: '--profile needs a value.',
  });
  assert.deepEqual(parseDoctorArgs(['--profile', '-h']), {
    ok: false,
    message: '--profile needs a value.',
  });
  // Only the separate-slot spelling is guarded: an inline `=` is explicit, and
  // the name it gives is judged by the profile rule instead.
  assert.deepEqual(parseDoctorArgs(['--profile=-x']), {
    ok: false,
    message: 'invalid profile name "-x": expected [A-Z0-9_]+',
  });
  assert.deepEqual(parseDoctorArgs(['--profile', 'no spaces']), {
    ok: false,
    message: 'invalid profile name "no spaces": expected [A-Z0-9_]+',
  });
  assert.deepEqual(parseDoctorArgs(['--offline', '-h']), {
    ok: true,
    flags: { offline: true, json: false, help: true },
  });
  assert.deepEqual(parseDoctorArgs(['--json', '--offline']), {
    ok: true,
    flags: { offline: true, json: true, help: false },
  });
  assert.deepEqual(parseDoctorArgs([]), {
    ok: true,
    flags: { offline: false, json: false, help: false },
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
  assert.deepEqual(parseDoctorArgs(['--json=1']), {
    ok: false,
    message: '--json does not take a value.',
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
    assert.match(r.out, /\[info\] publish journal: no publish has been recorded yet\n/);
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
      'install',
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

test(
  'cc-f3: a fix that cannot be applied is reported rather than swallowed',
  { skip: POSIX_ONLY },
  async () => {
    const f = await fixture();
    try {
      await writeEnvFile(f, authorizedLines());
      await chmod(f.envFile, 0o644);

      // The snapshot was read before the question was asked, so a file that goes
      // away while the user is answering leaves `chmod` with nothing to change —
      // the same shape as a file this account is not allowed to touch.
      const r = await run(f, ['--offline'], {
        isTTY: true,
        prompt: async () => {
          await rm(f.envFile);
          return 'y';
        },
      });

      assert.equal(r.code, EXIT_OK, 'a warning is not a failure');
      assert.match(r.out, /\[warn\] permissions: mode 0644 — .*; the fix failed: ENOENT/);
      // The chmod is still offered: the run could not apply it, but the user can.
      assert.ok(r.out.includes(`→ chmod 600 ${JSON.stringify(f.envFile)}\n`), r.out);
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

test('an env file whose directory does not exist still gets a schema row', async () => {
  const f = await fixture();
  try {
    // cc-f1: no file is legal, and here not even the directory is there — the
    // backup scan has nothing to list and says nothing rather than failing the
    // check the env-file row already reported on.
    const r = await run(
      f,
      ['--offline'],
      {},
      { TT_ENV_FILE: join(f.dir, 'no-such-dir', '.env') },
    );

    assert.equal(row(r.out, 'config schema'), '[ ok ] config schema: version 1');
    assert.ok(!r.out.includes('leftover pre-migration backup'), r.out);
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
    // A bad name is a usage error, like any other malformed argument.
    assert.equal(r.code, EXIT_USAGE);
    assert.match(
      r.err,
      /invalid profile name "no spaces please": expected \[A-Z0-9_\]\+/,
    );
    assert.match(r.err, /Usage: tiktok-mcp-ai doctor/);
    assert.equal(r.out, '', 'a run that produced no report prints no report');
  } finally {
    await f.cleanup();
  }
});

test('doctor --profile --json is a usage error, not a report for a profile named "--json"', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    const r = await run(f, ['--profile', '--json']);
    assert.equal(r.code, EXIT_USAGE);
    assert.match(r.err, /--profile needs a value\./);
    assert.equal(r.out, '', 'no report, and in particular no JSON report');
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

test('a profile the env file damages fails the run, with the error code and its remediation', async () => {
  const f = await fixture();
  try {
    // `readProfile` throws `invalid_timestamp` here — neither of the two codes
    // the credentials and profiles rows report — so before this row owned it
    // the report came out clean and the exit code was 0.
    await writeEnvFile(f, authorizedLines({ TT_TOKEN_EXPIRES_AT: 'soon-ish' }));

    const r = await run(f);
    assert.equal(r.code, EXIT_FAILURE);
    assert.match(
      r.out,
      /\[FAIL\] tokens: profile DEFAULT could not be read \(invalid_timestamp\): TT_TOKEN_EXPIRES_AT: expected an ISO-8601 UTC timestamp, got "soon-ish"\n/,
    );
    assert.match(r.out, /Remove that key and re-run login/);
  } finally {
    await f.cleanup();
  }
});

test('a profile read that throws something other than a TikTokError is a fail, not an ok', async () => {
  const findings = await checkById('tokens').run(
    doctorContext({ credentialsError: new Error('EIO: the disk went away') }),
  );
  assert.deepEqual(findings, [
    {
      severity: 'fail',
      text: 'profile DEFAULT could not be read: EIO: the disk went away',
      remediation:
        'Check "/nowhere/.env" for a damaged value, then re-run npx tiktok-mcp-ai login --profile DEFAULT.',
    } satisfies Finding,
  ]);
});

test('a thrown non-Error in the profile read is still a fail', async () => {
  const findings = await checkById('tokens').run(
    doctorContext({ credentialsError: 'a bare string' }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'fail');
  assert.equal(findings[0]?.text, 'profile DEFAULT could not be read: a bare string');
});

test('the tokens row leaves missing credentials and an unknown profile to their own rows', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, ['TT_ACCESS_TOKEN=act.only']);
    const missing = await run(f);
    assert.equal(missing.code, EXIT_FAILURE);
    assert.equal(row(missing.out, 'tokens'), undefined);

    await writeEnvFile(f, authorizedLines());
    const unknown = await run(f, ['--offline', '--profile', 'nobody']);
    assert.equal(unknown.code, EXIT_FAILURE);
    assert.equal(row(unknown.out, 'tokens'), undefined);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// publish journal — the rotation lock
// ---------------------------------------------------------------------------

/** The journal check against a real directory, with the lock dir aged `ageMs` (or absent). */
async function journalLockRun(ageMs: number | undefined): Promise<readonly Finding[]> {
  const f = await fixture();
  try {
    const journal = join(f.dir, 'journal.ndjson');
    if (ageMs !== undefined) {
      const lockDir = envLockDir(journal);
      await mkdir(lockDir);
      const mtime = new Date(f.clock.now() - ageMs);
      await utimes(lockDir, mtime, mtime);
    }
    return await checkById('publish-journal').run(
      doctorContext({ envFilePath: f.envFile, clock: f.clock }),
    );
  } finally {
    await f.cleanup();
  }
}

test('no rotation lock adds no row to the journal check', async () => {
  const findings = await journalLockRun(undefined);
  assert.deepEqual(findings, [
    { severity: 'info', text: 'no publish has been recorded yet' } satisfies Finding,
  ]);
});

test('a rotation lock younger than the stale threshold is reported as held right now', async () => {
  const findings = await journalLockRun(5_000);
  assert.deepEqual(findings.at(-1), {
    severity: 'info',
    text: 'rotation lock held right now (5 seconds old)',
  } satisfies Finding);
});

test('a rotation lock past the stale threshold is a warning with an rm -rf remediation', async () => {
  const f = await fixture();
  try {
    const journal = join(f.dir, 'journal.ndjson');
    const lockDir = envLockDir(journal);
    await mkdir(lockDir);
    const mtime = new Date(f.clock.now() - 10 * 60 * 1000);
    await utimes(lockDir, mtime, mtime);

    const findings = await checkById('publish-journal').run(
      doctorContext({ envFilePath: f.envFile, clock: f.clock }),
    );
    assert.deepEqual(findings.at(-1), {
      severity: 'warn',
      text:
        `a stale rotation lock has been held for 10 minutes at ${lockDir}; ` +
        'the journal is not rotated until the next rotation breaks it',
      remediation: `If no server is running you may remove it: rm -rf ${JSON.stringify(lockDir)}`,
    } satisfies Finding);
  } finally {
    await f.cleanup();
  }
});

test("doctor's stale threshold is the env-lock default rotation and TT_ENV_LOCK_STALE_MS share", async () => {
  // Rotation passes no `staleMs`, so env-lock's own default is what breaks a
  // rotation lock; the doctor row must call "stale" exactly what that would
  // break, and the setting's default must be the same number, or the two rows
  // would disagree about one lock age.
  assert.equal(loadSettings({}).envLockStaleMs, DEFAULT_STALE_MS);
  // Whole seconds either side of the boundary, so the mtime's resolution
  // cannot move a case across it.
  const under = await journalLockRun(DEFAULT_STALE_MS - 1_000);
  assert.equal(under.at(-1)?.severity, 'info');
  const over = await journalLockRun(DEFAULT_STALE_MS + 1_000);
  assert.equal(over.at(-1)?.severity, 'warn');
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

test(
  'cc-f5: a symlinked env file is checked for the lock its writers actually take',
  {
    skip:
      process.platform === 'win32'
        ? 'symlinks: win32 needs SeCreateSymbolicLinkPrivilege'
        : false,
  },
  async () => {
    // Writers key the lock on the canonical path, so a lock beside the link would
    // exclude nobody; the one that matters sits beside the link's target.
    const f = await fixture();
    try {
      const realDir = join(f.dir, 'real');
      await mkdir(realDir);
      const target = join(realDir, '.env');
      await writeFile(target, `${authorizedLines().join('\n')}\n`, 'utf8');
      await chmod(target, 0o600);
      await symlink(target, f.envFile);

      const lockDir = envLockDir(await realpath(target));
      await mkdir(lockDir);
      const longAgo = new Date(BASELINE_NOW_MS - 5 * 60 * 1000);
      await utimes(lockDir, longAgo, longAgo);

      const r = await run(f);
      assert.equal(
        row(r.out, 'env lock'),
        `[warn] env lock: a stale lock has been held for 5 minutes at ${lockDir}; its ` +
          'writer is gone and the next writer will break it',
      );
    } finally {
      await f.cleanup();
    }
  },
);

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

test('cc-f5: a lock is judged by the built-in horizon when the settings did not load', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    const lockDir = `${f.envFile}.lock`;
    await mkdir(lockDir);
    const longAgo = new Date(BASELINE_NOW_MS - 5 * 60 * 1000);
    await utimes(lockDir, longAgo, longAgo);

    // TT_ENV_LOCK_STALE_MS would have called this lock fresh, but the rest of the
    // environment is rejected, so there are no settings to read it from and the
    // built-in 15 s horizon decides instead.
    const r = await run(
      f,
      ['--offline'],
      {},
      { TT_ENV_LOCK_STALE_MS: '600000', TT_TIMEOUT_MS: 'soon' },
    );

    assert.match(r.out, /\[FAIL\] settings: /);
    assert.match(
      r.out,
      /\[warn\] env lock: a stale lock has been held for 5 minutes at /,
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

/** Where `resolveJournalPath` puts the journal for a fixture's env file. */
function journalPath(f: Fixture): string {
  return join(f.dir, 'journal.ndjson');
}

/**
 * One attempt in the journal, written through the module that owns the format.
 * A hand-rolled NDJSON fixture would be a second writer of that format, and the
 * row asserted below is only as true as the file doctor actually reads.
 *
 * Omitting `result` leaves the intent alone — the crash-between-init-and-status
 * state, which is the whole subject of this section.
 */
async function recordAttempt(
  f: Fixture,
  attemptId: string,
  result?: OutcomeResult,
): Promise<void> {
  const path = journalPath(f);
  const ts = new Date(f.clock.now()).toISOString();
  await appendIntent(
    {
      v: 1,
      type: 'intent',
      attempt_id: attemptId,
      ts,
      tool: 'tiktok_post_video',
      profile: 'DEFAULT',
      open_id: 'open-id-doctor-1234',
      plan_id: 'plan-doctor-1',
      payload_digest: 'digest-doctor-1',
      title_excerpt: 'a caption nobody should have to redact by hand',
      source: 'FILE_UPLOAD',
      mode: 'direct',
    },
    { path },
  );
  if (result !== undefined) {
    await appendOutcome(
      {
        v: 1,
        type: 'outcome',
        attempt_id: attemptId,
        ts,
        result,
        publish_id: 'v_pub_doctor_1',
      },
      { path },
    );
  }
}

/** Every row the journal check produced, in order — it may emit more than one. */
function journalRows(out: string): string[] {
  return out.split('\n').filter((line) => line.includes('] publish journal: '));
}

test('a journal whose attempts all reached an outcome reconciles clean', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    await recordAttempt(f, 'ATTEMPT00000000000000000A', 'ok');
    // A failed publish is still resolved: its fate is known.
    await recordAttempt(f, 'ATTEMPT00000000000000000B', 'error');

    const r = await run(f);
    assert.equal(r.code, EXIT_OK);
    assert.deepEqual(journalRows(r.out), [
      `[ ok ] publish journal: ${journalPath(f)} — 2 attempts recorded, every one with an outcome`,
    ]);
  } finally {
    await f.cleanup();
  }
});

test('cc-e10: an intent with no outcome is reported unresolved, not as done', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    await recordAttempt(f, 'ATTEMPT00000000000000000A', 'ok');
    await recordAttempt(f, 'ATTEMPT00000000000000000B');

    const r = await run(f);
    // A post that may exist is not a broken installation: doctor says so and
    // still exits 0, because a readiness gate that trips here is a gate nobody
    // keeps.
    assert.equal(r.code, EXIT_OK);
    assert.deepEqual(journalRows(r.out), [
      `[warn] publish journal: ${journalPath(f)} — 2 attempts recorded, 1 without an ` +
        'outcome: the request may have been sent and no answer was recorded, so the post ' +
        'may exist',
    ]);
    assert.match(
      r.out,
      /→ Reconcile them with tiktok_list_publish_journal, then confirm each one with tiktok_get_publish_status or tiktok_list_videos\.\n/,
    );
    // The report stays pasteable (CONTRIBUTING § Reporting a bug): the counts
    // come out of the records, nothing else does.
    assert.ok(!r.out.includes('v_pub_doctor_1'));
    assert.ok(!r.out.includes('a caption nobody should have to redact by hand'));
    assert.ok(!r.out.includes('ATTEMPT00000000000000000B'));
    assert.ok(!r.out.includes('open-id-doctor-1234'));
  } finally {
    await f.cleanup();
  }
});

test('a machine that has never published is told so, and told nothing else', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());

    const r = await run(f);
    assert.equal(r.code, EXIT_OK);
    assert.deepEqual(journalRows(r.out), [
      '[info] publish journal: no publish has been recorded yet',
    ]);
    // Not an `ok`: nothing was verified. And no path — naming a file that does
    // not exist invites the reader to go looking for it.
    assert.ok(!r.out.includes('journal.ndjson'));
  } finally {
    await f.cleanup();
  }
});

test('a journal that exists but records no attempt is not a fresh install', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    // The other half of the zero-attempt case: the file is there, so this is not
    // a machine that has never published — every line in it is simply damaged.
    // Two torn writes rather than one, so the row cannot be mistaken for the
    // torn-tail case below, which still has an intact attempt to count.
    await writeFile(journalPath(f), '{"v":1,"type":"inte\n{"v":1,"type":"outc\n', 'utf8');

    const r = await run(f);
    // Still exit 0: an unreadable audit trail is not a broken installation.
    assert.equal(r.code, EXIT_OK);
    assert.deepEqual(journalRows(r.out), [
      `[info] publish journal: ${journalPath(f)} — no attempt is recorded in it yet`,
      '[info] publish journal: 2 unreadable lines skipped — usually a truncated last write after a crash',
    ]);
  } finally {
    await f.cleanup();
  }
});

test('a torn last record is counted as damage, not as a reason to stop', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    await recordAttempt(f, 'ATTEMPT00000000000000000A', 'ok');
    // What a crash mid-append leaves behind: half a record and no newline.
    await appendFile(journalPath(f), '{"v":1,"type":"inte', 'utf8');

    const r = await run(f);
    assert.equal(r.code, EXIT_OK);
    assert.deepEqual(journalRows(r.out), [
      `[ ok ] publish journal: ${journalPath(f)} — 1 attempt recorded, every one with an outcome`,
      '[info] publish journal: 1 unreadable line skipped — usually a truncated last write after a crash',
    ]);
  } finally {
    await f.cleanup();
  }
});

test('a journal that cannot be read warns rather than failing the run', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    // A directory in the journal's place: present, statable, unreadable as a
    // file — the same shape a bad mode produces, and reproducible as any user.
    await mkdir(journalPath(f));

    const r = await run(f);
    assert.equal(r.code, EXIT_OK);
    assert.deepEqual(journalRows(r.out), [
      `[warn] publish journal: ${journalPath(f)} exists but cannot be read, so no attempt ` +
        'in it could be reconciled',
    ]);
    assert.match(
      r.out,
      /→ Check its owner and mode — the journal is written 0600 by the account that publishes\.\n/,
    );
  } finally {
    await f.cleanup();
  }
});

test('cc-g6: the http transport reports its bind and its bearer', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    const r = await run(
      f,
      ['--offline'],
      {},
      {
        TT_TRANSPORT: 'http',
        TT_PORT: '8931',
        TT_HTTP_TOKEN: 'doctor-test-http-token-0123456789',
      },
    );

    assert.equal(r.code, EXIT_OK);
    assert.match(
      r.out,
      /\[ ok \] transport: http on 127\.0\.0\.1:8931\/mcp, TT_HTTP_TOKEN required on every request\n/,
    );
    // The token is a registered secret: it may not appear anywhere, and no row
    // may hint at its length either.
    assert.ok(!r.out.includes('doctor-test-http-token-0123456789'));
  } finally {
    await f.cleanup();
  }
});

test('cc-g6: a bind past loopback warns that the bearer travels in plaintext', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    const r = await run(
      f,
      ['--offline'],
      {},
      {
        TT_TRANSPORT: 'http',
        TT_HTTP_HOST: '0.0.0.0',
        TT_HTTP_INSECURE: '1',
        TT_HTTP_TOKEN: 'doctor-test-http-token-0123456789',
      },
    );

    // A warning, not a failure: the operator acknowledged the bind, and doctor
    // is documented as a readiness gate that only a `fail` may trip.
    assert.equal(r.code, EXIT_OK);
    assert.match(
      r.out,
      /\[ ok \] transport: http on 0\.0\.0\.0:3000\/mcp, TT_HTTP_TOKEN required on every request\n/,
    );
    // Written as `TT_HTTP_TOKEN`, never as "the bearer is …": `core/redact`
    // masks `bearer <word>` on sight and would blank out doctor's own prose.
    assert.match(
      r.out,
      /\[warn\] transport: TT_HTTP_INSECURE=1: this bind is reachable off-box, and this server speaks plaintext http — TT_HTTP_TOKEN is only as private as whatever fronts it\n/,
    );
    assert.match(
      r.out,
      /→ Terminate TLS in front of the server, or bind TT_HTTP_HOST to 127\.0\.0\.1\.\n/,
    );
    // Past loopback with no allowlist, the Host/Origin check cannot close DNS
    // rebinding, and doctor says so.
    assert.match(
      r.out,
      /\[warn\] transport: TT_HTTP_ALLOWED_HOSTS is unset: past loopback the Host\/Origin check cannot stop DNS rebinding, so TT_HTTP_TOKEN is the only layer left\n/,
    );
    assert.match(
      r.out,
      /→ Set TT_HTTP_ALLOWED_HOSTS to the host names clients use to reach this server\.\n/,
    );
  } finally {
    await f.cleanup();
  }
});

test('cc-g6: a bind past loopback with TT_HTTP_ALLOWED_HOSTS set has no rebinding warning', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    const r = await run(
      f,
      ['--offline'],
      {},
      {
        TT_TRANSPORT: 'http',
        TT_HTTP_HOST: '0.0.0.0',
        TT_HTTP_INSECURE: '1',
        TT_HTTP_ALLOWED_HOSTS: 'mcp.example.com',
        TT_HTTP_TOKEN: 'doctor-test-http-token-0123456789',
      },
    );

    assert.equal(r.code, EXIT_OK);
    // The plaintext warning still stands: the allowlist does not add TLS.
    assert.match(r.out, /\[warn\] transport: TT_HTTP_INSECURE=1: /);
    assert.doesNotMatch(r.out, /TT_HTTP_ALLOWED_HOSTS/);
  } finally {
    await f.cleanup();
  }
});

test('cc-g6: TT_HTTP_INSECURE on a loopback bind warns about nothing', async () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    const f = await fixture();
    try {
      await writeEnvFile(f, authorizedLines());
      const r = await run(
        f,
        ['--offline'],
        {},
        {
          TT_TRANSPORT: 'http',
          TT_HTTP_HOST: host,
          TT_HTTP_INSECURE: '1',
          TT_HTTP_TOKEN: 'doctor-test-http-token-0123456789',
        },
      );

      assert.equal(r.code, EXIT_OK, host);
      assert.match(
        r.out,
        /\[ ok \] transport: http on .+:3000\/mcp, TT_HTTP_TOKEN required on every request\n/,
        host,
      );
      // The flag is redundant here: the bind is not reachable off-box and the
      // pinned Host check stops rebinding, so neither warning would be true.
      assert.doesNotMatch(r.out, /TT_HTTP_INSECURE=1/, host);
      assert.doesNotMatch(r.out, /TT_HTTP_ALLOWED_HOSTS is unset/, host);
      assert.doesNotMatch(r.out, /\[warn\] transport:/, host);
    } finally {
      await f.cleanup();
    }
  }
});

test('cc-g6: an http transport with no bearer fails the schema check', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    const r = await run(f, ['--offline'], {}, { TT_TRANSPORT: 'http' });

    // `core/settings` refuses the combination outright (SYN-31), so the report
    // stops at the settings row instead of describing a server that cannot
    // start — and the transport row falls silent rather than guessing.
    assert.equal(r.code, EXIT_FAILURE);
    const settings = row(r.out, 'settings');
    assert.ok(settings !== undefined && settings.startsWith('[FAIL]'), r.out);
    assert.match(
      r.out,
      /TT_HTTP_TOKEN: required whenever TT_TRANSPORT=http, including a loopback bind/,
    );
    assert.equal(row(r.out, 'transport'), undefined);
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

test('an egress violation fails the probe and has no next step to offer', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());

    // What `redirect: "error"` looks like from `fetch`: a TypeError whose cause
    // names the redirect. It is neither weather nor an auth refusal, so the probe
    // reports the error as it stands.
    const r = await withFetch(
      () =>
        Promise.reject(
          new TypeError('fetch failed', { cause: new Error('unexpected redirect') }),
        ),
      async () => run(f, ['--json']),
    );

    assert.equal(r.code, EXIT_FAILURE);
    const probe = parseReport(r.out).checks.find((check) => check.id === 'api-probe');
    assert.equal(probe?.findings[0]?.severity, 'fail');
    assert.match(probe?.findings[0]?.text ?? '', /with a redirect\./);
    assert.equal(probe?.findings[0]?.remediation, undefined);
  } finally {
    await f.cleanup();
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

test('a profile with no scopes on record skips the probe before any request', async () => {
  const f = await fixture();
  try {
    // A login that never recorded its grant: there is no scope list to check
    // `user.info.basic` against, which is not the same as holding it.
    await writeEnvFile(f, authorizedLines({ TT_SCOPES: '' }));
    const r = await withFetch(
      () => Promise.reject(new Error('the probe must not send a request')),
      async () => run(f, []),
    );

    assert.match(
      r.out,
      /\[info\] api probe: skipped — profile DEFAULT has not granted user\.info\.basic/,
    );
    assert.match(
      r.out,
      /\[warn\] scopes: profile DEFAULT has no granted scopes on record\n/,
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

test(
  'cc-f3: a prompt that fails costs one row, whatever it rejected with',
  { skip: POSIX_ONLY },
  async () => {
    const f = await fixture();
    try {
      await writeEnvFile(f, authorizedLines());
      await chmod(f.envFile, 0o644);

      const closed = await run(f, ['--offline'], {
        isTTY: true,
        prompt: () => Promise.reject(new Error('stdin closed')),
      });
      assert.equal(closed.code, EXIT_FAILURE);
      assert.equal(row(closed.out, 'permissions'), '[FAIL] permissions: stdin closed');
      assert.match(closed.out, /\[ ok \] transport: stdio\n/);
      assert.equal((await stat(f.envFile)).mode & 0o777, 0o644);

      // Nothing in the type system says a rejection is an `Error`, and the row
      // has to be readable either way.
      const raw = await run(f, ['--offline'], {
        isTTY: true,
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the value under test
        prompt: () => Promise.reject('EOF'),
      });
      assert.equal(row(raw.out, 'permissions'), '[FAIL] permissions: EOF');
    } finally {
      await f.cleanup();
    }
  },
);

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

// ---------------------------------------------------------------------------
// --json
// ---------------------------------------------------------------------------

/**
 * Parse the document `--json` owes stdout, and prove it was the *only* thing on
 * it: re-serializing what was parsed reproduces the captured stream byte for
 * byte only if no header, row or summary shared the stream with it.
 */
function parseReport(out: string): DoctorReport {
  const report = JSON.parse(out) as DoctorReport;
  assert.equal(renderJsonReport(report), out);
  return report;
}

test('--json prints one document and none of the human rendering', async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    const r = await run(f, ['--offline', '--json']);

    assert.equal(r.code, EXIT_OK);
    assert.equal(r.err, '');
    const report = parseReport(r.out);

    assert.equal(report.schema, 'tiktok-mcp-ai/doctor-report');
    assert.equal(report.version, 1);
    assert.equal(report.profile, 'DEFAULT');
    assert.equal(report.offline, true);
    assert.equal(report.exit_code, EXIT_OK);
    // Every check that ran is in the document, in registry order — including the
    // ones that had nothing to say.
    assert.deepEqual(
      report.checks.map((check) => check.id),
      DOCTOR_CHECKS.map((check) => check.id),
    );
    const severities = report.checks.flatMap((check) =>
      check.findings.map((found) => found.severity),
    );
    assert.equal(report.tally.ok, severities.filter((s) => s === 'ok').length);
    assert.equal(report.tally.info, severities.filter((s) => s === 'info').length);
    assert.equal(report.tally.warn, 0);
    assert.equal(report.tally.fail, 0);
    // A remediation rides with its finding instead of on an indented line.
    const probe = report.checks.find((check) => check.id === 'api-probe');
    assert.equal(probe?.findings[0]?.text, 'skipped (--offline)');
    assert.equal(probe?.findings[0]?.remediation, undefined);
  } finally {
    await f.cleanup();
  }
});

test('--json reports an unreadable configuration as a document, not as silence', async () => {
  const f = await fixture();
  try {
    await mkdir(f.envFile);
    const r = await run(f, ['--offline', '--json']);

    assert.equal(r.code, EXIT_FAILURE);
    // The reason is in the document; stderr would be a second copy of it.
    assert.equal(r.err, '');
    const report = parseReport(r.out);

    assert.equal(report.profile, null);
    assert.equal(report.offline, true);
    assert.equal(report.exit_code, EXIT_FAILURE);
    assert.deepEqual(
      report.checks.map((check) => check.id),
      ['configuration'],
    );
    const found = report.checks[0]?.findings[0];
    assert.equal(found?.severity, 'fail');
    assert.match(found?.text ?? '', /cannot be read \(EISDIR\)/);
    assert.match(found?.remediation ?? '', /Check TT_ENV_FILE/);
    assert.deepEqual(report.tally, { ok: 0, info: 0, warn: 0, fail: 1 });
  } finally {
    await f.cleanup();
  }
});

test('a failing check still leaves stdout parseable under --json', async () => {
  const f = await fixture();
  try {
    // Nothing configured: the app-credentials check fails the run.
    const r = await run(f, ['--offline', '--json']);

    assert.equal(r.code, EXIT_FAILURE);
    const report = parseReport(r.out);
    assert.equal(report.exit_code, EXIT_FAILURE);
    assert.ok(report.tally.fail > 0);
    const credentials = report.checks.find((check) => check.id === 'app-credentials');
    assert.equal(credentials?.findings[0]?.severity, 'fail');
  } finally {
    await f.cleanup();
  }
});

test('--json takes no value, and the usage error keeps stdout empty', async () => {
  const f = await fixture();
  try {
    const r = await run(f, ['--json=1']);
    assert.equal(r.code, EXIT_USAGE);
    // cc-g3: a usage error is a diagnostic, so stdout stays empty rather than
    // carrying a document nobody can act on.
    assert.equal(r.out, '');
    assert.match(r.err, /--json does not take a value\./);
  } finally {
    await f.cleanup();
  }
});

test('--help wins over --json and still prints the usage text', async () => {
  const f = await fixture();
  try {
    const r = await run(f, ['--json', '--help']);
    assert.equal(r.code, EXIT_OK);
    assert.equal(r.out, doctorUsage());
    assert.match(r.out, /--json {13}print the report as one JSON document/);
  } finally {
    await f.cleanup();
  }
});

test('--json output passes through redaction and is still a valid document', async () => {
  const f = await fixture();
  try {
    // A value doctor does print — the profile name — registered as a secret, so
    // the redacting sink has something to catch. Nothing else in the report can
    // carry a credential today, which is exactly what makes this the seam test.
    registerSecret('DOCTORJSONSECRET');
    await writeEnvFile(f, authorizedLines());
    const r = await run(f, ['--offline', '--json', '--profile', 'DOCTORJSONSECRET']);

    assert.ok(!r.out.includes('DOCTORJSONSECRET'), r.out);
    // Redaction rewrote a value inside the document without breaking it.
    const report = parseReport(r.out);
    assert.equal(report.profile, '[REDACTED]');
  } finally {
    await f.cleanup();
  }
});

test('--json never prompts, even on a terminal', { skip: POSIX_ONLY }, async () => {
  const f = await fixture();
  try {
    await writeEnvFile(f, authorizedLines());
    await chmod(f.envFile, 0o644);

    const asked: string[] = [];
    const r = await run(f, ['--offline', '--json'], {
      isTTY: true,
      prompt: (question) => {
        asked.push(question);
        return Promise.resolve('y');
      },
    });

    // A consumer of the document has no way to answer a question, so CC-F3
    // reports the mode instead of offering to fix it.
    assert.deepEqual(asked, []);
    assert.equal((await stat(f.envFile)).mode & 0o777, 0o644);
    const report = parseReport(r.out);
    const permissions = report.checks.find((check) => check.id === 'permissions');
    assert.equal(permissions?.findings[0]?.severity, 'warn');
    assert.match(permissions?.findings[0]?.text ?? '', /mode 0644/);
  } finally {
    await f.cleanup();
  }
});

test('a package that ships no tools is reported as a roadmap hole, not as ok', async () => {
  // Today's manifest gives all five packages at least one tool, so the row has
  // no subject in this build; `DoctorContext.packages` is the seam that lets a
  // future manifest — a package declared before it is written — be handed in.
  const findings = await checkById('scopes').run(
    doctorContext({
      settings: loadSettings({ TT_TOOL_PACKAGES: 'video' }),
      credentials: { clientKey: 'k', clientSecret: 's', scopes: ['video.list'] },
      packages: [{ name: 'video', tools: [] }] satisfies ToolPackageSpec[],
    }),
  );

  assert.deepEqual(findings, [
    { severity: 'ok', text: 'granted: video.list' },
    {
      severity: 'info',
      text: 'enabled but not implemented in this build: video',
    },
  ] satisfies Finding[]);
});

// ---------------------------------------------------------------------------
// the install check
// ---------------------------------------------------------------------------

test('the install check warns on an npx-cached copy, with the POSIX command', async () => {
  const findings = await checkById('install').run(
    doctorContext({
      modulePath:
        '/home/dev/.npm/_npx/2f9c1b/node_modules/tiktok-mcp-ai/build/src/cli/doctor.js',
    }),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'warn');
  assert.match(findings[0]?.text ?? '', /running from the npx cache/);
  assert.match(findings[0]?.remediation ?? '', /rm -rf ~\/\.npm\/_npx/);
});

test('the install check gives the Windows cache path on win32', async () => {
  const findings = await checkById('install').run(
    doctorContext({
      platform: 'win32',
      modulePath:
        'C:\\Users\\dev\\AppData\\Local\\npm-cache\\_npx\\2f9c1b\\node_modules\\' +
        'tiktok-mcp-ai\\build\\src\\cli\\doctor.js',
    }),
  );

  assert.equal(findings[0]?.severity, 'warn');
  assert.match(findings[0]?.remediation ?? '', /%LOCALAPPDATA%\\npm-cache\\_npx/);
  assert.ok(!(findings[0]?.remediation ?? '').includes('rm -rf'), 'POSIX command leaked');
});

test('the install check is quiet about an ordinary node_modules install', async () => {
  const findings = await checkById('install').run(
    doctorContext({
      modulePath: '/srv/app/node_modules/tiktok-mcp-ai/build/src/cli/doctor.js',
    }),
  );

  assert.deepEqual(findings, [
    { severity: 'ok', text: 'not running from the npx cache' },
  ]);
});

test('the install check matches a path segment, not a substring', async () => {
  // `_npx` inside a longer directory name is somebody's project, not the cache.
  const findings = await checkById('install').run(
    doctorContext({
      modulePath: '/home/dev/my_npx_tools/node_modules/tiktok-mcp-ai/build/cli.js',
    }),
  );

  assert.equal(findings[0]?.severity, 'ok');
});

// ---------------------------------------------------------------------------
// the seams that default to the real process
// ---------------------------------------------------------------------------

test('with nothing but the output seams injected the run still reports', async () => {
  const f = await fixture();
  const stdout: string[] = [];
  const stderr: string[] = [];
  // `test/helpers.ts` clears every TT_* key from `process.env` on import, so this
  // one key is the whole configuration the run can find.
  process.env.TT_ENV_FILE = f.envFile;
  try {
    // No argv, no env, no clock, no logger: the defaults are what `runCli` leaves
    // the command with in production. There is no env file, so the probe skips
    // itself before it builds an API context — nothing here reaches the network.
    const code = await runDoctor({
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
      isTTY: false,
    });
    const out = stdout.join('');

    assert.equal(code, EXIT_FAILURE);
    assert.match(out, /\[info\] env file: no file at /);
    assert.match(out, /\[FAIL\] app credentials: missing TikTok app credentials: /);
    assert.match(
      out,
      /\[info\] api probe: skipped — the local configuration has to be fixed first\n/,
    );
    assert.match(out, /\[ ok \] transport: stdio\n/);
    assert.equal(stderr.join(''), '');

    // The default logger takes its level from the settings, so the run that has
    // no settings at all is the one that has to fall back to a built-in level —
    // and it still owes the operator the report that says why.
    process.env.TT_TIMEOUT_MS = 'soon';
    stdout.length = 0;
    const broken = await runDoctor({
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
      isTTY: false,
    });

    assert.equal(broken, EXIT_FAILURE);
    assert.match(stdout.join(''), /\[FAIL\] settings: /);
    // The report ran to its end: a run with no settings is still a whole report.
    assert.match(stdout.join(''), /\n\d+ checks passed, .*\d+ failures\n$/);
  } finally {
    delete process.env.TT_ENV_FILE;
    delete process.env.TT_TIMEOUT_MS;
    await f.cleanup();
  }
});

test('resolveModulePath answers a file: URL and degrades on anything else', () => {
  // The default is `import.meta.url`, which is what production wants and what a
  // test cannot move — so the URL is a parameter and both arms are reachable.
  // Built from an absolute path of this platform: a drive-less `file:///opt/…`
  // is not an absolute path on win32, where `fileURLToPath` refuses it.
  const modulePath = resolve('opt', 'app', 'build', 'src', 'cli', 'doctor.js');
  assert.equal(resolveModulePath(pathToFileURL(modulePath).href), modulePath);
  // Not a `file:` URL: there is no path to hand back, and a doctor run must not
  // die over where it was loaded from. The install check reads '' as "unknown".
  assert.equal(resolveModulePath('https://example.invalid/doctor.js'), '');
  // No argument at all is the production call.
  assert.ok(resolveModulePath().endsWith('doctor.js'), resolveModulePath());
});

/**
 * `tiktok-mcp-ai run-queue` — publish what the local schedule says is due
 * (TOOLS.md § 2.10, CONFIGURATION.md § Schedule).
 *
 * Meant for cron or launchd every few minutes; one run claims every pending
 * entry whose `run_at` has passed, applies each through the ordinary write
 * path and exits. TikTok has no scheduling, so this command *is* the
 * scheduler: nothing posts while the machine is off or the runner is not
 * installed, and an entry reached more than a day late expires instead.
 *
 * Each entry is replayed, not trusted. The runner previews the stored
 * arguments as the tool would, checks the fresh plan against the digest,
 * account and file identity the user approved, and only then applies it with
 * that plan — so the duplicate guard, the rate bucket, the journal and the
 * dispatch are exactly those of an interactive apply. A request that would
 * now send something different fails with `payload_changed` (or
 * `file_changed`) and is never published.
 *
 * Claims are written before any network call (`pending` → `running`), so two
 * runners never apply one entry. A run that dies mid-apply leaves its entry
 * `running`; it is not retried, because whether TikTok received it is a
 * question for the journal (`tiktok_list_publish_journal`), not for a retry.
 */

import { createApiContext } from '../api/context.js';
import { systemClock, type Clock } from '../core/clock.js';
import {
  listProfiles,
  readEnvFile,
  readProfile,
  resolveEnvFilePath,
} from '../core/config.js';
import { createLogger, type Logger } from '../core/log.js';
import { loadSettings, type Settings } from '../core/settings.js';
import type { AnyToolSpec } from '../mcp/define.js';
import type { ToolError, ToolResult } from '../mcp/result.js';
import { verifyPlan, type ConsumeFailure } from '../mcp/plan-store.js';
import {
  readSchedule,
  SCHEDULE_LATE_LIMIT_MS,
  scheduleOptionsFor,
  updateSchedule,
  type ScheduledEntry,
  type ScheduleOptions,
} from '../mcp/schedule.js';
import { callTool, type ServerRuntime } from '../mcp/server.js';
import { allTools } from '../tools/index.js';
import {
  cliIo,
  CLI_NAME,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  overlayEnvFile,
  type CliDeps,
} from './index.js';

/** How long one entry may wait on the local rate bucket before it is put back. */
const MAX_RATE_WAIT_S = 120;

/** Rate waits per entry before it goes back to `pending` for the next run. */
const MAX_RATE_RETRIES = 3;

export function runQueueUsage(): string {
  return [
    `Usage: ${CLI_NAME} run-queue [--dry-run]`,
    '',
    'Publish every scheduled entry whose run_at has passed (queued by a write tool',
    'with run_at). Run it from cron or launchd every few minutes; this machine must',
    'be on at the scheduled time. Entries more than 24 h late expire unposted.',
    '',
    'Options:',
    '  --dry-run   list what is due without claiming or publishing anything',
    '  --help      show this text',
    '',
    'Exit status: 0 when every due entry was published (or nothing was due),',
    '1 when an entry failed or the schedule could not be read, 2 on bad usage.',
    '',
  ].join('\n');
}

/** What one run did with one entry. */
export interface RunOutcome {
  schedule_id: string;
  tool: string;
  profile: string;
  status: 'done' | 'failed' | 'expired' | 'pending' | 'due';
  publish_id?: string;
  error?: { code: string; message: string };
}

export interface RunQueueOptions {
  runtime: ServerRuntime;
  clock: Clock;
  schedule: ScheduleOptions;
  tools?: readonly AnyToolSpec[];
  dryRun?: boolean;
}

function isDue(entry: ScheduledEntry, now: number, locked: string | undefined): boolean {
  return (
    entry.status === 'pending' &&
    Date.parse(entry.run_at) <= now &&
    (locked === undefined || entry.profile === locked)
  );
}

function outcomeOf(entry: ScheduledEntry, status: RunOutcome['status']): RunOutcome {
  return {
    schedule_id: entry.schedule_id,
    tool: entry.tool,
    profile: entry.profile,
    status,
    ...(entry.publish_id === undefined ? {} : { publish_id: entry.publish_id }),
    ...(entry.error === undefined ? {} : { error: entry.error }),
  };
}

function failure(code: string, message: string): { code: string; message: string } {
  return { code, message };
}

/** Why a fresh preview no longer matches the approval, in the entry's words. */
function mismatch(reason: ConsumeFailure): { code: string; message: string } {
  switch (reason) {
    case 'file_changed':
      return failure(
        'file_changed',
        'The media file changed since the publish was scheduled; nothing was posted.',
      );
    case 'account_mismatch':
      return failure(
        'account_changed',
        'The profile is now logged in to a different TikTok account; nothing was posted.',
      );
    default:
      return failure(
        'payload_changed',
        'The request would now send something other than what was approved (a creator ' +
          'setting or the arguments resolve differently); nothing was posted.',
      );
  }
}

function errorOf(result: ToolResult<unknown>): ToolError | undefined {
  return result.ok ? undefined : result.error;
}

type Applied =
  | { kind: 'done'; publishId: string }
  | { kind: 'failed'; error: { code: string; message: string } }
  | { kind: 'retry_later'; error: { code: string; message: string } };

async function applyEntry(
  entry: ScheduledEntry,
  spec: AnyToolSpec,
  opts: RunQueueOptions,
): Promise<Applied> {
  const { runtime, clock } = opts;
  for (let attempt = 0; ; attempt += 1) {
    const preview = await callTool(spec, entry.args, runtime);
    const previewError = errorOf(preview);
    if (previewError !== undefined) {
      return { kind: 'failed', error: failure(previewError.code, previewError.message) };
    }
    const data = (preview as { data?: { mode?: unknown; plan_id?: unknown } }).data;
    if (data?.mode !== 'plan' || typeof data.plan_id !== 'string') {
      return {
        kind: 'failed',
        error: failure(
          'schedule_replay_failed',
          'The tool did not return a preview to apply.',
        ),
      };
    }
    const planId = data.plan_id;

    const verdict = verifyPlan(
      planId,
      {
        digest: entry.payload_digest,
        profile: entry.profile,
        openId: entry.open_id,
        tool: entry.tool,
        fileIdentity: entry.file_identity,
      },
      clock,
      {
        limits: {
          planTtlS: runtime.settings.planTtlS,
          planMaxOutstanding: runtime.settings.planMaxOutstanding,
        },
      },
    );
    if (!verdict.ok) return { kind: 'failed', error: mismatch(verdict.reason) };

    const applied = await callTool(spec, { ...entry.args, plan_id: planId }, runtime);
    const appliedError = errorOf(applied);
    if (appliedError === undefined) {
      const publishId = (applied as { data?: { publish_id?: unknown } }).data?.publish_id;
      return typeof publishId === 'string'
        ? { kind: 'done', publishId }
        : {
            kind: 'failed',
            error: failure('schedule_replay_failed', 'The apply returned no publish_id.'),
          };
    }
    if (appliedError.code !== 'local_rate_limited') {
      return { kind: 'failed', error: failure(appliedError.code, appliedError.message) };
    }
    // Nothing was sent: wait for the bucket, then preview and apply afresh.
    const waitS = Number(appliedError.details?.['retry_after_s']);
    const error = failure(appliedError.code, appliedError.message);
    if (attempt + 1 >= MAX_RATE_RETRIES || !(waitS >= 0) || waitS > MAX_RATE_WAIT_S) {
      return { kind: 'retry_later', error };
    }
    await clock.sleep(waitS * 1000);
  }
}

/** Write one entry's new state back under the queue lock. */
async function settle(
  opts: RunQueueOptions,
  scheduleId: string,
  patch: Partial<Pick<ScheduledEntry, 'status' | 'publish_id' | 'error'>>,
): Promise<void> {
  await updateSchedule(
    opts.clock,
    (entries) => {
      const entry = entries.find((e) => e.schedule_id === scheduleId);
      if (entry === undefined) return;
      Object.assign(entry, patch);
      if (patch.error === undefined) delete entry.error;
      entry.updated_at = new Date(opts.clock.now()).toISOString();
    },
    opts.schedule,
  );
}

/**
 * One pass over the schedule: claim what is due, expire what is too late,
 * apply each claimed entry in `run_at` order. Throws only when the schedule
 * itself cannot be read or written.
 */
export async function runQueue(opts: RunQueueOptions): Promise<RunOutcome[]> {
  const { clock } = opts;
  const locked = opts.runtime.settings.lockProfile;
  const tools = opts.tools ?? allTools();

  if (opts.dryRun === true) {
    const now = clock.now();
    return (await readSchedule(opts.schedule))
      .filter((entry) => isDue(entry, now, locked))
      .sort((a, b) => Date.parse(a.run_at) - Date.parse(b.run_at))
      .map((entry) => outcomeOf(entry, 'due'));
  }

  const outcomes: RunOutcome[] = [];
  const claimed = await updateSchedule(
    clock,
    (entries) => {
      const now = clock.now();
      const stamp = new Date(now).toISOString();
      const mine: ScheduledEntry[] = [];
      for (const entry of entries) {
        if (!isDue(entry, now, locked)) continue;
        entry.updated_at = stamp;
        if (now - Date.parse(entry.run_at) > SCHEDULE_LATE_LIMIT_MS) {
          entry.status = 'expired';
          entry.error = failure(
            'schedule_expired',
            'The runner reached this entry more than 24 h after run_at; nothing was posted.',
          );
          outcomes.push(outcomeOf(entry, 'expired'));
        } else {
          entry.status = 'running';
          mine.push({ ...entry });
        }
      }
      return mine.sort((a, b) => Date.parse(a.run_at) - Date.parse(b.run_at));
    },
    opts.schedule,
  );

  for (const entry of claimed) {
    const spec = tools.find((tool) => tool.name === entry.tool);
    const applied: Applied =
      spec === undefined
        ? {
            kind: 'failed',
            error: failure(
              'schedule_replay_failed',
              `${entry.tool} is not a tool this server has.`,
            ),
          }
        : await applyEntry(entry, spec, opts);

    switch (applied.kind) {
      case 'done':
        await settle(opts, entry.schedule_id, {
          status: 'done',
          publish_id: applied.publishId,
        });
        outcomes.push({ ...outcomeOf(entry, 'done'), publish_id: applied.publishId });
        break;
      case 'failed':
        await settle(opts, entry.schedule_id, { status: 'failed', error: applied.error });
        outcomes.push({ ...outcomeOf(entry, 'failed'), error: applied.error });
        break;
      case 'retry_later':
        await settle(opts, entry.schedule_id, {
          status: 'pending',
          error: applied.error,
        });
        outcomes.push({ ...outcomeOf(entry, 'pending'), error: applied.error });
        break;
    }
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

function renderOutcome(outcome: RunOutcome): string {
  const head = `${outcome.schedule_id}  ${outcome.tool}  @${outcome.profile}  ${outcome.status}`;
  if (outcome.publish_id !== undefined)
    return `${head}  publish_id=${outcome.publish_id}\n`;
  if (outcome.error !== undefined) {
    return `${head}  ${outcome.error.code}: ${outcome.error.message}\n`;
  }
  return `${head}\n`;
}

/** The runtime the MCP server would build, from the same env file. */
async function buildRuntime(
  processEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  clock: Clock,
  logger: Logger | undefined,
): Promise<{ runtime: ServerRuntime; settings: Settings; envFilePath: string }> {
  const envFilePath = resolveEnvFilePath(processEnv, platform);
  const snapshot = await readEnvFile(envFilePath);
  const settings = loadSettings(overlayEnvFile(processEnv, snapshot));
  const log = logger ?? createLogger({ level: settings.logLevel, clock });
  // Every apply is preview-then-plan here, whatever TT_WRITE_MODE says: the
  // plan is what the runner checks against the approval.
  const runSettings: Settings = { ...settings, writeMode: 'plan' };
  const runtime: ServerRuntime = {
    settings: runSettings,
    log,
    profiles: async () => {
      const current = await readEnvFile(envFilePath);
      const merged = overlayEnvFile(processEnv, current);
      return listProfiles(current, merged).map((name) => {
        try {
          const stored = readProfile(name, current, merged);
          return {
            name,
            scopes: stored.scopes ?? [],
            authorized:
              stored.accessToken !== undefined || stored.refreshToken !== undefined,
          };
        } catch {
          return { name, scopes: [], authorized: false };
        }
      });
    },
    createContext: (profile: string) =>
      Promise.resolve(
        createApiContext({ profile, settings: runSettings, log, clock, env: processEnv }),
      ),
  };
  return { runtime, settings, envFilePath };
}

export async function runRunQueue(deps: CliDeps = {}): Promise<number> {
  const io = cliIo(deps);
  const argv = deps.argv ?? [];
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      io.out(runQueueUsage());
      return EXIT_OK;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    io.err(`Unknown option ${JSON.stringify(arg)}.\n\n${runQueueUsage()}`);
    return EXIT_USAGE;
  }

  const clock = deps.clock ?? systemClock;
  try {
    const { runtime, settings, envFilePath } = await buildRuntime(
      deps.env ?? process.env,
      deps.platform ?? process.platform,
      clock,
      deps.logger,
    );
    // Only the two safety switches stop the runner. The package selection is
    // usually set in the MCP client's env, which cron never sees; the entries
    // were queued by a server that had publish-write enabled.
    if (!dryRun && (settings.writeMode === 'deny' || settings.packagesReadonly)) {
      io.err(
        'Publishing is disabled here (TT_WRITE_MODE=deny or TT_PACKAGES_READONLY), ' +
          'so nothing was run. Pending entries stay queued.\n',
      );
      return EXIT_FAILURE;
    }
    const outcomes = await runQueue({
      runtime,
      clock,
      schedule: scheduleOptionsFor({ ...settings, envFile: envFilePath }, runtime.log),
      dryRun,
    });
    if (outcomes.length === 0) {
      io.out(dryRun ? 'Nothing is due.\n' : 'Nothing was due.\n');
      return EXIT_OK;
    }
    for (const outcome of outcomes) io.out(renderOutcome(outcome));
    return outcomes.some((o) => o.status === 'failed' || o.status === 'expired')
      ? EXIT_FAILURE
      : EXIT_OK;
  } catch (cause) {
    io.err(`run-queue: ${(cause as Error).message}\n`);
    return EXIT_FAILURE;
  }
}

/**
 * Per-area coverage floors (TESTING.md § Coverage floors).
 *
 * A single global floor is the wrong instrument for this repo: `core/oauth.ts`
 * and `core/redact.ts` are where a gap turns into a leaked secret, while a
 * well-covered 3000-line project can carry an untested 40-line module without
 * moving the global number at all. The floors in `coverage-floors.json` are
 * therefore charged per area, most specific rule first.
 *
 * Input is `coverage/coverage-summary.json` (c8's `json-summary` reporter),
 * which reports per-file totals *after* the source-map remap — the numbers the
 * text reporter prints, not the build-directory ones.
 *
 * Usage: `node build/scripts/coverage-gate.js [--ratchet]`
 */

import { readFile } from 'node:fs/promises';

import { readRepoText, repoPath, syncFile } from './lib/repo.js';

const FLOORS = 'scripts/coverage-floors.json';
const SUMMARY = 'coverage/coverage-summary.json';

/** The three metrics the floors are expressed in. */
const METRICS = ['lines', 'branches', 'functions'] as const;
type MetricName = (typeof METRICS)[number];

interface Metric {
  total: number;
  covered: number;
}

type FileSummary = Record<MetricName, Metric>;

interface Rule extends Record<MetricName, number> {
  path: string;
  advisory?: boolean;
  advisoryReason?: string;
}

interface Floors {
  global: Record<MetricName, number>;
  rules: readonly Rule[];
}

/** Repo-relative, forward-slashed — `coverage-summary.json` keys are absolute. */
export function relativize(key: string): string {
  // `join` drops the trailing separator, so the prefix is rebuilt with one.
  const root = `${repoPath('').replace(/\\/g, '/').replace(/\/$/, '')}/`;
  const normalized = key.replace(/\\/g, '/');
  return normalized.startsWith(root) ? normalized.slice(root.length) : normalized;
}

/** `src/api/**` matches everything below `src/api/`; anything else is exact. */
export function matches(pattern: string, file: string): boolean {
  return pattern.endsWith('/**')
    ? file.startsWith(pattern.slice(0, -2))
    : file === pattern;
}

export function percent(metric: Metric): number {
  // An area with nothing to cover is fully covered — istanbul's own convention.
  return metric.total === 0 ? 100 : (metric.covered / metric.total) * 100;
}

function add(into: Metric, from: Metric): void {
  into.total += from.total;
  into.covered += from.covered;
}

function emptyTotals(): FileSummary {
  return {
    lines: { total: 0, covered: 0 },
    branches: { total: 0, covered: 0 },
    functions: { total: 0, covered: 0 },
  };
}

export interface AreaResult {
  path: string;
  advisory: boolean;
  files: number;
  achieved: Record<MetricName, number>;
  /** Metrics below their floor; empty means the area passed. */
  failures: { metric: MetricName; achieved: number; floor: number }[];
}

/**
 * Charge every covered file to its first matching rule, then compare each
 * area's aggregate against that rule's floors.
 */
export function evaluate(
  floors: Floors,
  summary: Record<string, FileSummary>,
): { areas: AreaResult[]; unmatchedFiles: string[] } {
  const totals = new Map<string, FileSummary>(
    floors.rules.map((rule) => [rule.path, emptyTotals()]),
  );
  const counts = new Map<string, number>(floors.rules.map((rule) => [rule.path, 0]));
  const unmatchedFiles: string[] = [];
  const globalTotals = emptyTotals();
  let globalFiles = 0;

  for (const [key, file] of Object.entries(summary)) {
    if (key === 'total') continue;
    const rel = relativize(key);
    globalFiles += 1;
    for (const metric of METRICS) add(globalTotals[metric], file[metric]);
    const rule = floors.rules.find((candidate) => matches(candidate.path, rel));
    if (rule === undefined) {
      unmatchedFiles.push(rel);
      continue;
    }
    const bucket = totals.get(rule.path);
    if (bucket === undefined) continue;
    for (const metric of METRICS) add(bucket[metric], file[metric]);
    counts.set(rule.path, (counts.get(rule.path) ?? 0) + 1);
  }

  const areas: AreaResult[] = [];
  for (const rule of [...floors.rules, { path: 'GLOBAL', ...floors.global }]) {
    const bucket = rule.path === 'GLOBAL' ? globalTotals : totals.get(rule.path);
    if (bucket === undefined) continue;
    const achieved = {} as Record<MetricName, number>;
    const failures: AreaResult['failures'] = [];
    const files = rule.path === 'GLOBAL' ? globalFiles : (counts.get(rule.path) ?? 0);
    for (const metric of METRICS) {
      const value = percent(bucket[metric]);
      achieved[metric] = value;
      const floor = rule[metric];
      // Tolerate float noise: 89.99999999 against a floor of 90 is a pass.
      if (files > 0 && value + 1e-9 < floor)
        failures.push({ metric, achieved: value, floor });
    }
    areas.push({
      path: rule.path,
      advisory: 'advisory' in rule && rule.advisory === true,
      files,
      achieved,
      failures,
    });
  }
  return { areas, unmatchedFiles };
}

function fmt(value: number): string {
  return value.toFixed(2).padStart(6);
}

/** The floors file with every floor raised to `max(floor, achieved - 2)`. */
export function ratchet(floors: Floors, areas: readonly AreaResult[]): Floors {
  const raise = (
    current: Record<MetricName, number>,
    achieved: Record<MetricName, number> | undefined,
  ): Record<MetricName, number> => {
    const next = {} as Record<MetricName, number>;
    for (const metric of METRICS) {
      const target = achieved === undefined ? 0 : Math.floor(achieved[metric] - 2);
      next[metric] = Math.max(current[metric], target);
    }
    return next;
  };
  const byPath = new Map(areas.map((area) => [area.path, area]));
  // Spread `floors` first so the file's `$comment` block survives the rewrite.
  return {
    ...floors,
    global: raise(floors.global, byPath.get('GLOBAL')?.achieved),
    rules: floors.rules.map((rule) => {
      const area = byPath.get(rule.path);
      // A rule whose module does not exist yet keeps the floor it was written with.
      const achieved = area !== undefined && area.files > 0 ? area.achieved : undefined;
      return { ...rule, ...raise(rule, achieved) };
    }),
  };
}

export async function runCoverageGate(doRatchet: boolean): Promise<boolean> {
  const floors = JSON.parse(await readRepoText(FLOORS)) as Floors;
  let raw: string;
  try {
    raw = await readFile(repoPath(SUMMARY), 'utf8');
  } catch {
    process.stderr.write(
      `coverage-gate: ${SUMMARY} not found — run \`npm run coverage:run\` first.\n`,
    );
    return false;
  }
  const summary = JSON.parse(raw) as Record<string, FileSummary>;
  const { areas, unmatchedFiles } = evaluate(floors, summary);

  const out: string[] = [
    'coverage floors (docs/TESTING.md)',
    '  area                          files   lines branches  funcs',
  ];
  let ok = true;
  for (const area of areas) {
    const mark = area.failures.length === 0 ? ' ' : area.advisory ? '!' : 'x';
    out.push(
      `${mark} ${area.path.padEnd(28)} ${String(area.files).padStart(5)} ` +
        `${fmt(area.achieved.lines)} ${fmt(area.achieved.branches)} ${fmt(area.achieved.functions)}`,
    );
    for (const failure of area.failures) {
      const label = area.advisory ? 'advisory' : 'BELOW FLOOR';
      out.push(
        `    ${label}: ${failure.metric} ${failure.achieved.toFixed(2)} < ${String(failure.floor)}`,
      );
      if (!area.advisory) ok = false;
    }
    if (area.files === 0 && area.path !== 'GLOBAL') {
      out.push('    note: no source file matches this rule yet');
    }
  }
  for (const file of unmatchedFiles) {
    out.push(`  note: ${file} is covered by the global floor only`);
  }
  process.stdout.write(`${out.join('\n')}\n`);

  if (doRatchet) {
    const next = `${JSON.stringify(ratchet(floors, areas), null, 2)}\n`;
    const { drifted } = await syncFile(FLOORS, next, false);
    process.stdout.write(
      drifted
        ? `coverage-gate: ${FLOORS} ratcheted.\n`
        : `coverage-gate: floors unchanged.\n`,
    );
  }
  return ok;
}

if (process.argv[1]?.endsWith('coverage-gate.js') === true) {
  const ok = await runCoverageGate(process.argv.includes('--ratchet'));
  process.exitCode = ok ? 0 : 1;
}

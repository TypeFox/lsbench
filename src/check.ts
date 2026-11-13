import type { BenchReport, MethodStats } from './types.js';

/** Version of the baseline file format, bumped on incompatible changes */
export const BASELINE_FORMAT = 1;

/** Rates compared by `checkReport`, each within `rateTolerance` of the baseline */
export const CHECKED_RATES = ['timeout_rate', 'skip_rate', 'empty_rate', 'null_rate', 'failure_rate'] as const;

/** Run settings that must match between a report and its baseline */
export const CHECKED_SETTINGS = ['iterations', 'warmup', 'restart_between_iterations'] as const;

/** The `method` of failures that concern the whole run, such as a settings mismatch */
export const RUN_METHOD = '(run)';

/** absorbs floating point noise in rate differences, so 0.3 vs 0.2 stays within 0.1 */
const EPSILON = 1e-9;

/**
 * A report reduced to what `checkReport` compares: the run settings, the per method summary
 * and the iteration summary, without the per iteration runs, so it stays small and diffs well
 */
export interface BenchBaseline {
    lsbench_baseline: number;
    iterations: number;
    warmup: number;
    restart_between_iterations: boolean;
    summary: Record<string, MethodStats>;
    iteration_summary: BenchReport['iteration_summary'];
}

/** The fields shared by a report and a baseline, so either can be checked against a baseline */
export type CheckedRun = Pick<BenchBaseline, (typeof CHECKED_SETTINGS)[number] | 'summary'>;

export interface CheckOptions {
    /** largest allowed absolute difference of a rate (default 0.1) */
    rateTolerance?: number;
    /** median_ms may grow by this factor or shrink by its inverse (default 2) */
    medianRatio?: number;
    /** milliseconds added on both sides of the median bounds (default 5) */
    slackMs?: number;
    /** the median rule is skipped when the baseline's or the report's count is below this (default 3) */
    minCount?: number;
}

export const DEFAULT_CHECK_OPTIONS: Required<CheckOptions> = {
    rateTolerance: 0.1,
    medianRatio: 2,
    slackMs: 5,
    minCount: 3,
};

export interface CheckFailure {
    /** method name, or RUN_METHOD for a run setting */
    method: string;
    /** the compared field, e.g. "median_ms", "iterations", or "method" for an added or missing method */
    field: string;
    baseline: unknown;
    actual: unknown;
    /** the rule that failed, readable, e.g. "|diff| > 0.1" */
    rule: string;
}

export interface CheckResult {
    pass: boolean;
    failures: CheckFailure[];
}

/** Reduces a report to a baseline */
export function createBaseline(report: BenchReport): BenchBaseline {
    return {
        lsbench_baseline: BASELINE_FORMAT,
        iterations: report.iterations,
        warmup: report.warmup,
        restart_between_iterations: report.restart_between_iterations,
        summary: report.summary,
        iteration_summary: report.iteration_summary,
    };
}

/** Compares a report (or baseline) against a baseline, collecting every failing rule */
export function checkReport(actual: CheckedRun, baseline: CheckedRun, options: CheckOptions = {}): CheckResult {
    const opts = { ...DEFAULT_CHECK_OPTIONS, ...options };
    const failures: CheckFailure[] = [];

    // run settings must match, timings of different settings are not comparable
    for (const field of CHECKED_SETTINGS) {
        if (actual[field] !== baseline[field]) {
            failures.push({
                method: RUN_METHOD,
                field,
                baseline: baseline[field],
                actual: actual[field],
                rule: 'setting must match',
            });
        }
    }

    // methods missing from the report, then the shared ones
    for (const [method, base] of Object.entries(baseline.summary)) {
        const stats = actual.summary[method];
        if (!stats) {
            failures.push({ method, field: 'method', baseline: 'present', actual: 'missing', rule: 'method missing' });
            continue;
        }
        failures.push(...compareMethod(method, stats, base, opts));
    }

    // methods the baseline does not know
    for (const method of Object.keys(actual.summary)) {
        if (!(method in baseline.summary)) {
            failures.push({ method, field: 'method', baseline: 'missing', actual: 'present', rule: 'method added' });
        }
    }

    return { pass: failures.length === 0, failures };
}

/** The rate and median failures of one method */
function compareMethod(
    method: string,
    stats: MethodStats,
    base: MethodStats,
    opts: Required<CheckOptions>,
): CheckFailure[] {
    const failures: CheckFailure[] = [];

    for (const field of CHECKED_RATES) {
        const diff = Math.abs(stats[field] - base[field]);
        if (diff > opts.rateTolerance + EPSILON) {
            failures.push({
                method,
                field,
                baseline: base[field],
                actual: stats[field],
                rule: `|diff| > ${opts.rateTolerance}`,
            });
        }
    }

    // a null median (no durations, e.g. every wait timed out) must stay null and vice versa
    const median = stats.median_ms;
    const baseMedian = base.median_ms;
    if (baseMedian === null || median === null) {
        if (baseMedian !== median) {
            failures.push({
                method,
                field: 'median_ms',
                baseline: baseMedian,
                actual: median,
                rule: baseMedian === null ? 'must stay null' : 'must not be null',
            });
        }
        return failures;
    }
    // a median of too few samples is noise, e.g. lifecycle methods measured once per run
    if (stats.count < opts.minCount || base.count < opts.minCount) {
        return failures;
    }
    // a median is never negative, so the lower bound stops at 0
    const low = Math.max(0, baseMedian / opts.medianRatio - opts.slackMs);
    const high = baseMedian * opts.medianRatio + opts.slackMs;
    if (median < low || median > high) {
        failures.push({
            method,
            field: 'median_ms',
            baseline: baseMedian,
            actual: median,
            rule: `outside [${round(low)}, ${round(high)}]`,
        });
    }
    return failures;
}

/**
 * Validates that a parsed JSON value has the shape `checkReport` needs, returning an error
 * message when it does not. Accepts reports and baselines
 */
export function validateCheckedRun(value: unknown): string | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return 'expected a JSON object';
    }
    const run = value as Record<string, unknown>;
    if (typeof run.iterations !== 'number' || typeof run.warmup !== 'number') {
        return 'missing numeric "iterations" or "warmup"';
    }
    if (typeof run.restart_between_iterations !== 'boolean') {
        return 'missing boolean "restart_between_iterations"';
    }
    const summary = run.summary;
    if (typeof summary !== 'object' || summary === null || Array.isArray(summary)) {
        return 'missing object "summary"';
    }
    for (const [method, stats] of Object.entries(summary)) {
        if (typeof stats !== 'object' || stats === null) {
            return `summary of ${method} is not an object`;
        }
        const fields = stats as Record<string, unknown>;
        for (const rate of CHECKED_RATES) {
            if (typeof fields[rate] !== 'number') {
                return `summary of ${method} has no numeric ${rate}`;
            }
        }
        if (typeof fields.count !== 'number') {
            return `summary of ${method} has no numeric count`;
        }
        if (fields.median_ms !== null && typeof fields.median_ms !== 'number') {
            return `summary of ${method} has no median_ms`;
        }
    }
    return undefined;
}

/** A readable table of the failures, or a pass line */
export function formatCheckResult(result: CheckResult): string {
    if (result.pass) {
        return 'PASS: no regressions against the baseline';
    }
    const header = ['method', 'field', 'baseline', 'actual', 'rule'];
    const rows = result.failures.map((f) => [
        f.method,
        f.field,
        formatValue(f.baseline),
        formatValue(f.actual),
        f.rule,
    ]);
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
    const line = (cells: string[]) =>
        cells
            .map((cell, i) => cell.padEnd(widths[i]))
            .join('  ')
            .trimEnd();
    const count = result.failures.length;
    return [
        `FAIL: ${count} ${count === 1 ? 'regression' : 'regressions'} against the baseline`,
        '',
        line(header),
        line(widths.map((w) => '-'.repeat(w))),
        ...rows.map(line),
    ].join('\n');
}

function formatValue(value: unknown): string {
    return typeof value === 'number' ? String(round(value)) : String(value);
}

function round(value: number): number {
    return Math.round(value * 1000) / 1000;
}

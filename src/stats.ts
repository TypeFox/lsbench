import type { AbnormalExit, BenchOptions, BenchReport, IterationResult, MethodStats, RequestTiming } from './types.js';

/** Sort numbers ascending (in-place) and return the array */
function sorted(arr: number[]): number[] {
    return arr.sort((a, b) => a - b);
}

/** Compute a percentile from a sorted array (nearest-rank method) */
function percentile(sortedArr: number[], p: number): number {
    if (sortedArr.length === 0) {
        return 0;
    }
    const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
    return sortedArr[Math.max(0, idx)];
}

/** Round to N decimal places */
function round(value: number, decimals = 3): number {
    const f = 10 ** decimals;
    return Math.round(value * f) / f;
}

/**
 * Compute aggregate statistics for a set of timings. Skipped ones only count toward skipped
 * and skip_rate, timeouts count toward timeout_rate but are left out of the durations,
 * since their duration is just the timeout
 */
export function computeMethodStats(timings: RequestTiming[]): MethodStats {
    const durations: number[] = [];
    let failures = 0;
    let nulls = 0;
    let empties = 0;
    let skipped = 0;
    let timeouts = 0;
    const graces: number[] = [];
    for (const t of timings) {
        if (t.result === 'skipped') {
            skipped++;
            continue;
        }
        if (t.result === 'timeout') {
            timeouts++;
            continue;
        }
        durations.push(t.duration_ms);
        if (t.grace_ms !== undefined) {
            graces.push(t.grace_ms);
        }
        if (!t.success) {
            failures++;
        }
        if (t.result === 'null') {
            nulls++;
        } else if (t.result === 'empty') {
            empties++;
        }
    }
    sorted(durations);
    const n = durations.length;
    const count = timings.length;
    // rates cover every timing actually sent, timeouts included
    const sent = count - skipped;
    const rate = (k: number, of: number) => (of === 0 ? 0 : round(k / of, 4));
    const rates = {
        failure_rate: rate(failures, sent),
        null_rate: rate(nulls, sent),
        empty_rate: rate(empties, sent),
        timeout_rate: rate(timeouts, sent),
        skipped,
        skip_rate: rate(skipped, count),
        ...(graces.length > 0 ? { graced: graces.length, grace_median_ms: round(percentile(sorted(graces), 50)) } : {}),
    };

    // no durations left (all timeouts or skipped): null rather than 0, which would read as instant
    if (n === 0) {
        return {
            count,
            avg_ms: null,
            median_ms: null,
            p95_ms: null,
            p99_ms: null,
            min_ms: null,
            max_ms: null,
            stddev_ms: null,
            ...rates,
        };
    }

    const sum = durations.reduce((a, b) => a + b, 0);
    const avg = sum / n;
    const variance = durations.reduce((acc, d) => acc + (d - avg) ** 2, 0) / n;

    return {
        count,
        avg_ms: round(avg),
        median_ms: round(percentile(durations, 50)),
        p95_ms: round(percentile(durations, 95)),
        p99_ms: round(percentile(durations, 99)),
        min_ms: round(durations[0]),
        max_ms: round(durations[n - 1]),
        stddev_ms: round(Math.sqrt(variance)),
        ...rates,
    };
}

/** Compute per-iteration total stats */
function computeIterationSummary(runs: IterationResult[]) {
    const totals = sorted(runs.map((r) => r.total_ms));
    const n = totals.length;
    if (n === 0) {
        return { avg_ms: 0, median_ms: 0, p95_ms: 0, min_ms: 0, max_ms: 0 };
    }
    const sum = totals.reduce((a, b) => a + b, 0);
    return {
        avg_ms: round(sum / n),
        median_ms: round(percentile(totals, 50)),
        p95_ms: round(percentile(totals, 95)),
        min_ms: round(totals[0]),
        max_ms: round(totals[n - 1]),
    };
}

/**
 * Compute per-method stats across all runs plus any keep alive lifecycle timings.
 * lifecycle/* methods are listed first, the rest in order of first appearance
 */
export function summarizeMethods(
    runs: IterationResult[],
    lifecycle: RequestTiming[] = [],
): Record<string, MethodStats> {
    // group all timings by method
    const byMethod = new Map<string, RequestTiming[]>();
    const add = (req: RequestTiming) => {
        const key = req.label ? `${req.method} (${req.label})` : req.method;
        if (!byMethod.has(key)) {
            byMethod.set(key, []);
        }
        byMethod.get(key)?.push(req);
    };
    for (const req of lifecycle) {
        add(req);
    }
    for (const run of runs) {
        for (const req of run.requests) {
            add(req);
        }
    }

    const summary: Record<string, MethodStats> = {};
    for (const firstPass of [true, false]) {
        for (const [method, timings] of byMethod) {
            if (method.startsWith('lifecycle/') === firstPass) {
                summary[method] = computeMethodStats(timings);
            }
        }
    }
    return summary;
}

/** Build the final report from collected iteration results and optional keep alive lifecycle timings */
export function buildReport(
    opts: BenchOptions,
    runs: IterationResult[],
    totalDuration: number,
    lifecycle?: RequestTiming[],
): BenchReport {
    const report: BenchReport = {
        server: opts.server,
        workspace: opts.workspace,
        script: opts.script,
        iterations: opts.iterations,
        warmup: opts.warmup,
        restart_between_iterations: opts.restart,
        timestamp: new Date().toISOString(),
        total_duration_ms: round(totalDuration),
        summary: summarizeMethods(runs, lifecycle),
        iteration_summary: computeIterationSummary(runs),
        runs,
    };
    if (lifecycle) {
        report.lifecycle = lifecycle;
    }
    return report;
}

/** "code 1" or "codes 1, 2" for the distinct exit codes of some exits */
function describeExitCodes(exits: AbnormalExit[]): string {
    const codes = [...new Set(exits.map((e) => e.code))].sort((a, b) => (a ?? -1) - (b ?? -1));
    return `${codes.length === 1 ? 'code' : 'codes'} ${codes.join(', ')} after shutdown, allowed`;
}

/** Pretty-print a summary table to the console */
export function printSummary(report: BenchReport): void {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║                     lsbench results                          ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    console.log(`  Server:      ${report.server}`);
    console.log(`  Workspace:   ${report.workspace}`);
    console.log(`  Iterations:  ${report.iterations} (+ ${report.warmup} warmup)`);
    console.log(`  Total time:  ${(report.total_duration_ms / 1000).toFixed(1)}s`);
    console.log(`  Restart:     ${report.restart_between_iterations ? 'yes' : 'no'}`);
    if (report.abnormal_exits) {
        console.log(`  Abnormal exits:  ${report.abnormal_exits.length}`);
    }
    if (report.tolerated_exits) {
        console.log(
            `  Tolerated exits: ${report.tolerated_exits.length} (${describeExitCodes(report.tolerated_exits)})`,
        );
    }
    console.log();

    // Iteration summary
    const is = report.iteration_summary;
    console.log('  Iteration totals:');
    console.log(
        `    avg=${is.avg_ms}ms  median=${is.median_ms}ms  p95=${is.p95_ms}ms  min=${is.min_ms}ms  max=${is.max_ms}ms`,
    );
    console.log();

    // Per-method table
    const methods = Object.keys(report.summary);
    if (methods.length === 0) {
        console.log('  No requests recorded.');
        return;
    }

    // Column widths
    const nameWidth = Math.max(20, ...methods.map((m) => m.length)) + 2;
    // null, empty, timeout and skip columns only when some method has any, keeping the common table narrow
    let showResults = false;
    let showSkipped = false;
    let showTimeouts = false;
    for (const method of methods) {
        const s = report.summary[method];
        if (s.timeout_rate > 0) {
            showTimeouts = true;
        }
        if (s.null_rate > 0 || s.empty_rate > 0) {
            showResults = true;
        }
        if (s.skipped > 0) {
            showSkipped = true;
        }
    }
    const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`.padStart(8);
    // latencies are null when no durations are left
    const ms = (value: number | null) => (value === null ? 'n/a' : `${value}`).padStart(10);

    const header =
        '  ' +
        'Method'.padEnd(nameWidth) +
        'Avg'.padStart(10) +
        'Median'.padStart(10) +
        'P95'.padStart(10) +
        'P99'.padStart(10) +
        'Min'.padStart(10) +
        'Max'.padStart(10) +
        'Stddev'.padStart(10) +
        'Fail%'.padStart(8) +
        (showResults ? 'Null%'.padStart(8) + 'Empty%'.padStart(8) : '') +
        (showTimeouts ? 'Tmout%'.padStart(8) : '') +
        (showSkipped ? 'Skip%'.padStart(8) : '');

    console.log(header);
    console.log(`  ${'─'.repeat(header.length - 2)}`);

    for (const method of methods) {
        const s = report.summary[method];
        const row =
            '  ' +
            method.padEnd(nameWidth) +
            ms(s.avg_ms) +
            ms(s.median_ms) +
            ms(s.p95_ms) +
            ms(s.p99_ms) +
            ms(s.min_ms) +
            ms(s.max_ms) +
            ms(s.stddev_ms) +
            percent(s.failure_rate) +
            (showResults ? percent(s.null_rate) + percent(s.empty_rate) : '') +
            (showTimeouts ? percent(s.timeout_rate) : '') +
            (showSkipped ? percent(s.skip_rate) : '');
        console.log(row);
    }

    // auto mode pulls that first waited for a push include that grace in their durations
    const graced = methods.filter((m) => report.summary[m].graced !== undefined);
    if (graced.length > 0) {
        console.log();
        for (const method of graced) {
            const s = report.summary[method];
            const pulls = s.graced === 1 ? '1 pull' : `${s.graced} pulls`;
            console.log(
                `  ${method}: ${pulls} first waited for a push (median ${s.grace_median_ms}ms, included above)`,
            );
        }
        console.log("  Pass mode: 'pull' or a short pullAfterMs to waitForDiagnostics for a pull only server");
    }

    console.log();
}

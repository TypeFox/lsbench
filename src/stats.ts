import type { AbnormalExit, BenchOptions, BenchReport, IterationResult, MethodStats, RequestTiming } from './types.js';

export const PLAINTEXT_FALLBACK_NOTE =
    'Some documents were opened as plaintext, and the server may not serve that language id';

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
    const closeWindows: number[] = [];
    let held = 0;
    let heldPublishes = 0;
    let shortened = 0;
    for (const t of timings) {
        if (t.result === 'skipped') {
            skipped++;
            continue;
        }
        if (t.held_pulls !== undefined) {
            held++;
        }
        if (t.held_publishes !== undefined) {
            heldPublishes++;
        }
        if (t.shortened) {
            shortened++;
        }
        if (t.result === 'timeout') {
            timeouts++;
            continue;
        }
        durations.push(t.duration_ms);
        if (t.grace_ms !== undefined) {
            graces.push(t.grace_ms);
        }
        if (t.close_window_ms !== undefined) {
            closeWindows.push(t.close_window_ms);
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
        ...(held > 0 ? { held } : {}),
        ...(heldPublishes > 0 ? { held_publishes: heldPublishes } : {}),
        ...(closeWindows.length > 0
            ? {
                  close_windowed: closeWindows.length,
                  close_window_median_ms: round(percentile(sorted(closeWindows), 50)),
              }
            : {}),
        ...(shortened > 0 ? { shortened } : {}),
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
function computeIterationSummary(runs: IterationResult[]): BenchReport['iteration_summary'] {
    const totals = sorted(runs.map((r) => r.total_ms));
    const n = totals.length;
    if (n === 0) {
        return { avg_ms: null, median_ms: null, p95_ms: null, min_ms: null, max_ms: null };
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
    const codes = new Set<number>();
    const signals = new Set<string>();
    for (const exit of exits) {
        if (exit.signal) {
            signals.add(exit.signal);
        } else if (exit.code !== null) {
            codes.add(exit.code);
        }
    }
    const parts: string[] = [];
    if (codes.size > 0) {
        const sorted = [...codes].sort((a, b) => a - b);
        parts.push(`${sorted.length === 1 ? 'code' : 'codes'} ${sorted.join(', ')}`);
    }
    if (signals.size > 0) {
        const sorted = [...signals].sort();
        parts.push(`${sorted.length === 1 ? 'signal' : 'signals'} ${sorted.join(', ')}`);
    }
    return `${parts.join(', ')} after shutdown, allowed`;
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
    const total = (ms: number | null) => (ms === null ? 'n/a' : `${ms}ms`);
    console.log('  Iteration totals:');
    console.log(
        `    avg=${total(is.avg_ms)}  median=${total(is.median_ms)}  p95=${total(is.p95_ms)}  min=${total(is.min_ms)}  max=${total(is.max_ms)}`,
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

    // auto mode pulls that first waited for a push include that grace in their durations,
    // and those that held back empty answers of a busy server include the wait for it. Push
    // waits holding an empty publish in a close window do not include that hold
    const graced = methods.filter((m) => report.summary[m].graced !== undefined);
    const held = methods.filter((m) => report.summary[m].held !== undefined);
    const heldPublishes = methods.filter((m) => report.summary[m].held_publishes !== undefined);
    const closeWindowed = methods.filter((m) => report.summary[m].close_windowed !== undefined);
    const shortened = methods.filter((m) => report.summary[m].shortened !== undefined);
    if (
        graced.length > 0 ||
        held.length > 0 ||
        heldPublishes.length > 0 ||
        closeWindowed.length > 0 ||
        shortened.length > 0
    ) {
        console.log();
        for (const method of graced) {
            const s = report.summary[method];
            const pulls = s.graced === 1 ? '1 pull' : `${s.graced} pulls`;
            console.log(
                `  ${method}: ${pulls} first waited for a push (median ${s.grace_median_ms}ms, included above)`,
            );
        }
        for (const method of held) {
            const s = report.summary[method];
            const waits = s.held === 1 ? '1 wait' : `${s.held} waits`;
            console.log(`  ${method}: ${waits} held back empty answers while the server was busy (included above)`);
        }
        for (const method of heldPublishes) {
            const s = report.summary[method];
            const waits = s.held_publishes === 1 ? '1 wait' : `${s.held_publishes} waits`;
            console.log(
                `  ${method}: ${waits} held back empty publishes until the server was quiescent (included above)`,
            );
        }
        for (const method of closeWindowed) {
            const s = report.summary[method];
            const waits = s.close_windowed === 1 ? '1 wait' : `${s.close_windowed} waits`;
            console.log(
                `  ${method}: ${waits} held an empty publish in the close window ` +
                    `(median ${s.close_window_median_ms}ms, not included above)`,
            );
        }
        for (const method of shortened) {
            const s = report.summary[method];
            const waits = s.shortened === 1 ? '1 wait' : `${s.shortened} waits`;
            console.log(
                `  ${method}: ${waits} of a kind known to time out shortened by --shorten-silent-waits ` +
                    '(counted as timeouts above)',
            );
        }
        // a server answering empty while busy loads and may still push, it is not pull only
        if (graced.length > 0 && held.length === 0 && heldPublishes.length === 0) {
            console.log("  Pass mode: 'pull' or a short pullAfterMs to waitForDiagnostics for a pull only server");
        }
    }

    // push waits that never saw a publish, warmups included, which summary rows cannot tell
    if (report.silent_waits) {
        console.log();
        for (const [method, silent] of Object.entries(report.silent_waits)) {
            console.log(
                `  ${method}: the server did not publish in ${silent.waits} waits ` +
                    `(${silent.longest_streak} in a row, warmups included${shortenedNote(silent.shortened)}), ` +
                    'it may never publish for a clean document',
            );
        }
        console.log(
            '  Their timeouts mean no diagnostics, not slow ones: use `until` or a short timeout for such waits',
        );
        printPlaintextNote(report);
    }

    if (report.until_rejected) {
        console.log();
        for (const [method, rejected] of Object.entries(report.until_rejected)) {
            console.log(
                `  ${method}: ${rejected.waits} waits timed out after publishes that all failed until ` +
                    `(warmups included${shortenedNote(rejected.shortened)}), the server may never report what until expects`,
            );
        }
        console.log('  Their timeouts do not mean a slow server: check what the server reports for such waits');
        printPlaintextNote(report);
    }

    if (report.reopen_waits) {
        console.log();
        for (const [method, reopen] of Object.entries(report.reopen_waits)) {
            console.log(
                `  ${method}: ${reopen.waits} reopen waits saw only the publishes clearing the close ` +
                    `(${reopen.longest_streak} in a row, warmups included${shortenedNote(reopen.shortened)}), ` +
                    'the server may not republish a clean file on reopen',
            );
        }
    }

    if (report.plaintext_fallbacks) {
        console.log();
        const extensions = report.plaintext_fallbacks.map((ext) => (ext === '' ? '(no extension)' : ext)).join(', ');
        console.log(
            `  Opened as plaintext: ${extensions} have no registered language id, ` +
                'register them with addRegisteredLanguage() or pass options.languageId to openDocument()',
        );
    }

    console.log();
}

function printPlaintextNote(report: BenchReport): void {
    if (report.plaintext_fallbacks) {
        console.log(`  ${PLAINTEXT_FALLBACK_NOTE}`);
    }
}

function shortenedNote(shortened: number | undefined): string {
    return shortened ? `, ${shortened} shortened` : '';
}

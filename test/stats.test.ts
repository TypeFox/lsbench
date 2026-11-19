import type { BenchOptions, IterationResult, RequestTiming } from 'lsbench';
import { buildReport, computeMethodStats, printSummary } from 'lsbench';
import { afterEach, describe, expect, it, vi } from 'vitest';

function timing(overrides: Partial<RequestTiming> = {}): RequestTiming {
    return {
        method: 'textDocument/hover',
        duration_ms: 10,
        success: true,
        result: 'ok',
        ...overrides,
    };
}

describe('computeMethodStats', () => {
    it('returns null latencies and zero rates for an empty set', () => {
        const stats = computeMethodStats([]);
        expect(stats).toEqual({
            count: 0,
            avg_ms: null,
            median_ms: null,
            p95_ms: null,
            p99_ms: null,
            min_ms: null,
            max_ms: null,
            stddev_ms: null,
            failure_rate: 0,
            null_rate: 0,
            empty_rate: 0,
            timeout_rate: 0,
            skipped: 0,
            skip_rate: 0,
        });
    });

    it('computes aggregates for a single timing', () => {
        const stats = computeMethodStats([timing({ duration_ms: 42 })]);
        expect(stats.count).toBe(1);
        expect(stats.avg_ms).toBe(42);
        expect(stats.median_ms).toBe(42);
        expect(stats.min_ms).toBe(42);
        expect(stats.max_ms).toBe(42);
        expect(stats.stddev_ms).toBe(0);
        expect(stats.failure_rate).toBe(0);
    });

    it('computes avg, min, max and stddev across multiple timings', () => {
        const durations = [10, 20, 30, 40, 50];
        const stats = computeMethodStats(durations.map((d) => timing({ duration_ms: d })));

        expect(stats.count).toBe(5);
        expect(stats.avg_ms).toBe(30);
        expect(stats.min_ms).toBe(10);
        expect(stats.max_ms).toBe(50);
        // population stddev of the set = sqrt(200) ≈ 14.142
        expect(stats.stddev_ms).toBeCloseTo(14.142, 2);
    });

    it('uses nearest-rank percentiles (median/p95/p99)', () => {
        // 1..100 → median is index ceil(0.5*100)-1 = 49 → value 50
        const durations = Array.from({ length: 100 }, (_, i) => i + 1);
        const stats = computeMethodStats(durations.map((d) => timing({ duration_ms: d })));

        expect(stats.median_ms).toBe(50);
        expect(stats.p95_ms).toBe(95);
        expect(stats.p99_ms).toBe(99);
    });

    it('does not mutate the input ordering semantics of the caller', () => {
        // computeMethodStats maps to a fresh array internally, so the original
        // RequestTiming array order is preserved for the caller.
        const input = [timing({ duration_ms: 30 }), timing({ duration_ms: 10 }), timing({ duration_ms: 20 })];
        computeMethodStats(input);
        expect(input.map((t) => t.duration_ms)).toEqual([30, 10, 20]);
    });

    it('reports the failure rate rounded to 4 decimals', () => {
        const timings = [
            timing({ success: true }),
            timing({ success: false, result: 'error', error: 'boom' }),
            timing({ success: false, result: 'error', error: 'boom' }),
        ];
        const stats = computeMethodStats(timings);
        expect(stats.count).toBe(3);
        // 2 of 3 failed
        expect(stats.failure_rate).toBeCloseTo(0.6667, 4);
    });

    it('reports null and empty rates apart from failures', () => {
        const stats = computeMethodStats([
            timing(),
            timing({ result: 'null' }),
            timing({ result: 'null' }),
            timing({ result: 'empty' }),
            timing({ success: false, result: 'error', error: 'boom' }),
        ]);
        expect(stats.failure_rate).toBe(0.2);
        expect(stats.null_rate).toBe(0.4);
        expect(stats.empty_rate).toBe(0.2);
    });

    it('counts skipped requests but keeps them out of durations and the other rates', () => {
        const skipped = timing({ duration_ms: 0, success: false, result: 'skipped' });
        const stats = computeMethodStats([
            timing({ duration_ms: 10 }),
            timing({ duration_ms: 30, success: false, result: 'error' }),
            skipped,
            skipped,
        ]);
        expect(stats).toMatchObject({
            count: 4,
            skipped: 2,
            skip_rate: 0.5,
            avg_ms: 20,
            min_ms: 10,
            failure_rate: 0.5,
        });
    });

    it('reports a fully skipped method with null latencies and a skip rate of 1', () => {
        const stats = computeMethodStats([timing({ duration_ms: 0, success: false, result: 'skipped' })]);
        expect(stats).toMatchObject({ count: 1, skipped: 1, skip_rate: 1, avg_ms: null, failure_rate: 0 });
    });

    it('counts timeouts in timeout_rate but keeps them out of durations and failures', () => {
        const timeout = timing({ method: 'diagnostics/open', duration_ms: 3000, success: false, result: 'timeout' });
        const stats = computeMethodStats([
            timing({ method: 'diagnostics/open', duration_ms: 10 }),
            timing({ method: 'diagnostics/open', duration_ms: 30, result: 'empty' }),
            timeout,
            timeout,
        ]);
        expect(stats).toMatchObject({
            count: 4,
            avg_ms: 20,
            max_ms: 30,
            timeout_rate: 0.5,
            failure_rate: 0,
            empty_rate: 0.25,
            skip_rate: 0,
        });
    });

    it('counts auto mode pulls that waited for a push, with their median grace', () => {
        const pull = (duration_ms: number, grace_ms?: number) =>
            timing({ method: 'diagnostics/pull/open', duration_ms, ...(grace_ms !== undefined ? { grace_ms } : {}) });
        const stats = computeMethodStats([
            pull(1004, 1000),
            pull(1010, 1002),
            pull(1003, 1001),
            pull(4),
            timing({
                method: 'diagnostics/pull/open',
                duration_ms: 5000,
                success: false,
                result: 'timeout',
                grace_ms: 1000,
            }),
        ]);
        // the timeout is left out, like from the durations
        expect(stats).toMatchObject({ count: 5, graced: 3, grace_median_ms: 1001, max_ms: 1010 });
    });

    it('leaves the grace fields out when no pull waited for a push', () => {
        const stats = computeMethodStats([timing({ method: 'diagnostics/pull/open', duration_ms: 4 })]);
        expect(stats).not.toHaveProperty('graced');
        expect(stats).not.toHaveProperty('grace_median_ms');
    });

    it('counts push waits that held an empty publish in the close window, with their median hold', () => {
        const open = (duration_ms: number, close_window_ms?: number) =>
            timing({
                method: 'diagnostics/open',
                duration_ms,
                ...(close_window_ms !== undefined ? { close_window_ms } : {}),
            });
        const stats = computeMethodStats([
            open(56, 940),
            open(60, 950),
            open(58, 930),
            open(70),
            timing({
                method: 'diagnostics/open',
                duration_ms: 5000,
                success: false,
                result: 'timeout',
                close_window_ms: 900,
            }),
            timing({
                method: 'diagnostics/open',
                duration_ms: 0,
                success: false,
                result: 'skipped',
                close_window_ms: 900,
            }),
        ]);
        // timeouts and skipped timings are left out, like from the durations
        expect(stats).toMatchObject({ count: 6, close_windowed: 3, close_window_median_ms: 940, max_ms: 70 });
    });

    it('leaves the close window fields out when no wait held an empty publish', () => {
        const stats = computeMethodStats([timing({ method: 'diagnostics/open', duration_ms: 4 })]);
        expect(stats).not.toHaveProperty('close_windowed');
        expect(stats).not.toHaveProperty('close_window_median_ms');
    });

    it('reports a method where every wait timed out with null latencies and a timeout rate of 1', () => {
        const timeout = timing({ method: 'diagnostics/open', duration_ms: 15000, success: false, result: 'timeout' });
        const stats = computeMethodStats([timeout, timeout, timeout]);
        expect(stats).toMatchObject({
            count: 3,
            timeout_rate: 1,
            avg_ms: null,
            median_ms: null,
            p95_ms: null,
            p99_ms: null,
            min_ms: null,
            max_ms: null,
            stddev_ms: null,
            failure_rate: 0,
        });
    });

    it('leaves skipped requests out of the timeout rate', () => {
        const stats = computeMethodStats([
            timing({ result: 'timeout', success: false }),
            timing({ result: 'skipped', success: false, duration_ms: 0 }),
        ]);
        expect(stats).toMatchObject({ timeout_rate: 1, skip_rate: 0.5 });
    });
});

describe('buildReport', () => {
    const opts: BenchOptions = {
        server: 'fake-language-server --stdio',
        workspace: '/tmp/ws',
        script: 'actions.ts',
        iterations: 2,
        warmup: 1,
        output: 'out.json',
        restart: false,
        verbose: false,
    };

    function run(iteration: number, requests: RequestTiming[]): IterationResult {
        const total_ms = requests.reduce((a, r) => a + r.duration_ms, 0);
        return { iteration, requests, total_ms };
    }

    it('groups timings by method and by label', () => {
        const runs = [
            run(1, [
                timing({ method: 'textDocument/hover', duration_ms: 10 }),
                timing({ method: 'textDocument/hover', label: 'in-class', duration_ms: 20 }),
                timing({ method: 'textDocument/completion', duration_ms: 30 }),
            ]),
        ];

        const report = buildReport(opts, runs, 123.456);
        const keys = Object.keys(report.summary).sort();

        expect(keys).toEqual(['textDocument/completion', 'textDocument/hover', 'textDocument/hover (in-class)']);
        expect(report.summary['textDocument/hover'].count).toBe(1);
        expect(report.summary['textDocument/hover (in-class)'].avg_ms).toBe(20);
    });

    it('aggregates the same method across multiple iterations', () => {
        const runs = [run(1, [timing({ duration_ms: 10 })]), run(2, [timing({ duration_ms: 30 })])];

        const report = buildReport(opts, runs, 100);
        expect(report.summary['textDocument/hover'].count).toBe(2);
        expect(report.summary['textDocument/hover'].avg_ms).toBe(20);
    });

    it('carries options through onto the report and rounds total duration', () => {
        const report = buildReport(opts, [], 999.98765);

        expect(report.server).toBe(opts.server);
        expect(report.workspace).toBe(opts.workspace);
        expect(report.script).toBe(opts.script);
        expect(report.iterations).toBe(opts.iterations);
        expect(report.warmup).toBe(opts.warmup);
        expect(report.restart_between_iterations).toBe(opts.restart);
        expect(report.total_duration_ms).toBe(999.988);
        expect(typeof report.timestamp).toBe('string');
        expect(report.runs).toEqual([]);
    });

    it('produces an empty iteration summary when there are no runs', () => {
        const report = buildReport(opts, [], 0);
        expect(report.iteration_summary).toEqual({
            avg_ms: 0,
            median_ms: 0,
            p95_ms: 0,
            min_ms: 0,
            max_ms: 0,
        });
        expect(report.summary).toEqual({});
    });

    it('summarizes iteration totals across runs', () => {
        const runs = [run(1, [timing({ duration_ms: 100 })]), run(2, [timing({ duration_ms: 300 })])];
        const report = buildReport(opts, runs, 400);
        expect(report.iteration_summary.avg_ms).toBe(200);
        expect(report.iteration_summary.min_ms).toBe(100);
        expect(report.iteration_summary.max_ms).toBe(300);
    });
    it('lists lifecycle methods first when they come from runs', () => {
        const runs = [
            run(1, [
                timing({ method: 'lifecycle/spawn', duration_ms: 5 }),
                timing({ method: 'textDocument/hover', duration_ms: 10 }),
                timing({ method: 'lifecycle/shutdown', duration_ms: 7 }),
            ]),
        ];
        const report = buildReport(opts, runs, 22);
        expect(Object.keys(report.summary)).toEqual(['lifecycle/spawn', 'lifecycle/shutdown', 'textDocument/hover']);
        expect(report.lifecycle).toBeUndefined();
    });

    it('includes keep alive lifecycle timings in the summary and on the report', () => {
        const lifecycle = [
            timing({ method: 'lifecycle/spawn', duration_ms: 5 }),
            timing({ method: 'lifecycle/initialize', duration_ms: 50 }),
        ];
        const runs = [run(1, [timing({ duration_ms: 10 })]), run(2, [timing({ duration_ms: 30 })])];
        const report = buildReport(opts, runs, 100, lifecycle);
        expect(Object.keys(report.summary)).toEqual(['lifecycle/spawn', 'lifecycle/initialize', 'textDocument/hover']);
        expect(report.summary['lifecycle/initialize']).toMatchObject({ count: 1, avg_ms: 50 });
        expect(report.lifecycle).toBe(lifecycle);
        // lifecycle timings stay out of the iteration totals
        expect(report.iteration_summary.avg_ms).toBe(20);
    });
});

describe('printSummary', () => {
    const opts: BenchOptions = {
        server: 'fake-language-server --stdio',
        workspace: '/tmp/ws',
        script: 'actions.ts',
        iterations: 1,
        warmup: 0,
        output: '',
        restart: false,
        verbose: false,
    };

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /** print a report over the given timings and return the table header line */
    function header(requests: RequestTiming[]): string {
        const lines: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
            lines.push(String(line ?? ''));
        });
        printSummary(buildReport(opts, [{ iteration: 1, requests, total_ms: 10 }], 10));
        for (const line of lines) {
            if (line.includes('Method')) {
                return line;
            }
        }
        return '';
    }

    it('describes the codes and signals of tolerated exits', () => {
        const lines: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
            lines.push(String(line ?? ''));
        });
        const report = buildReport(opts, [{ iteration: 1, requests: [timing()], total_ms: 10 }], 10);
        const exit = (code: number | null, signal: NodeJS.Signals | null) => ({
            during: 'final teardown',
            code,
            signal,
            reason: 'allowed',
        });
        report.tolerated_exits = [exit(null, 'SIGSEGV'), exit(null, 'SIGSEGV')];
        printSummary(report);
        report.tolerated_exits = [exit(2, null), exit(1, null), exit(null, 'SIGSEGV'), exit(null, 'SIGABRT')];
        printSummary(report);
        report.tolerated_exits = [exit(1, null)];
        printSummary(report);
        expect(lines.filter((line) => line.includes('Tolerated exits'))).toEqual([
            '  Tolerated exits: 2 (signal SIGSEGV after shutdown, allowed)',
            '  Tolerated exits: 4 (codes 1, 2, signals SIGABRT, SIGSEGV after shutdown, allowed)',
            '  Tolerated exits: 1 (code 1 after shutdown, allowed)',
        ]);
    });

    it('prints n/a for the latencies of a method where every wait timed out', () => {
        const lines: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
            lines.push(String(line ?? ''));
        });
        const requests = [
            timing(),
            timing({ method: 'diagnostics/open', duration_ms: 15000, success: false, result: 'timeout' }),
        ];
        printSummary(buildReport(opts, [{ iteration: 1, requests, total_ms: 10 }], 10));
        const row = lines.find((line) => line.trimStart().startsWith('diagnostics/open')) ?? '';
        expect(row.match(/n\/a/g)).toHaveLength(7);
        expect(row).toContain('100.0%');
        const hover = lines.find((line) => line.trimStart().startsWith('textDocument/hover')) ?? '';
        expect(hover).not.toContain('n/a');
    });

    it('notes pulls that first waited for a push, only when there are some', () => {
        const lines: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
            lines.push(String(line ?? ''));
        });
        const requests = [
            timing({ method: 'diagnostics/pull/open', duration_ms: 1004, grace_ms: 1000 }),
            timing({ method: 'diagnostics/pull/edit', duration_ms: 4 }),
        ];
        printSummary(buildReport(opts, [{ iteration: 1, requests, total_ms: 1010 }], 1010));
        expect(lines).toContain(
            '  diagnostics/pull/open: 1 pull first waited for a push (median 1000ms, included above)',
        );
        expect(lines.some((line) => line.includes('diagnostics/pull/edit:'))).toBe(false);
        expect(lines.some((line) => line.includes("mode: 'pull'"))).toBe(true);

        lines.length = 0;
        printSummary(buildReport(opts, [{ iteration: 1, requests: [timing()], total_ms: 10 }], 10));
        expect(lines.some((line) => line.includes('waited for a push'))).toBe(false);
    });

    it('notes held pulls and drops the pull mode hint when a busy server answered with placeholders', () => {
        const lines: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
            lines.push(String(line ?? ''));
        });
        const requests = [
            timing({ method: 'diagnostics/pull/open', duration_ms: 2800, grace_ms: 1000, held_pulls: 1 }),
            timing({ method: 'diagnostics/pull/open', duration_ms: 2900, held_pulls: 2 }),
        ];
        const report = buildReport(opts, [{ iteration: 1, requests, total_ms: 5700 }], 5700);
        expect(report.summary['diagnostics/pull/open']).toMatchObject({ graced: 1, held: 2 });
        printSummary(report);
        expect(lines).toContain(
            '  diagnostics/pull/open: 2 waits held back empty answers while the server was busy (included above)',
        );
        expect(lines.some((line) => line.includes("mode: 'pull'"))).toBe(false);
    });

    it('notes held publishes and drops the pull mode hint when a server published placeholders', () => {
        const lines: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
            lines.push(String(line ?? ''));
        });
        const requests = [
            timing({ method: 'diagnostics/open', duration_ms: 3000, held_publishes: 1, held_pulls: 1 }),
            timing({ method: 'diagnostics/pull/open', duration_ms: 2800, grace_ms: 1000, held_publishes: 1 }),
        ];
        const report = buildReport(opts, [{ iteration: 1, requests, total_ms: 5800 }], 5800);
        expect(report.summary['diagnostics/open']).toMatchObject({ held: 1, held_publishes: 1 });
        expect(report.summary['diagnostics/pull/open']).toMatchObject({ graced: 1, held_publishes: 1 });
        expect(report.summary['diagnostics/pull/open'].held).toBeUndefined();
        printSummary(report);
        expect(lines).toContain(
            '  diagnostics/open: 1 wait held back empty publishes until the server was quiescent (included above)',
        );
        expect(lines.some((line) => line.includes("mode: 'pull'"))).toBe(false);
    });

    it('notes waits that held an empty publish in the close window, without the pull mode hint', () => {
        const lines: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
            lines.push(String(line ?? ''));
        });
        const requests = [
            timing({ method: 'diagnostics/open', duration_ms: 56, close_window_ms: 940 }),
            timing({ method: 'diagnostics/open', duration_ms: 60, close_window_ms: 950 }),
            timing({ method: 'diagnostics/open', duration_ms: 58, close_window_ms: 930 }),
            timing({ method: 'diagnostics/edit', duration_ms: 4 }),
        ];
        const report = buildReport(opts, [{ iteration: 1, requests, total_ms: 2010 }], 2010);
        expect(report.summary['diagnostics/open']).toMatchObject({ close_windowed: 3, close_window_median_ms: 940 });
        printSummary(report);
        expect(lines).toContain(
            '  diagnostics/open: 3 waits held an empty publish in the close window (median 940ms, not included above)',
        );
        expect(lines.some((line) => line.includes('diagnostics/edit:'))).toBe(false);
        expect(lines.some((line) => line.includes("mode: 'pull'"))).toBe(false);
    });

    it('counts and notes shortened waits, and their share of the known timeout kinds', () => {
        const lines: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
            lines.push(String(line ?? ''));
        });
        const timeout = { duration_ms: 500, success: false, result: 'timeout' as const };
        const requests = [
            timing({ method: 'diagnostics/open', ...timeout, shortened: true }),
            timing({ method: 'diagnostics/open', ...timeout, shortened: true }),
            timing({ method: 'diagnostics/open', duration_ms: 3000, success: false, result: 'timeout' }),
            timing({ method: 'diagnostics/open', duration_ms: 40 }),
            timing({ method: 'diagnostics/edit', duration_ms: 4 }),
        ];
        const report = buildReport(opts, [{ iteration: 1, requests, total_ms: 4044 }], 4044);
        expect(report.summary['diagnostics/open']).toMatchObject({ shortened: 2, timeout_rate: 0.75, median_ms: 40 });
        expect(report.summary['diagnostics/edit']).not.toHaveProperty('shortened');
        report.silent_waits = { 'diagnostics/open': { waits: 5, longest_streak: 5, shortened: 2 } };
        report.until_rejected = { 'diagnostics/edit': { waits: 4, shortened: 1 } };
        report.reopen_waits = { 'diagnostics/open': { waits: 6, longest_streak: 6, shortened: 3 } };
        printSummary(report);
        expect(lines).toContain(
            '  diagnostics/open: 2 waits of a kind known to time out shortened by --shorten-silent-waits ' +
                '(counted as timeouts above)',
        );
        expect(lines.some((line) => line.includes('diagnostics/edit: 1 wait'))).toBe(false);
        expect(lines).toContain(
            '  diagnostics/open: the server did not publish in 5 waits (5 in a row, warmups included, 2 shortened), ' +
                'it may never publish for a clean document',
        );
        expect(lines).toContain(
            '  diagnostics/edit: 4 waits timed out after publishes that all failed until (warmups included, 1 shortened), ' +
                'the server may never report what until expects',
        );
        expect(lines).toContain(
            '  diagnostics/open: 6 reopen waits saw only the publishes clearing the close ' +
                '(6 in a row, warmups included, 3 shortened), the server may not republish a clean file on reopen',
        );
    });

    it('notes silent waits only when the report has them', () => {
        const lines: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
            lines.push(String(line ?? ''));
        });
        const requests = [timing({ method: 'diagnostics/open', duration_ms: 3000, success: false, result: 'timeout' })];
        const report = buildReport(opts, [{ iteration: 1, requests, total_ms: 3000 }], 3000);
        printSummary(report);
        expect(lines.some((line) => line.includes('did not publish'))).toBe(false);

        report.silent_waits = { 'diagnostics/open': { waits: 4, longest_streak: 4 } };
        printSummary(report);
        expect(lines).toContain(
            '  diagnostics/open: the server did not publish in 4 waits (4 in a row, warmups included), ' +
                'it may never publish for a clean document',
        );
    });

    it('notes waits failing until only when the report has them', () => {
        const lines: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
            lines.push(String(line ?? ''));
        });
        const requests = [timing({ method: 'diagnostics/edit', duration_ms: 3000, success: false, result: 'timeout' })];
        const report = buildReport(opts, [{ iteration: 1, requests, total_ms: 3000 }], 3000);
        printSummary(report);
        expect(lines.some((line) => line.includes('failed until'))).toBe(false);

        report.until_rejected = { 'diagnostics/edit': { waits: 5 } };
        printSummary(report);
        expect(lines).toContain(
            '  diagnostics/edit: 5 waits timed out after publishes that all failed until (warmups included), ' +
                'the server may never report what until expects',
        );
    });

    it('notes plaintext fallbacks, and adds them to the silent and until notes, only when the report has them', () => {
        const lines: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
            lines.push(String(line ?? ''));
        });
        const note = '  Some documents were opened as plaintext, and the server may not serve that language id';
        const requests = [timing({ method: 'diagnostics/open', duration_ms: 3000, success: false, result: 'timeout' })];
        const report = buildReport(opts, [{ iteration: 1, requests, total_ms: 3000 }], 3000);
        report.silent_waits = { 'diagnostics/open': { waits: 4, longest_streak: 4 } };
        report.until_rejected = { 'diagnostics/edit': { waits: 5 } };
        printSummary(report);
        expect(lines.some((line) => line.includes('plaintext'))).toBe(false);

        lines.length = 0;
        report.plaintext_fallbacks = ['', '.tf'];
        printSummary(report);
        expect(lines.filter((line) => line === note)).toHaveLength(2);
        expect(lines).toContain(
            '  Opened as plaintext: (no extension), .tf have no registered language id, ' +
                'register them with addRegisteredLanguage() or pass options.languageId to openDocument()',
        );

        lines.length = 0;
        report.silent_waits = undefined;
        report.until_rejected = undefined;
        printSummary(report);
        expect(lines.some((line) => line === note)).toBe(false);
        expect(lines.some((line) => line.startsWith('  Opened as plaintext: (no extension), .tf'))).toBe(true);
    });

    it('leaves out the null and empty columns when every result is ok', () => {
        expect(header([timing()])).not.toMatch(/Null%|Empty%/);
    });

    it('adds the null and empty columns when any method has such results', () => {
        expect(header([timing(), timing({ method: 'completionItem/resolve', result: 'null' })])).toMatch(
            /Fail%\s+Null%\s+Empty%/,
        );
    });

    it('adds the skip column only when some request was skipped', () => {
        expect(header([timing()])).not.toMatch(/Skip%/);
        expect(header([timing(), timing({ method: 'textDocument/definition', result: 'skipped' })])).toMatch(
            /Fail%\s+Skip%/,
        );
    });

    it('adds the timeout column only when some wait timed out', () => {
        expect(header([timing()])).not.toMatch(/Tmout%/);
        expect(header([timing(), timing({ method: 'diagnostics/open', result: 'timeout' })])).toMatch(/Fail%\s+Tmout%/);
    });
});

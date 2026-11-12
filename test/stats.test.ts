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

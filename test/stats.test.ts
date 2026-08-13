import type { BenchOptions, IterationResult, RequestTiming } from 'lsbench';
import { buildReport, computeMethodStats } from 'lsbench';
import { describe, expect, it } from 'vitest';

function timing(overrides: Partial<RequestTiming> = {}): RequestTiming {
    return {
        method: 'textDocument/hover',
        duration_ms: 10,
        success: true,
        ...overrides,
    };
}

describe('computeMethodStats', () => {
    it('returns all-zero stats for an empty set', () => {
        const stats = computeMethodStats([]);
        expect(stats).toEqual({
            count: 0,
            avg_ms: 0,
            median_ms: 0,
            p95_ms: 0,
            p99_ms: 0,
            min_ms: 0,
            max_ms: 0,
            stddev_ms: 0,
            failure_rate: 0,
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
            timing({ success: false, error: 'boom' }),
            timing({ success: false, error: 'boom' }),
        ];
        const stats = computeMethodStats(timings);
        expect(stats.count).toBe(3);
        // 2 of 3 failed
        expect(stats.failure_rate).toBeCloseTo(0.6667, 4);
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
});

import type { BenchReport, CheckedRun, MethodStats } from 'lsbench';
import {
    BASELINE_FORMAT,
    checkReport,
    createBaseline,
    formatCheckResult,
    RUN_METHOD,
    validateCheckedRun,
} from 'lsbench';
import { afterEach, describe, expect, it, vi } from 'vitest';

function stats(overrides: Partial<MethodStats> = {}): MethodStats {
    return {
        count: 10,
        avg_ms: 100,
        median_ms: 100,
        p95_ms: 120,
        p99_ms: 120,
        min_ms: 90,
        max_ms: 120,
        stddev_ms: 5,
        failure_rate: 0,
        null_rate: 0,
        empty_rate: 0,
        timeout_rate: 0,
        skipped: 0,
        skip_rate: 0,
        ...overrides,
    };
}

function run(summary: Record<string, MethodStats>, overrides: Partial<CheckedRun> = {}): CheckedRun {
    return { iterations: 10, warmup: 1, restart_between_iterations: false, summary, ...overrides };
}

function report(): BenchReport {
    return {
        server: 'gopls serve',
        workspace: 'fixtures/go',
        script: 'driver.ts',
        iterations: 10,
        warmup: 1,
        restart_between_iterations: true,
        timestamp: '2026-11-13T09:06:50.191Z',
        total_duration_ms: 2053,
        summary: { 'diagnostics/open': stats() },
        iteration_summary: { avg_ms: 155, median_ms: 152, p95_ms: 162, min_ms: 149, max_ms: 162 },
        runs: [{ iteration: 1, requests: [], total_ms: 150 }],
        lifecycle: [],
    };
}

describe('createBaseline', () => {
    it('keeps settings and summaries, drops runs and run metadata', () => {
        const r = report();
        expect(createBaseline(r)).toEqual({
            lsbench_baseline: BASELINE_FORMAT,
            iterations: 10,
            warmup: 1,
            restart_between_iterations: true,
            summary: r.summary,
            iteration_summary: r.iteration_summary,
        });
    });

    it('produces a baseline that passes against its own report', () => {
        const r = report();
        expect(checkReport(r, createBaseline(r))).toEqual({ pass: true, failures: [] });
    });
});

describe('checkReport', () => {
    it('passes identical runs', () => {
        const base = run({ 'textDocument/hover': stats() });
        expect(checkReport(base, base).pass).toBe(true);
    });

    describe('methods', () => {
        it('fails a method missing from the report', () => {
            const result = checkReport(run({}), run({ 'diagnostics/open': stats() }));
            expect(result.failures).toEqual([
                {
                    method: 'diagnostics/open',
                    field: 'method',
                    baseline: 'present',
                    actual: 'missing',
                    rule: 'method missing',
                },
            ]);
        });

        it('fails a method added to the report', () => {
            const result = checkReport(run({ 'diagnostics/pull/open': stats() }), run({}));
            expect(result.failures).toEqual([
                {
                    method: 'diagnostics/pull/open',
                    field: 'method',
                    baseline: 'missing',
                    actual: 'present',
                    rule: 'method added',
                },
            ]);
        });

        it('catches a delivery change through the method names', () => {
            const result = checkReport(run({ 'diagnostics/pull/open': stats() }), run({ 'diagnostics/open': stats() }));
            expect(result.failures.map((f) => f.rule)).toEqual(['method missing', 'method added']);
        });

        it('fails an added method named like an Object.prototype member', () => {
            const result = checkReport(run({ m: stats(), toString: stats() }), run({ m: stats() }));
            expect(result.failures.map((f) => [f.method, f.rule])).toEqual([['toString', 'method added']]);
        });

        it('fails a missing method named like an Object.prototype member', () => {
            const result = checkReport(run({ m: stats() }), run({ m: stats(), constructor: stats() }));
            expect(result.failures.map((f) => [f.method, f.rule])).toEqual([['constructor', 'method missing']]);
        });
    });

    describe('rates', () => {
        for (const field of ['timeout_rate', 'skip_rate', 'empty_rate', 'null_rate', 'failure_rate'] as const) {
            it(`fails ${field} beyond the tolerance`, () => {
                const result = checkReport(run({ m: stats({ [field]: 0.3 }) }), run({ m: stats() }));
                expect(result.failures).toEqual([
                    { method: 'm', field, baseline: 0, actual: 0.3, rule: '|diff| > 0.1' },
                ]);
            });

            it(`passes ${field} within the tolerance, the boundary included`, () => {
                expect(checkReport(run({ m: stats({ [field]: 0.1 }) }), run({ m: stats() })).pass).toBe(true);
                expect(checkReport(run({ m: stats({ [field]: 0.2 }) }), run({ m: stats({ [field]: 0.3 }) })).pass).toBe(
                    true,
                );
            });
        }

        it('fails a drop as well as a rise', () => {
            const result = checkReport(run({ m: stats({ empty_rate: 0 }) }), run({ m: stats({ empty_rate: 1 }) }));
            expect(result.failures[0]).toMatchObject({ field: 'empty_rate', baseline: 1, actual: 0 });
        });

        it('honors a custom tolerance', () => {
            const actual = run({ m: stats({ failure_rate: 0.3 }) });
            const base = run({ m: stats() });
            expect(checkReport(actual, base, { rateTolerance: 0.5 }).pass).toBe(true);
            expect(checkReport(actual, base, { rateTolerance: 0.2 }).failures[0].rule).toBe('|diff| > 0.2');
        });
    });

    describe('median_ms', () => {
        const base = run({ m: stats({ median_ms: 100 }) });

        it('passes within [base / 2 - 5, base * 2 + 5], the bounds included', () => {
            for (const median of [45, 100, 205]) {
                expect(checkReport(run({ m: stats({ median_ms: median }) }), base).pass).toBe(true);
            }
        });

        it('fails above the upper bound', () => {
            const result = checkReport(run({ m: stats({ median_ms: 205.1 }) }), base);
            expect(result.failures).toEqual([
                { method: 'm', field: 'median_ms', baseline: 100, actual: 205.1, rule: 'outside [45, 205]' },
            ]);
        });

        it('fails below the lower bound', () => {
            const result = checkReport(run({ m: stats({ median_ms: 44.9 }) }), base);
            expect(result.failures[0]).toMatchObject({ field: 'median_ms', rule: 'outside [45, 205]' });
        });

        it('lets the slack absorb noise of fast methods', () => {
            const fast = run({ m: stats({ median_ms: 0.4 }) });
            expect(checkReport(run({ m: stats({ median_ms: 5 }) }), fast).pass).toBe(true);
            expect(checkReport(run({ m: stats({ median_ms: 6 }) }), fast).pass).toBe(false);
        });

        it('clamps the lower bound at 0', () => {
            const fast = run({ m: stats({ median_ms: 0.4 }) });
            expect(checkReport(run({ m: stats({ median_ms: 6 }) }), fast).failures[0].rule).toBe('outside [0, 5.8]');
        });

        it('honors a custom ratio and slack', () => {
            const actual = run({ m: stats({ median_ms: 140 }) });
            expect(checkReport(actual, base, { medianRatio: 1.5, slackMs: 0 }).pass).toBe(true);
            expect(checkReport(actual, base, { medianRatio: 1.2, slackMs: 0 }).failures[0].rule).toBe(
                'outside [83.333, 120]',
            );
        });

        it('requires a null median to stay null', () => {
            const nullBase = run({ m: stats({ median_ms: null }) });
            expect(checkReport(nullBase, nullBase).pass).toBe(true);
            expect(checkReport(run({ m: stats({ median_ms: 10 }) }), nullBase).failures).toEqual([
                { method: 'm', field: 'median_ms', baseline: null, actual: 10, rule: 'must stay null' },
            ]);
        });

        it('fails a median that became null', () => {
            const result = checkReport(run({ m: stats({ median_ms: null }) }), base);
            expect(result.failures).toEqual([
                { method: 'm', field: 'median_ms', baseline: 100, actual: null, rule: 'must not be null' },
            ]);
        });
    });

    describe('min count', () => {
        const base = run({ m: stats({ median_ms: 100 }) });
        const slow = stats({ median_ms: 300 });

        it('skips the median when the report count is below the minimum', () => {
            expect(checkReport(run({ m: { ...slow, count: 2 } }), base).pass).toBe(true);
        });

        it('skips the median when the baseline count is below the minimum', () => {
            const single = run({ m: stats({ median_ms: 0.84, count: 1 }) });
            expect(checkReport(run({ m: stats({ median_ms: 7.2 }) }), single).pass).toBe(true);
        });

        it('compares the median at the minimum', () => {
            const result = checkReport(
                run({ m: { ...slow, count: 3 } }),
                run({ m: stats({ median_ms: 100, count: 3 }) }),
            );
            expect(result.failures).toEqual([
                { method: 'm', field: 'median_ms', baseline: 100, actual: 300, rule: 'outside [45, 205]' },
            ]);
        });

        it('still checks rates of a single sample', () => {
            const result = checkReport(
                run({ m: stats({ count: 1, median_ms: 300, timeout_rate: 1 }) }),
                run({ m: stats({ count: 1 }) }),
            );
            expect(result.failures.map((f) => f.field)).toEqual(['timeout_rate']);
        });

        it('compares every median with a minimum of 1', () => {
            const result = checkReport(run({ m: { ...slow, count: 1 } }), run({ m: stats({ count: 1 }) }), {
                minCount: 1,
            });
            expect(result.failures[0]).toMatchObject({ field: 'median_ms', baseline: 100, actual: 300 });
        });
    });

    describe('run settings', () => {
        it.each([
            ['iterations', 20],
            ['warmup', 3],
            ['restart_between_iterations', true],
        ] as const)('fails a mismatched %s', (field, value) => {
            const result = checkReport(run({}, { [field]: value }), run({}));
            expect(result.failures).toEqual([
                {
                    method: RUN_METHOD,
                    field,
                    baseline: run({})[field],
                    actual: value,
                    rule: 'setting must match',
                },
            ]);
        });
    });

    describe('failed iterations', () => {
        it('fails a report with failed iterations', () => {
            const result = checkReport(run({}, { iteration_summary: { failed: 2 } }), run({}));
            expect(result.failures).toEqual([
                {
                    method: RUN_METHOD,
                    field: 'failed_iterations',
                    baseline: 0,
                    actual: 2,
                    rule: 'iterations must not fail',
                },
            ]);
        });

        it('fails even when the baseline had failed iterations too', () => {
            const failing = run({}, { iteration_summary: { failed: 1 } });
            expect(checkReport(failing, failing).failures).toMatchObject([
                { field: 'failed_iterations', baseline: 1, actual: 1 },
            ]);
        });

        it('passes a report without failed iterations against a baseline with some', () => {
            expect(
                checkReport(run({}, { iteration_summary: {} }), run({}, { iteration_summary: { failed: 1 } })).pass,
            ).toBe(true);
        });
    });

    it('collects every failure at once', () => {
        const result = checkReport(
            run({ m: stats({ median_ms: 500, timeout_rate: 1 }) }, { warmup: 0 }),
            run({ m: stats(), gone: stats() }),
        );
        expect(result.pass).toBe(false);
        expect(result.failures.map((f) => `${f.method} ${f.field}`)).toEqual([
            `${RUN_METHOD} warmup`,
            'm timeout_rate',
            'm median_ms',
            'gone method',
        ]);
    });
});

describe('validateCheckedRun', () => {
    it('accepts reports and baselines', () => {
        const r = report();
        expect(validateCheckedRun(r)).toBeUndefined();
        expect(validateCheckedRun(createBaseline(r))).toBeUndefined();
        expect(validateCheckedRun(run({ m: stats({ median_ms: null }) }))).toBeUndefined();
    });

    it('rejects values missing checked fields', () => {
        expect(validateCheckedRun([])).toBe('expected a JSON object');
        expect(validateCheckedRun({ ...run({}), iterations: '10' })).toMatch(/iterations/);
        expect(validateCheckedRun({ ...run({}), restart_between_iterations: 1 })).toMatch(/restart/);
        expect(validateCheckedRun({ ...run({}), summary: null })).toMatch(/summary/);
        expect(validateCheckedRun(run({ m: { ...stats(), skip_rate: undefined } as unknown as MethodStats }))).toBe(
            'summary of m has no numeric skip_rate',
        );
        expect(validateCheckedRun(run({ m: { ...stats(), median_ms: '1' } as unknown as MethodStats }))).toBe(
            'summary of m has no median_ms',
        );
        expect(validateCheckedRun(run({ m: { ...stats(), count: '1' } as unknown as MethodStats }))).toBe(
            'summary of m has no numeric count',
        );
        expect(validateCheckedRun({ ...run({}), iteration_summary: { failed: '1' } })).toBe(
            'iteration_summary has a non numeric failed',
        );
    });

    it('accepts a baseline of the current format and a report without one', () => {
        expect(validateCheckedRun(run({}))).toBeUndefined();
        expect(validateCheckedRun({ ...run({}), lsbench_baseline: BASELINE_FORMAT })).toBeUndefined();
    });

    it('rejects an unsupported baseline format', () => {
        expect(validateCheckedRun({ ...run({}), lsbench_baseline: 2 })).toBe(
            `unsupported baseline format 2 (supported: ${BASELINE_FORMAT})`,
        );
        expect(validateCheckedRun({ ...run({}), lsbench_baseline: String(BASELINE_FORMAT) })).toBe(
            `unsupported baseline format "${BASELINE_FORMAT}" (supported: ${BASELINE_FORMAT})`,
        );
        expect(validateCheckedRun({ ...run({}), lsbench_baseline: null })).toBe(
            `unsupported baseline format null (supported: ${BASELINE_FORMAT})`,
        );
    });

    it('reports an unsupported format before missing fields', () => {
        expect(validateCheckedRun({ lsbench_baseline: 2 })).toMatch(/unsupported baseline format 2/);
    });
});

describe('formatCheckResult', () => {
    it('prints a pass line', () => {
        expect(formatCheckResult({ pass: true, failures: [] })).toBe('PASS: no regressions against the baseline');
    });

    it('prints an aligned table of the failures', () => {
        const text = formatCheckResult(checkReport(run({ m: stats({ median_ms: 300.12345 }) }), run({ m: stats() })));
        expect(text).toBe(
            [
                'FAIL: 1 regression against the baseline',
                '',
                'method  field      baseline  actual   rule',
                '------  ---------  --------  -------  -----------------',
                'm       median_ms  100       300.123  outside [45, 205]',
            ].join('\n'),
        );
    });

    it('counts several regressions in the headline', () => {
        const result = checkReport(run({ a: stats(), b: stats() }), run({}));
        expect(formatCheckResult(result)).toMatch(/^FAIL: 2 regressions against the baseline\n/);
    });

    describe('with color', () => {
        afterEach(() => {
            vi.unstubAllEnvs();
        });

        it('styles the verdict and header', () => {
            vi.stubEnv('FORCE_COLOR', '1');
            expect(formatCheckResult({ pass: true, failures: [] }, { color: true })).toBe(
                '\x1b[1m\x1b[32mPASS:\x1b[39m\x1b[22m no regressions against the baseline',
            );
            const text = formatCheckResult(checkReport(run({ m: stats({ median_ms: 300 }) }), run({ m: stats() })), {
                color: true,
            });
            const lines = text.split('\n');
            expect(lines[0]).toBe('\x1b[1m\x1b[31mFAIL:\x1b[39m\x1b[22m 1 regression against the baseline');
            expect(lines[2]).toBe('\x1b[1mmethod  field      baseline  actual  rule\x1b[22m');
            expect(lines[4]).not.toContain('\x1b[');
        });

        it('stays plain without the color option', () => {
            vi.stubEnv('FORCE_COLOR', '1');
            expect(formatCheckResult({ pass: true, failures: [] })).toBe('PASS: no regressions against the baseline');
        });

        it('stays plain with NO_COLOR', () => {
            vi.stubEnv('FORCE_COLOR', undefined);
            vi.stubEnv('NO_COLOR', '1');
            expect(formatCheckResult({ pass: true, failures: [] }, { color: true })).toBe(
                'PASS: no regressions against the baseline',
            );
        });
    });
});

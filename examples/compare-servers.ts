/**
 * Example: comparing two language servers programmatically.
 *
 * Instead of the `lsbench` CLI, you can import `runBenchmark` from the package
 * and drive benchmarks from your own script. This is handy for A/B comparisons.
 * You can run the same action script and workspace against two servers, then diff the
 * resulting per-method statistics.
 *
 * Here we compare `typescript-language-server` against `vtsls`. These are two language servers
 * that work with TypeScript.
 * This assumes both these language servers are installed an accessible.
 *
 * Run it directly with Node (>= 24), which strips TypeScript on load:
 *
 *   node examples/compare-servers.ts
 *
 * Adjust WORKSPACE, SCRIPT, and the SERVERS list for your own setup as needed.
 */

import type { BenchReport } from 'lsbench';
import { runBenchmark } from 'lsbench';

const WORKSPACE = './my-ts-project';
const SCRIPT = './examples/typescript-actions.ts';
const ITERATIONS = 30;

// the servers to compare — each entry is a label plus its spawn command
const SERVERS: { label: string; command: string }[] = [
    { label: 'tsls', command: 'typescript-language-server --stdio' },
    { label: 'vtsls', command: 'vtsls --stdio' },
];

async function main() {
    const reports = new Map<string, BenchReport>();

    // run each server through the identical benchmark
    for (const { label, command } of SERVERS) {
        const report = await runBenchmark({
            server: command,
            workspace: WORKSPACE,
            script: SCRIPT,
            iterations: ITERATIONS,
            warmup: 5,
            output: '', // post-process in memory rather than writing files
            restart: false,
            verbose: false,
        });
        reports.set(label, report);
    }

    // collect every method that appeared in any report, then compare medians
    const methods = new Set<string>();
    for (const report of reports.values()) {
        for (const method of Object.keys(report.summary)) {
            methods.add(method);
        }
    }

    console.log(`\n  Median latency by method (${ITERATIONS} iterations)\n`);
    const [a, b] = SERVERS.map((s) => s.label);
    console.log(`  ${'method'.padEnd(32)} ${a.padStart(10)} ${b.padStart(10)}   delta`);

    for (const method of [...methods].sort()) {
        const medianA = reports.get(a)?.summary[method]?.median_ms;
        const medianB = reports.get(b)?.summary[method]?.median_ms;

        const cellA = medianA === undefined ? '—' : medianA.toFixed(1);
        const cellB = medianB === undefined ? '—' : medianB.toFixed(1);

        // percentage change from a -> b, when both servers reported the method
        let delta = '';
        if (medianA !== undefined && medianB !== undefined && medianA > 0) {
            const pct = ((medianB - medianA) / medianA) * 100;
            const sign = pct >= 0 ? '+' : '';
            delta = `${sign}${pct.toFixed(0)}%`;
        }

        console.log(`  ${method.padEnd(32)} ${cellA.padStart(10)} ${cellB.padStart(10)}   ${delta}`);
    }
    console.log();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

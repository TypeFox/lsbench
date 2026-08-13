import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BenchContextImpl } from './context.js';
import { LspHarness } from './harness.js';
import { buildReport, printSummary } from './stats.js';
import type { ActionScript, BenchOptions, BenchReport, IterationResult, ServerConfig } from './types.js';

/**
 * Resolve a server config from the CLI --server command string.
 * The argument is always a plain command like "typescript-language-server --stdio";
 * structured options (initializationOptions) are supplied separately via CLI flags.
 */
export function resolveServerConfig(
    serverArg: string,
    extraArgs?: string[],
    initializationOptions?: unknown,
): ServerConfig {
    const parts = serverArg.split(/\s+/).filter(Boolean);
    const command = parts[0];
    const args = [...parts.slice(1), ...(extraArgs ?? [])];

    return { command, args, initializationOptions };
}

/**
 * Load the user's action script.
 * Action scripts are TypeScript ESM modules loaded natively by Node's built-in
 * type stripping (Node >= 24). They must be "erasable" TypeScript — no runtime
 * TS features like enum, namespace, or parameter properties.
 */
export async function loadActionScript(scriptPath: string): Promise<ActionScript> {
    const absPath = path.resolve(scriptPath);

    if (!absPath.endsWith('.ts')) {
        throw new Error(`Action script ${scriptPath} must be a TypeScript (.ts) file.`);
    }

    const mod = await import(pathToFileURL(absPath).href);
    const fn: ActionScript = mod.default;

    if (typeof fn !== 'function') {
        throw new Error(`Action script ${scriptPath} must have a default-exported function.`);
    }

    return fn;
}

/**
 * Main benchmark runner.
 */
export async function runBenchmark(opts: BenchOptions): Promise<BenchReport> {
    const workspaceRoot = path.resolve(opts.workspace);
    const serverConfig = resolveServerConfig(opts.server, opts.serverArgs, opts.initializationOptions);
    const actionFn = await loadActionScript(opts.script);

    const totalIterations = opts.warmup + opts.iterations;
    const runs: IterationResult[] = [];

    console.log(`\n  Server:     ${opts.server}`);
    console.log(`  Workspace:  ${workspaceRoot}`);
    console.log(`  Script:     ${opts.script}`);
    console.log(`  Iterations: ${opts.iterations} (+ ${opts.warmup} warmup)`);
    console.log(`  Restart:    ${opts.restart ? 'each iteration' : 'keep alive'}`);
    console.log();

    const benchStart = process.hrtime.bigint();

    let harness: LspHarness | null = null;
    let ctx: BenchContextImpl | null = null;

    // Start server if we're keeping it alive across iterations
    if (!opts.restart) {
        harness = new LspHarness(serverConfig, workspaceRoot, opts.verbose);
        await harness.start();
        ctx = new BenchContextImpl(harness, workspaceRoot, opts.verbose);
    }

    for (let i = 0; i < totalIterations; i++) {
        const isWarmup = i < opts.warmup;
        const iterNum = isWarmup ? `warmup ${i + 1}/${opts.warmup}` : `${i - opts.warmup + 1}/${opts.iterations}`;

        process.stdout.write(`  Running iteration ${iterNum}...`);

        const iterStart = process.hrtime.bigint();

        // If restarting, create fresh harness each time (inside timed section
        // so cold-start benchmarks capture server spawn + initialize time)
        if (opts.restart) {
            harness = new LspHarness(serverConfig, workspaceRoot, opts.verbose);
            await harness.start();
            ctx = new BenchContextImpl(harness, workspaceRoot, opts.verbose);
        }

        try {
            await actionFn(ctx!);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(` ERROR: ${msg}`);
            if (opts.verbose && err instanceof Error) {
                console.error(err.stack);
            }
        }

        const iterEnd = process.hrtime.bigint();
        const iterMs = Number(iterEnd - iterStart) / 1_000_000;

        // Collect timings
        // biome-ignore lint/style/noNonNullAssertion: ctx is always set at this point
        const timings = ctx!.collectTimings();

        if (!isWarmup) {
            runs.push({
                iteration: i - opts.warmup + 1,
                requests: timings,
                total_ms: Math.round(iterMs * 1000) / 1000,
            });
        }

        console.log(` ${iterMs.toFixed(0)}ms${isWarmup ? ' (warmup)' : ''}`);

        // Reset document state between iterations (if not restarting)
        if (!opts.restart) {
            await ctx?.resetDocuments();
        }

        // If restarting, stop the server
        if (opts.restart && harness) {
            await harness.stop();
            harness = null;
            ctx = null;
        }
    }

    // Stop the persistent server
    if (!opts.restart && harness) {
        await harness.stop();
    }

    const benchEnd = process.hrtime.bigint();
    const totalMs = Number(benchEnd - benchStart) / 1_000_000;

    const report = buildReport(opts, runs, totalMs);
    printSummary(report);

    return report;
}

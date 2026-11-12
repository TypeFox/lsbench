import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { summarizeSupport } from './capabilities.js';
import { BenchContextImpl } from './context.js';
import { LspHarness } from './harness.js';
import { buildReport, printSummary, summarizeMethods } from './stats.js';
import type {
    AbnormalExit,
    ActionScript,
    BenchOptions,
    BenchReport,
    IterationResult,
    RequestTiming,
    ServerConfig,
} from './types.js';

/**
 * Resolve a server config from the CLI --server command string.
 * The argument is always a plain command like "typescript-language-server --stdio";
 * structured options (initializationOptions, clientCapabilities, settings) are supplied separately via CLI flags.
 */
export function resolveServerConfig(
    serverArg: string,
    extraArgs?: string[],
    initializationOptions?: unknown,
    clientCapabilities?: Record<string, unknown>,
    settings?: Record<string, unknown>,
    allowExitCodes?: number[],
): ServerConfig {
    const parts = serverArg.split(/\s+/).filter(Boolean);
    const command = parts[0];
    const args = [...parts.slice(1), ...(extraArgs ?? [])];

    const config: ServerConfig = { command, args, initializationOptions, clientCapabilities, settings };
    if (allowExitCodes && allowExitCodes.length > 0) {
        config.allowExitCodes = allowExitCodes;
    }
    return config;
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
    const serverConfig = resolveServerConfig(
        opts.server,
        opts.serverArgs,
        opts.initializationOptions,
        opts.clientCapabilities,
        opts.settings,
        opts.allowExitCodes,
    );
    const actionFn = await loadActionScript(opts.script);

    const totalIterations = opts.warmup + opts.iterations;
    const runs: IterationResult[] = [];

    console.log(`\n  Server:     ${opts.server}`);
    console.log(`  Workspace:  ${workspaceRoot}`);
    console.log(`  Script:     ${opts.script}`);
    console.log(`  Iterations: ${opts.iterations} (+ ${opts.warmup} warmup)`);
    console.log(`  Restart:    ${opts.restart ? 'each iteration' : 'keep alive'}`);
    if (opts.waitIdle !== undefined) {
        console.log(`  Wait idle:  up to ${opts.waitIdle}ms after initialized`);
    }
    if (serverConfig.allowExitCodes) {
        console.log(`  Allow exit: ${serverConfig.allowExitCodes.join(', ')} after shutdown`);
    }
    if (opts.serverLog) {
        console.log(`  Server log: ${path.resolve(opts.serverLog)}`);
    }
    console.log();

    const benchStart = process.hrtime.bigint();

    // tear down a harness, recording an abnormal exit or failed teardown instead of throwing
    const abnormalExits: AbnormalExit[] = [];
    const recordAbnormal = (exit: AbnormalExit) => {
        abnormalExits.push(exit);
        console.error(`  Warning: server ${exit.reason} during ${exit.during}`);
    };
    // exits with an allowed code after a replied shutdown, kept apart so they do not fail the run
    const toleratedExits: AbnormalExit[] = [];
    const teardown = async (h: LspHarness, during: string) => {
        try {
            const exit = await h.stop(opts.shutdownTimeout);
            if (exit?.tolerated) {
                toleratedExits.push({ during, code: exit.code, signal: exit.signal, reason: exit.reason });
            }
            if (exit?.abnormal) {
                recordAbnormal({ during, code: exit.code, signal: exit.signal, reason: exit.reason });
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            recordAbnormal({ during, code: null, signal: null, reason: `teardown failed: ${msg}` });
        }
    };

    // with restart, an exit seen while stopping an iteration's server happened at shutdown,
    // after the iteration's work, while one seen before stopping happened during the iteration
    const restartTeardownLabel = (h: LspHarness, during: string) => (h.exit ? during : `teardown of ${during}`);

    let harness: LspHarness | null = null;
    let ctx: BenchContextImpl | null = null;
    // keep alive spawn, initialize, idle and final shutdown timings, which belong to no iteration
    const harnessOptions = { serverLog: opts.serverLog };
    const ctxOptions = { contentModifiedRetries: opts.contentModifiedRetries, skipUnsupported: opts.skipUnsupported };
    let lifecycle: RequestTiming[] | undefined;
    // in verbose mode, summarize capabilities once, after the first server is up
    let capabilitiesLogged = !opts.verbose;
    const logCapabilities = (h: LspHarness) => {
        if (capabilitiesLogged) {
            return;
        }
        capabilitiesLogged = true;
        printCapabilitySummary(h, opts.skipUnsupported ?? true);
    };

    // Start server if we're keeping it alive across iterations
    if (!opts.restart) {
        harness = new LspHarness(serverConfig, workspaceRoot, opts.verbose, harnessOptions);
        await harness.start();
        await waitIdleAfterStart(harness, opts.waitIdle);
        lifecycle = harness.takeLifecycleTimings();
        logCapabilities(harness);
        ctx = new BenchContextImpl(harness, workspaceRoot, opts.verbose, ctxOptions);
    }

    for (let i = 0; i < totalIterations; i++) {
        const isWarmup = i < opts.warmup;
        const iterNum = isWarmup ? `warmup ${i + 1}/${opts.warmup}` : `${i - opts.warmup + 1}/${opts.iterations}`;
        const during = isWarmup ? `warmup ${i + 1}` : `iteration ${i - opts.warmup + 1}`;

        // verbose ctx and server lines follow, so end the progress line there and print the
        // time on its own line below them, otherwise append the time to the progress line
        process.stdout.write(`  Running iteration ${iterNum}...${opts.verbose ? '\n' : ''}`);

        const iterStart = process.hrtime.bigint();
        // with restart, this iteration's spawn and initialize timings
        let startTimings: RequestTiming[] = [];

        // If restarting, create fresh harness each time (inside timed section
        // so cold-start benchmarks capture server spawn + initialize time)
        if (opts.restart) {
            harness = new LspHarness(serverConfig, workspaceRoot, opts.verbose, harnessOptions);
            ctx = new BenchContextImpl(harness, workspaceRoot, opts.verbose, ctxOptions);
            try {
                await harness.start();
                await waitIdleAfterStart(harness, opts.waitIdle);
                startTimings = harness.takeLifecycleTimings();
                logCapabilities(harness);
            } catch (err: unknown) {
                // without collected runs there is nothing to keep, so fail as before
                if (runs.length === 0) {
                    throw err;
                }
                const msg = err instanceof Error ? err.message : String(err);
                console.log(`${opts.verbose ? '  ' : ' '}ERROR: ${msg}`);
                const exit = harness.exit;
                recordAbnormal({
                    during,
                    code: exit?.code ?? null,
                    signal: exit?.signal ?? null,
                    reason: `failed to start: ${msg.split('\n')[0]}`,
                });
                await teardown(harness, restartTeardownLabel(harness, during));
                harness = null;
                break;
            }
        }

        try {
            await actionFn(ctx!);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`${opts.verbose ? '  ' : ' '}ERROR: ${msg}`);
            if (opts.verbose && err instanceof Error) {
                console.error(err.stack);
            }
        }

        const iterEnd = process.hrtime.bigint();
        const iterMs = Number(iterEnd - iterStart) / 1_000_000;

        // Collect timings
        // biome-ignore lint/style/noNonNullAssertion: ctx is always set at this point
        const timings = ctx!.collectTimings();

        let run: IterationResult | null = null;
        if (!isWarmup) {
            run = {
                iteration: i - opts.warmup + 1,
                requests: [...startTimings, ...timings],
                total_ms: Math.round(iterMs * 1000) / 1000,
            };
            runs.push(run);
        }

        const iterTime = `${iterMs.toFixed(0)}ms${isWarmup ? ' (warmup)' : ''}`;
        console.log(opts.verbose ? `  Iteration ${iterNum}: ${iterTime}` : ` ${iterTime}`);

        // Reset document state between iterations (if not restarting)
        if (!opts.restart) {
            await ctx?.resetDocuments();
        }

        // If restarting, stop the server, keeping collected runs if teardown fails.
        // shutdown falls outside total_ms but is still attributed to this run
        if (opts.restart && harness) {
            await teardown(harness, restartTeardownLabel(harness, during));
            run?.requests.push(...harness.takeLifecycleTimings());
            harness = null;
            ctx = null;
        }
    }

    const benchEnd = process.hrtime.bigint();
    const totalMs = Number(benchEnd - benchStart) / 1_000_000;

    // build and write the report before the final teardown, so a server
    // crashing at shutdown cannot lose the collected runs
    const report = buildReport(opts, runs, totalMs, lifecycle);
    const addExits = () => {
        if (abnormalExits.length > 0) {
            report.abnormal_exits = abnormalExits;
        }
        if (toleratedExits.length > 0) {
            report.tolerated_exits = toleratedExits;
        }
    };
    addExits();
    if (opts.output) {
        writeReport(report, opts.output);
    }

    // stop the persistent server, then rewrite the report with the shutdown
    // timing and any abnormal or tolerated exit
    if (!opts.restart && harness && lifecycle) {
        await teardown(harness, 'final teardown');
        lifecycle.push(...harness.takeLifecycleTimings());
        report.summary = summarizeMethods(runs, lifecycle);
        addExits();
        if (opts.output) {
            writeReport(report, opts.output);
        }
    }

    printSummary(report);

    if (opts.output) {
        console.log(`  Report written to: ${path.resolve(opts.output)}\n`);
    }

    return report;
}

/** With --wait-idle, wait for a freshly started server to become idle, recorded as lifecycle/idle */
async function waitIdleAfterStart(harness: LspHarness, timeoutMs: number | undefined): Promise<void> {
    if (timeoutMs === undefined) {
        return;
    }
    const result = await harness.waitForIdleAfterStart({ timeoutMs });
    if (result.timedOut) {
        console.error(`  Warning: server not idle after ${timeoutMs}ms`);
    }
}

/** Print which context request methods the server supports statically, dynamic registrations are logged as they arrive */
function printCapabilitySummary(harness: LspHarness, skipUnsupported: boolean): void {
    const { supported, unsupported } = summarizeSupport(harness.capabilities, harness.registrations);
    console.error(
        `[lsbench] Server supports ${supported.length} of ${supported.length + unsupported.length} mapped requests`,
    );
    if (unsupported.length > 0) {
        const action = skipUnsupported ? 'skipped' : 'sent anyway (--no-skip-unsupported)';
        console.error(`[lsbench] Unsupported, ${action} unless registered later: ${unsupported.join(', ')}`);
    }
}

/** Write a report as JSON to the given path */
function writeReport(report: BenchReport, output: string): void {
    fs.writeFileSync(path.resolve(output), JSON.stringify(report, null, 2));
}

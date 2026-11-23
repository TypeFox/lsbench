import * as fs from 'node:fs';
import * as os from 'node:os';
import { Command } from 'commander';
import {
    type CheckedRun,
    checkReport,
    createBaseline,
    DEFAULT_CHECK_OPTIONS,
    formatCheckResult,
    validateCheckedRun,
} from './check.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from './context.js';
import { getPrimer } from './primer.js';
import { actionScriptExtensionError, isActionScriptPath, runBenchmark } from './runner.js';
import type { BenchOptions, BenchReport } from './types.js';
import { CLI_VERSION } from './version.js';

/** idle wait timeout of --wait-idle without a value */
export const DEFAULT_WAIT_IDLE_MS = 30000;
export const DEFAULT_SHORTEN_SILENT_WAITS_MS = 500;

export function createProgram(): Command {
    const program = new Command();

    program
        .name('lsbench')
        .description(
            'Benchmark language servers with scripted LSP actions.\n\n' +
                'Examples:\n' +
                '  lsbench "typescript-language-server --stdio" \\\n' +
                '    --workspace ./my-project \\\n' +
                '    --script ./bench-actions.ts \\\n' +
                '    --iterations 50\n\n' +
                '  lsbench "typescript-language-server --stdio" \\\n' +
                '    -w ./workspace -s ./actions.ts -n 100 -o results.json \\\n' +
                '    --init-options-file ./init-options.json',
        )
        .version(CLI_VERSION);

    // The benchmark itself is the default command, so `lsbench "<server>" ...` still
    // works while leaving room for sibling subcommands like `prime`.
    program
        .command('run', { isDefault: true })
        .description('Run a benchmark against a language server (default command).')
        .allowExcessArguments(true)
        .argument('<server>', 'Server command, e.g. "typescript-language-server --stdio"')
        .requiredOption('-w, --workspace <path>', 'Path to the workspace directory to benchmark against')
        .requiredOption('-s, --script <path>', 'Path to the action driver script (.ts, .js or .mjs)')
        .option('-n, --iterations <number>', 'Number of timed iterations', '10')
        .option('--warmup <number>', 'Number of warmup iterations (not recorded)', '2')
        .option('-o, --output <path>', 'Output file for JSON report', '')
        .option('--init-options-file <path>', 'Path to a JSON file with LSP initializationOptions')
        .option(
            '--client-capabilities-file <path>',
            'Path to a JSON file deep merged over the default client capabilities',
        )
        .option(
            '--advertise-pull',
            'Advertise the textDocument.diagnostic client capability, so servers may switch from pushing to pull diagnostics',
            false,
        )
        .option(
            '--settings-file <path>',
            'Path to a JSON file with client settings keyed by section. Only the listed keys are sent, and servers may read a missing key as false (e.g. json.validate.enable)',
        )
        .option('--restart', 'Restart the server between each iteration (measures cold start)', false)
        .option(
            '--shutdown-timeout <ms>',
            'Milliseconds to wait for a shutdown reply before killing the server',
            '5000',
        )
        .option(
            '--allow-exit-code <n>',
            'Tolerate this non zero exit code after a replied shutdown (repeatable), recorded in tolerated_exits',
            collectExitCode,
            [] as number[],
        )
        .option(
            '--allow-exit-signal <name>',
            'Tolerate this signal (e.g. SIGSEGV) after a replied shutdown (repeatable), recorded in tolerated_exits',
            collectExitSignal,
            [] as string[],
        )
        .option(
            '--allow-unreplied-shutdown',
            'Tolerate a server exiting with code 0, or an allowed code or signal, after shutdown was sent but before it replied, recorded in tolerated_exits',
            false,
        )
        .option('--content-modified-retries <n>', 'Retry a request rejected with ContentModified up to n times', '3')
        .option(
            '--request-timeout <ms>',
            'Cancel a request the server has not answered after ms, per attempt, recorded as a timeout',
            String(DEFAULT_REQUEST_TIMEOUT_MS),
        )
        .option('--no-skip-unsupported', 'Send requests even when the server does not advertise their provider')
        .option(
            '--wait-idle [ms]',
            `Wait up to ms (default ${DEFAULT_WAIT_IDLE_MS}) for the server to finish background work after initialized`,
        )
        .option(
            '--shorten-silent-waits [ms]',
            `Once 3 diagnostics waits of a kind known to time out did so in a row (no publish, only close publishes on reopen, publishes all failing until), end later ones after ms (default ${DEFAULT_SHORTEN_SILENT_WAITS_MS}), recorded as shortened timeouts`,
        )
        .option('--server-log <file>', 'Append server stderr and log messages to this file instead of the console')
        .option(
            '--trace <file>',
            'Write every LSP message in both directions to this file as JSON lines, with timestamps and iteration markers (adds overhead to timings)',
        )
        .option('-v, --verbose', 'Enable verbose logging', false)
        .action(async (server: string, rawOpts: Record<string, unknown>, command: Command) => {
            // Extra arguments after `--` are passed through to the language server command
            const serverArgs = command.args.slice(1);
            // load initializationOptions, client capabilities and settings from JSON files if provided
            const initializationOptions = readJsonFile(rawOpts.initOptionsFile as string | undefined, 'Init options');
            const clientCapabilities = readJsonObjectFile(
                rawOpts.clientCapabilitiesFile as string | undefined,
                'Client capabilities',
            );
            const settings = readJsonObjectFile(rawOpts.settingsFile as string | undefined, 'Settings');

            const opts: BenchOptions = {
                server,
                workspace: rawOpts.workspace as string,
                script: rawOpts.script as string,
                iterations: parseIntStrict(rawOpts.iterations as string),
                warmup: parseIntStrict(rawOpts.warmup as string),
                output: rawOpts.output as string,
                restart: rawOpts.restart as boolean,
                verbose: rawOpts.verbose as boolean,
                serverLog: rawOpts.serverLog as string | undefined,
                trace: rawOpts.trace as string | undefined,
                shutdownTimeout: parseIntStrict(rawOpts.shutdownTimeout as string),
                contentModifiedRetries: parseIntStrict(rawOpts.contentModifiedRetries as string),
                requestTimeout: parseIntStrict(rawOpts.requestTimeout as string),
                skipUnsupported: rawOpts.skipUnsupported as boolean,
                waitIdle: parseOptionalMs(rawOpts.waitIdle as string | boolean | undefined, DEFAULT_WAIT_IDLE_MS),
                shortenSilentWaits: parseOptionalMs(
                    rawOpts.shortenSilentWaits as string | boolean | undefined,
                    DEFAULT_SHORTEN_SILENT_WAITS_MS,
                ),
                serverArgs: serverArgs.length ? serverArgs : undefined,
                initializationOptions,
                clientCapabilities,
                advertisePullDiagnostics: rawOpts.advertisePull as boolean,
                settings,
                allowExitCodes: (rawOpts.allowExitCode as number[]).length
                    ? (rawOpts.allowExitCode as number[])
                    : undefined,
                allowExitSignals: (rawOpts.allowExitSignal as string[]).length
                    ? (rawOpts.allowExitSignal as NodeJS.Signals[])
                    : undefined,
                allowUnrepliedShutdown: rawOpts.allowUnrepliedShutdown as boolean,
            };

            // Validate inputs
            if (!fs.existsSync(opts.workspace)) {
                console.error(`Error: Workspace directory not found: ${opts.workspace}`);
                process.exit(1);
            }
            if (!fs.statSync(opts.workspace).isDirectory()) {
                console.error(`Error: Workspace path is not a directory: ${opts.workspace}`);
                process.exit(1);
            }
            if (!isActionScriptPath(opts.script)) {
                console.error(`Error: ${actionScriptExtensionError(opts.script)}`);
                process.exit(1);
            }
            if (!fs.existsSync(opts.script)) {
                console.error(`Error: Action script not found: ${opts.script}`);
                process.exit(1);
            }
            if (Number.isNaN(opts.iterations) || opts.iterations < 1) {
                console.error('Error: --iterations must be a positive integer');
                process.exit(1);
            }
            if (Number.isNaN(opts.warmup) || opts.warmup < 0) {
                console.error('Error: --warmup must be a non-negative integer');
                process.exit(1);
            }
            if (Number.isNaN(opts.shutdownTimeout) || (opts.shutdownTimeout ?? 0) < 1) {
                console.error('Error: --shutdown-timeout must be a positive integer');
                process.exit(1);
            }
            if (opts.allowExitCodes?.some((code) => Number.isNaN(code))) {
                console.error('Error: --allow-exit-code must be a non-negative integer');
                process.exit(1);
            }
            if (opts.allowExitSignals?.some((signal) => !isSignalName(signal))) {
                console.error('Error: --allow-exit-signal must be a signal name such as SIGSEGV');
                process.exit(1);
            }
            if (opts.waitIdle !== undefined && (Number.isNaN(opts.waitIdle) || opts.waitIdle < 1)) {
                console.error('Error: --wait-idle must be a positive integer');
                process.exit(1);
            }
            if (
                opts.shortenSilentWaits !== undefined &&
                (Number.isNaN(opts.shortenSilentWaits) || opts.shortenSilentWaits < 1)
            ) {
                console.error('Error: --shorten-silent-waits must be a positive integer');
                process.exit(1);
            }
            if (Number.isNaN(opts.contentModifiedRetries) || (opts.contentModifiedRetries ?? 0) < 0) {
                console.error('Error: --content-modified-retries must be a non-negative integer');
                process.exit(1);
            }
            if (Number.isNaN(opts.requestTimeout) || (opts.requestTimeout ?? 0) < 1) {
                console.error('Error: --request-timeout must be a positive integer');
                process.exit(1);
            }

            // fail early on a server log that cannot be appended to
            if (opts.serverLog) {
                try {
                    fs.appendFileSync(opts.serverLog, '');
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`Error: Cannot write server log ${opts.serverLog}: ${msg}`);
                    process.exit(1);
                }
            }

            // fail early on a trace file that cannot be written, the run truncates it anyway
            if (opts.trace) {
                try {
                    fs.writeFileSync(opts.trace, '');
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`Error: Cannot write trace ${opts.trace}: ${msg}`);
                    process.exit(1);
                }
            }

            try {
                // the runner writes the report itself, before the final server teardown
                const report = await runBenchmark(opts);

                // still exit non zero when the server crashed, so callers notice
                if (report.abnormal_exits) {
                    for (const exit of report.abnormal_exits) {
                        const status = exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`;
                        console.error(
                            `Error: server exited abnormally during ${exit.during} (${status}): ${exit.reason}`,
                        );
                    }
                    process.exit(1);
                }
                process.exit(0);
            } catch (err: unknown) {
                console.error('\nFatal error:', err instanceof Error ? err.message : err);
                if (opts.verbose && err instanceof Error) {
                    console.error(err.stack);
                }
                process.exit(1);
            }
        });

    program
        .command('prime')
        .description('Print a self-contained primer with everything needed to start using lsbench.')
        .action(() => {
            console.log(getPrimer());
        });

    program
        .command('baseline')
        .description('Write a baseline from a report: run settings and summaries, without the per iteration runs.')
        .argument('<report>', 'JSON report written by lsbench')
        .requiredOption('-o, --output <path>', 'Output file for the baseline')
        .addHelpText(
            'after',
            '\nThe baseline keeps iterations, warmup, restart_between_iterations, summary and\n' +
                'iteration_summary. Commit it and review its diff when rewriting it.\n\n' +
                'Example:\n' +
                '  lsbench baseline results.json -o baseline.json',
        )
        .action((reportFile: string, rawOpts: Record<string, unknown>) => {
            const report = readCheckedRun(reportFile, 'Report', 1) as BenchReport;
            if (!report.iteration_summary) {
                console.error(`Error: Report ${reportFile} has no iteration_summary`);
                process.exit(1);
            }
            const output = rawOpts.output as string;
            try {
                fs.writeFileSync(output, `${JSON.stringify(createBaseline(report), null, 2)}\n`);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`Error: Cannot write baseline ${output}: ${msg}`);
                process.exit(1);
            }
            console.log(`Baseline written to ${output}`);
        });

    program
        .command('check')
        .description('Check a report against a baseline. Exits 0 on pass, 1 on regressions, 2 on usage errors.')
        .argument('<report>', 'JSON report written by lsbench')
        .requiredOption('-b, --baseline <path>', 'Baseline written by `lsbench baseline`')
        .option(
            '--rate-tolerance <n>',
            'Largest allowed absolute difference of a rate',
            String(DEFAULT_CHECK_OPTIONS.rateTolerance),
        )
        .option(
            '--median-ratio <n>',
            'median_ms may grow by this factor or shrink by its inverse',
            String(DEFAULT_CHECK_OPTIONS.medianRatio),
        )
        .option(
            '--slack-ms <n>',
            'Milliseconds added on both sides of the median bounds',
            String(DEFAULT_CHECK_OPTIONS.slackMs),
        )
        .option(
            '--min-count <n>',
            'Skip the median rule for methods with a count below this in the baseline or report',
            String(DEFAULT_CHECK_OPTIONS.minCount),
        )
        .option('--json', 'Print a machine readable verdict', false)
        .addHelpText(
            'after',
            '\nRules, each failing the check:\n' +
                '  - iterations, warmup or restart_between_iterations differ\n' +
                '  - a method is added or missing\n' +
                '  - timeout_rate, skip_rate, empty_rate, null_rate or failure_rate differ by\n' +
                '    more than --rate-tolerance\n' +
                '  - median_ms is outside [max(0, base / ratio - slack), base * ratio + slack],\n' +
                '    unless the baseline or report count is below --min-count (1 checks all)\n' +
                '  - a null median_ms becomes a number or vice versa\n\n' +
                'Examples:\n' +
                '  lsbench check results.json -b baseline.json\n' +
                '  lsbench check results.json -b baseline.json --median-ratio 3 --slack-ms 10 --json',
        )
        // usage errors exit 2, apart from regressions (1)
        .exitOverride((err) => {
            process.exit(err.exitCode === 0 ? 0 : 2);
        })
        .action((reportFile: string, rawOpts: Record<string, unknown>) => {
            const rateTolerance = Number(rawOpts.rateTolerance);
            const medianRatio = Number(rawOpts.medianRatio);
            const slackMs = Number(rawOpts.slackMs);
            const minCount = Number(rawOpts.minCount);
            if (!Number.isFinite(rateTolerance) || rateTolerance < 0) {
                console.error('Error: --rate-tolerance must be a non-negative number');
                process.exit(2);
            }
            if (!Number.isFinite(medianRatio) || medianRatio < 1) {
                console.error('Error: --median-ratio must be a number of at least 1');
                process.exit(2);
            }
            if (!Number.isFinite(slackMs) || slackMs < 0) {
                console.error('Error: --slack-ms must be a non-negative number');
                process.exit(2);
            }
            if (!Number.isInteger(minCount) || minCount < 1) {
                console.error('Error: --min-count must be a positive integer');
                process.exit(2);
            }
            const report = readCheckedRun(reportFile, 'Report', 2);
            const baseline = readCheckedRun(rawOpts.baseline as string, 'Baseline', 2);
            const result = checkReport(report, baseline, { rateTolerance, medianRatio, slackMs, minCount });
            console.log(rawOpts.json ? JSON.stringify(result, null, 2) : formatCheckResult(result));
            process.exit(result.pass ? 0 : 1);
        });

    return program;
}

/** Collect repeated --allow-exit-code values, NaN for an invalid one (rejected after parsing) */
function collectExitCode(value: string, previous: number[]): number[] {
    const code = parseIntStrict(value);
    return previous.includes(code) ? previous : [...previous, code];
}

function collectExitSignal(value: string, previous: string[]): string[] {
    const upper = value.trim().toUpperCase();
    const signal = upper.startsWith('SIG') ? upper : `SIG${upper}`;
    return previous.includes(signal) ? previous : [...previous, signal];
}

function isSignalName(name: string): boolean {
    return Object.hasOwn(os.constants.signals, name);
}

function parseOptionalMs(value: string | boolean | undefined, bare: number): number | undefined {
    if (value === undefined || value === false) {
        return undefined;
    }
    if (value === true) {
        return bare;
    }
    return parseIntStrict(value);
}

function parseIntStrict(value: string): number {
    return /^\d+$/.test(value) ? parseInt(value, 10) : Number.NaN;
}

/** Read and parse a JSON file named by a CLI flag, exiting with an error if it is missing or invalid */
function readJsonFile(file: string | undefined, what: string): unknown {
    if (!file) {
        return undefined;
    }
    if (!fs.existsSync(file)) {
        console.error(`Error: ${what} file not found: ${file}`);
        process.exit(1);
    }
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: Failed to parse ${what.toLowerCase()} file ${file}: ${msg}`);
        process.exit(1);
    }
}

/** reads a JSON file like readJsonFile, exiting unless it holds a JSON object */
function readJsonObjectFile(file: string | undefined, what: string): Record<string, unknown> | undefined {
    const value = readJsonFile(file, what);
    if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
        console.error(`Error: ${what} file must contain a JSON object`);
        process.exit(1);
    }
    return value as Record<string, unknown> | undefined;
}

/** Reads a report or baseline, exiting with exitCode if it is missing, invalid or lacks checked fields */
function readCheckedRun(file: string, what: string, exitCode: number): CheckedRun {
    if (!fs.existsSync(file)) {
        console.error(`Error: ${what} file not found: ${file}`);
        process.exit(exitCode);
    }
    let value: unknown;
    try {
        value = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: Failed to parse ${what.toLowerCase()} file ${file}: ${msg}`);
        process.exit(exitCode);
    }
    const error = validateCheckedRun(value);
    if (error) {
        console.error(`Error: ${what} file ${file} is not an lsbench report or baseline: ${error}`);
        process.exit(exitCode);
    }
    return value as CheckedRun;
}

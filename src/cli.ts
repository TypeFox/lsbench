#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { runBenchmark } from './runner.js';
import type { BenchOptions } from './types.js';

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
    .version('0.1.0')
    .allowExcessArguments(true)
    .argument('<server>', 'Server command, e.g. "typescript-language-server --stdio"')
    .requiredOption('-w, --workspace <path>', 'Path to the workspace directory to benchmark against')
    .requiredOption('-s, --script <path>', 'Path to the action driver script (.ts)')
    .option('-n, --iterations <number>', 'Number of timed iterations', '10')
    .option('--warmup <number>', 'Number of warmup iterations (not recorded)', '2')
    .option('-o, --output <path>', 'Output file for JSON report', '')
    .option('--init-options-file <path>', 'Path to a JSON file with LSP initializationOptions')
    .option('--restart', 'Restart the server between each iteration (measures cold start)', false)
    .option('-v, --verbose', 'Enable verbose logging', false)
    .action(async (server: string, rawOpts: Record<string, unknown>, command: Command) => {
        // Extra arguments after `--` are passed through to the language server command
        const serverArgs = command.args.slice(1);
        // Load initializationOptions from a JSON file if provided
        let initializationOptions: unknown;
        const initOptionsFile = rawOpts.initOptionsFile as string | undefined;
        if (initOptionsFile) {
            if (!fs.existsSync(initOptionsFile)) {
                console.error(`Error: Init options file not found: ${initOptionsFile}`);
                process.exit(1);
            }
            try {
                initializationOptions = JSON.parse(fs.readFileSync(initOptionsFile, 'utf8'));
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`Error: Failed to parse init options file ${initOptionsFile}: ${msg}`);
                process.exit(1);
            }
        }

        const opts: BenchOptions = {
            server,
            workspace: rawOpts.workspace as string,
            script: rawOpts.script as string,
            iterations: parseInt(rawOpts.iterations as string, 10),
            warmup: parseInt(rawOpts.warmup as string, 10),
            output: rawOpts.output as string,
            restart: rawOpts.restart as boolean,
            verbose: rawOpts.verbose as boolean,
            serverArgs: serverArgs.length ? serverArgs : undefined,
            initializationOptions,
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
        if (!opts.script.endsWith('.ts')) {
            console.error(`Error: Action script must be a TypeScript (.ts) file: ${opts.script}`);
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

        try {
            const report = await runBenchmark(opts);

            // Write JSON report
            if (opts.output) {
                const outPath = path.resolve(opts.output);
                fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
                console.log(`  Report written to: ${outPath}\n`);
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

program.parse();

#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { runBenchmark } from './runner';
import type { BenchOptions } from './types';

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
            '  lsbench ./server-config.json \\\n' +
            '    -w ./workspace -s ./actions.ts -n 100 -o results.json',
    )
    .version('0.1.0')
    .argument(
        '<server>',
        'Server command (e.g. "typescript-language-server --stdio") or path to a config file (.json/.js/.ts)',
    )
    .requiredOption('-w, --workspace <path>', 'Path to the workspace directory to benchmark against')
    .requiredOption('-s, --script <path>', 'Path to the action driver script (.ts or .js)')
    .option('-n, --iterations <number>', 'Number of timed iterations', '10')
    .option('--warmup <number>', 'Number of warmup iterations (not recorded)', '2')
    .option('-o, --output <path>', 'Output file for JSON report', '')
    .option('--restart', 'Restart the server between each iteration (measures cold start)', false)
    .option('-v, --verbose', 'Enable verbose logging', false)
    .option('-- <args...>', 'Extra arguments to pass to the language server command')
    .action(async (server: string, rawOpts: Record<string, unknown>) => {
        const opts: BenchOptions = {
            server,
            workspace: rawOpts.workspace as string,
            script: rawOpts.script as string,
            iterations: parseInt(rawOpts.iterations as string, 10),
            warmup: parseInt(rawOpts.warmup as string, 10),
            output: rawOpts.output as string,
            restart: rawOpts.restart as boolean,
            verbose: rawOpts.verbose as boolean,
            serverArgs: rawOpts.args as string[] | undefined,
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

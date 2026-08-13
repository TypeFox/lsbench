#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { runBenchmark } from './runner.js';
import type { BenchOptions } from './types.js';
import { CLI_VERSION } from './version.js';

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

program
    .command('prime')
    .description('Print a self-contained primer with everything needed to start using lsbench.')
    .action(() => {
        console.log(getPrimer());
    });

program.parse();

// ── Primer ──────────────────────────────────────────────────────────────────
// A self-contained onboarding document for an agent (or human) about to use
// lsbench. It covers the purpose, the workflow, the full BenchContext API, a
// copy-pasteable action-script template, CLI usage, and the output format so
// the reader has enough context to begin immediately without further docs.
// Declared as a hoisted function so the `prime` action can reference it
// regardless of source ordering relative to program.parse().
function getPrimer(): string {
    return `# lsbench primer

lsbench benchmarks *any* language server by driving it with a scripted sequence
of LSP requests and timing each one. You point it at a server command, a
workspace, and a TypeScript "action script"; it runs that script for N
iterations and emits per-method latency statistics (avg/median/p95/p99/stddev)
plus a full per-iteration breakdown.

Use it to answer questions like: "how fast is hover in this project?", "how
much does cold start cost?", or "is server A faster than server B on the same
workspace?".

## How it works

1. lsbench spawns the language server process you name.
2. It performs the LSP initialize / initialized handshake against your workspace.
3. It loads your action script and calls its default-exported function once per
   iteration, passing a BenchContext (\`ctx\`).
4. Every LSP request sent through \`ctx\` is timed with a high-resolution clock.
5. After warmup + timed iterations, it prints a summary and (optionally) writes
   a JSON report.

By default the server is kept alive across iterations (warm benchmark). With
\`--restart\` a fresh server is spawned inside each timed iteration, so the timing
captures spawn + initialize (cold start).

## Quick start

    lsbench "typescript-language-server --stdio" \\
      --workspace ./my-project \\
      --script ./bench-actions.ts \\
      --iterations 50 \\
      --output results.json

## Writing an action script

An action script is a \`.ts\` file that default-exports an async function taking a
BenchContext. It is loaded natively by Node (>= 24) via type stripping, so it
must be "erasable" TypeScript: no \`enum\`, \`namespace\`, or parameter properties.

    import type { BenchContext } from 'lsbench';

    export default async function (ctx: BenchContext) {
      // 1. open the file and wait for the server to finish loading
      await ctx.openDocument('src/index.ts');
      await ctx.waitForDiagnostics('src/index.ts', 30_000);

      // 2. exercise typical editor interactions (each call is timed)
      await ctx.hover('src/index.ts', 10, 5);
      await ctx.completion('src/index.ts', 15, 10);
      await ctx.definition('src/index.ts', 10, 5);
      await ctx.references('src/index.ts', 10, 5);
      await ctx.documentSymbol('src/index.ts');

      // 3. simulate an edit, then re-measure
      await ctx.edit('src/index.ts', {
        range: { start: { line: 20, character: 0 }, end: { line: 20, character: 0 } },
        text: 'const __benchTemp = 42;\\n',
      });
      await ctx.waitForDiagnostics('src/index.ts', 10_000);
      await ctx.hover('src/index.ts', 20, 10);

      // 4. clean up
      await ctx.closeDocument('src/index.ts');
    }

All file paths are relative to the workspace root. Positions are zero-based
(line 0 = first line, character 0 = first column).

## The context API (BenchContext)

The object passed to your script. Import its type from 'lsbench'. Methods marked
(timed) record a RequestTiming entry; others are notifications or helpers.

Document lifecycle
  openDocument(path)                      textDocument/didOpen  — must be called before requests on a file
  closeDocument(path)                     textDocument/didClose

Timed LSP requests  (return the raw LSP result, or null on failure)
  hover(path, line, char)                 textDocument/hover
  completion(path, line, char)            textDocument/completion
  definition(path, line, char)            textDocument/definition
  references(path, line, char)            textDocument/references (includeDeclaration: true)
  typeDefinition(path, line, char)        textDocument/typeDefinition
  implementation(path, line, char)        textDocument/implementation
  documentSymbol(path)                    textDocument/documentSymbol
  formatting(path)                        textDocument/formatting (tabSize 2, spaces)
  rename(path, line, char, newName)       textDocument/rename
  codeAction(path, range, codes?)         textDocument/codeAction (codes filter cached diagnostics)
  signatureHelp(path, line, char)         textDocument/signatureHelp

Mutations
  edit(path, edits)                       textDocument/didChange — edits is an EditOperation or array of them.
                                          The document must be open first. Each EditOperation is
                                          { range: { start: {line,character}, end: {line,character} }, text }.

Synchronization
  waitForDiagnostics(path, timeoutMs?)    resolves with the diagnostics array once the server publishes
                                          them (default timeout 30_000ms). Call after open/edit before timing.
  sleep(ms)                               pause execution — useful to let background indexing settle.

Escape hatches (for methods without a convenience wrapper)
  request<R>(method, params, label?)      send an arbitrary LSP request; it is timed. label appears in the report.
  notify(method, params)                  send an arbitrary LSP notification (not timed — no response).

Property
  workspaceRoot                           the resolved workspace root URI.

## CLI reference

    Usage: lsbench [options] <server>

    Arguments:
      server                       Server command, e.g. "typescript-language-server --stdio"

    Options:
      -w, --workspace <path>       Workspace directory to benchmark against         (required)
      -s, --script <path>          Action driver script (.ts)                       (required)
      -n, --iterations <number>    Number of timed iterations                       (default: 10)
          --warmup <number>        Warmup iterations, not recorded                  (default: 2)
      -o, --output <path>          Write the JSON report to this file
          --init-options-file <p>  JSON file with LSP initializationOptions
          --restart                Restart the server each iteration (cold start)   (default: false)
      -v, --verbose                Verbose logging                                  (default: false)
      -V, --version                Print version
      -h, --help                   Print help

    prime                          Print this primer

Anything after \`--\` is passed through as extra args to the server command.

## Output format

The JSON report (and the printed summary) contains:
  - summary            per-method stats: count, avg/median/p95/p99/min/max_ms, stddev_ms, failure_rate
  - iteration_summary  per-iteration total-time stats
  - runs               full per-iteration, per-request breakdown

Example \`summary\` entry:

    "textDocument/hover": {
      "count": 50, "avg_ms": 12.4, "median_ms": 11.2, "p95_ms": 22.1,
      "p99_ms": 34.5, "min_ms": 8.1, "max_ms": 42.3, "stddev_ms": 5.2,
      "failure_rate": 0
    }

## Tips for reliable numbers

  - Warmup matters: JIT and caches need a few runs to stabilize. Use --warmup 3-5.
  - Always waitForDiagnostics after opening or editing before you time requests;
    servers do background work that skews latency otherwise.
  - Point positions at real symbols in your workspace, or requests return null.
  - Large workspaces: the first iteration is often much slower due to indexing —
    warmup absorbs this.
  - Cold start: use --restart to measure spawn + initialize time.
  - Compare servers: run the same script/workspace against different servers
    (e.g. typescript-language-server vs vtsls).
`;
}

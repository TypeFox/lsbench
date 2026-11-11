#!/usr/bin/env node

import * as fs from 'node:fs';
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
    .option('--client-capabilities-file <path>', 'Path to a JSON file deep merged over the default client capabilities')
    .option('--restart', 'Restart the server between each iteration (measures cold start)', false)
    .option('--shutdown-timeout <ms>', 'Milliseconds to wait for a shutdown reply before killing the server', '5000')
    .option('--content-modified-retries <n>', 'Retry a request rejected with ContentModified up to n times', '3')
    .option('--no-skip-unsupported', 'Send requests even when the server does not advertise their provider')
    .option('-v, --verbose', 'Enable verbose logging', false)
    .action(async (server: string, rawOpts: Record<string, unknown>, command: Command) => {
        // Extra arguments after `--` are passed through to the language server command
        const serverArgs = command.args.slice(1);
        // load initializationOptions and client capabilities from JSON files if provided
        const initializationOptions = readJsonFile(rawOpts.initOptionsFile as string | undefined, 'Init options');
        const clientCapabilities = readJsonFile(
            rawOpts.clientCapabilitiesFile as string | undefined,
            'Client capabilities',
        );
        if (
            clientCapabilities !== undefined &&
            (typeof clientCapabilities !== 'object' || clientCapabilities === null || Array.isArray(clientCapabilities))
        ) {
            console.error('Error: Client capabilities file must contain a JSON object');
            process.exit(1);
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
            shutdownTimeout: parseInt(rawOpts.shutdownTimeout as string, 10),
            contentModifiedRetries: parseInt(rawOpts.contentModifiedRetries as string, 10),
            skipUnsupported: rawOpts.skipUnsupported as boolean,
            serverArgs: serverArgs.length ? serverArgs : undefined,
            initializationOptions,
            clientCapabilities: clientCapabilities as Record<string, unknown> | undefined,
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
        if (Number.isNaN(opts.shutdownTimeout) || (opts.shutdownTimeout ?? 0) < 1) {
            console.error('Error: --shutdown-timeout must be a positive integer');
            process.exit(1);
        }
        if (Number.isNaN(opts.contentModifiedRetries) || (opts.contentModifiedRetries ?? 0) < 0) {
            console.error('Error: --content-modified-retries must be a non-negative integer');
            process.exit(1);
        }

        try {
            // the runner writes the report itself, before the final server teardown
            const report = await runBenchmark(opts);

            // still exit non zero when the server crashed, so callers notice
            if (report.abnormal_exits) {
                for (const exit of report.abnormal_exits) {
                    const status = exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`;
                    console.error(`Error: server exited abnormally during ${exit.during} (${status}): ${exit.reason}`);
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

program.parse();

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
captures spawn + initialize (cold start). Either way, spawn, initialize and
shutdown are also reported as lifecycle/* methods (see Output format).

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
      await ctx.waitForDiagnostics('src/index.ts', { timeout: 30_000 });

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
      await ctx.waitForDiagnostics('src/index.ts', { timeout: 10_000 });
      await ctx.hover('src/index.ts', 20, 10);

      // 4. clean up
      await ctx.closeDocument('src/index.ts');
    }

All file paths are relative to the workspace root. Positions are zero-based
(line 0 = first line, character 0 = first column).

## The context API (BenchContext)

The object passed to your script. Import its type from 'lsbench'. Methods marked
(timed) record a RequestTiming entry and return the raw LSP result, or null on
failure. Others are notifications or helpers.

ctx.lastError is { method, message, code? } when the last timed request failed,
and undefined otherwise (it is cleared as each request starts). Use it to tell
a failure apart from a null result:

    const res = await ctx.definition('src/index.ts', 10, 5);
    if (ctx.lastError) { console.error(ctx.lastError.message); }

ctx.capabilities is the capabilities object of the initialize result, and
ctx.registrations the dynamic registrations ({ id, method, registerOptions? })
the server holds. ctx.supports(method) checks both for the provider behind an
LSP request method (including options such as resolveProvider); methods
lsbench has no mapping for count as supported.

Unsupported requests: a timed request whose provider the server advertises
neither statically nor dynamically is not sent. It returns null at once and
records result "skipped" with duration_ms 0. This applies to the wrappers
below, willSaveWaitUntil, and request() calls for the same methods; other
request() methods are always sent. --no-skip-unsupported sends them anyway.
Providers registered dynamically after initialized are skipped until the
registration arrives, so wait (e.g. waitForDiagnostics) before the first request.

Document lifecycle  (all but openDocument/closeDocument throw if the document is not open)
  openDocument(path)                      textDocument/didOpen, call before requests on a file
  closeDocument(path)                     textDocument/didClose
  edit(path, edits)                       textDocument/didChange. edits is an EditOperation or an array,
                                          each { range: { start: {line,character}, end: {line,character} }, text }.
                                          Array edits apply in order, each range refers to the text after
                                          the previous edits. The tracked document text is updated to match.
  saveDocument(path)                      textDocument/didSave, only if the server asks for it, with the
                                          tracked text when it wants includeText
  willSave(path, reason?)                 textDocument/willSave, only if the server asks for it (reason default 1, Manual)
  willSaveWaitUntil(path, reason?)        textDocument/willSaveWaitUntil (timed, skipped unless the server asks for it,
                                          reason default 1)

  Save options come from the static textDocumentSync capability and from dynamic
  didSave/willSave/willSaveWaitUntil registrations. A bare TextDocumentSyncKind
  number implies didSave without text.

Navigation and editing  (timed)
  hover(path, line, char)                 textDocument/hover
  completion(path, line, char)            textDocument/completion
  signatureHelp(path, line, char)         textDocument/signatureHelp
  definition(path, line, char)            textDocument/definition
  declaration(path, line, char)           textDocument/declaration
  typeDefinition(path, line, char)        textDocument/typeDefinition
  implementation(path, line, char)        textDocument/implementation
  references(path, line, char)            textDocument/references (includeDeclaration: true)
  documentHighlight(path, line, char)     textDocument/documentHighlight
  prepareRename(path, line, char)         textDocument/prepareRename
  rename(path, line, char, newName)       textDocument/rename
  codeAction(path, range, codes?)         textDocument/codeAction (codes filter cached diagnostics by code,
                                          falling back to data.code as used by Langium)
  formatting(path)                        textDocument/formatting (tabSize 2, spaces)
  rangeFormatting(path, range)            textDocument/rangeFormatting (tabSize 2, spaces)
  onTypeFormatting(path, line, char, ch)  textDocument/onTypeFormatting (ch is the typed trigger character)

Document structure  (timed)
  documentSymbol(path)                    textDocument/documentSymbol
  foldingRange(path)                      textDocument/foldingRange
  selectionRange(path, positions)         textDocument/selectionRange (positions is an array of {line,character})
  documentLink(path)                      textDocument/documentLink
  codeLens(path)                          textDocument/codeLens
  inlayHint(path, range)                  textDocument/inlayHint
  semanticTokensFull(path)                textDocument/semanticTokens/full
  semanticTokensRange(path, range)        textDocument/semanticTokens/range
  semanticTokensDelta(path, prevResultId) textDocument/semanticTokens/full/delta (prevResultId from a prior result)

Workspace, hierarchies, pull diagnostics  (timed)
  workspaceSymbol(query)                  workspace/symbol (no document needed)
  prepareCallHierarchy(path, line, char)  textDocument/prepareCallHierarchy (returns CallHierarchyItem[])
  callHierarchyIncomingCalls(item)        callHierarchy/incomingCalls (item from prepareCallHierarchy)
  callHierarchyOutgoingCalls(item)        callHierarchy/outgoingCalls (item from prepareCallHierarchy)
  prepareTypeHierarchy(path, line, char)  textDocument/prepareTypeHierarchy (returns TypeHierarchyItem[])
  typeHierarchySupertypes(item)           typeHierarchy/supertypes (item from prepareTypeHierarchy)
  typeHierarchySubtypes(item)             typeHierarchy/subtypes (item from prepareTypeHierarchy)
  documentDiagnostic(path, prevResultId?) textDocument/diagnostic
  workspaceDiagnostic(prevResultIds?)     workspace/diagnostic (prevResultIds is [{uri,value}], default [])

  Pull diagnostics need a server with diagnosticProvider. lsbench does not
  advertise the textDocument.diagnostic client capability, since some servers
  would then stop pushing diagnostics and break waitForDiagnostics.

Resolve  (timed, the item from the matching request is sent back as the params)
  completionItemResolve(item)             completionItem/resolve
  codeActionResolve(action)               codeAction/resolve
  codeLensResolve(codeLens)               codeLens/resolve
  inlayHintResolve(hint)                  inlayHint/resolve
  documentLinkResolve(link)               documentLink/resolve
  workspaceSymbolResolve(symbol)          workspaceSymbol/resolve

  Skipped unless the provider advertises resolveProvider: true. lsbench
  advertises resolveSupport for completion items, code actions, inlay hints and
  workspace symbols, so some servers defer work from the request to resolve.

Synchronization
  waitForDiagnostics(path, options?)      waits for the server's diagnostics. Call after open/edit before timing.
                                          options is { timeout, until, settleMs } or a bare timeout
                                          (default 30_000ms). until: (diagnostics) => boolean resolves
                                          on the first current publish passing it, e.g. d => d.length > 0
                                          to skip an empty syntax pass. settleMs keeps waiting after that
                                          publish until none arrived for settleMs, then takes the latest.
                                          timeout caps both. Resolves with { diagnostics, timedOut,
                                          publishes, ms }: timedOut is true when the timer fired before a
                                          publish passed until (diagnostics are then the latest current
                                          publish, or the cached ones), a timeout while settling is not
                                          a timeout. publishes counts the current publishes seen, those
                                          failing until included. ms is the time from the latest
                                          didOpen/didChange to the resolving publish (with settleMs the
                                          latest one, the quiet period is not included).
                                          Only publishes for the current version and open generation count,
                                          and one already received resolves at once. The first empty,
                                          unversioned publish after a reopen within 1000ms of the close
                                          is held: a later publish in that window supersedes it as the
                                          close publish, otherwise it is accepted when the window ends.
                                          lsbench learns per server whether it publishes on close, then
                                          treats such a publish as stale at once, or drops the rule.
                                          Each wait is recorded as diagnostics/open or diagnostics/edit
                                          (diagnostics/wait for a document that is not open, timed from
                                          the call), with the count in \`diagnostics\` and result ok, empty
                                          or timeout.
  sleep(ms)                               pause execution, useful to let background indexing settle.

Escape hatches (for methods without a convenience wrapper)
  request<R>(method, params, label?)      send an arbitrary LSP request (timed). label appears in the report.
  notify(method, params)                  send an arbitrary LSP notification (not timed, no response).

Property
  workspaceRoot                           absolute path of the workspace root.

## Server to client requests

lsbench answers these so a server never stalls waiting on a client:
  workspace/configuration                 an empty object per item
  client/(un)registerCapability           accepted, all registrations are tracked (ctx.registrations)
                                          (didChangeWatchedFiles is advertised, but no file events are sent)
  workspace/*/refresh, workDoneProgress   acknowledged
  window/showMessageRequest               dismissed with null
  workspace/applyEdit                     declined, lsbench never modifies the workspace

## CLI reference

    Usage: lsbench [run] [options] <server>

    Arguments:
      server                       Server command, e.g. "typescript-language-server --stdio"

    Options:
      -w, --workspace <path>       Workspace directory to benchmark against         (required)
      -s, --script <path>          Action driver script (.ts)                       (required)
      -n, --iterations <number>    Number of timed iterations                       (default: 10)
          --warmup <number>        Warmup iterations, not recorded                  (default: 2)
      -o, --output <path>          Write the JSON report to this file
          --init-options-file <p>  JSON file with LSP initializationOptions
          --client-capabilities-file <p>
                                   JSON file deep merged over the client capabilities
          --restart                Restart the server each iteration (cold start)   (default: false)
          --shutdown-timeout <ms>  Wait this long for a shutdown reply, then kill   (default: 5000)
          --content-modified-retries <n>
                                   Retry requests rejected with ContentModified     (default: 3)
          --no-skip-unsupported    Send requests the server does not advertise
      -v, --verbose                Verbose logging                                  (default: false)
      -V, --version                Print version
      -h, --help                   Print help

    prime                          Print this primer

Anything after \`--\` is passed through as extra args to the server command.

## Output format

The JSON report (and the printed summary) contains:
  - summary            per-method stats: count, avg/median/p95/p99/min/max_ms, stddev_ms,
                       failure_rate, null_rate, empty_rate, timeout_rate, skipped, skip_rate
  - iteration_summary  per-iteration total-time stats
  - runs               full per-iteration, per-request breakdown
  - lifecycle          keep alive mode only: spawn, initialize and final shutdown
                       timings of the single server
  - abnormal_exits     servers that crashed or exited unexpectedly (only when any did,
                       lsbench then exits non zero but still writes the report)

Server lifecycle timings appear in summary like methods:
  - lifecycle/spawn       spawning the process until the OS reports it started
  - lifecycle/initialize  initialize request until its response (includes server startup)
  - lifecycle/shutdown    shutdown request until its reply, failed when the server
                          exits first or does not reply within --shutdown-timeout
With --restart they are in each run's requests (shutdown comes after the
iteration and is not part of total_ms). Without it they go in \`lifecycle\`.

Example \`summary\` entry:

    "textDocument/hover": {
      "count": 50, "avg_ms": 12.4, "median_ms": 11.2, "p95_ms": 22.1,
      "p99_ms": 34.5, "min_ms": 8.1, "max_ms": 42.3, "stddev_ms": 5.2,
      "failure_rate": 0, "null_rate": 0, "empty_rate": 0,
      "timeout_rate": 0, "skipped": 0, "skip_rate": 0
    }

Time to diagnostics appears in summary like methods too, one entry per
waitForDiagnostics call:
  - diagnostics/open   from didOpen to the resolving publish
  - diagnostics/edit   from the latest didChange to the resolving publish
  - diagnostics/wait   document not open, from the call to the next publish
These timings carry the diagnostic count in \`diagnostics\`.

Each request in runs has a \`result\`: ok, empty (empty list, or a list wrapper
such as a CompletionList with no items), null, error (with \`error\` set),
skipped (not sent, the server lacks the provider), or timeout (a diagnostics
wait ran out). \`success\` is kept and is false exactly for errors, skips and
timeouts. count and skipped include skips; the rates cover only requests
actually sent, and durations also leave out timeouts, which only count toward
timeout_rate (a server that never publishes for clean files shows 1 there).
A high null_rate usually means a position misses a symbol, so its fast
timings mean little.
Requests rejected with ContentModified (-32801) are retried with a short
backoff; \`retries\` records how often, and only the final attempt is timed.
Lifecycle timings are ok or error.

## Tips for reliable numbers

  - Warmup matters: JIT and caches need a few runs to stabilize. Use --warmup 3-5.
  - Always waitForDiagnostics after opening or editing before you time requests;
    servers do background work that skews latency otherwise. The wait itself is
    timed as diagnostics/open or diagnostics/edit; check timeout_rate first.
  - Point positions at real symbols in your workspace, or requests return null.
  - Large workspaces: the first iteration is often much slower due to indexing —
    warmup absorbs this.
  - Cold start: use --restart to measure spawn + initialize time per iteration
    (lifecycle/spawn, lifecycle/initialize).
  - Compare servers: run the same script/workspace against different servers
    (e.g. typescript-language-server vs vtsls).
`;
}

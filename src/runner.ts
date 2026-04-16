import * as path from "path";
import { LspHarness } from "./harness";
import { BenchContextImpl } from "./context";
import { buildReport, printSummary } from "./stats";
import {
  ActionScript,
  BenchOptions,
  BenchReport,
  IterationResult,
  ServerConfig,
} from "./types";

/**
 * Resolve a server config from the CLI --server argument.
 * Accepts:
 *   - A plain command string like "typescript-language-server --stdio"
 *   - A path to a .json config file
 *   - A path to a .js/.ts config file that exports a ServerConfig
 */
export async function resolveServerConfig(
  serverArg: string,
  extraArgs?: string[]
): Promise<ServerConfig> {
  // Check if it's a file path to a config
  if (
    serverArg.endsWith(".json") ||
    serverArg.endsWith(".js") ||
    serverArg.endsWith(".ts")
  ) {
    const absPath = path.resolve(serverArg);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require(absPath);
    const resolved: ServerConfig = config.default ?? config;
    if (extraArgs?.length) {
      resolved.args = [...(resolved.args ?? []), ...extraArgs];
    }
    return resolved;
  }

  // Otherwise treat it as a command string
  const parts = serverArg.split(/\s+/);
  const command = parts[0];
  const args = [...parts.slice(1), ...(extraArgs ?? [])];

  return { command, args };
}

/**
 * Load the user's action script.
 * Supports .js files (require) and .ts files (via tsx or ts-node if available).
 */
export async function loadActionScript(
  scriptPath: string
): Promise<ActionScript> {
  const absPath = path.resolve(scriptPath);

  if (absPath.endsWith(".ts")) {
    // Try to register ts-node or tsx for on-the-fly TS compilation
    try {
      require("tsx/cjs/api").register();
    } catch {
      try {
        require("ts-node").register({
          transpileOnly: true,
          compilerOptions: { module: "commonjs" },
        });
      } catch {
        throw new Error(
          `Action script is TypeScript but neither 'tsx' nor 'ts-node' is installed.\n` +
            `Install one of them: npm install -g tsx`
        );
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(absPath);
  const fn: ActionScript = mod.default ?? mod;

  if (typeof fn !== "function") {
    throw new Error(
      `Action script ${scriptPath} must export a function (default export or module.exports).`
    );
  }

  return fn;
}

/**
 * Main benchmark runner.
 */
export async function runBenchmark(opts: BenchOptions): Promise<BenchReport> {
  const workspaceRoot = path.resolve(opts.workspace);
  const serverConfig = await resolveServerConfig(opts.server, opts.serverArgs);
  const actionFn = await loadActionScript(opts.script);

  const totalIterations = opts.warmup + opts.iterations;
  const runs: IterationResult[] = [];

  console.log(`\n  Server:     ${opts.server}`);
  console.log(`  Workspace:  ${workspaceRoot}`);
  console.log(`  Script:     ${opts.script}`);
  console.log(`  Iterations: ${opts.iterations} (+ ${opts.warmup} warmup)`);
  console.log(`  Restart:    ${opts.restart ? "each iteration" : "keep alive"}`);
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
    const timings = ctx!.collectTimings();

    if (!isWarmup) {
      runs.push({
        iteration: i - opts.warmup + 1,
        requests: timings,
        total_ms: Math.round(iterMs * 1000) / 1000,
      });
    }

    console.log(` ${iterMs.toFixed(0)}ms${isWarmup ? " (warmup)" : ""}`);

    // Reset document state between iterations (if not restarting)
    if (!opts.restart) {
      await ctx!.resetDocuments();
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

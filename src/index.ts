// Public API for lsbench
// Consumers import from "lsbench" to run benchmarks programmatically,
// drive a language server session directly, or get type information for
// authoring action scripts.

export { BenchContextImpl } from './context.js';
export { LspHarness, pathToUri, uriToPath } from './harness.js';
export type { Diagnostic } from './harness.js';
export { loadActionScript, resolveServerConfig, runBenchmark } from './runner.js';
export { buildReport, computeMethodStats, printSummary } from './stats.js';

// ── Types ───────────────────────────────────────────────────────────────────
export type {
    ActionScript,
    BenchContext,
    BenchOptions,
    BenchReport,
    EditOperation,
    IterationResult,
    MethodStats,
    Position,
    Range,
    RequestTiming,
    ServerConfig,
} from './types.js';

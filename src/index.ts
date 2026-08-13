// Public API for lsbench
// Consumers import from "lsbench" to run benchmarks programmatically,
// drive a language server session directly, or get type information for
// authoring action scripts.

export { BenchContextImpl } from './context';
export { LspHarness, pathToUri, uriToPath } from './harness';
export type { Diagnostic } from './harness';
export { loadActionScript, resolveServerConfig, runBenchmark } from './runner';
export { buildReport, computeMethodStats, printSummary } from './stats';

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
} from './types';

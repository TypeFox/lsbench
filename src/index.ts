// Public API for lsbench
// Consumers import from "lsbench" to run benchmarks programmatically,
// drive a language server session directly, or get type information for
// authoring action scripts.

export type { BenchContextOptions } from './context.js';
export { addRegisteredLanguage, BenchContextImpl, classifyResult } from './context.js';
export type { Diagnostic, SaveSyncOptions, ServerExit } from './harness.js';
export { LspHarness, pathToUri, uriToPath } from './harness.js';
export { loadActionScript, resolveServerConfig, runBenchmark } from './runner.js';
export { buildReport, computeMethodStats, printSummary } from './stats.js';

// ── Types ───────────────────────────────────────────────────────────────────
export type {
    AbnormalExit,
    ActionScript,
    BenchContext,
    BenchOptions,
    BenchReport,
    EditOperation,
    IterationResult,
    MethodStats,
    OpenDocumentOptions,
    Position,
    Range,
    RequestError,
    RequestResult,
    RequestTiming,
    ServerConfig,
} from './types.js';

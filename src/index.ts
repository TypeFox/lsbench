// Public API for lsbench
// Consumers import from "lsbench" to run benchmarks programmatically,
// drive a language server session directly, or get type information for
// authoring action scripts.

export type { ProviderRequirement } from './capabilities.js';
export { METHOD_PROVIDERS, summarizeSupport, supportsMethod } from './capabilities.js';
export type { BenchContextOptions } from './context.js';
export { addRegisteredLanguage, BenchContextImpl, classifyResult } from './context.js';
export type { Diagnostic, SaveSyncOptions, ServerExit } from './harness.js';
export { defaultClientCapabilities, LspHarness, mergeCapabilities, pathToUri, uriToPath } from './harness.js';
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
    Registration,
    RequestError,
    RequestResult,
    RequestTiming,
    ServerCapabilities,
    ServerConfig,
} from './types.js';

// Public API for lsbench
// Consumers import from "lsbench" to run benchmarks programmatically,
// drive a language server session directly, or get type information for
// authoring action scripts.

export type { ProviderRequirement } from './capabilities.js';
export { METHOD_PROVIDERS, summarizeSupport, supportsMethod } from './capabilities.js';
export type { BenchContextOptions } from './context.js';
export {
    addRegisteredLanguage,
    BenchContextImpl,
    classifyResult,
    detectLanguageId,
    isCurrentPublish,
} from './context.js';
export type {
    ClosePublishBehavior,
    Diagnostic,
    DiagnosticsDelivery,
    DiagnosticsPublish,
    DocumentSyncState,
    IdleWaitOptions,
    IdleWaitResult,
    LspHarnessOptions,
    ProgressToken,
    PublishStatus,
    PublishWaitOptions,
    PublishWaitResult,
    SaveSyncOptions,
    ServerExit,
    ServerStatusParams,
} from './harness.js';
export {
    CLOSE_PUBLISH_WINDOW_MS,
    DEFAULT_IDLE_QUIET_MS,
    DiagnosticsTracker,
    defaultClientCapabilities,
    expandSettings,
    formatPublishLine,
    LspHarness,
    mergeCapabilities,
    pathToUri,
    ProgressTracker,
    resolveConfigurationSection,
    ServerOutput,
    uriToPath,
} from './harness.js';
export { loadActionScript, resolveServerConfig, runBenchmark } from './runner.js';
export { buildReport, computeMethodStats, printSummary } from './stats.js';

// ── Types ───────────────────────────────────────────────────────────────────
export type {
    AbnormalExit,
    ActionScript,
    BenchContext,
    BenchOptions,
    BenchReport,
    DiagnosticsMode,
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
    WaitForDiagnosticsOptions,
    WaitForDiagnosticsResult,
    WaitForIdleOptions,
    WaitForIdleResult,
} from './types.js';

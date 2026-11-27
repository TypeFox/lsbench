import type { Diagnostic } from './harness.js';

// ── Server Configuration ────────────────────────────────────────────────────

export type ServerTransport =
    | { kind: 'stdio' }
    | { kind: 'connect'; host: string; port: number; timeoutMs?: number }
    | { kind: 'socket'; port: number; timeoutMs?: number };

export interface ServerConfig {
    /** Command to spawn the language server */
    command?: string;
    /** Arguments to pass to the server command */
    args?: string[];
    /** Environment variables for the server process */
    env?: Record<string, string>;
    /** Initialization options sent during LSP initialize */
    initializationOptions?: unknown;
    /** Client capabilities deep merged over the defaults: objects merge recursively, arrays and scalars replace */
    clientCapabilities?: Record<string, unknown>;
    /**
     * Advertise the textDocument.diagnostic client capability (pull diagnostics), merged over the
     * defaults before clientCapabilities. Servers built on vscode-languageserver then stop pushing
     */
    advertisePullDiagnostics?: boolean;
    /**
     * Client settings keyed by section, answering workspace/configuration and sent once via
     * workspace/didChangeConfiguration after initialized. Dotted keys ("html.format") are expanded
     * into nested objects first, as VS Code does. Only the given keys are sent, unlike VS Code,
     * which sends every setting with its default, so a server may read a missing key as false
     */
    settings?: Record<string, unknown>;
    /**
     * Non zero exit codes tolerated after the server replied to shutdown, for servers known to
     * exit with them (0 is always clean). Such an exit is recorded as tolerated, not abnormal.
     * An exit without a shutdown reply stays abnormal whatever its code
     */
    allowExitCodes?: number[];
    allowExitSignals?: NodeJS.Signals[];
    allowUnrepliedShutdown?: boolean;
    transport?: ServerTransport;
}

// ── CLI Options ─────────────────────────────────────────────────────────────

export interface BenchOptions {
    /** Command to spawn the language server, e.g. "typescript-language-server --stdio" */
    server?: string;
    transport?: ServerTransport;
    /** Path to the workspace root to benchmark against */
    workspace: string;
    /** Path to the action driver script (.ts, .js or .mjs) */
    script: string;
    /** Number of timed iterations */
    iterations: number;
    /** Number of warmup iterations (not recorded) */
    warmup: number;
    /** Output file path for the JSON report */
    output: string;
    /** Whether to restart the server between iterations */
    restart: boolean;
    /** Extra args to pass to the server command (after --) */
    serverArgs?: string[];
    /** Initialization options sent during the LSP initialize handshake */
    initializationOptions?: unknown;
    /** Client capabilities deep merged over the defaults sent during initialize */
    clientCapabilities?: Record<string, unknown>;
    /** Advertise the pull diagnostics client capability, see ServerConfig.advertisePullDiagnostics */
    advertisePullDiagnostics?: boolean;
    /** Client settings keyed by section, see ServerConfig.settings */
    settings?: Record<string, unknown>;
    /** Non zero exit codes tolerated after a replied shutdown, see ServerConfig.allowExitCodes */
    allowExitCodes?: number[];
    allowExitSignals?: NodeJS.Signals[];
    allowUnrepliedShutdown?: boolean;
    /** Verbose logging */
    verbose: boolean;
    quiet?: boolean;
    /**
     * Append server stderr, window/logMessage, window/showMessage and $/logTrace to this file,
     * with a header line per server start, instead of forwarding them in verbose mode
     */
    serverLog?: string;
    /**
     * Write every message exchanged with the server to this file as JSON lines, with server
     * starts and iteration markers. Off by default, since tracing adds overhead to the timings
     */
    trace?: string;
    /** Milliseconds to wait for a shutdown reply before killing the server (default 5000) */
    shutdownTimeout?: number;
    /** How often a request rejected with ContentModified (-32801) is retried (default 3) */
    contentModifiedRetries?: number;
    /** Skip requests whose provider the server does not advertise, recording them as skipped (default true) */
    skipUnsupported?: boolean;
    /**
     * Wait up to this many milliseconds for the server to become idle after initialized
     * (and after each restart) before the script runs, recorded as lifecycle/idle
     */
    waitIdle?: number;
    shortenSilentWaits?: number;
    requestTimeout?: number;
}

// ── Timing & Results ────────────────────────────────────────────────────────

/**
 * Outcome of a request: `ok` for a non empty result, `empty` for an empty list
 * (or a list wrapper such as a CompletionList with no items), `null` for a null
 * result, `error` for a rejected request, `skipped` for a request never sent
 * because the server does not advertise its provider, and `timeout` for a
 * diagnostics wait that ran out before a matching publish arrived
 */
export type RequestResult = 'ok' | 'empty' | 'null' | 'error' | 'skipped' | 'timeout';

export interface RequestTiming {
    /** LSP method name, e.g. "textDocument/hover" */
    method: string;
    /** Human label (optional, from the script) */
    label?: string;
    /** Duration in milliseconds (high-resolution), 0 when skipped */
    duration_ms: number;
    /** Whether the request succeeded, false exactly when `result` is `error`, `skipped` or `timeout` */
    success: boolean;
    /** What the request returned */
    result: RequestResult;
    /** Error message if failed */
    error?: string;
    /** How often the request was retried after ContentModified, absent when never */
    retries?: number;
    /** Diagnostics waits only: how many diagnostics the wait resolved with */
    diagnostics?: number;
    /**
     * Auto mode diagnostics pulls only: true when the server's delivery was not settled when
     * the pull resolved (unknown, or pull learned only from empty pulls). A server that is
     * still loading may answer pulls with an empty placeholder and push later, so such a
     * result may not measure real diagnostics. Absent otherwise
     */
    tentative?: true;
    /**
     * Auto mode diagnostics pulls only: milliseconds the wait spent waiting for a push from a
     * server whose delivery was unknown before it pulled (the `pullAfterMs` grace). Included
     * in `duration_ms`, which runs from the didOpen or didChange like a push wait. Absent when
     * the wait pulled at once
     */
    grace_ms?: number;
    /**
     * Diagnostics waits only: how many empty pull answers the wait held back as placeholders,
     * because the server reported it was still loading when they arrived (experimental/serverStatus
     * not quiescent, and in auto mode also an open $/progress token for a server that never sends
     * a status). The wait then waited for a push (auto mode) or for the server to be no longer
     * busy, which `duration_ms` includes. Absent when nothing was held
     */
    held_pulls?: number;
    /**
     * Diagnostics waits only: how many empty publishes for the open document the wait held back as placeholders, because the server reported experimental/serverStatus
     * quiescent:false when they arrived. The wait then waited for a further publish or for the
     * server to be quiescent, which `duration_ms` includes. Absent when nothing was held
     */
    held_publishes?: number;
    /**
     * Push diagnostics waits only: milliseconds the wait spent holding an empty unversioned
     * publish after a reopen as the possible clearing publish of the close, until the close
     * window ended without a further publish, from the publish's receipt (or the start of the
     * wait, when later) to the end of the window. Not included in `duration_ms`, which runs to
     * the publish's receipt, but in the iteration total. Absent when nothing was held
     */
    close_window_ms?: number;
    shortened?: true;
}

export interface IterationResult {
    iteration: number;
    requests: RequestTiming[];
    /** Total wall-clock time for this iteration in ms */
    total_ms: number;
}

/**
 * Per method aggregates. `count` and `skipped` include skipped requests, the rates cover
 * only the requests actually sent, and the durations additionally leave out timeouts.
 * The latency fields are null when no durations are left, for example when every wait timed out
 */
export interface MethodStats {
    count: number;
    avg_ms: number | null;
    median_ms: number | null;
    p95_ms: number | null;
    p99_ms: number | null;
    min_ms: number | null;
    max_ms: number | null;
    stddev_ms: number | null;
    failure_rate: number;
    /** Share of requests that returned null */
    null_rate: number;
    /** Share of requests that returned an empty list */
    empty_rate: number;
    /** Share of diagnostics waits that timed out */
    timeout_rate: number;
    /** Requests skipped because the server does not advertise their provider */
    skipped: number;
    /** Share of all requests that were skipped */
    skip_rate: number;
    /**
     * Diagnostics pulls only, present when some auto mode pull first waited for a push: how
     * many timings did (timeouts and skipped left out, like the durations) and their median
     * `grace_ms`, which their durations include
     */
    graced?: number;
    grace_median_ms?: number;
    /**
     * Diagnostics waits only, present when some wait held back empty pull answers of a busy
     * server: how many timings did, timeouts included, see RequestTiming.held_pulls
     */
    held?: number;
    /**
     * Diagnostics waits only, present when some wait held back a placeholder publish
     * of a server not quiescent: how many timings did, timeouts included, see
     * RequestTiming.held_publishes
     */
    held_publishes?: number;
    /**
     * Push diagnostics waits only, present when some wait held an empty publish in the close
     * window: how many timings did (timeouts and skipped left out, like the durations) and
     * their median `close_window_ms`, which their durations do not include
     */
    close_windowed?: number;
    close_window_median_ms?: number;
    shortened?: number;
}

export interface BenchReport {
    server: string;
    transport?: string;
    workspace: string;
    script: string;
    iterations: number;
    warmup: number;
    restart_between_iterations: boolean;
    timestamp: string;
    total_duration_ms: number;
    summary: Record<string, MethodStats>;
    iteration_summary: {
        avg_ms: number | null;
        median_ms: number | null;
        p95_ms: number | null;
        min_ms: number | null;
        max_ms: number | null;
    };
    runs: IterationResult[];
    /**
     * Keep alive mode only: spawn, initialize, idle and final shutdown timings of the single
     * server, which belong to no iteration. With restart they are in each run's requests
     */
    lifecycle?: RequestTiming[];
    /** Server processes that crashed or exited unexpectedly, absent when none did */
    abnormal_exits?: AbnormalExit[];
    /**
     * Server processes that exited after a replied shutdown with a code allowed by
     * allowExitCodes (--allow-exit-code), absent when none did. They do not fail the run
     */
    tolerated_exits?: AbnormalExit[];
    /**
     * Diagnostics push waits per timing method (`diagnostics/open`, `diagnostics/edit`,
     * `diagnostics/wait`) that timed out without any current publish, warmups included, for
     * methods where at least 3 did so in a row. Such a server likely never publishes for a
     * clean document, so its timeouts mean no diagnostics. Absent when no method did
     */
    silent_waits?: Record<string, SilentWaits>;
    until_rejected?: Record<string, UntilRejectedWaits>;
    reopen_waits?: Record<string, ReopenWaits>;
    plaintext_fallbacks?: string[];
}

/** Push waits of one timing method that timed out without any current publish, see BenchReport.silent_waits */
export interface SilentWaits {
    /** silent waits in the run, warmups included */
    waits: number;
    /** most silent waits in a row, not interrupted by a resolved wait or one that saw publishes */
    longest_streak: number;
    shortened?: number;
}

export interface UntilRejectedWaits {
    waits: number;
    shortened?: number;
}

export interface ReopenWaits {
    waits: number;
    longest_streak: number;
    shortened: number;
}

/** A server exit recorded in abnormal_exits or tolerated_exits */
export interface AbnormalExit {
    /**
     * When the exit was seen, e.g. "iteration 3" or "warmup 1" for a server that exited during
     * an iteration, "teardown of iteration 3" or "teardown of warmup 1" for one that exited while
     * being stopped with restart, or "final teardown" for one that exited while being stopped
     * after the last iteration without restart. Without restart, an exit during an iteration
     * ends the run, so no iteration follows it
     */
    during: string;
    code: number | null;
    signal: string | null;
    reason: string;
}

// ── BenchContext: the API exposed to action scripts ─────────────────────────

export interface Position {
    line: number;
    character: number;
}

export interface Range {
    start: Position;
    end: Position;
}

export interface EditOperation {
    range: Range;
    text: string;
}

/** The `capabilities` of the server's initialize result */
export interface ServerCapabilities {
    [key: string]: unknown;
}

/** A dynamic registration received through client/registerCapability */
export interface Registration {
    id: string;
    method: string;
    registerOptions?: unknown;
}

/** The error of a rejected request, see `BenchContext.lastError` */
export interface RequestError {
    method: string;
    message: string;
    /** JSON-RPC error code, when the server sent one */
    code?: number;
}

/** Options for `BenchContext.waitForDiagnostics` */
export interface WaitForDiagnosticsOptions {
    /** give up after this many milliseconds (default 30000), caps settling too */
    timeout?: number;
    /**
     * resolve on the first current publish whose diagnostics pass this, e.g.
     * `(d) => d.length > 0`; current publishes failing it are counted but do not resolve
     */
    until?: (diagnostics: Diagnostic[]) => boolean;
    /**
     * after the resolving publish (the first passing `until`, when given), keep waiting
     * until no current publish arrived for this many milliseconds, then resolve with the
     * latest one. `ms` stays the time to that publish, the quiet period is not included.
     * Push only, a pulled report is the server's complete answer and resolves at once
     */
    settleMs?: number;
    /**
     * where diagnostics come from (default `auto`): `push` waits for publishDiagnostics,
     * `pull` sends textDocument/diagnostic. `auto` waits for pushes unless the server
     * advertises diagnosticProvider and has not been seen pushing: an unknown server is
     * pulled when it sent no publish within `pullAfterMs`, one learned to be pull only is
     * pulled at once. Any publish for an opened document makes later auto waits wait for
     * pushes, and switches an auto wait that is pulling to wait for pushes for the rest of
     * its timeout. Every mode holds empty answers of a server reporting experimental/serverStatus
     * quiescent:false as placeholders until it is quiescent, see RequestTiming.held_pulls and
     * RequestTiming.held_publishes
     */
    mode?: DiagnosticsMode;
    /**
     * auto mode, server not yet seen pushing: how long to wait for a publish before pulling
     * (default 1000). With a timeout not longer than this, pulling starts at half the timeout
     */
    pullAfterMs?: number;
}

/** How waitForDiagnostics obtains diagnostics */
export type DiagnosticsMode = 'push' | 'pull' | 'auto';

/** What a diagnostics wait resolved with */
export interface WaitForDiagnosticsResult {
    /**
     * the diagnostics of the resolving publish (the latest one when settling), or on
     * timeout those of the latest current publish, falling back to the cached ones
     */
    diagnostics: Diagnostic[];
    /**
     * true when the timeout fired before a current publish (passing `until`, when given)
     * arrived. A timeout during the settle quiet period does not count
     */
    timedOut: boolean;
    /** how many current publishes the wait saw, those failing `until` and a cached one included */
    publishes: number;
    /** whether the diagnostics were pushed (publishDiagnostics) or pulled (textDocument/diagnostic) */
    source: 'push' | 'pull';
    /** how many textDocument/diagnostic requests the wait sent, 0 for push */
    pulls: number;
    /**
     * auto mode pulls only: true when the server's delivery was not settled, the pulled
     * diagnostics may be a placeholder of a server still loading, see RequestTiming.tentative
     */
    tentative?: true;
    /**
     * auto mode pulls only: milliseconds spent waiting for a push before pulling, included in
     * `ms`, see RequestTiming.grace_ms. Absent when the wait pulled at once
     */
    graceMs?: number;
    /**
     * push waits only: milliseconds the wait held the resolving empty publish in the close
     * window of an earlier didClose, not included in `ms`, see RequestTiming.close_window_ms.
     * Absent when nothing was held
     */
    closeWindowMs?: number;
    shortened?: true;
    /**
     * Milliseconds from the latest didOpen or didChange of the document to the resolving
     * publish (or to the timeout). With `settleMs` that is the latest publish before the
     * quiet period, which is not included. For a document that is not open, from the
     * start of the wait. Auto mode pulls are timed the same way to the resolving response,
     * a push grace before the pull (`graceMs`) and re-pulls included; a repeated pull of a
     * document not synced since its previous pull is timed from the start of the wait.
     * `mode: 'pull'` waits are timed from the first pull request to the resolving response,
     * the wait for a server to be quiescent after a held placeholder included
     */
    ms: number;
}

/** Options for `BenchContext.waitForIdle` */
export interface WaitForIdleOptions {
    /** give up after this many milliseconds (default 30000) */
    timeout?: number;
    /** how long the server must stay idle before the wait resolves (default 100) */
    quietMs?: number;
}

/** What an idle wait resolved with */
export interface WaitForIdleResult {
    /** whether the server was idle when the wait resolved, on timeout possibly without a full quiet period */
    idle: boolean;
    /** the timeout fired before the server stayed idle for the quiet period */
    timedOut: boolean;
    /**
     * milliseconds from the call until the server became idle for the last time, 0 when it
     * already was; the quiet period is not included. On timeout, the time until the timeout
     */
    ms: number;
}

export interface CodeActionOptions {
    diagnosticCodes?: (string | number)[];
    only?: string[];
    overlappingDiagnostics?: boolean;
}

/** Options for opening a document */
export interface OpenDocumentOptions {
    /** overrides the languageId detected from the file extension, for this document only */
    languageId?: string;
}

/**
 * The context object passed to user action scripts.
 * All methods that send LSP requests are automatically timed.
 */
export interface BenchContext {
    /** Absolute path of the workspace root */
    workspaceRoot: string;
    /**
     * The error of the last timed request, cleared when the next one starts.
     * Tells a failed request apart from a null result, since both return null
     */
    readonly lastError: RequestError | undefined;
    /** The capabilities of the server's initialize result, null before initialize */
    readonly capabilities: Readonly<ServerCapabilities> | null;
    /** The dynamic registrations the server currently holds */
    readonly registrations: readonly Registration[];
    /**
     * Whether the server answers an LSP request method, from its static capabilities or a
     * dynamic registration. Methods lsbench has no provider mapping for count as supported
     */
    supports(method: string): boolean;

    // ── Document lifecycle ──────────────────────────────────────────────
    /** Sends didOpen, with the languageId detected from the extension unless `options.languageId` is given */
    openDocument(relativePath: string, options?: OpenDocumentOptions): Promise<void>;
    closeDocument(relativePath: string): Promise<void>;
    /** Sends didSave only if the server asked for it, with the tracked text when it wants includeText */
    saveDocument(relativePath: string): Promise<void>;
    /** Sends willSave only if the server asked for it. `reason` is a TextDocumentSaveReason, default 1 (Manual) */
    willSave(relativePath: string, reason?: number): Promise<void>;
    /** Timed willSaveWaitUntil request, skipped like other requests when the server does not ask for it. `reason` defaults to 1 (Manual) */
    willSaveWaitUntil(relativePath: string, reason?: number): Promise<unknown | null>;

    // ── Timed LSP requests ──────────────────────────────────────────────
    hover(relativePath: string, line: number, character: number): Promise<unknown | null>;
    completion(relativePath: string, line: number, character: number): Promise<unknown | null>;
    definition(relativePath: string, line: number, character: number): Promise<unknown | null>;
    references(relativePath: string, line: number, character: number): Promise<unknown | null>;
    documentSymbol(relativePath: string): Promise<unknown | null>;
    formatting(relativePath: string): Promise<unknown | null>;
    rangeFormatting(relativePath: string, range: Range): Promise<unknown | null>;
    onTypeFormatting(relativePath: string, line: number, character: number, ch: string): Promise<unknown | null>;
    rename(relativePath: string, line: number, character: number, newName: string): Promise<unknown | null>;
    codeAction(
        relativePath: string,
        range: Range,
        options?: (string | number)[] | CodeActionOptions,
    ): Promise<unknown | null>;
    signatureHelp(relativePath: string, line: number, character: number): Promise<unknown | null>;
    typeDefinition(relativePath: string, line: number, character: number): Promise<unknown | null>;
    implementation(relativePath: string, line: number, character: number): Promise<unknown | null>;
    declaration(relativePath: string, line: number, character: number): Promise<unknown | null>;
    documentHighlight(relativePath: string, line: number, character: number): Promise<unknown | null>;
    prepareRename(relativePath: string, line: number, character: number): Promise<unknown | null>;
    foldingRange(relativePath: string): Promise<unknown | null>;
    selectionRange(relativePath: string, positions: Position[]): Promise<unknown | null>;
    documentLink(relativePath: string): Promise<unknown | null>;
    codeLens(relativePath: string): Promise<unknown | null>;
    inlayHint(relativePath: string, range: Range): Promise<unknown | null>;
    semanticTokensFull(relativePath: string): Promise<unknown | null>;
    semanticTokensRange(relativePath: string, range: Range): Promise<unknown | null>;
    semanticTokensDelta(relativePath: string, previousResultId: string): Promise<unknown | null>;
    workspaceSymbol(query: string): Promise<unknown | null>;
    prepareCallHierarchy(relativePath: string, line: number, character: number): Promise<unknown | null>;
    callHierarchyIncomingCalls(item: unknown): Promise<unknown | null>;
    callHierarchyOutgoingCalls(item: unknown): Promise<unknown | null>;
    prepareTypeHierarchy(relativePath: string, line: number, character: number): Promise<unknown | null>;
    typeHierarchySupertypes(item: unknown): Promise<unknown | null>;
    typeHierarchySubtypes(item: unknown): Promise<unknown | null>;
    documentDiagnostic(relativePath: string, previousResultId?: string): Promise<unknown | null>;
    workspaceDiagnostic(previousResultIds?: { uri: string; value: string }[]): Promise<unknown | null>;
    completionItemResolve(item: unknown): Promise<unknown | null>;
    codeLensResolve(codeLens: unknown): Promise<unknown | null>;
    inlayHintResolve(hint: unknown): Promise<unknown | null>;
    codeActionResolve(action: unknown): Promise<unknown | null>;
    documentLinkResolve(link: unknown): Promise<unknown | null>;
    workspaceSymbolResolve(symbol: unknown): Promise<unknown | null>;

    // ── Document mutations ──────────────────────────────────────────────
    edit(relativePath: string, edits: EditOperation | EditOperation[]): Promise<void>;

    // ── Synchronization helpers ─────────────────────────────────────────
    /**
     * Wait until the server publishes diagnostics for the current state of the given file,
     * and record the time to diagnostics as `diagnostics/open` or `diagnostics/edit`.
     * Pulled diagnostics are recorded as `diagnostics/pull/open` or `diagnostics/pull/edit`.
     * Useful after opening a document or making edits. `options` may be a bare timeout in ms
     */
    waitForDiagnostics(
        relativePath: string,
        options?: WaitForDiagnosticsOptions | number,
    ): Promise<WaitForDiagnosticsResult>;

    /**
     * Wait until the server has finished its background work: no work done progress token
     * ($/progress) is active and, once rust-analyzer sent experimental/serverStatus, the
     * latest status is quiescent. The server must stay idle for `quietMs` (default 100), so
     * back to back progress tokens do not resolve the wait in between; a server that never
     * reports progress resolves after the quiet period. Recorded as `server/idle`, result
     * ok or timeout. `options` may be a bare timeout in ms
     */
    waitForIdle(options?: WaitForIdleOptions | number): Promise<WaitForIdleResult>;

    /**
     * Sleep for the given number of milliseconds.
     * Useful for letting background indexing settle.
     */
    sleep(ms: number): Promise<void>;

    // ── Custom timing ───────────────────────────────────────────────────
    /**
     * Send an arbitrary LSP request and time it.
     * For methods not covered by the convenience wrappers above.
     */
    request<R>(method: string, params: unknown, label?: string): Promise<R>;

    /**
     * Send an LSP notification (not timed, since there's no response).
     */
    notify(method: string, params: unknown): void;
}

/** The shape of a user-authored action script's default export (default-exported function) */
export type ActionScript = (ctx: BenchContext) => Promise<void>;

export interface ClientHooks {
    onNotification(method: string, handler: (params: unknown) => void | Promise<void>): void;
    onRequest(method: string, handler: (params: unknown) => unknown): void;
    notify(method: string, params: unknown): void;
}

export type SetupScript = (client: ClientHooks) => void | Promise<void>;

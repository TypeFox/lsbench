// ── Server Configuration ────────────────────────────────────────────────────

export interface ServerConfig {
    /** Command to spawn the language server */
    command: string;
    /** Arguments to pass to the server command */
    args?: string[];
    /** Environment variables for the server process */
    env?: Record<string, string>;
    /** Initialization options sent during LSP initialize */
    initializationOptions?: unknown;
}

// ── CLI Options ─────────────────────────────────────────────────────────────

export interface BenchOptions {
    /** Command to spawn the language server, e.g. "typescript-language-server --stdio" */
    server: string;
    /** Path to the workspace root to benchmark against */
    workspace: string;
    /** Path to the action driver script (.ts) */
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
    /** Verbose logging */
    verbose: boolean;
    /** Milliseconds to wait for a shutdown reply before killing the server (default 5000) */
    shutdownTimeout?: number;
    /** How often a request rejected with ContentModified (-32801) is retried (default 3) */
    contentModifiedRetries?: number;
}

// ── Timing & Results ────────────────────────────────────────────────────────

/**
 * Outcome of a request: `ok` for a non empty result, `empty` for an empty list
 * (or a list wrapper such as a CompletionList with no items), `null` for a null
 * result and `error` for a rejected request
 */
export type RequestResult = 'ok' | 'empty' | 'null' | 'error';

export interface RequestTiming {
    /** LSP method name, e.g. "textDocument/hover" */
    method: string;
    /** Human label (optional, from the script) */
    label?: string;
    /** Duration in milliseconds (high-resolution) */
    duration_ms: number;
    /** Whether the request succeeded, false exactly when `result` is `error` */
    success: boolean;
    /** What the request returned */
    result: RequestResult;
    /** Error message if failed */
    error?: string;
    /** How often the request was retried after ContentModified, absent when never */
    retries?: number;
}

export interface IterationResult {
    iteration: number;
    requests: RequestTiming[];
    /** Total wall-clock time for this iteration in ms */
    total_ms: number;
}

export interface MethodStats {
    count: number;
    avg_ms: number;
    median_ms: number;
    p95_ms: number;
    p99_ms: number;
    min_ms: number;
    max_ms: number;
    stddev_ms: number;
    failure_rate: number;
    /** Share of requests that returned null */
    null_rate: number;
    /** Share of requests that returned an empty list */
    empty_rate: number;
}

export interface BenchReport {
    server: string;
    workspace: string;
    script: string;
    iterations: number;
    warmup: number;
    restart_between_iterations: boolean;
    timestamp: string;
    total_duration_ms: number;
    summary: Record<string, MethodStats>;
    iteration_summary: {
        avg_ms: number;
        median_ms: number;
        p95_ms: number;
        min_ms: number;
        max_ms: number;
    };
    runs: IterationResult[];
    /**
     * Keep alive mode only: spawn, initialize and final shutdown timings of the single
     * server, which belong to no iteration. With restart they are in each run's requests
     */
    lifecycle?: RequestTiming[];
    /** Server processes that crashed or exited unexpectedly, absent when none did */
    abnormal_exits?: AbnormalExit[];
}

export interface AbnormalExit {
    /** When the exit was seen, e.g. "iteration 3", "warmup 1" or "final teardown" */
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

/** The error of a rejected request, see `BenchContext.lastError` */
export interface RequestError {
    method: string;
    message: string;
    /** JSON-RPC error code, when the server sent one */
    code?: number;
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

    // ── Document lifecycle ──────────────────────────────────────────────
    /** Sends didOpen, with the languageId detected from the extension unless `options.languageId` is given */
    openDocument(relativePath: string, options?: OpenDocumentOptions): Promise<void>;
    closeDocument(relativePath: string): Promise<void>;
    /** Sends didSave only if the server asked for it, with the tracked text when it wants includeText */
    saveDocument(relativePath: string): Promise<void>;
    /** Sends willSave only if the server asked for it. `reason` is a TextDocumentSaveReason, default 1 (Manual) */
    willSave(relativePath: string, reason?: number): Promise<void>;
    /** Timed willSaveWaitUntil request, always sent. `reason` defaults to 1 (Manual) */
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
    codeAction(relativePath: string, range: Range, diagnosticCodes?: (string | number)[]): Promise<unknown | null>;
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
     * Wait until the server publishes diagnostics for the given file.
     * Useful after opening a document or making edits.
     */
    waitForDiagnostics(relativePath: string, timeoutMs?: number): Promise<unknown[]>;

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

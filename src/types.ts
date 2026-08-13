// ── Server Configuration ────────────────────────────────────────────────────

export interface ServerConfig {
    /** Command to spawn the language server */
    command: string;
    /** Arguments to pass to the server command */
    args?: string[];
    /** Environment variables for the server process */
    env?: Record<string, string>;
    /** Transport mechanism */
    transport?: 'stdio' | 'tcp';
    /** Port for TCP transport */
    port?: number;
    /** Initialization options sent during LSP initialize */
    initializationOptions?: unknown;
}

// ── CLI Options ─────────────────────────────────────────────────────────────

export interface BenchOptions {
    /** Path to the language server executable, or a JSON/JS config file */
    server: string;
    /** Path to the workspace root to benchmark against */
    workspace: string;
    /** Path to the action driver script (.ts or .js) */
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
    /** Verbose logging */
    verbose: boolean;
}

// ── Timing & Results ────────────────────────────────────────────────────────

export interface RequestTiming {
    /** LSP method name, e.g. "textDocument/hover" */
    method: string;
    /** Human label (optional, from the script) */
    label?: string;
    /** Duration in milliseconds (high-resolution) */
    duration_ms: number;
    /** Whether the request succeeded */
    success: boolean;
    /** Error message if failed */
    error?: string;
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

/**
 * The context object passed to user action scripts.
 * All methods that send LSP requests are automatically timed.
 */
export interface BenchContext {
    /** The workspace root URI */
    workspaceRoot: string;

    // ── Document lifecycle ──────────────────────────────────────────────
    openDocument(relativePath: string): Promise<void>;
    closeDocument(relativePath: string): Promise<void>;

    // ── Timed LSP requests ──────────────────────────────────────────────
    hover(relativePath: string, line: number, character: number): Promise<unknown | null>;
    completion(relativePath: string, line: number, character: number): Promise<unknown | null>;
    definition(relativePath: string, line: number, character: number): Promise<unknown | null>;
    references(relativePath: string, line: number, character: number): Promise<unknown | null>;
    documentSymbol(relativePath: string): Promise<unknown | null>;
    formatting(relativePath: string): Promise<unknown | null>;
    rename(relativePath: string, line: number, character: number, newName: string): Promise<unknown | null>;
    codeAction(relativePath: string, range: Range, diagnosticCodes?: (string | number)[]): Promise<unknown | null>;
    signatureHelp(relativePath: string, line: number, character: number): Promise<unknown | null>;
    typeDefinition(relativePath: string, line: number, character: number): Promise<unknown | null>;
    implementation(relativePath: string, line: number, character: number): Promise<unknown | null>;

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

/** The shape of a user-authored action script's default export */
export type ActionScript = (ctx: BenchContext) => Promise<void>;

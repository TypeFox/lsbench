import * as cp from 'node:child_process';
import * as path from 'node:path';
import * as rpc from 'vscode-jsonrpc/node';
import type { Registration, RequestTiming, ServerCapabilities, ServerConfig } from './types.js';

/** Minimal types we need from LSP (avoids cross-package type conflicts) */
interface InitializeResult {
    capabilities: ServerCapabilities;
}

interface PublishDiagnosticsParams {
    uri: string;
    diagnostics: Diagnostic[];
}

export interface Diagnostic {
    range: unknown;
    message: string;
    severity?: number;
    code?: string | number;
    source?: string;
    [key: string]: unknown;
}

/** Which save related notifications the server wants, from static and dynamic registration */
export interface SaveSyncOptions {
    /** server wants textDocument/didSave */
    didSave: boolean;
    /** didSave should carry the full document text */
    includeText: boolean;
    /** server wants textDocument/willSave */
    willSave: boolean;
    /** server wants textDocument/willSaveWaitUntil */
    willSaveWaitUntil: boolean;
}

/** default time to wait for a shutdown reply before giving up on the server */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

/** How the server process ended */
export interface ServerExit {
    code: number | null;
    signal: NodeJS.Signals | null;
    /** the server exited on its own before replying to shutdown, or with a failure after it */
    abnormal: boolean;
    /** human readable description of the exit */
    reason: string;
}

/**
 * Manages a language server process and its JSON-RPC connection.
 */
export class LspHarness {
    private process: cp.ChildProcess | null = null;
    private connection: rpc.MessageConnection | null = null;
    private diagnosticsMap = new Map<string, Diagnostic[]>();
    private diagnosticsListeners = new Map<string, Array<(diags: Diagnostic[]) => void>>();
    private _capabilities: ServerCapabilities | null = null;
    /** dynamic registrations by registration id */
    private _registrations = new Map<string, Registration>();
    private verbose: boolean;
    /** resolves once the server process has exited */
    private exited: Promise<void> = Promise.resolve();
    private _exit: ServerExit | null = null;
    /** set once the server replies to shutdown, so a following exit is expected */
    private shutdownReplied = false;
    /** set once we signal the process, so the resulting exit is not abnormal */
    private killRequested = false;
    /** lifecycle timings (spawn, initialize, shutdown) not yet taken by the runner */
    private lifecycleTimings: RequestTiming[] = [];

    constructor(
        private config: ServerConfig,
        private workspaceRoot: string,
        verbose = false,
    ) {
        this.verbose = verbose;
    }

    /** How the server process ended, or null while it is still running */
    get exit(): ServerExit | null {
        return this._exit;
    }

    get capabilities(): ServerCapabilities | null {
        return this._capabilities;
    }

    /** The dynamic registrations the server currently holds */
    get registrations(): Registration[] {
        return [...this._registrations.values()];
    }

    /** Save related sync options, merging the static textDocumentSync capability with dynamic registrations */
    saveSyncOptions(): SaveSyncOptions {
        const options = staticSaveSyncOptions(this._capabilities?.textDocumentSync);
        for (const reg of this._registrations.values()) {
            if (reg.method === 'textDocument/didSave') {
                options.didSave = true;
                if (hasIncludeText(reg.registerOptions)) {
                    options.includeText = true;
                }
            } else if (reg.method === 'textDocument/willSave') {
                options.willSave = true;
            } else if (reg.method === 'textDocument/willSaveWaitUntil') {
                options.willSaveWaitUntil = true;
            }
        }
        return options;
    }

    /** Drain and return the recorded lifecycle/spawn, lifecycle/initialize and lifecycle/shutdown timings */
    takeLifecycleTimings(): RequestTiming[] {
        const result = this.lifecycleTimings;
        this.lifecycleTimings = [];
        return result;
    }

    get conn(): rpc.MessageConnection {
        if (!this.connection) {
            throw new Error('LSP connection not initialized');
        }
        return this.connection;
    }

    /** Spawn the language server and perform LSP initialize/initialized handshake */
    async start(): Promise<void> {
        const { command, args = [], env } = this.config;

        this.log(`Spawning: ${command} ${args.join(' ')}`);
        const spawnStart = process.hrtime.bigint();

        // spawn from the current working directory, not the workspace: the server
        // command may be a path relative to cwd, while the workspace is communicated
        // to the server via rootUri/workspaceFolders in the initialize params below
        this.process = cp.spawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...env },
        });
        this._exit = null;
        this.shutdownReplied = false;
        this.killRequested = false;
        const child = this.process;
        const spawned = new Promise<void>((resolve) => child.once('spawn', () => resolve()));
        this.exited = new Promise((resolve) => {
            child.once('exit', () => resolve());
            // a process that failed to spawn never emits exit
            child.once('error', () => {
                if (child.pid === undefined) {
                    resolve();
                }
            });
        });

        // capture stderr, and retain the tail so we can report it if the server dies
        let stderrTail = '';
        this.process.stderr?.on('data', (chunk: Buffer) => {
            stderrTail = (stderrTail + chunk.toString()).slice(-4000);
            if (this.verbose) {
                process.stderr.write(`[server stderr] ${chunk.toString()}`);
            }
        });

        // reject the initialize handshake if the process dies or fails to spawn,
        // otherwise sendRequest('initialize') hangs forever with no response
        let onEarlyExit: (reason: Error) => void = () => {};
        const earlyExit = new Promise<never>((_, reject) => {
            onEarlyExit = reject;
        });

        this.process.on('error', (err) => {
            if (child.pid === undefined) {
                this._exit = { code: null, signal: null, abnormal: true, reason: `failed to spawn (${err.message})` };
            }
            onEarlyExit(new Error(`Server process failed to spawn: ${err.message}`));
        });

        this.process.on('exit', (code, signal) => {
            this.log(`Server exited: code=${code} signal=${signal}`);
            this._exit = this.describeExit(code, signal);
            onEarlyExit(
                new Error(
                    `Server exited before initialize (code=${code} signal=${signal}).` +
                        (stderrTail ? `\nServer stderr:\n${stderrTail}` : ''),
                ),
            );
        });

        // Create JSON-RPC connection over stdio
        const input = this.process.stdout!;
        const output = this.process.stdin!;
        this.connection = rpc.createMessageConnection(
            new rpc.StreamMessageReader(input),
            new rpc.StreamMessageWriter(output),
        );

        this.connection.listen();

        // Subscribe to diagnostics notifications
        this.connection.onNotification('textDocument/publishDiagnostics', (params: PublishDiagnosticsParams) => {
            this.diagnosticsMap.set(params.uri, params.diagnostics);
            const listeners = this.diagnosticsListeners.get(params.uri);
            if (listeners) {
                for (const cb of listeners) {
                    cb(params.diagnostics);
                }
                this.diagnosticsListeners.delete(params.uri);
            }
        });

        // Log window messages from the server
        this.connection.onNotification('window/logMessage', (params: { type: number; message: string }) => {
            this.log(`[server] ${params.message}`);
        });

        this.connection.onNotification('window/showMessage', (params: { type: number; message: string }) => {
            this.log(`[server msg] ${params.message}`);
        });

        // Handle workspace/configuration requests (many servers need this)
        this.connection.onRequest('workspace/configuration', (params: { items: unknown[] }) => {
            return params.items.map(() => ({}));
        });

        // acknowledge pull diagnostic refresh requests, we never cache pulled results
        this.connection.onRequest('workspace/diagnostic/refresh', () => {
            return;
        });

        // acknowledge refresh and progress requests, we hold no cached state to invalidate
        const noOpRequests = [
            'workspace/semanticTokens/refresh',
            'workspace/inlayHint/refresh',
            'workspace/codeLens/refresh',
            'workspace/inlineValue/refresh',
            'window/workDoneProgress/create',
        ];
        for (const method of noOpRequests) {
            this.connection.onRequest(method, () => null);
        }

        // accept and remember all dynamic registrations
        this.connection.onRequest('client/registerCapability', (params: { registrations?: Registration[] }) => {
            for (const reg of params.registrations ?? []) {
                this._registrations.set(reg.id, reg);
                this.log(`Registered ${reg.method}`);
            }
        });

        // the LSP spec really does spell this field 'unregisterations'
        this.connection.onRequest('client/unregisterCapability', (params: { unregisterations?: Registration[] }) => {
            for (const reg of params.unregisterations ?? []) {
                this._registrations.delete(reg.id);
            }
        });

        // no user is present to pick an action, so dismiss the prompt
        this.connection.onRequest('window/showMessageRequest', (params: { type: number; message: string }) => {
            this.log(`[server msg request] ${params.message}`);
            return null;
        });

        // lsbench never mutates the workspace on the server's behalf
        this.connection.onRequest('workspace/applyEdit', (params: { label?: string }) => {
            this.log(`[server applyEdit] declined${params.label ? `: ${params.label}` : ''}`);
            return { applied: false, failureReason: 'lsbench does not apply workspace edits' };
        });

        // time spawn up to the OS reporting the process as started
        try {
            await Promise.race([spawned, earlyExit]);
            this.recordLifecycle('lifecycle/spawn', spawnStart);
        } catch (err: unknown) {
            this.recordLifecycle('lifecycle/spawn', spawnStart, err);
            throw err;
        }

        // Perform LSP initialize
        const workspaceUri = pathToUri(this.workspaceRoot);

        const initParams = {
            processId: process.pid,
            rootUri: workspaceUri,
            rootPath: this.workspaceRoot,
            workspaceFolders: [{ uri: workspaceUri, name: path.basename(this.workspaceRoot) }],
            capabilities: mergeCapabilities(defaultClientCapabilities(), this.config.clientCapabilities ?? {}),
            initializationOptions: this.config.initializationOptions ?? {},
        };

        this.log('Sending initialize...');
        // race the handshake against an early process exit so a server that dies
        // (bad command, missing module, crash on startup) surfaces as a rejection
        // instead of hanging on a response that will never come
        const initStart = process.hrtime.bigint();
        let result: InitializeResult;
        try {
            result = (await Promise.race([
                this.connection.sendRequest('initialize', initParams),
                earlyExit,
            ])) as InitializeResult;
            this.recordLifecycle('lifecycle/initialize', initStart);
        } catch (err: unknown) {
            this.recordLifecycle('lifecycle/initialize', initStart, err);
            throw err;
        }
        this._capabilities = result.capabilities;

        // Send initialized notification
        this.connection.sendNotification('initialized', {});
        this.log('Server initialized.');
    }

    /**
     * Shut down the server, always settling: the shutdown request is raced against
     * the process exiting and a timeout, then the server is sent exit and killed if
     * it is still running. Returns how the process ended.
     */
    async stop(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<ServerExit | null> {
        const connection = this.connection;
        const child = this.process;
        if (!connection) {
            return this._exit;
        }

        if (!this._exit) {
            const shutdownStart = process.hrtime.bigint();
            const shutdown = connection.sendRequest('shutdown').then(
                () => {
                    this.shutdownReplied = true;
                    return 'replied' as const;
                },
                () => 'failed' as const,
            );
            const outcome = await raceTimeout([shutdown, this.exited.then(() => 'exited' as const)], timeoutMs);
            // time shutdown from request to reply, or to however it failed
            const shutdownErrors = {
                replied: undefined,
                failed: new Error('shutdown request failed'),
                exited: new Error('server exited before replying to shutdown'),
                timeout: new Error(`no shutdown reply within ${timeoutMs}ms`),
            };
            this.recordLifecycle('lifecycle/shutdown', shutdownStart, shutdownErrors[outcome]);
            if (outcome === 'replied') {
                try {
                    await connection.sendNotification('exit');
                } catch {
                    // the server may have closed its input already
                }
                // give the server a moment to exit on its own before signaling it
                await raceTimeout([this.exited], Math.min(timeoutMs, 1000));
            } else if (outcome === 'timeout') {
                this.log(`No shutdown reply within ${timeoutMs}ms, killing the server`);
            }
        }

        connection.dispose();
        this.connection = null;

        if (child && !this._exit) {
            this.killRequested = true;
            child.kill('SIGTERM');
            // force kill a server that ignores SIGTERM, `killed` only reports that a
            // signal was sent, so check the recorded exit instead
            if ((await raceTimeout([this.exited], 3000)) === 'timeout') {
                child.kill('SIGKILL');
                await this.exited;
            }
        }
        this.process = null;
        this.diagnosticsMap.clear();
        this.diagnosticsListeners.clear();
        this._registrations.clear();
        return this._exit;
    }

    /** Record a lifecycle timing from startNs to now, failed when error is given */
    private recordLifecycle(method: string, startNs: bigint, error?: unknown): void {
        const ms = Number(process.hrtime.bigint() - startNs) / 1_000_000;
        const timing: RequestTiming = {
            method,
            duration_ms: Math.round(ms * 1000) / 1000,
            success: error === undefined,
            // lifecycle steps have no meaningful payload (shutdown even replies null by spec)
            result: error === undefined ? 'ok' : 'error',
        };
        if (error !== undefined) {
            timing.error = (error instanceof Error ? error.message : String(error)).split('\n')[0];
        }
        this.lifecycleTimings.push(timing);
    }

    /** Classify a process exit, signals we sent and a clean exit after shutdown are normal */
    private describeExit(code: number | null, signal: NodeJS.Signals | null): ServerExit {
        const status = signal ? `signal ${signal}` : `code ${code}`;
        if (this.killRequested) {
            return { code, signal, abnormal: false, reason: `killed by lsbench (${status})` };
        }
        if (!this.shutdownReplied) {
            return { code, signal, abnormal: true, reason: `exited unexpectedly (${status})` };
        }
        if (code !== 0) {
            return { code, signal, abnormal: true, reason: `exited after shutdown with ${status}` };
        }
        return { code, signal, abnormal: false, reason: 'exited cleanly' };
    }

    /** Get cached diagnostics for a URI */
    getDiagnostics(uri: string): Diagnostic[] {
        return this.diagnosticsMap.get(uri) ?? [];
    }

    /** Wait for the next diagnostics publication for a URI */
    onDiagnostics(uri: string, timeoutMs: number): Promise<Diagnostic[]> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const existing = this.diagnosticsMap.get(uri);
                resolve(existing ?? []);
            }, timeoutMs);

            const listeners = this.diagnosticsListeners.get(uri) ?? [];
            listeners.push((diags) => {
                clearTimeout(timer);
                resolve(diags);
            });
            this.diagnosticsListeners.set(uri, listeners);
        });
    }

    /** Send a typed LSP request */
    async sendRequest<R>(method: string, params: unknown): Promise<R> {
        return this.conn.sendRequest(method, params) as Promise<R>;
    }

    /** Send an LSP notification */
    sendNotification(method: string, params: unknown): void {
        this.conn.sendNotification(method, params);
    }

    private log(msg: string): void {
        if (this.verbose) {
            console.error(`[lsbench] ${msg}`);
        }
    }
}

/**
 * The client capabilities lsbench advertises by default, modeled on what
 * VS Code sends. ServerConfig.clientCapabilities is deep merged over these.
 */
export function defaultClientCapabilities(): Record<string, unknown> {
    return {
        workspace: {
            workspaceFolders: true,
            configuration: true,
            didChangeConfiguration: { dynamicRegistration: true },
        // advertised so servers rely on the client for file watching, as they do under VS Code;
        // the resulting registrations are tracked but no file events are ever sent
        didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
            symbol: {
                dynamicRegistration: true,
                symbolKind: {
                    valueSet: Array.from({ length: 26 }, (_, i) => i + 1),
                },
                resolveSupport: { properties: ['location.range'] },
            },
        },
        textDocument: {
            synchronization: {
                dynamicRegistration: true,
                willSave: true,
                willSaveWaitUntil: true,
                didSave: true,
            },
            hover: {
                dynamicRegistration: true,
                contentFormat: ['markdown', 'plaintext'],
            },
            completion: {
                dynamicRegistration: true,
                completionItem: {
                    snippetSupport: true,
                    commitCharactersSupport: true,
                    documentationFormat: ['markdown', 'plaintext'],
                    resolveSupport: {
                        properties: ['documentation', 'detail', 'additionalTextEdits'],
                    },
                },
                contextSupport: true,
            },
            definition: { dynamicRegistration: true, linkSupport: true },
            declaration: { dynamicRegistration: true, linkSupport: true },
            typeDefinition: { dynamicRegistration: true, linkSupport: true },
            implementation: { dynamicRegistration: true, linkSupport: true },
            references: { dynamicRegistration: true },
            documentHighlight: { dynamicRegistration: true },
            documentSymbol: {
                dynamicRegistration: true,
                hierarchicalDocumentSymbolSupport: true,
                symbolKind: {
                    valueSet: Array.from({ length: 26 }, (_, i) => i + 1),
                },
            },
            formatting: { dynamicRegistration: true },
            rangeFormatting: { dynamicRegistration: true },
            onTypeFormatting: { dynamicRegistration: true },
            rename: { dynamicRegistration: true, prepareSupport: true },
            codeAction: {
                dynamicRegistration: true,
                codeActionLiteralSupport: {
                    codeActionKind: {
                        valueSet: [
                            '',
                            'quickfix',
                            'refactor',
                            'refactor.extract',
                            'refactor.inline',
                            'refactor.rewrite',
                            'source',
                            'source.organizeImports',
                        ],
                    },
                },
                dataSupport: true,
                resolveSupport: { properties: ['edit'] },
            },
            signatureHelp: {
                dynamicRegistration: true,
                signatureInformation: {
                    documentationFormat: ['markdown', 'plaintext'],
                    parameterInformation: { labelOffsetSupport: true },
                },
            },
            foldingRange: { dynamicRegistration: true, lineFoldingOnly: false },
            selectionRange: { dynamicRegistration: true },
            documentLink: { dynamicRegistration: true, tooltipSupport: true },
            codeLens: { dynamicRegistration: true },
            inlayHint: {
                dynamicRegistration: true,
                resolveSupport: {
                    properties: ['tooltip', 'textEdits', 'label.tooltip', 'label.location', 'label.command'],
                },
            },
            callHierarchy: { dynamicRegistration: true },
            typeHierarchy: { dynamicRegistration: true },
            semanticTokens: {
                dynamicRegistration: true,
                requests: {
                    range: true,
                    full: { delta: true },
                },
                tokenTypes: [
                    'namespace',
                    'type',
                    'class',
                    'enum',
                    'interface',
                    'struct',
                    'typeParameter',
                    'parameter',
                    'variable',
                    'property',
                    'enumMember',
                    'event',
                    'function',
                    'method',
                    'macro',
                    'keyword',
                    'modifier',
                    'comment',
                    'string',
                    'number',
                    'regexp',
                    'operator',
                    'decorator',
                ],
                tokenModifiers: [
                    'declaration',
                    'definition',
                    'readonly',
                    'static',
                    'deprecated',
                    'abstract',
                    'async',
                    'modification',
                    'documentation',
                    'defaultLibrary',
                ],
                formats: ['relative'],
                overlappingTokenSupport: false,
                multilineTokenSupport: false,
            },
            // textDocument.diagnostic is intentionally not advertised: some servers switch
            // from push to pull diagnostics when it is present, which breaks waitForDiagnostics
            publishDiagnostics: {
                relatedInformation: true,
                tagSupport: { valueSet: [1, 2] },
            },
        },
    };
}

/**
 * Deep merge `override` over `base` without mutating either: plain objects merge
 * recursively, arrays and scalars in `override` replace the value in `base`.
 */
export function mergeCapabilities(
    base: Record<string, unknown>,
    override: Record<string, unknown>,
): Record<string, unknown> {
    const result: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
        const current = result[key];
        if (isPlainObject(current) && isPlainObject(value)) {
            result[key] = mergeCapabilities(current, value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads save options from a static textDocumentSync capability. A bare TextDocumentSyncKind
 * number implies didSave without text, matching vscode-languageclient.
 */
function staticSaveSyncOptions(sync: unknown): SaveSyncOptions {
    const options: SaveSyncOptions = { didSave: false, includeText: false, willSave: false, willSaveWaitUntil: false };
    if (typeof sync === 'number') {
        options.didSave = true;
    } else if (typeof sync === 'object' && sync !== null) {
        const { save, willSave, willSaveWaitUntil } = sync as {
            save?: unknown;
            willSave?: unknown;
            willSaveWaitUntil?: unknown;
        };
        if (save === true) {
            options.didSave = true;
        } else if (typeof save === 'object' && save !== null) {
            options.didSave = true;
            options.includeText = hasIncludeText(save);
        }
        options.willSave = willSave === true;
        options.willSaveWaitUntil = willSaveWaitUntil === true;
    }
    return options;
}

function hasIncludeText(options: unknown): boolean {
    return (
        typeof options === 'object' && options !== null && (options as { includeText?: unknown }).includeText === true
    );
}

/** Convert an absolute file path to a file:// URI */
export function pathToUri(filePath: string): string {
    const resolved = path.resolve(filePath);
    return `file://${resolved}`;
}

/** Convert a file:// URI back to an absolute path */
export function uriToPath(uri: string): string {
    if (uri.startsWith('file://')) {
        return uri.slice(7);
    }
    return uri;
}

/** Resolve with the first promise to settle, or 'timeout' once timeoutMs has passed */
async function raceTimeout<T>(promises: Array<Promise<T>>, timeoutMs: number): Promise<T | 'timeout'> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
        return await Promise.race([...promises, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

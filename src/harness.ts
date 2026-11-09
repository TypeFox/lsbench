import * as cp from 'node:child_process';
import * as path from 'node:path';
import * as rpc from 'vscode-jsonrpc/node';
import type { ServerConfig } from './types.js';

/** Minimal types we need from LSP (avoids cross-package type conflicts) */
interface ServerCapabilities {
    [key: string]: unknown;
}

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

interface Registration {
    id: string;
    method: string;
    registerOptions?: unknown;
}

/** save related methods whose dynamic registrations we track */
const SAVE_METHODS = new Set(['textDocument/didSave', 'textDocument/willSave', 'textDocument/willSaveWaitUntil']);

/**
 * Manages a language server process and its JSON-RPC connection.
 */
export class LspHarness {
    private process: cp.ChildProcess | null = null;
    private connection: rpc.MessageConnection | null = null;
    private diagnosticsMap = new Map<string, Diagnostic[]>();
    private diagnosticsListeners = new Map<string, Array<(diags: Diagnostic[]) => void>>();
    private _capabilities: ServerCapabilities | null = null;
    /** dynamic save registrations by registration id */
    private saveRegistrations = new Map<string, Registration>();
    private verbose: boolean;

    constructor(
        private config: ServerConfig,
        private workspaceRoot: string,
        verbose = false,
    ) {
        this.verbose = verbose;
    }

    get capabilities(): ServerCapabilities | null {
        return this._capabilities;
    }

    /** Save related sync options, merging the static textDocumentSync capability with dynamic registrations */
    saveSyncOptions(): SaveSyncOptions {
        const options = staticSaveSyncOptions(this._capabilities?.textDocumentSync);
        for (const reg of this.saveRegistrations.values()) {
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

        // spawn from the current working directory, not the workspace: the server
        // command may be a path relative to cwd, while the workspace is communicated
        // to the server via rootUri/workspaceFolders in the initialize params below
        this.process = cp.spawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...env },
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
            onEarlyExit(new Error(`Server process failed to spawn: ${err.message}`));
        });

        this.process.on('exit', (code, signal) => {
            this.log(`Server exited: code=${code} signal=${signal}`);
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

        // accept all dynamic registrations, remembering save related ones
        this.connection.onRequest('client/registerCapability', (params: { registrations?: Registration[] }) => {
            for (const reg of params.registrations ?? []) {
                if (SAVE_METHODS.has(reg.method)) {
                    this.saveRegistrations.set(reg.id, reg);
                }
            }
        });

        // the LSP spec really does spell this field 'unregisterations'
        this.connection.onRequest('client/unregisterCapability', (params: { unregisterations?: Registration[] }) => {
            for (const reg of params.unregisterations ?? []) {
                this.saveRegistrations.delete(reg.id);
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

        // Perform LSP initialize
        const workspaceUri = pathToUri(this.workspaceRoot);

        const initParams = {
            processId: process.pid,
            rootUri: workspaceUri,
            rootPath: this.workspaceRoot,
            workspaceFolders: [{ uri: workspaceUri, name: path.basename(this.workspaceRoot) }],
            capabilities: this.clientCapabilities(),
            initializationOptions: this.config.initializationOptions ?? {},
        };

        this.log('Sending initialize...');
        // race the handshake against an early process exit so a server that dies
        // (bad command, missing module, crash on startup) surfaces as a rejection
        // instead of hanging on a response that will never come
        const result = (await Promise.race([
            this.connection.sendRequest('initialize', initParams),
            earlyExit,
        ])) as InitializeResult;
        this._capabilities = result.capabilities;

        // Send initialized notification
        this.connection.sendNotification('initialized', {});
        this.log('Server initialized.');
    }

    /** Gracefully shut down the server */
    async stop(): Promise<void> {
        if (!this.connection) {
            return;
        }

        try {
            await this.connection.sendRequest('shutdown');
            this.connection.sendNotification('exit');
        } catch {
            // Server may have already exited
        }

        this.connection.dispose();
        this.connection = null;

        // `killed` only reports that a signal was sent, so check whether the process
        // actually exited; otherwise a server ignoring SIGTERM is never force killed
        const child = this.process;
        const hasExited = () => child !== null && (child.exitCode !== null || child.signalCode !== null);
        if (child && !hasExited()) {
            await new Promise<void>((resolve) => {
                // give it a moment after SIGTERM, then force kill and wait for the exit
                const timer = setTimeout(() => {
                    if (!hasExited()) {
                        child.kill('SIGKILL');
                    }
                }, 3000);
                child.once('exit', () => {
                    clearTimeout(timer);
                    resolve();
                });
                child.kill('SIGTERM');
            });
        }
        this.process = null;
        this.diagnosticsMap.clear();
        this.diagnosticsListeners.clear();
        this.saveRegistrations.clear();
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

    /** Build comprehensive client capabilities */
    private clientCapabilities(): Record<string, unknown> {
        return {
            workspace: {
                workspaceFolders: true,
                configuration: true,
                didChangeConfiguration: { dynamicRegistration: true },
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

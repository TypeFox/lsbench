import * as cp from "node:child_process";
import * as path from "node:path";
import * as rpc from "vscode-jsonrpc/node";
import type { ServerConfig } from "./types";

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

/**
 * Manages a language server process and its JSON-RPC connection.
 */
export class LspHarness {
  private process: cp.ChildProcess | null = null;
  private connection: rpc.MessageConnection | null = null;
  private diagnosticsMap = new Map<string, Diagnostic[]>();
  private diagnosticsListeners = new Map<
    string,
    Array<(diags: Diagnostic[]) => void>
  >();
  private _capabilities: ServerCapabilities | null = null;
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

  get conn(): rpc.MessageConnection {
    if (!this.connection) {
      throw new Error("LSP connection not initialized");
    }
    return this.connection;
  }

  /** Spawn the language server and perform LSP initialize/initialized handshake */
  async start(): Promise<void> {
    const { command, args = [], env } = this.config;

    this.log(`Spawning: ${command} ${args.join(" ")}`);

    this.process = cp.spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.workspaceRoot,
      env: { ...process.env, ...env },
    });

    // Capture stderr for debugging
    this.process.stderr?.on("data", (chunk: Buffer) => {
      if (this.verbose) {
        process.stderr.write(`[server stderr] ${chunk.toString()}`);
      }
    });

    this.process.on("error", (err) => {
      console.error(`[lsbench] Server process error: ${err.message}`);
    });

    this.process.on("exit", (code, signal) => {
      this.log(`Server exited: code=${code} signal=${signal}`);
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
    this.connection.onNotification(
      "textDocument/publishDiagnostics",
      (params: PublishDiagnosticsParams) => {
        this.diagnosticsMap.set(params.uri, params.diagnostics);
        const listeners = this.diagnosticsListeners.get(params.uri);
        if (listeners) {
          for (const cb of listeners) {
            cb(params.diagnostics);
          }
          this.diagnosticsListeners.delete(params.uri);
        }
      },
    );

    // Log window messages from the server
    this.connection.onNotification(
      "window/logMessage",
      (params: { type: number; message: string }) => {
        this.log(`[server] ${params.message}`);
      },
    );

    this.connection.onNotification(
      "window/showMessage",
      (params: { type: number; message: string }) => {
        this.log(`[server msg] ${params.message}`);
      },
    );

    // Handle workspace/configuration requests (many servers need this)
    this.connection.onRequest(
      "workspace/configuration",
      (params: { items: unknown[] }) => {
        return params.items.map(() => ({}));
      },
    );

    // Handle client/registerCapability (dynamic registration)
    this.connection.onRequest("client/registerCapability", () => {
      return; // Accept all registrations
    });

    // Perform LSP initialize
    const workspaceUri = pathToUri(this.workspaceRoot);

    const initParams = {
      processId: process.pid,
      rootUri: workspaceUri,
      rootPath: this.workspaceRoot,
      workspaceFolders: [
        { uri: workspaceUri, name: path.basename(this.workspaceRoot) },
      ],
      capabilities: this.clientCapabilities(),
      initializationOptions: this.config.initializationOptions ?? {},
    };

    this.log("Sending initialize...");
    const result = (await this.connection.sendRequest(
      "initialize",
      initParams,
    )) as InitializeResult;
    this._capabilities = result.capabilities;

    // Send initialized notification
    this.connection.sendNotification("initialized", {});
    this.log("Server initialized.");
  }

  /** Gracefully shut down the server */
  async stop(): Promise<void> {
    if (!this.connection) {
      return;
    }

    try {
      await this.connection.sendRequest("shutdown");
      this.connection.sendNotification("exit");
    } catch {
      // Server may have already exited
    }

    this.connection.dispose();
    this.connection = null;

    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
      // Give it a moment, then force kill
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (this.process && !this.process.killed) {
            this.process.kill("SIGKILL");
          }
          resolve();
        }, 3000);
        this.process?.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.process = null;
    this.diagnosticsMap.clear();
    this.diagnosticsListeners.clear();
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
          contentFormat: ["markdown", "plaintext"],
        },
        completion: {
          dynamicRegistration: true,
          completionItem: {
            snippetSupport: true,
            commitCharactersSupport: true,
            documentationFormat: ["markdown", "plaintext"],
            resolveSupport: {
              properties: ["documentation", "detail", "additionalTextEdits"],
            },
          },
          contextSupport: true,
        },
        definition: { dynamicRegistration: true, linkSupport: true },
        typeDefinition: { dynamicRegistration: true, linkSupport: true },
        implementation: { dynamicRegistration: true, linkSupport: true },
        references: { dynamicRegistration: true },
        documentSymbol: {
          dynamicRegistration: true,
          hierarchicalDocumentSymbolSupport: true,
          symbolKind: {
            valueSet: Array.from({ length: 26 }, (_, i) => i + 1),
          },
        },
        formatting: { dynamicRegistration: true },
        rename: { dynamicRegistration: true, prepareSupport: true },
        codeAction: {
          dynamicRegistration: true,
          codeActionLiteralSupport: {
            codeActionKind: {
              valueSet: [
                "",
                "quickfix",
                "refactor",
                "refactor.extract",
                "refactor.inline",
                "refactor.rewrite",
                "source",
                "source.organizeImports",
              ],
            },
          },
        },
        signatureHelp: {
          dynamicRegistration: true,
          signatureInformation: {
            documentationFormat: ["markdown", "plaintext"],
            parameterInformation: { labelOffsetSupport: true },
          },
        },
        publishDiagnostics: {
          relatedInformation: true,
          tagSupport: { valueSet: [1, 2] },
        },
      },
    };
  }
}

/** Convert an absolute file path to a file:// URI */
export function pathToUri(filePath: string): string {
  const resolved = path.resolve(filePath);
  return `file://${resolved}`;
}

/** Convert a file:// URI back to an absolute path */
export function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) {
    return uri.slice(7);
  }
  return uri;
}

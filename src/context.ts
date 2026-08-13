import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Diagnostic, type LspHarness, pathToUri } from './harness.js';
import type { BenchContext, EditOperation, Range, RequestTiming } from './types.js';

/**
 * Concrete implementation of BenchContext.
 * Each LSP request is timed with high-resolution timers.
 * Accumulated timings are collected after each iteration.
 */
export class BenchContextImpl implements BenchContext {
    readonly workspaceRoot: string;
    private harness: LspHarness;
    private timings: RequestTiming[] = [];
    private openDocuments = new Map<string, { uri: string; version: number; text: string }>();
    private verbose: boolean;

    constructor(harness: LspHarness, workspaceRoot: string, verbose = false) {
        this.harness = harness;
        this.workspaceRoot = workspaceRoot;
        this.verbose = verbose;
    }

    /** Drain and return all collected timings, resetting for the next iteration */
    collectTimings(): RequestTiming[] {
        const result = [...this.timings];
        this.timings = [];
        return result;
    }

    /** Reset open document state (e.g. between iterations without restart) */
    async resetDocuments(): Promise<void> {
        for (const [, doc] of this.openDocuments) {
            try {
                this.harness.sendNotification('textDocument/didClose', {
                    textDocument: { uri: doc.uri },
                });
            } catch {
                // ignore
            }
        }
        this.openDocuments.clear();
    }

    // ── Document lifecycle ──────────────────────────────────────────────

    async openDocument(relativePath: string): Promise<void> {
        const absPath = path.resolve(this.workspaceRoot, relativePath);
        const uri = pathToUri(absPath);

        if (this.openDocuments.has(relativePath)) {
            return; // Already open
        }

        const text = fs.readFileSync(absPath, 'utf-8');
        const languageId = detectLanguageId(absPath);

        const doc = { uri, version: 1, text };
        this.openDocuments.set(relativePath, doc);

        this.harness.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri,
                languageId,
                version: doc.version,
                text,
            },
        });

        this.log(`Opened ${relativePath} (${languageId})`);
    }

    async closeDocument(relativePath: string): Promise<void> {
        const doc = this.openDocuments.get(relativePath);
        if (!doc) {
            return;
        }

        this.harness.sendNotification('textDocument/didClose', {
            textDocument: { uri: doc.uri },
        });

        this.openDocuments.delete(relativePath);
        this.log(`Closed ${relativePath}`);
    }

    // ── Timed LSP requests ──────────────────────────────────────────────

    async hover(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/hover', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    async completion(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/completion', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    async definition(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/definition', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    async references(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/references', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
            context: { includeDeclaration: true },
        });
    }

    async documentSymbol(relativePath: string): Promise<unknown | null> {
        return this.timedRequest('textDocument/documentSymbol', {
            textDocument: { uri: this.getUri(relativePath) },
        });
    }

    async formatting(relativePath: string): Promise<unknown | null> {
        return this.timedRequest('textDocument/formatting', {
            textDocument: { uri: this.getUri(relativePath) },
            options: { tabSize: 2, insertSpaces: true },
        });
    }

    async rename(relativePath: string, line: number, character: number, newName: string): Promise<unknown | null> {
        return this.timedRequest('textDocument/rename', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
            newName,
        });
    }

    async codeAction(
        relativePath: string,
        range: Range,
        diagnosticCodes?: (string | number)[],
    ): Promise<unknown | null> {
        const uri = this.getUri(relativePath);
        const diagnostics = diagnosticCodes
            ? this.harness.getDiagnostics(uri).filter((d) => diagnosticCodes.includes(d.code as string | number))
            : [];

        return this.timedRequest('textDocument/codeAction', {
            textDocument: { uri },
            range: toLspRange(range),
            context: { diagnostics },
        });
    }

    async signatureHelp(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/signatureHelp', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    async typeDefinition(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/typeDefinition', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    async implementation(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/implementation', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    // ── Document mutations ──────────────────────────────────────────────

    async edit(relativePath: string, edits: EditOperation | EditOperation[]): Promise<void> {
        const doc = this.openDocuments.get(relativePath);
        if (!doc) {
            throw new Error(`Document ${relativePath} is not open. Call openDocument() first.`);
        }

        const editArray = Array.isArray(edits) ? edits : [edits];
        doc.version++;

        const contentChanges: { range: unknown; text: string }[] = editArray.map((e) => ({
            range: toLspRange(e.range),
            text: e.text,
        }));

        // Apply edits to our local copy of the text (simplified: just for version tracking)
        // A more precise implementation would apply the actual text edits
        this.harness.sendNotification('textDocument/didChange', {
            textDocument: { uri: doc.uri, version: doc.version },
            contentChanges,
        });
    }

    // ── Synchronization helpers ─────────────────────────────────────────

    async waitForDiagnostics(relativePath: string, timeoutMs = 30000): Promise<Diagnostic[]> {
        const uri = this.getUri(relativePath);
        return this.harness.onDiagnostics(uri, timeoutMs);
    }

    async sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // ── Custom timing ───────────────────────────────────────────────────

    async request<R>(method: string, params: unknown, label?: string): Promise<R> {
        return this.timedRequest<R>(method, params, label);
    }

    notify(method: string, params: unknown): void {
        this.harness.sendNotification(method, params);
    }

    // ── Internal helpers ────────────────────────────────────────────────

    private getUri(relativePath: string): string {
        const doc = this.openDocuments.get(relativePath);
        if (doc) {
            return doc.uri;
        }
        // If not opened yet, compute the URI anyway
        return pathToUri(path.resolve(this.workspaceRoot, relativePath));
    }

    private async timedRequest<R>(method: string, params: unknown, label?: string): Promise<R> {
        const start = process.hrtime.bigint();
        let success = true;
        let error: string | undefined;
        let result: R;

        try {
            result = await this.harness.sendRequest<R>(method, params);
        } catch (err: unknown) {
            success = false;
            error = err instanceof Error ? err.message : String(err);
            result = null as R;
        }

        const end = process.hrtime.bigint();
        const duration_ms = Number(end - start) / 1_000_000; // nanoseconds → milliseconds

        this.timings.push({
            method,
            label,
            duration_ms: Math.round(duration_ms * 1000) / 1000, // 3 decimal places
            success,
            error,
        });

        this.log(
            `${method}${label ? ` [${label}]` : ''}: ${duration_ms.toFixed(1)}ms${success ? '' : ` ERROR: ${error}`}`,
        );

        return result;
    }

    private log(msg: string): void {
        if (this.verbose) {
            console.error(`  [ctx] ${msg}`);
        }
    }
}

// ── Utilities ─────────────────────────────────────────────────────────────

function toLspRange(range: Range): {
    start: { line: number; character: number };
    end: { line: number; character: number };
} {
    return {
        start: { line: range.start.line, character: range.start.character },
        end: { line: range.end.line, character: range.end.character },
    };
}

function detectLanguageId(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string, string> = {
        '.ts': 'typescript',
        '.tsx': 'typescriptreact',
        '.js': 'javascript',
        '.jsx': 'javascriptreact',
        '.json': 'json',
        '.html': 'html',
        '.css': 'css',
        '.scss': 'scss',
        '.less': 'less',
        '.vue': 'vue',
        '.svelte': 'svelte',
        '.py': 'python',
        '.rs': 'rust',
        '.go': 'go',
        '.java': 'java',
        '.c': 'c',
        '.cpp': 'cpp',
        '.h': 'c',
        '.hpp': 'cpp',
        '.cs': 'csharp',
        '.rb': 'ruby',
        '.php': 'php',
        '.swift': 'swift',
        '.kt': 'kotlin',
        '.md': 'markdown',
        '.yaml': 'yaml',
        '.yml': 'yaml',
        '.toml': 'toml',
        '.xml': 'xml',
        '.sql': 'sql',
        '.sh': 'shellscript',
        '.bash': 'shellscript',
        '.zsh': 'shellscript',
        '.lua': 'lua',
        '.zig': 'zig',
        '.ex': 'elixir',
        '.exs': 'elixir',
        '.ipl': 'ipl',
        '.ipld': 'ipl',
    };
    return map[ext] ?? 'plaintext';
}

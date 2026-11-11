import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Diagnostic, type LspHarness, pathToUri } from './harness.js';
import type { BenchContext, EditOperation, OpenDocumentOptions, Position, Range, RequestTiming } from './types.js';

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

    async openDocument(relativePath: string, options?: OpenDocumentOptions): Promise<void> {
        const absPath = path.resolve(this.workspaceRoot, relativePath);
        const uri = pathToUri(absPath);

        if (this.openDocuments.has(relativePath)) {
            return; // Already open
        }

        const text = fs.readFileSync(absPath, 'utf-8');
        const languageId = options?.languageId ?? detectLanguageId(absPath);

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

    async saveDocument(relativePath: string): Promise<void> {
        const doc = this.getOpenDocument(relativePath);
        const { didSave, includeText } = this.harness.saveSyncOptions();
        if (!didSave) {
            this.log(`Skipped didSave for ${relativePath}: server did not ask for it`);
            return;
        }

        this.harness.sendNotification('textDocument/didSave', {
            textDocument: { uri: doc.uri },
            ...(includeText ? { text: doc.text } : {}),
        });

        this.log(`Saved ${relativePath}`);
    }

    async willSave(relativePath: string, reason = 1): Promise<void> {
        const doc = this.getOpenDocument(relativePath);
        if (!this.harness.saveSyncOptions().willSave) {
            this.log(`Skipped willSave for ${relativePath}: server did not ask for it`);
            return;
        }

        this.harness.sendNotification('textDocument/willSave', {
            textDocument: { uri: doc.uri },
            reason,
        });
    }

    // always sent, since the caller explicitly asked for it to be timed
    async willSaveWaitUntil(relativePath: string, reason = 1): Promise<unknown | null> {
        const doc = this.getOpenDocument(relativePath);
        return this.timedRequest('textDocument/willSaveWaitUntil', {
            textDocument: { uri: doc.uri },
            reason,
        });
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
            options: FORMATTING_OPTIONS,
        });
    }

    async rangeFormatting(relativePath: string, range: Range): Promise<unknown | null> {
        return this.timedRequest('textDocument/rangeFormatting', {
            textDocument: { uri: this.getUri(relativePath) },
            range: toLspRange(range),
            options: FORMATTING_OPTIONS,
        });
    }

    async onTypeFormatting(relativePath: string, line: number, character: number, ch: string): Promise<unknown | null> {
        return this.timedRequest('textDocument/onTypeFormatting', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
            ch,
            options: FORMATTING_OPTIONS,
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
            ? filterDiagnosticsByCode(this.harness.getDiagnostics(uri), diagnosticCodes)
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

    async declaration(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/declaration', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    async documentHighlight(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/documentHighlight', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    async prepareRename(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/prepareRename', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    async foldingRange(relativePath: string): Promise<unknown | null> {
        return this.timedRequest('textDocument/foldingRange', {
            textDocument: { uri: this.getUri(relativePath) },
        });
    }

    async selectionRange(relativePath: string, positions: Position[]): Promise<unknown | null> {
        return this.timedRequest('textDocument/selectionRange', {
            textDocument: { uri: this.getUri(relativePath) },
            positions: positions.map((p) => ({ line: p.line, character: p.character })),
        });
    }

    async documentLink(relativePath: string): Promise<unknown | null> {
        return this.timedRequest('textDocument/documentLink', {
            textDocument: { uri: this.getUri(relativePath) },
        });
    }

    async codeLens(relativePath: string): Promise<unknown | null> {
        return this.timedRequest('textDocument/codeLens', {
            textDocument: { uri: this.getUri(relativePath) },
        });
    }

    async inlayHint(relativePath: string, range: Range): Promise<unknown | null> {
        return this.timedRequest('textDocument/inlayHint', {
            textDocument: { uri: this.getUri(relativePath) },
            range: toLspRange(range),
        });
    }

    async semanticTokensFull(relativePath: string): Promise<unknown | null> {
        return this.timedRequest('textDocument/semanticTokens/full', {
            textDocument: { uri: this.getUri(relativePath) },
        });
    }

    async semanticTokensRange(relativePath: string, range: Range): Promise<unknown | null> {
        return this.timedRequest('textDocument/semanticTokens/range', {
            textDocument: { uri: this.getUri(relativePath) },
            range: toLspRange(range),
        });
    }

    async semanticTokensDelta(relativePath: string, previousResultId: string): Promise<unknown | null> {
        return this.timedRequest('textDocument/semanticTokens/full/delta', {
            textDocument: { uri: this.getUri(relativePath) },
            previousResultId,
        });
    }

    async workspaceSymbol(query: string): Promise<unknown | null> {
        return this.timedRequest('workspace/symbol', { query });
    }

    async prepareCallHierarchy(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/prepareCallHierarchy', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    async callHierarchyIncomingCalls(item: unknown): Promise<unknown | null> {
        return this.timedRequest('callHierarchy/incomingCalls', { item });
    }

    async callHierarchyOutgoingCalls(item: unknown): Promise<unknown | null> {
        return this.timedRequest('callHierarchy/outgoingCalls', { item });
    }

    async prepareTypeHierarchy(relativePath: string, line: number, character: number): Promise<unknown | null> {
        return this.timedRequest('textDocument/prepareTypeHierarchy', {
            textDocument: { uri: this.getUri(relativePath) },
            position: { line, character },
        });
    }

    async typeHierarchySupertypes(item: unknown): Promise<unknown | null> {
        return this.timedRequest('typeHierarchy/supertypes', { item });
    }

    async typeHierarchySubtypes(item: unknown): Promise<unknown | null> {
        return this.timedRequest('typeHierarchy/subtypes', { item });
    }

    async documentDiagnostic(relativePath: string, previousResultId?: string): Promise<unknown | null> {
        return this.timedRequest('textDocument/diagnostic', {
            textDocument: { uri: this.getUri(relativePath) },
            ...(previousResultId !== undefined ? { previousResultId } : {}),
        });
    }

    async workspaceDiagnostic(previousResultIds: { uri: string; value: string }[] = []): Promise<unknown | null> {
        return this.timedRequest('workspace/diagnostic', { previousResultIds });
    }

    // resolve requests send the raw item from a prior request as the params, unwrapped
    async completionItemResolve(item: unknown): Promise<unknown | null> {
        return this.timedRequest('completionItem/resolve', item);
    }

    async codeLensResolve(codeLens: unknown): Promise<unknown | null> {
        return this.timedRequest('codeLens/resolve', codeLens);
    }

    async inlayHintResolve(hint: unknown): Promise<unknown | null> {
        return this.timedRequest('inlayHint/resolve', hint);
    }

    async codeActionResolve(action: unknown): Promise<unknown | null> {
        return this.timedRequest('codeAction/resolve', action);
    }

    async documentLinkResolve(link: unknown): Promise<unknown | null> {
        return this.timedRequest('documentLink/resolve', link);
    }

    async workspaceSymbolResolve(symbol: unknown): Promise<unknown | null> {
        return this.timedRequest('workspaceSymbol/resolve', symbol);
    }

    // ── Document mutations ──────────────────────────────────────────────

    async edit(relativePath: string, edits: EditOperation | EditOperation[]): Promise<void> {
        const doc = this.getOpenDocument(relativePath);

        const editArray = Array.isArray(edits) ? edits : [edits];
        doc.version++;

        const contentChanges: { range: unknown; text: string }[] = editArray.map((e) => ({
            range: toLspRange(e.range),
            text: e.text,
        }));

        // mirror the change locally, each edit applies to the result of the previous one
        for (const e of editArray) {
            doc.text = applyEdit(doc.text, e);
        }

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

    private getOpenDocument(relativePath: string): { uri: string; version: number; text: string } {
        const doc = this.openDocuments.get(relativePath);
        if (!doc) {
            throw new Error(`Document ${relativePath} is not open. Call openDocument() first.`);
        }
        return doc;
    }

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

/** formatting options shared by all formatting requests */
const FORMATTING_OPTIONS = { tabSize: 2, insertSpaces: true };

function toLspRange(range: Range): {
    start: { line: number; character: number };
    end: { line: number; character: number };
} {
    return {
        start: { line: range.start.line, character: range.start.character },
        end: { line: range.end.line, character: range.end.character },
    };
}

/** Replace the text covered by `edit.range` with `edit.text` */
function applyEdit(text: string, edit: EditOperation): string {
    const lineStarts = computeLineStarts(text);
    let start = positionToOffset(text, lineStarts, edit.range.start);
    let end = positionToOffset(text, lineStarts, edit.range.end);
    if (start > end) {
        [start, end] = [end, start];
    }
    return text.slice(0, start) + edit.text + text.slice(end);
}

/** Offsets at which each line begins, treating \n, \r\n and \r as line breaks like LSP does */
function computeLineStarts(text: string): number[] {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        if (ch === 13 /* \r */) {
            if (text.charCodeAt(i + 1) === 10 /* \n */) {
                i++;
            }
            starts.push(i + 1);
        } else if (ch === 10 /* \n */) {
            starts.push(i + 1);
        }
    }
    return starts;
}

/**
 * Convert an LSP position to a string offset. Characters are UTF-16 code units, which is
 * what JS string indices count. Out of range positions are clamped as the LSP spec requires:
 * a character past the line end maps to the line end, a line past the last maps to the end.
 */
function positionToOffset(text: string, lineStarts: number[], pos: Position): number {
    if (pos.line < 0) {
        return 0;
    }
    if (pos.line >= lineStarts.length) {
        return text.length;
    }
    const lineStart = lineStarts[pos.line];
    let lineEnd = pos.line + 1 < lineStarts.length ? lineStarts[pos.line + 1] : text.length;
    // exclude the line break itself, so a position can never land inside \r\n
    if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 10) {
        lineEnd--;
    }
    if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13) {
        lineEnd--;
    }
    return Math.min(lineStart + Math.max(pos.character, 0), lineEnd);
}

/**
 * Keeps diagnostics whose `code` is in `codes`, falling back to `data.code`
 * for servers (such as Langium) that carry their issue code in the opaque `data` payload.
 */
function filterDiagnosticsByCode(diagnostics: Diagnostic[], codes: (string | number)[]): Diagnostic[] {
    const matched: Diagnostic[] = [];
    for (const d of diagnostics) {
        if (d.code !== undefined && codes.includes(d.code)) {
            matched.push(d);
            continue;
        }
        const data = d.data;
        if (typeof data === 'object' && data !== null && 'code' in data) {
            const dataCode = (data as { code: unknown }).code;
            if ((typeof dataCode === 'string' || typeof dataCode === 'number') && codes.includes(dataCode)) {
                matched.push(d);
            }
        }
    }
    return matched;
}

/**
 * Mapping of extensions -> language ids
 */
const RegisteredLanguages: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.jsx': 'javascriptreact',
    '.json': 'json',
    '.jsonc': 'jsonc',
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
    '.langium': 'langium',
};

/**
 * Adds a new registered language via a new extension -> name mapping
 * @param languageId To be picked up by the correct language server
 * @param extension That should correlate with the given id (ex. `.ts`, or `.c`, or `.langium`)
 */
export function addRegisteredLanguage(languageId: string, extension: string) {
    // normalize to match detectLanguageId, which looks up lowercased extensions
    extension = extension.trim().toLowerCase();
    if (!extension.startsWith('.')) {
        extension = '.' + extension;
    }
    RegisteredLanguages[extension] = languageId;
}

/**
 * Will attempt to resolve the language id via the extension of the given file path.
 * Will default to 'plaintext' if the language id is unrecognized.
 * In such cases, `addRegisteredLanguage` should be invoked before opening any document.
 * @param filePath To extract extension from (expecting at least `abc.xyz`), no extension-less files here
 * @returns Associated language ID, or 'plaintext'
 */
function detectLanguageId(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    return RegisteredLanguages[ext] ?? 'plaintext';
}

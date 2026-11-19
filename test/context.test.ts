import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
    Diagnostic,
    DiagnosticsDelivery,
    DiagnosticsPublish,
    DocumentSyncState,
    EditOperation,
    IdleWaitOptions,
    IdleWaitResult,
    LspHarness,
    PublishWaitOptions,
    PublishWaitResult,
    Registration,
    ChangeSyncKind,
    SaveSyncOptions,
    ServerCapabilities,
    WaitForDiagnosticsResult,
} from 'lsbench';
import {
    addRegisteredLanguage,
    BenchContextImpl,
    classifyResult,
    DiagnosticsTracker,
    detectLanguageId,
    linkPlaceholders,
    ProgressTracker,
    SILENT_WAIT_STREAK,
    SilenceTracker,
} from 'lsbench';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface SentRequest {
    method: string;
    params: unknown;
}

interface SentNotification {
    method: string;
    params: unknown;
}

/**
 * A stand-in for LspHarness that records traffic instead of spawning a server.
 * Requests resolve with a canned response and can be made to reject to exercise
 * the failure-timing path.
 */
class FakeHarness {
    requests: SentRequest[] = [];
    notifications: SentNotification[] = [];
    /** the real tracker, fed by sent notifications and simulated publishes */
    tracker = new DiagnosticsTracker((msg) => this.logs.push(msg));
    /** the real progress tracker, fed by simulated $/progress notifications */
    progress = new ProgressTracker();
    logs: string[] = [];
    /** methods that should reject when requested */
    failMethods = new Set<string>();
    response: unknown = { ok: true };
    /** what the fake server asks for around saves */
    saveOptions: SaveSyncOptions = { didSave: true, includeText: false, willSave: true, willSaveWaitUntil: true };

    constructor() {
        linkPlaceholders(this.tracker, this.progress);
    }

    /** answers requests in place of `response` when set, may throw or return a promise */
    respond?: (method: string, params: unknown) => unknown;

    /** errors thrown by the next requests, in order, before any canned response */
    rejections: unknown[] = [];
    /** null like before initialize, so every request counts as supported */
    capabilities: ServerCapabilities | null = null;
    registrations: Registration[] = [];

    async sendRequest<R>(method: string, params: unknown): Promise<R> {
        this.requests.push({ method, params });
        if (this.rejections.length > 0) {
            throw this.rejections.shift();
        }
        if (this.failMethods.has(method)) {
            throw new Error(`simulated failure for ${method}`);
        }
        if (this.respond) {
            return (await this.respond(method, params)) as R;
        }
        return this.response as R;
    }

    sendNotification(method: string, params: unknown): void {
        this.notifications.push({ method, params });
        this.tracker.noteNotification(method, params);
    }

    getDiagnostics(uri: string): Diagnostic[] {
        return this.tracker.latestPublish(uri)?.diagnostics ?? [];
    }

    /** simulate the server publishing diagnostics */
    setDiagnostics(uri: string, diags: Diagnostic[], version?: number): void {
        this.tracker.receive({ uri, diagnostics: diags, ...(version !== undefined ? { version } : {}) });
    }

    diagnosticsDelivery(): DiagnosticsDelivery {
        return this.tracker.delivery;
    }

    diagnosticsDeliveryTentative(): boolean {
        return this.tracker.deliveryTentative;
    }

    markPullOnly(reason: string, tentative = false): void {
        this.tracker.markPullOnly(reason, tentative);
    }

    onDiagnosticsDeliveryChange(listener: (delivery: DiagnosticsDelivery) => void): () => void {
        return this.tracker.onDeliveryChange(listener);
    }

    latestPublish(uri: string): DiagnosticsPublish | undefined {
        return this.tracker.latestPublish(uri);
    }

    documentState(uri: string): DocumentSyncState | undefined {
        return this.tracker.document(uri);
    }

    closeWindowEndsAt(uri: string): bigint | undefined {
        return this.tracker.closeWindowEndsAt(uri);
    }

    currentPublishSeq(): number {
        return this.tracker.currentSeq();
    }

    waitForPublishes(
        uri: string,
        accept: (publish: DiagnosticsPublish) => boolean,
        options: PublishWaitOptions,
    ): Promise<PublishWaitResult> {
        return this.tracker.waitForPublishes(uri, accept, options);
    }

    saveSyncOptions(): SaveSyncOptions {
        return { ...this.saveOptions };
    }

    changeKind: ChangeSyncKind = 2;

    changeSyncKind(): ChangeSyncKind {
        return this.changeKind;
    }

    waitForIdle(options: IdleWaitOptions): Promise<IdleWaitResult> {
        return this.progress.waitForIdle(options);
    }

    isServerBusy(): boolean {
        return this.progress.busy;
    }

    isServerNotQuiescent(): boolean {
        return this.progress.serverStatus?.quiescent === false;
    }

    onServerNotBusy(listener: () => void): () => void {
        return this.progress.onNotBusy(listener);
    }

    refreshListeners = new Set<() => void>();

    onDiagnosticRefresh(listener: () => void): () => void {
        this.refreshListeners.add(listener);
        return () => this.refreshListeners.delete(listener);
    }

    /** simulate the server sending workspace/diagnostic/refresh */
    refresh(): void {
        for (const listener of this.refreshListeners) {
            listener();
        }
    }

    markPullFromRefresh(reason: string): void {
        this.tracker.markPullFromRefresh(reason);
    }
}

/** shorthand for an edit replacing the range from (sl, sc) to (el, ec) */
function op(sl: number, sc: number, el: number, ec: number, text: string): EditOperation {
    return { range: { start: { line: sl, character: sc }, end: { line: el, character: ec } }, text };
}

describe('detectLanguageId', () => {
    it.each([
        ['src/index.ts', 'typescript'],
        ['/abs/path/App.TSX', 'typescriptreact'],
        ['lib/x.mjs', 'javascript'],
        ['config.jsonc', 'jsonc'],
        ['grammar.langium', 'langium'],
        ['main.tf', 'terraform'],
        ['prod.TFVARS', 'terraform-vars'],
        ['config.hcl', 'hcl'],
        ['src/main.ml', 'ocaml'],
        ['src/shape.MLI', 'ocaml.interface'],
        ['lexer.mll', 'ocaml.ocamllex'],
        ['parser.mly', 'ocaml.menhir'],
        ['app/Main.hs', 'haskell'],
        ['Notes.LHS', 'literate haskell'],
        ['lib.nix', 'nix'],
        ['flake.NIX', 'nix'],
        ['main.tex', 'latex'],
        ['chapters/Intro.TEX', 'latex'],
        ['mystyle.sty', 'latex'],
        ['thesis.cls', 'latex'],
        ['refs.bib', 'bibtex'],
        ['Refs.BIB', 'bibtex'],
        ['notes.txt', 'plaintext'],
    ])('maps %s to %s', (file, languageId) => {
        expect(detectLanguageId(file)).toBe(languageId);
    });

    it('falls back to plaintext for unknown or missing extensions', () => {
        expect(detectLanguageId('notes.unknownext')).toBe('plaintext');
        expect(detectLanguageId('Makefile')).toBe('plaintext');
    });

    it('picks up extensions registered with addRegisteredLanguage', () => {
        addRegisteredLanguage('detect-test-lang', '.DetectTest');
        expect(detectLanguageId('a.detecttest')).toBe('detect-test-lang');
    });
});

describe('BenchContextImpl', () => {
    let tmpDir: string;
    let harness: FakeHarness;
    let ctx: BenchContextImpl;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-ctx-'));
        fs.writeFileSync(path.join(tmpDir, 'sample.ts'), 'const x: number = 1;\n', 'utf-8');
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        harness = new FakeHarness();
        ctx = new BenchContextImpl(harness as unknown as LspHarness, tmpDir);
    });

    describe('document lifecycle', () => {
        it('sends didOpen with detected languageId and reads file text', async () => {
            await ctx.openDocument('sample.ts');

            expect(harness.notifications).toHaveLength(1);
            const [open] = harness.notifications;
            expect(open.method).toBe('textDocument/didOpen');
            const params = open.params as { textDocument: { languageId: string; text: string; version: number } };
            expect(params.textDocument.languageId).toBe('typescript');
            expect(params.textDocument.version).toBe(1);
            expect(params.textDocument.text).toContain('const x');
        });

        it('sends didOpen with the languageId of a registered custom extension', async () => {
            // register with mixed case and no leading dot to exercise normalization
            addRegisteredLanguage('minilogo', 'LoGo');
            fs.writeFileSync(path.join(tmpDir, 'sample.LOGO'), 'pen down\n', 'utf-8');

            await ctx.openDocument('sample.LOGO');

            expect(harness.notifications).toHaveLength(1);
            const params = harness.notifications[0].params as { textDocument: { languageId: string } };
            expect(params.textDocument.languageId).toBe('minilogo');
        });

        it.each([
            ['sample.mjs', 'javascript'],
            ['sample.cjs', 'javascript'],
            ['sample.mts', 'typescript'],
            ['sample.cts', 'typescript'],
            ['sample.jsonc', 'jsonc'],
        ])('detects the languageId of %s as %s', async (file, languageId) => {
            fs.writeFileSync(path.join(tmpDir, file), '\n', 'utf-8');

            await ctx.openDocument(file);

            const params = harness.notifications[0].params as { textDocument: { languageId: string } };
            expect(params.textDocument.languageId).toBe(languageId);
        });

        it('uses options.languageId over the detected languageId for that document only', async () => {
            fs.writeFileSync(path.join(tmpDir, 'other.ts'), '\n', 'utf-8');

            await ctx.openDocument('sample.ts', { languageId: 'typescript-next' });
            await ctx.openDocument('other.ts');

            const ids = harness.notifications.map(
                (n) => (n.params as { textDocument: { languageId: string } }).textDocument.languageId,
            );
            expect(ids).toEqual(['typescript-next', 'typescript']);
        });

        describe('plaintext fallback', () => {
            function warnings(lines: string[]): string[] {
                return lines.filter((l) => l.includes('has no registered language id'));
            }

            async function errorLines(body: () => Promise<void>): Promise<string[]> {
                const lines: string[] = [];
                const spy = vi.spyOn(console, 'error').mockImplementation((line?: unknown) => {
                    lines.push(String(line));
                });
                try {
                    await body();
                } finally {
                    spy.mockRestore();
                }
                return lines;
            }

            it('warns once per unknown extension without verbose, across contexts sharing a tracker', async () => {
                fs.writeFileSync(path.join(tmpDir, 'a.fallbackx'), '\n', 'utf-8');
                fs.writeFileSync(path.join(tmpDir, 'b.FallbackX'), '\n', 'utf-8');
                fs.writeFileSync(path.join(tmpDir, 'c.fallbacky'), '\n', 'utf-8');
                const silence = new SilenceTracker();
                const lines = await errorLines(async () => {
                    const first = new BenchContextImpl(harness as unknown as LspHarness, tmpDir, false, { silence });
                    await first.openDocument('a.fallbackx');
                    await first.openDocument('b.FallbackX');
                    const second = new BenchContextImpl(harness as unknown as LspHarness, tmpDir, false, { silence });
                    await second.openDocument('a.fallbackx');
                    await second.openDocument('c.fallbacky');
                });
                expect(warnings(lines)).toEqual([
                    '[lsbench:ctx] Warning: `.fallbackx` has no registered language id, so a.fallbackx opened as ' +
                        'plaintext and the server may not serve it. Register it with `addRegisteredLanguage()` or ' +
                        'pass `options.languageId` to `openDocument()`',
                    expect.stringContaining('`.fallbacky` has no registered language id, so c.fallbacky'),
                ]);
                expect(silence.plaintextFallbacks()).toEqual(['.fallbackx', '.fallbacky']);
            });

            it('names files without an extension', async () => {
                fs.writeFileSync(path.join(tmpDir, 'Fallbackfile'), '\n', 'utf-8');
                const silence = new SilenceTracker();
                const lines = await errorLines(async () => {
                    const plain = new BenchContextImpl(harness as unknown as LspHarness, tmpDir, false, { silence });
                    await plain.openDocument('Fallbackfile');
                });
                expect(warnings(lines)).toEqual([
                    expect.stringContaining('Warning: a file without an extension has no registered language id'),
                ]);
                expect(silence.plaintextFallbacks()).toEqual(['']);
            });

            it('marks the fallback on the verbose open line', async () => {
                fs.writeFileSync(path.join(tmpDir, 'v.fallbackz'), '\n', 'utf-8');
                const lines = await errorLines(async () => {
                    const verbose = new BenchContextImpl(harness as unknown as LspHarness, tmpDir, true);
                    await verbose.openDocument('v.fallbackz');
                    await verbose.openDocument('sample.ts');
                });
                expect(lines).toContain('[lsbench:ctx] Opened v.fallbackz (plaintext, fallback)');
                expect(lines).toContain('[lsbench:ctx] Opened sample.ts (typescript)');
            });

            it('does not warn for registered extensions or options.languageId', async () => {
                fs.writeFileSync(path.join(tmpDir, 'o.fallbackw'), '\n', 'utf-8');
                fs.writeFileSync(path.join(tmpDir, 'notes.txt'), '\n', 'utf-8');
                const silence = new SilenceTracker();
                const lines = await errorLines(async () => {
                    const plain = new BenchContextImpl(harness as unknown as LspHarness, tmpDir, false, { silence });
                    await plain.openDocument('sample.ts');
                    await plain.openDocument('notes.txt');
                    await plain.openDocument('o.fallbackw', { languageId: 'custom' });
                });
                expect(warnings(lines)).toEqual([]);
                expect(silence.plaintextFallbacks()).toBeUndefined();
                const ids = harness.notifications.map(
                    (n) => (n.params as { textDocument: { languageId: string } }).textDocument.languageId,
                );
                expect(ids).toEqual(['typescript', 'plaintext', 'custom']);
            });
        });

        it('is idempotent — opening the same document twice sends one didOpen', async () => {
            await ctx.openDocument('sample.ts');
            await ctx.openDocument('sample.ts');
            expect(harness.notifications.filter((n) => n.method === 'textDocument/didOpen')).toHaveLength(1);
        });

        it('sends didClose only for open documents', async () => {
            await ctx.closeDocument('sample.ts'); // not open → no-op
            expect(harness.notifications).toHaveLength(0);

            await ctx.openDocument('sample.ts');
            await ctx.closeDocument('sample.ts');
            expect(harness.notifications.some((n) => n.method === 'textDocument/didClose')).toBe(true);
        });

        it('saveDocument throws when the document is not open', async () => {
            await expect(ctx.saveDocument('sample.ts')).rejects.toThrow(/is not open/);
            expect(harness.notifications).toHaveLength(0);
        });

        it('saveDocument sends an untimed didSave for an open document', async () => {
            await ctx.openDocument('sample.ts');
            await ctx.saveDocument('sample.ts');

            expect(harness.notifications).toHaveLength(2);
            expect(harness.notifications[1]).toEqual({
                method: 'textDocument/didSave',
                params: { textDocument: { uri: expect.stringMatching(/sample\.ts$/) } },
            });
            expect(harness.requests).toHaveLength(0);
            expect(ctx.collectTimings()).toHaveLength(0);
        });

        it('saveDocument includes the current text when the server asks for includeText', async () => {
            harness.saveOptions.includeText = true;
            await ctx.openDocument('sample.ts');
            await ctx.saveDocument('sample.ts');

            expect(harness.notifications[1]).toEqual({
                method: 'textDocument/didSave',
                params: { textDocument: { uri: expect.stringMatching(/sample\.ts$/) }, text: 'const x: number = 1;\n' },
            });
        });

        it('saveDocument skips didSave when the server does not want it', async () => {
            harness.saveOptions.didSave = false;
            await ctx.openDocument('sample.ts');
            await ctx.saveDocument('sample.ts');

            expect(harness.notifications.map((n) => n.method)).toEqual(['textDocument/didOpen']);
        });

        it('willSave sends an untimed willSave with the reason, defaulting to Manual', async () => {
            await ctx.openDocument('sample.ts');
            await ctx.willSave('sample.ts');
            await ctx.willSave('sample.ts', 2);

            expect(harness.notifications.slice(1)).toEqual([
                {
                    method: 'textDocument/willSave',
                    params: { textDocument: { uri: expect.stringMatching(/sample\.ts$/) }, reason: 1 },
                },
                {
                    method: 'textDocument/willSave',
                    params: { textDocument: { uri: expect.stringMatching(/sample\.ts$/) }, reason: 2 },
                },
            ]);
            expect(harness.requests).toHaveLength(0);
            expect(ctx.collectTimings()).toHaveLength(0);
        });

        it('willSave skips the notification when the server does not want it', async () => {
            harness.saveOptions.willSave = false;
            await ctx.openDocument('sample.ts');
            await ctx.willSave('sample.ts');

            expect(harness.notifications.map((n) => n.method)).toEqual(['textDocument/didOpen']);
        });

        it('willSave and willSaveWaitUntil throw when the document is not open', async () => {
            await expect(ctx.willSave('sample.ts')).rejects.toThrow(/is not open/);
            await expect(ctx.willSaveWaitUntil('sample.ts')).rejects.toThrow(/is not open/);
            expect(harness.notifications).toHaveLength(0);
            expect(harness.requests).toHaveLength(0);
        });

        it('willSaveWaitUntil issues a timed request', async () => {
            await ctx.openDocument('sample.ts');
            const res = await ctx.willSaveWaitUntil('sample.ts', 3);

            expect(res).toEqual({ ok: true });
            expect(harness.requests).toEqual([
                {
                    method: 'textDocument/willSaveWaitUntil',
                    params: { textDocument: { uri: expect.stringMatching(/sample\.ts$/) }, reason: 3 },
                },
            ]);
            const timings = ctx.collectTimings();
            expect(timings).toHaveLength(1);
            expect(timings[0].method).toBe('textDocument/willSaveWaitUntil');
            expect(timings[0].success).toBe(true);
        });

        it('resetDocuments closes every open document and clears state', async () => {
            await ctx.openDocument('sample.ts');
            await ctx.resetDocuments();

            expect(harness.notifications.some((n) => n.method === 'textDocument/didClose')).toBe(true);
            // after reset the doc is closed again on a fresh open (idempotency reset)
            harness.notifications = [];
            await ctx.openDocument('sample.ts');
            expect(harness.notifications.filter((n) => n.method === 'textDocument/didOpen')).toHaveLength(1);
        });
    });

    describe('timed LSP requests', () => {
        it('hover issues textDocument/hover with the right position and records a timing', async () => {
            await ctx.openDocument('sample.ts');
            const res = await ctx.hover('sample.ts', 0, 6);

            expect(res).toEqual({ ok: true });
            const req = harness.requests.find((r) => r.method === 'textDocument/hover');
            expect(req).toBeDefined();
            const params = req?.params as { position: { line: number; character: number } };
            expect(params.position).toEqual({ line: 0, character: 6 });

            const timings = ctx.collectTimings();
            expect(timings).toHaveLength(1);
            expect(timings[0].method).toBe('textDocument/hover');
            expect(timings[0].success).toBe(true);
            expect(timings[0].duration_ms).toBeGreaterThanOrEqual(0);
        });

        // position based requests that share the same params shape
        const positionRequests = [
            { name: 'declaration', method: 'textDocument/declaration' },
            { name: 'documentHighlight', method: 'textDocument/documentHighlight' },
            { name: 'prepareRename', method: 'textDocument/prepareRename' },
            { name: 'prepareCallHierarchy', method: 'textDocument/prepareCallHierarchy' },
            { name: 'prepareTypeHierarchy', method: 'textDocument/prepareTypeHierarchy' },
        ] as const;

        for (const { name, method } of positionRequests) {
            it(`${name} issues ${method} with the document uri and position and records a timing`, async () => {
                await ctx.openDocument('sample.ts');
                const res = await ctx[name]('sample.ts', 0, 6);

                expect(res).toEqual({ ok: true });
                expect(harness.requests).toHaveLength(1);
                const [req] = harness.requests;
                expect(req.method).toBe(method);
                expect(req.params).toEqual({
                    textDocument: { uri: expect.stringMatching(/sample\.ts$/) },
                    position: { line: 0, character: 6 },
                });

                const timings = ctx.collectTimings();
                expect(timings).toHaveLength(1);
                expect(timings[0].method).toBe(method);
                expect(timings[0].success).toBe(true);
                expect(timings[0].duration_ms).toBeGreaterThanOrEqual(0);
            });
        }

        // document scoped requests that only take a text document identifier
        const documentRequests = [
            { name: 'foldingRange', method: 'textDocument/foldingRange' },
            { name: 'documentLink', method: 'textDocument/documentLink' },
            { name: 'codeLens', method: 'textDocument/codeLens' },
        ] as const;

        for (const { name, method } of documentRequests) {
            it(`${name} issues ${method} with the document uri and records a timing`, async () => {
                await ctx.openDocument('sample.ts');
                const res = await ctx[name]('sample.ts');

                expect(res).toEqual({ ok: true });
                expect(harness.requests).toHaveLength(1);
                const [req] = harness.requests;
                expect(req.method).toBe(method);
                expect(req.params).toEqual({
                    textDocument: { uri: expect.stringMatching(/sample\.ts$/) },
                });

                const timings = ctx.collectTimings();
                expect(timings).toHaveLength(1);
                expect(timings[0].method).toBe(method);
                expect(timings[0].success).toBe(true);
                expect(timings[0].duration_ms).toBeGreaterThanOrEqual(0);
            });
        }

        it('selectionRange issues textDocument/selectionRange with the positions and records a timing', async () => {
            await ctx.openDocument('sample.ts');
            const positions = [
                { line: 0, character: 6 },
                { line: 0, character: 18 },
            ];
            const res = await ctx.selectionRange('sample.ts', positions);

            expect(res).toEqual({ ok: true });
            expect(harness.requests).toHaveLength(1);
            const [req] = harness.requests;
            expect(req.method).toBe('textDocument/selectionRange');
            expect(req.params).toEqual({
                textDocument: { uri: expect.stringMatching(/sample\.ts$/) },
                positions,
            });

            const timings = ctx.collectTimings();
            expect(timings).toHaveLength(1);
            expect(timings[0].method).toBe('textDocument/selectionRange');
            expect(timings[0].success).toBe(true);
            expect(timings[0].duration_ms).toBeGreaterThanOrEqual(0);
        });

        it('inlayHint issues textDocument/inlayHint with the range and records a timing', async () => {
            await ctx.openDocument('sample.ts');
            const range = { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } };
            const res = await ctx.inlayHint('sample.ts', range);

            expect(res).toEqual({ ok: true });
            expect(harness.requests).toHaveLength(1);
            const [req] = harness.requests;
            expect(req.method).toBe('textDocument/inlayHint');
            expect(req.params).toEqual({
                textDocument: { uri: expect.stringMatching(/sample\.ts$/) },
                range,
            });

            const timings = ctx.collectTimings();
            expect(timings).toHaveLength(1);
            expect(timings[0].method).toBe('textDocument/inlayHint');
            expect(timings[0].success).toBe(true);
            expect(timings[0].duration_ms).toBeGreaterThanOrEqual(0);
        });

        it('semanticTokensFull issues textDocument/semanticTokens/full for the document and records a timing', async () => {
            await ctx.openDocument('sample.ts');
            const res = await ctx.semanticTokensFull('sample.ts');

            expect(res).toEqual({ ok: true });
            expect(harness.requests).toHaveLength(1);
            const [req] = harness.requests;
            expect(req.method).toBe('textDocument/semanticTokens/full');
            expect(req.params).toEqual({
                textDocument: { uri: expect.stringMatching(/sample\.ts$/) },
            });

            const timings = ctx.collectTimings();
            expect(timings).toHaveLength(1);
            expect(timings[0].method).toBe('textDocument/semanticTokens/full');
            expect(timings[0].success).toBe(true);
            expect(timings[0].duration_ms).toBeGreaterThanOrEqual(0);
        });

        it('semanticTokensRange issues textDocument/semanticTokens/range with the range and records a timing', async () => {
            await ctx.openDocument('sample.ts');
            const range = { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } };
            const res = await ctx.semanticTokensRange('sample.ts', range);

            expect(res).toEqual({ ok: true });
            expect(harness.requests).toHaveLength(1);
            const [req] = harness.requests;
            expect(req.method).toBe('textDocument/semanticTokens/range');
            expect(req.params).toEqual({
                textDocument: { uri: expect.stringMatching(/sample\.ts$/) },
                range,
            });

            const timings = ctx.collectTimings();
            expect(timings).toHaveLength(1);
            expect(timings[0].method).toBe('textDocument/semanticTokens/range');
            expect(timings[0].success).toBe(true);
            expect(timings[0].duration_ms).toBeGreaterThanOrEqual(0);
        });

        it('semanticTokensDelta issues textDocument/semanticTokens/full/delta with the previous result id and records a timing', async () => {
            await ctx.openDocument('sample.ts');
            const res = await ctx.semanticTokensDelta('sample.ts', 'result-1');

            expect(res).toEqual({ ok: true });
            expect(harness.requests).toHaveLength(1);
            const [req] = harness.requests;
            expect(req.method).toBe('textDocument/semanticTokens/full/delta');
            expect(req.params).toEqual({
                textDocument: { uri: expect.stringMatching(/sample\.ts$/) },
                previousResultId: 'result-1',
            });

            const timings = ctx.collectTimings();
            expect(timings).toHaveLength(1);
            expect(timings[0].method).toBe('textDocument/semanticTokens/full/delta');
            expect(timings[0].success).toBe(true);
            expect(timings[0].duration_ms).toBeGreaterThanOrEqual(0);
        });

        // hierarchy requests that take a raw item from a prior prepare call
        const hierarchyItemRequests = [
            { name: 'callHierarchyIncomingCalls', method: 'callHierarchy/incomingCalls' },
            { name: 'callHierarchyOutgoingCalls', method: 'callHierarchy/outgoingCalls' },
            { name: 'typeHierarchySupertypes', method: 'typeHierarchy/supertypes' },
            { name: 'typeHierarchySubtypes', method: 'typeHierarchy/subtypes' },
        ] as const;

        for (const { name, method } of hierarchyItemRequests) {
            it(`${name} issues ${method} with the item and records a timing`, async () => {
                const item = {
                    name: 'x',
                    kind: 13,
                    uri: 'file:///sample.ts',
                    range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
                    selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
                };
                const res = await ctx[name](item);

                expect(res).toEqual({ ok: true });
                expect(harness.requests).toHaveLength(1);
                const [req] = harness.requests;
                expect(req.method).toBe(method);
                expect(req.params).toEqual({ item });

                const timings = ctx.collectTimings();
                expect(timings).toHaveLength(1);
                expect(timings[0].method).toBe(method);
                expect(timings[0].success).toBe(true);
                expect(timings[0].duration_ms).toBeGreaterThanOrEqual(0);
            });
        }

        // resolve requests that send the raw item from a prior request as the params
        const resolveRequests = [
            { name: 'completionItemResolve', method: 'completionItem/resolve', item: { label: 'x', data: { id: 1 } } },
            {
                name: 'codeLensResolve',
                method: 'codeLens/resolve',
                item: { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, data: 1 },
            },
            {
                name: 'inlayHintResolve',
                method: 'inlayHint/resolve',
                item: { position: { line: 0, character: 7 }, label: ': number', data: 1 },
            },
            {
                name: 'codeActionResolve',
                method: 'codeAction/resolve',
                item: { title: 'Fix it', kind: 'quickfix', data: 1 },
            },
            {
                name: 'documentLinkResolve',
                method: 'documentLink/resolve',
                item: { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, data: 1 },
            },
            {
                name: 'workspaceSymbolResolve',
                method: 'workspaceSymbol/resolve',
                item: { name: 'x', kind: 13, location: { uri: 'file:///sample.ts' } },
            },
        ] as const;

        for (const { name, method, item } of resolveRequests) {
            it(`${name} issues ${method} with the item as the params and records a timing`, async () => {
                const res = await ctx[name](item);

                expect(res).toEqual({ ok: true });
                expect(harness.requests).toHaveLength(1);
                const [req] = harness.requests;
                expect(req.method).toBe(method);
                expect(req.params).toEqual(item);

                const timings = ctx.collectTimings();
                expect(timings).toHaveLength(1);
                expect(timings[0].method).toBe(method);
                expect(timings[0].success).toBe(true);
                expect(timings[0].duration_ms).toBeGreaterThanOrEqual(0);
            });
        }

        it('documentDiagnostic issues textDocument/diagnostic without previousResultId when omitted and records a timing', async () => {
            await ctx.openDocument('sample.ts');
            const res = await ctx.documentDiagnostic('sample.ts');

            expect(res).toEqual({ ok: true });
            expect(harness.requests).toHaveLength(1);
            const [req] = harness.requests;
            expect(req.method).toBe('textDocument/diagnostic');
            expect(req.params).toEqual({
                textDocument: { uri: expect.stringMatching(/sample\.ts$/) },
            });
            expect(req.params).not.toHaveProperty('previousResultId');

            const timings = ctx.collectTimings();
            expect(timings).toHaveLength(1);
            expect(timings[0].method).toBe('textDocument/diagnostic');
            expect(timings[0].success).toBe(true);
            expect(timings[0].duration_ms).toBeGreaterThanOrEqual(0);
        });

        it('documentDiagnostic passes the previous result id when given', async () => {
            await ctx.openDocument('sample.ts');
            await ctx.documentDiagnostic('sample.ts', 'result-1');

            expect(harness.requests).toHaveLength(1);
            expect(harness.requests[0].params).toEqual({
                textDocument: { uri: expect.stringMatching(/sample\.ts$/) },
                previousResultId: 'result-1',
            });
        });

        it('workspaceDiagnostic issues workspace/diagnostic with empty previousResultIds by default and records a timing', async () => {
            const res = await ctx.workspaceDiagnostic();

            expect(res).toEqual({ ok: true });
            expect(harness.requests).toHaveLength(1);
            const [req] = harness.requests;
            expect(req.method).toBe('workspace/diagnostic');
            expect(req.params).toEqual({ previousResultIds: [] });

            const timings = ctx.collectTimings();
            expect(timings).toHaveLength(1);
            expect(timings[0].method).toBe('workspace/diagnostic');
            expect(timings[0].success).toBe(true);
            expect(timings[0].duration_ms).toBeGreaterThanOrEqual(0);
        });

        it('workspaceDiagnostic passes the given previousResultIds', async () => {
            const previousResultIds = [{ uri: 'file:///sample.ts', value: 'result-1' }];
            await ctx.workspaceDiagnostic(previousResultIds);

            expect(harness.requests).toHaveLength(1);
            expect(harness.requests[0].params).toEqual({ previousResultIds });
        });

        it('workspaceSymbol issues workspace/symbol with the query and records a timing', async () => {
            const res = await ctx.workspaceSymbol('Foo');

            expect(res).toEqual({ ok: true });
            expect(harness.requests).toHaveLength(1);
            const [req] = harness.requests;
            expect(req.method).toBe('workspace/symbol');
            expect(req.params).toEqual({ query: 'Foo' });

            const timings = ctx.collectTimings();
            expect(timings).toHaveLength(1);
            expect(timings[0].method).toBe('workspace/symbol');
            expect(timings[0].success).toBe(true);
            expect(timings[0].duration_ms).toBeGreaterThanOrEqual(0);
        });

        it('rangeFormatting issues textDocument/rangeFormatting with the range and options and records a timing', async () => {
            await ctx.openDocument('sample.ts');
            const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } };
            const res = await ctx.rangeFormatting('sample.ts', range);

            expect(res).toEqual({ ok: true });
            expect(harness.requests).toHaveLength(1);
            const [req] = harness.requests;
            expect(req.method).toBe('textDocument/rangeFormatting');
            expect(req.params).toEqual({
                textDocument: { uri: expect.stringMatching(/sample\.ts$/) },
                range,
                options: { tabSize: 2, insertSpaces: true },
            });

            const timings = ctx.collectTimings();
            expect(timings).toHaveLength(1);
            expect(timings[0].method).toBe('textDocument/rangeFormatting');
            expect(timings[0].success).toBe(true);
            expect(timings[0].duration_ms).toBeGreaterThanOrEqual(0);
        });

        it('onTypeFormatting issues textDocument/onTypeFormatting with the trigger character and records a timing', async () => {
            await ctx.openDocument('sample.ts');
            const res = await ctx.onTypeFormatting('sample.ts', 0, 20, ';');

            expect(res).toEqual({ ok: true });
            expect(harness.requests).toHaveLength(1);
            const [req] = harness.requests;
            expect(req.method).toBe('textDocument/onTypeFormatting');
            expect(req.params).toEqual({
                textDocument: { uri: expect.stringMatching(/sample\.ts$/) },
                position: { line: 0, character: 20 },
                ch: ';',
                options: { tabSize: 2, insertSpaces: true },
            });

            const timings = ctx.collectTimings();
            expect(timings).toHaveLength(1);
            expect(timings[0].method).toBe('textDocument/onTypeFormatting');
            expect(timings[0].success).toBe(true);
            expect(timings[0].duration_ms).toBeGreaterThanOrEqual(0);
        });

        it('references includes the declaration in its context', async () => {
            await ctx.references('sample.ts', 0, 6);
            const req = harness.requests.find((r) => r.method === 'textDocument/references');
            const params = req?.params as { context: { includeDeclaration: boolean } };
            expect(params.context.includeDeclaration).toBe(true);
        });

        it('codeAction filters cached diagnostics by the requested codes', async () => {
            const uri = `file://${path.resolve(tmpDir, 'sample.ts')}`;
            harness.setDiagnostics(uri, [
                { range: {}, message: 'a', code: 2322 },
                { range: {}, message: 'b', code: 'no-unused' },
                { range: {}, message: 'c', code: 9999 },
            ]);

            await ctx.codeAction('sample.ts', { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, [
                2322,
                'no-unused',
            ]);

            const req = harness.requests.find((r) => r.method === 'textDocument/codeAction');
            const params = req?.params as { context: { diagnostics: Diagnostic[] } };
            expect(params.context.diagnostics.map((d) => d.code)).toEqual([2322, 'no-unused']);
        });

        describe('codeAction context.only', () => {
            const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

            function sentContext(): { diagnostics: Diagnostic[]; only?: string[] } {
                const req = harness.requests.find((r) => r.method === 'textDocument/codeAction');
                const params = req?.params as { context: { diagnostics: Diagnostic[]; only?: string[] } };
                return params.context;
            }

            beforeEach(() => {
                harness.setDiagnostics(`file://${path.resolve(tmpDir, 'sample.ts')}`, [
                    { range: {}, message: 'a', code: 2322 },
                    { range: {}, message: 'b', code: 9999 },
                ]);
            });

            it('omits only without options', async () => {
                await ctx.codeAction('sample.ts', range);
                const context = sentContext();
                expect('only' in context).toBe(false);
                expect(context.diagnostics).toEqual([]);
            });

            it('omits only with the array form', async () => {
                await ctx.codeAction('sample.ts', range, [2322]);
                const context = sentContext();
                expect('only' in context).toBe(false);
                expect(context.diagnostics.map((d) => d.code)).toEqual([2322]);
            });

            it('omits only with an options object without it', async () => {
                await ctx.codeAction('sample.ts', range, { diagnosticCodes: [9999] });
                const context = sentContext();
                expect('only' in context).toBe(false);
                expect(context.diagnostics.map((d) => d.code)).toEqual([9999]);
            });

            it('sends only without diagnostics', async () => {
                await ctx.codeAction('sample.ts', range, { only: ['source.organizeImports'] });
                expect(sentContext()).toEqual({ diagnostics: [], only: ['source.organizeImports'] });
            });

            it('sends only with the requested diagnostics', async () => {
                await ctx.codeAction('sample.ts', range, { diagnosticCodes: [2322], only: ['quickfix'] });
                const context = sentContext();
                expect(context.diagnostics.map((d) => d.code)).toEqual([2322]);
                expect(context.only).toEqual(['quickfix']);
            });

            it('sends an empty only as is', async () => {
                await ctx.codeAction('sample.ts', range, { only: [] });
                expect(sentContext()).toEqual({ diagnostics: [], only: [] });
            });
        });

        describe('codeAction overlappingDiagnostics', () => {
            const at = (startLine: number, startChar: number, endLine: number, endChar: number) => ({
                start: { line: startLine, character: startChar },
                end: { line: endLine, character: endChar },
            });

            function sentContext(): { diagnostics: Diagnostic[]; only?: string[] } {
                const req = harness.requests.find((r) => r.method === 'textDocument/codeAction');
                const params = req?.params as { context: { diagnostics: Diagnostic[]; only?: string[] } };
                return params.context;
            }

            function setDiagnostics(diagnostics: Diagnostic[]): void {
                harness.setDiagnostics(`file://${path.resolve(tmpDir, 'sample.ts')}`, diagnostics);
            }

            it('sends overlapping diagnostics without a code as is', async () => {
                const warning: Diagnostic = {
                    data: null,
                    message: 'Geometry.Circle.perimeter/1 is undefined or private',
                    range: at(4, 4, 4, 30),
                    relatedInformation: [],
                    severity: 2,
                    source: 'Elixir',
                    tags: [],
                };
                setDiagnostics([warning]);
                await ctx.codeAction('sample.ts', at(4, 0, 4, 40), { overlappingDiagnostics: true });
                expect(sentContext()).toEqual({ diagnostics: [warning] });
            });

            it('leaves out diagnostics before and after the range', async () => {
                setDiagnostics([
                    { range: at(1, 0, 1, 5), message: 'before' },
                    { range: at(3, 2, 3, 6), message: 'inside' },
                    { range: at(3, 10, 3, 12), message: 'after on the line' },
                    { range: at(6, 0, 6, 5), message: 'after' },
                ]);
                await ctx.codeAction('sample.ts', at(3, 0, 3, 8), { overlappingDiagnostics: true });
                expect(sentContext().diagnostics.map((d) => d.message)).toEqual(['inside']);
            });

            it('includes diagnostics touching the range at a boundary', async () => {
                setDiagnostics([
                    { range: at(2, 0, 2, 4), message: 'ends at start' },
                    { range: at(2, 8, 2, 12), message: 'starts at end' },
                    { range: at(2, 13, 2, 14), message: 'apart' },
                ]);
                await ctx.codeAction('sample.ts', at(2, 4, 2, 8), { overlappingDiagnostics: true });
                expect(sentContext().diagnostics.map((d) => d.message)).toEqual(['ends at start', 'starts at end']);
            });

            it('selects diagnostics around an empty range', async () => {
                setDiagnostics([
                    { range: at(5, 2, 5, 10), message: 'around' },
                    { range: at(5, 12, 5, 14), message: 'later' },
                ]);
                await ctx.codeAction('sample.ts', at(5, 6, 5, 6), { overlappingDiagnostics: true });
                expect(sentContext().diagnostics.map((d) => d.message)).toEqual(['around']);
            });

            it('compares lines before characters', async () => {
                setDiagnostics([
                    { range: at(1, 20, 4, 0), message: 'spans the range' },
                    { range: at(4, 1, 5, 0), message: 'after on a later line' },
                ]);
                await ctx.codeAction('sample.ts', at(2, 30, 3, 2), { overlappingDiagnostics: true });
                expect(sentContext().diagnostics.map((d) => d.message)).toEqual(['spans the range']);
            });

            it('keeps the order of several diagnostics in the range', async () => {
                setDiagnostics([
                    { range: at(3, 0, 3, 1), message: 'c' },
                    { range: at(1, 0, 1, 1), message: 'a' },
                    { range: at(9, 0, 9, 1), message: 'out' },
                    { range: at(2, 0, 2, 1), message: 'b' },
                ]);
                await ctx.codeAction('sample.ts', at(1, 0, 3, 5), { overlappingDiagnostics: true });
                expect(sentContext().diagnostics.map((d) => d.message)).toEqual(['c', 'a', 'b']);
            });

            it('accepts a range whose start is after its end', async () => {
                setDiagnostics([{ range: at(2, 3, 2, 4), message: 'a' }]);
                await ctx.codeAction('sample.ts', at(2, 8, 2, 0), { overlappingDiagnostics: true });
                expect(sentContext().diagnostics.map((d) => d.message)).toEqual(['a']);
            });

            it('skips diagnostics with a malformed range', async () => {
                setDiagnostics([
                    { range: {}, message: 'empty' },
                    { range: null, message: 'null' },
                    {
                        range: { start: { line: 0, character: 0 }, end: { line: '0', character: 1 } },
                        message: 'string',
                    },
                    { range: at(0, 0, 0, 1), message: 'valid' },
                ]);
                await ctx.codeAction('sample.ts', at(0, 0, 0, 1), { overlappingDiagnostics: true });
                expect(sentContext().diagnostics.map((d) => d.message)).toEqual(['valid']);
            });

            it('requires matching codes when combined with diagnosticCodes', async () => {
                setDiagnostics([
                    { range: at(0, 0, 0, 1), message: 'a', code: 1 },
                    { range: at(0, 0, 0, 1), message: 'b', code: 2 },
                    { range: at(5, 0, 5, 1), message: 'c', code: 1 },
                ]);
                await ctx.codeAction('sample.ts', at(0, 0, 0, 1), {
                    diagnosticCodes: [1],
                    overlappingDiagnostics: true,
                });
                expect(sentContext().diagnostics.map((d) => d.message)).toEqual(['a']);
            });

            it('still sends only', async () => {
                setDiagnostics([{ range: at(0, 0, 0, 1), message: 'a' }]);
                await ctx.codeAction('sample.ts', at(0, 0, 0, 1), { overlappingDiagnostics: true, only: ['quickfix'] });
                expect(sentContext()).toEqual({
                    diagnostics: [{ range: at(0, 0, 0, 1), message: 'a' }],
                    only: ['quickfix'],
                });
            });

            it('sends no diagnostics when false', async () => {
                setDiagnostics([{ range: at(0, 0, 0, 1), message: 'a' }]);
                await ctx.codeAction('sample.ts', at(0, 0, 0, 1), { overlappingDiagnostics: false });
                expect(sentContext()).toEqual({ diagnostics: [] });
            });
        });

        describe('codeAction diagnostic matching', () => {
            const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

            async function sentDiagnostics(diagnostics: Diagnostic[], codes: (string | number)[]): Promise<string[]> {
                harness.setDiagnostics(`file://${path.resolve(tmpDir, 'sample.ts')}`, diagnostics);
                await ctx.codeAction('sample.ts', range, codes);
                const req = harness.requests.find((r) => r.method === 'textDocument/codeAction');
                const params = req?.params as { context: { diagnostics: Diagnostic[] } };
                return params.context.diagnostics.map((d) => d.message);
            }

            it('matches via code', async () => {
                expect(await sentDiagnostics([{ range: {}, message: 'a', code: 'x' }], ['x'])).toEqual(['a']);
            });

            it('matches via data.code', async () => {
                const diagnostics = [{ range: {}, message: 'a', data: { code: 'rule-name-uppercase' } }];
                expect(await sentDiagnostics(diagnostics, ['rule-name-uppercase'])).toEqual(['a']);
            });

            it('matches nothing when neither code nor data.code is requested', async () => {
                const diagnostics = [{ range: {}, message: 'a', code: 'x', data: { code: 'y' } }];
                expect(await sentDiagnostics(diagnostics, ['z'])).toEqual([]);
            });

            it('ignores data that is not an object', async () => {
                const diagnostics = [
                    { range: {}, message: 'a', data: 'rule-name-uppercase' },
                    { range: {}, message: 'b', data: null },
                    { range: {}, message: 'c', data: 42 },
                ];
                expect(await sentDiagnostics(diagnostics, ['rule-name-uppercase', 42])).toEqual([]);
            });
        });

        it('records a failed timing when the request rejects', async () => {
            harness.failMethods.add('textDocument/definition');
            const res = await ctx.definition('sample.ts', 0, 6);

            expect(res).toBeNull();
            const timings = ctx.collectTimings();
            expect(timings[0].success).toBe(false);
            expect(timings[0].error).toMatch(/simulated failure/);
        });

        it('custom request() attaches a label to the recorded timing', async () => {
            await ctx.request('workspace/symbol', { query: 'x' }, 'symbol-search');
            const timings = ctx.collectTimings();
            expect(timings[0].method).toBe('workspace/symbol');
            expect(timings[0].label).toBe('symbol-search');
        });
    });

    describe('results and errors', () => {
        /** an error shaped like a vscode-jsonrpc ResponseError */
        function responseError(code: number, message: string): Error {
            return Object.assign(new Error(message), { code });
        }

        it('classifies ok, empty and null results', async () => {
            for (const response of [[1], [], null, { items: [] }]) {
                harness.response = response;
                await ctx.hover('sample.ts', 0, 0);
            }
            const timings = ctx.collectTimings();
            expect(timings.map((t) => [t.result, t.success])).toEqual([
                ['ok', true],
                ['empty', true],
                ['null', true],
                ['empty', true],
            ]);
        });

        it('records an error result and exposes it as lastError until the next request', async () => {
            harness.rejections.push(responseError(-32603, 'internal'));
            expect(await ctx.definition('sample.ts', 0, 6)).toBeNull();
            expect(ctx.lastError).toEqual({ method: 'textDocument/definition', message: 'internal', code: -32603 });
            expect(ctx.collectTimings()[0]).toMatchObject({ result: 'error', success: false, error: 'internal' });

            harness.response = null;
            await ctx.hover('sample.ts', 0, 0);
            expect(ctx.lastError).toBeUndefined();
        });

        it('omits the code from lastError for errors without one', async () => {
            harness.rejections.push(new Error('connection closed'));
            await ctx.hover('sample.ts', 0, 0);
            expect(ctx.lastError).toEqual({ method: 'textDocument/hover', message: 'connection closed' });
        });

        it('retries ContentModified and records the retry count', async () => {
            ctx = new BenchContextImpl(harness as unknown as LspHarness, tmpDir, false, { retryBackoffMs: 0 });
            harness.rejections.push(responseError(-32801, 'modified'), responseError(-32801, 'modified'));
            harness.response = [1];

            expect(await ctx.hover('sample.ts', 0, 0)).toEqual([1]);
            expect(harness.requests).toHaveLength(3);
            expect(ctx.lastError).toBeUndefined();
            const timings = ctx.collectTimings();
            expect(timings).toHaveLength(1);
            expect(timings[0]).toMatchObject({ result: 'ok', retries: 2 });
        });

        it('gives up after the configured number of ContentModified retries', async () => {
            ctx = new BenchContextImpl(harness as unknown as LspHarness, tmpDir, false, {
                contentModifiedRetries: 1,
                retryBackoffMs: 0,
            });
            harness.rejections.push(responseError(-32801, 'modified'), responseError(-32801, 'modified'));

            expect(await ctx.hover('sample.ts', 0, 0)).toBeNull();
            expect(harness.requests).toHaveLength(2);
            expect(ctx.lastError?.code).toBe(-32801);
            expect(ctx.collectTimings()[0]).toMatchObject({ result: 'error', retries: 1, error: 'modified' });
        });

        it('does not retry other errors and omits retries when there were none', async () => {
            harness.rejections.push(responseError(-32603, 'internal'));
            await ctx.hover('sample.ts', 0, 0);
            expect(harness.requests).toHaveLength(1);
            expect(ctx.collectTimings()[0].retries).toBeUndefined();
        });
    });

    describe('unsupported requests', () => {
        beforeEach(() => {
            harness.capabilities = { hoverProvider: true, textDocumentSync: 2 };
        });

        it('exposes the capabilities and registrations of the harness', () => {
            harness.registrations = [{ id: 'r', method: 'textDocument/references' }];
            expect(ctx.capabilities).toEqual({ hoverProvider: true, textDocumentSync: 2 });
            expect(ctx.registrations).toEqual([{ id: 'r', method: 'textDocument/references' }]);
            expect(ctx.supports('textDocument/hover')).toBe(true);
            expect(ctx.supports('textDocument/references')).toBe(true);
            expect(ctx.supports('textDocument/definition')).toBe(false);
        });

        it('skips a request without a provider, recording a skipped timing without a round trip', async () => {
            harness.rejections.push(new Error('earlier failure'));
            await ctx.hover('sample.ts', 0, 0);
            expect(ctx.lastError).toBeDefined();
            ctx.collectTimings();

            expect(await ctx.definition('sample.ts', 0, 6)).toBeNull();
            expect(harness.requests.map((r) => r.method)).toEqual(['textDocument/hover']);
            expect(ctx.lastError).toBeUndefined();
            expect(ctx.collectTimings()).toEqual([
                {
                    method: 'textDocument/definition',
                    label: undefined,
                    duration_ms: 0,
                    success: false,
                    result: 'skipped',
                },
            ]);
        });

        it('sends a request the server registered dynamically', async () => {
            harness.registrations = [{ id: 'd', method: 'textDocument/definition' }];
            await ctx.definition('sample.ts', 0, 6);
            expect(harness.requests.map((r) => r.method)).toEqual(['textDocument/definition']);
            expect(ctx.collectTimings()[0].result).toBe('ok');
        });

        it('skips willSaveWaitUntil when the server does not ask for it', async () => {
            await ctx.openDocument('sample.ts');
            expect(await ctx.willSaveWaitUntil('sample.ts')).toBeNull();
            expect(harness.requests).toHaveLength(0);
            expect(ctx.collectTimings()[0].result).toBe('skipped');
        });

        it('skips mapped methods sent through request(), keeping the label, but always sends unmapped ones', async () => {
            await ctx.request('completionItem/resolve', { label: 'x' }, 'resolve');
            await ctx.request('custom/ping', {});
            expect(harness.requests.map((r) => r.method)).toEqual(['custom/ping']);
            const timings = ctx.collectTimings();
            expect(timings.map((t) => [t.method, t.label, t.result])).toEqual([
                ['completionItem/resolve', 'resolve', 'skipped'],
                ['custom/ping', undefined, 'ok'],
            ]);
        });

        it('sends unsupported requests when skipUnsupported is false', async () => {
            ctx = new BenchContextImpl(harness as unknown as LspHarness, tmpDir, false, { skipUnsupported: false });
            harness.failMethods.add('textDocument/definition');
            await ctx.definition('sample.ts', 0, 6);
            expect(harness.requests).toHaveLength(1);
            expect(ctx.collectTimings()[0].result).toBe('error');
        });
    });

    describe('classifyResult', () => {
        it('treats null and undefined as null', () => {
            expect(classifyResult(null)).toBe('null');
            expect(classifyResult(undefined)).toBe('null');
        });

        it('treats empty arrays and empty list wrappers as empty', () => {
            expect(classifyResult([])).toBe('empty');
            expect(classifyResult({ isIncomplete: false, items: [] })).toBe('empty');
            expect(classifyResult({ kind: 'full', items: [] })).toBe('empty');
            expect(classifyResult({ resultId: '1', data: [] })).toBe('empty');
            expect(classifyResult({ resultId: '2', edits: [] })).toBe('empty');
        });

        it('treats filled lists and other values as ok', () => {
            expect(classifyResult([{}])).toBe('ok');
            expect(classifyResult({ isIncomplete: false, items: [{}] })).toBe('ok');
            expect(classifyResult({ data: [1, 2, 3, 4, 5] })).toBe('ok');
            expect(classifyResult({ contents: 'doc' })).toBe('ok');
            expect(classifyResult({ kind: 'unchanged', resultId: '1' })).toBe('ok');
        });

        it('does not mistake the opaque data of a resolvable item for a list', () => {
            expect(classifyResult({ label: 'foo', data: [] })).toBe('ok');
        });
    });

    describe('collectTimings', () => {
        it('drains recorded timings so the next iteration starts empty', async () => {
            await ctx.hover('sample.ts', 0, 0);
            expect(ctx.collectTimings()).toHaveLength(1);
            expect(ctx.collectTimings()).toHaveLength(0);
        });
    });

    describe('edit', () => {
        it('throws when editing a document that is not open', async () => {
            await expect(
                ctx.edit('sample.ts', {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'x',
                }),
            ).rejects.toThrow(/is not open/);
        });

        it('sends didChange with an incremented version', async () => {
            await ctx.openDocument('sample.ts');
            await ctx.edit('sample.ts', {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                text: 'let ',
            });

            const change = harness.notifications.find((n) => n.method === 'textDocument/didChange');
            expect(change).toBeDefined();
            const params = change?.params as { textDocument: { version: number }; contentChanges: unknown[] };
            expect(params.textDocument.version).toBe(2);
            expect(params.contentChanges).toHaveLength(1);
        });

        it('sends one ranged change per edit for incremental sync', async () => {
            fs.writeFileSync(path.join(tmpDir, 'edit.txt'), 'abc', 'utf-8');
            await ctx.openDocument('edit.txt');
            await ctx.edit('edit.txt', [op(0, 3, 0, 3, 'd'), op(0, 0, 0, 1, '')]);
            const change = harness.notifications[harness.notifications.length - 1];
            expect(change.params).toEqual({
                textDocument: { uri: expect.stringMatching(/edit\.txt$/), version: 2 },
                contentChanges: [
                    { range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } }, text: 'd' },
                    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, text: '' },
                ],
            });
        });

        it('sends the whole text without a range for full sync', async () => {
            harness.changeKind = 1;
            fs.writeFileSync(path.join(tmpDir, 'edit.txt'), 'abc\n', 'utf-8');
            await ctx.openDocument('edit.txt');
            await ctx.edit('edit.txt', [op(0, 3, 0, 3, 'd'), op(0, 0, 0, 1, '')]);
            await ctx.edit('edit.txt', op(1, 0, 1, 0, 'x = 1\n'));
            const changes = harness.notifications.filter((n) => n.method === 'textDocument/didChange');
            expect(changes.map((n) => n.params)).toEqual([
                {
                    textDocument: { uri: expect.stringMatching(/edit\.txt$/), version: 2 },
                    contentChanges: [{ text: 'bcd\n' }],
                },
                {
                    textDocument: { uri: expect.stringMatching(/edit\.txt$/), version: 3 },
                    contentChanges: [{ text: 'bcd\nx = 1\n' }],
                },
            ]);
        });

        it('skips didChange for sync kind none but still tracks the text', async () => {
            harness.changeKind = 0;
            harness.saveOptions.includeText = true;
            fs.writeFileSync(path.join(tmpDir, 'edit.txt'), 'abc', 'utf-8');
            const verbose = new BenchContextImpl(harness as unknown as LspHarness, tmpDir, true);
            const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
            try {
                await verbose.openDocument('edit.txt');
                await verbose.edit('edit.txt', op(0, 3, 0, 3, 'd'));
                await verbose.saveDocument('edit.txt');
                expect(harness.notifications.map((n) => n.method)).toEqual([
                    'textDocument/didOpen',
                    'textDocument/didSave',
                ]);
                expect(harness.notifications[1].params).toMatchObject({ text: 'abcd' });
                expect(logs.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(
                    /Skipped didChange for edit\.txt: server asked for no document sync/,
                );
            } finally {
                logs.mockRestore();
            }
        });

        describe('tracked text', () => {
            /** open `content` as a fresh document, apply `edits`, and read the tracked text back via didSave */
            async function textAfter(content: string, edits: EditOperation | EditOperation[]): Promise<string> {
                fs.writeFileSync(path.join(tmpDir, 'edit.txt'), content, 'utf-8');
                harness.saveOptions.includeText = true;
                await ctx.openDocument('edit.txt');
                await ctx.edit('edit.txt', edits);
                await ctx.saveDocument('edit.txt');
                const save = harness.notifications[harness.notifications.length - 1];
                expect(save.method).toBe('textDocument/didSave');
                await ctx.closeDocument('edit.txt');
                return (save.params as { text: string }).text;
            }

            it('replaces text within a single line', async () => {
                expect(await textAfter('const x = 1;\nlet y;\n', op(0, 6, 0, 7, 'foo'))).toBe(
                    'const foo = 1;\nlet y;\n',
                );
            });

            it('replaces text spanning multiple lines', async () => {
                expect(await textAfter('aaa\nbbb\nccc\n', op(0, 1, 2, 2, 'X'))).toBe('aXc\n');
            });

            it('inserts at an empty range, including at the end of the document', async () => {
                expect(await textAfter('ab\ncd', op(1, 1, 1, 1, '-'))).toBe('ab\nc-d');
                expect(await textAfter('ab\ncd', op(1, 2, 1, 2, '\nef'))).toBe('ab\ncd\nef');
            });

            it('deletes text, including a whole line break', async () => {
                expect(await textAfter('one\ntwo\nthree\n', op(1, 0, 2, 0, ''))).toBe('one\nthree\n');
                expect(await textAfter('one two', op(0, 3, 0, 7, ''))).toBe('one');
            });

            it('applies a batch in order, each range relative to the previous result', async () => {
                const edits = [
                    // insert a new first line, shifting everything down
                    op(0, 0, 0, 0, 'first\n'),
                    // line 1 is now the original line 0
                    op(1, 0, 1, 3, 'ONE'),
                    // join the old lines 1 and 2, now at lines 2 and 3
                    op(2, 3, 3, 0, ' '),
                ];
                expect(await textAfter('one\ntwo\nthree\n', edits)).toBe('first\nONE\ntwo three\n');
            });

            it('accumulates text across separate edit calls', async () => {
                fs.writeFileSync(path.join(tmpDir, 'edit.txt'), 'abc', 'utf-8');
                harness.saveOptions.includeText = true;
                await ctx.openDocument('edit.txt');
                await ctx.edit('edit.txt', op(0, 3, 0, 3, 'd'));
                await ctx.edit('edit.txt', op(0, 0, 0, 1, ''));
                await ctx.saveDocument('edit.txt');
                const save = harness.notifications[harness.notifications.length - 1];
                expect((save.params as { text: string }).text).toBe('bcd');
            });

            it('handles \\r\\n line endings without splitting them', async () => {
                expect(await textAfter('ab\r\ncd\r\n', op(1, 0, 1, 2, 'XY'))).toBe('ab\r\nXY\r\n');
                // a character past the line end clamps to before the \r\n
                expect(await textAfter('ab\r\ncd\r\n', op(0, 99, 0, 99, '!'))).toBe('ab!\r\ncd\r\n');
                expect(await textAfter('ab\r\ncd', op(0, 2, 1, 0, ''))).toBe('abcd');
            });

            it('counts characters in UTF-16 code units', async () => {
                // the emoji is a surrogate pair, two code units wide
                expect(await textAfter('a😀b\n', op(0, 3, 0, 4, 'c'))).toBe('a😀c\n');
            });

            it('clamps a line past the end of the document to the end', async () => {
                expect(await textAfter('ab\n', op(5, 0, 5, 0, 'z'))).toBe('ab\nz');
            });
        });
    });

    describe('waitForIdle', () => {
        it('resolves after the quiet period and records server/idle', async () => {
            const result = await ctx.waitForIdle({ quietMs: 10 });
            expect(result).toEqual({ idle: true, timedOut: false, ms: 0 });
            expect(ctx.collectTimings()).toEqual([
                { method: 'server/idle', duration_ms: 0, success: true, result: 'ok' },
            ]);
        });

        it('waits for active progress to end', async () => {
            harness.progress.progress({ token: 1, value: { kind: 'begin', title: 'Indexing' } });
            setTimeout(() => harness.progress.progress({ token: 1, value: { kind: 'end' } }), 40);
            const result = await ctx.waitForIdle({ timeout: 1000, quietMs: 10 });
            expect(result.timedOut).toBe(false);
            expect(result.ms).toBeGreaterThanOrEqual(30);
        });

        it('takes a bare timeout and records a timeout', async () => {
            harness.progress.progress({ token: 1, value: { kind: 'begin', title: 'Indexing' } });
            const result = await ctx.waitForIdle(30);
            expect(result).toMatchObject({ idle: false, timedOut: true });
            expect(ctx.collectTimings()).toEqual([
                { method: 'server/idle', duration_ms: expect.any(Number), success: false, result: 'timeout' },
            ]);
        });
    });

    describe('notify and waitForDiagnostics', () => {
        it('forwards notify() straight to the harness', () => {
            ctx.notify('$/setTrace', { value: 'verbose' });
            expect(harness.notifications).toContainEqual({ method: '$/setTrace', params: { value: 'verbose' } });
        });

        describe('version aware waits', () => {
            let uri: string;
            const diag = (message: string): Diagnostic => ({ range: {}, message });

            beforeEach(() => {
                uri = `file://${path.resolve(tmpDir, 'sample.ts')}`;
            });

            /** resolves with the wait's diagnostics, or 'pending' if it has not settled within a tick */
            async function settledWithin(
                wait: Promise<WaitForDiagnosticsResult>,
                ms = 20,
            ): Promise<Diagnostic[] | 'pending'> {
                return Promise.race([
                    wait.then((r) => r.diagnostics),
                    new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms)),
                ]);
            }

            it('resolves at once when the publish arrived before the wait was registered', async () => {
                await ctx.openDocument('sample.ts');
                harness.setDiagnostics(uri, [diag('early')]);
                const start = Date.now();
                const { diagnostics } = await ctx.waitForDiagnostics('sample.ts', 5000);
                expect(diagnostics.map((d) => d.message)).toEqual(['early']);
                expect(Date.now() - start).toBeLessThan(100);
            });

            it('does not resolve with a stale empty publish landing after close and reopen', async () => {
                await ctx.openDocument('sample.ts');
                harness.setDiagnostics(uri, [diag('first')]);
                await ctx.resetDocuments();
                await ctx.openDocument('sample.ts');
                // the server clearing the closed document, received after the reopen
                harness.setDiagnostics(uri, []);
                const wait = ctx.waitForDiagnostics('sample.ts', 5000);
                expect(await settledWithin(wait)).toBe('pending');
                expect(harness.logs.some((l) => l.includes('held as tentative'))).toBe(true);
                harness.setDiagnostics(uri, [diag('fresh')]);
                expect((await wait).diagnostics.map((d) => d.message)).toEqual(['fresh']);
            });

            it('ignores a publish received while the document was closed', async () => {
                await ctx.openDocument('sample.ts');
                await ctx.closeDocument('sample.ts');
                harness.setDiagnostics(uri, [diag('closed')]);
                await ctx.openDocument('sample.ts');
                const wait = ctx.waitForDiagnostics('sample.ts', 5000);
                expect(await settledWithin(wait)).toBe('pending');
                harness.setDiagnostics(uri, [diag('reopened')]);
                expect((await wait).diagnostics.map((d) => d.message)).toEqual(['reopened']);
            });

            it('credits only the first empty publish after a close to the closed generation', async () => {
                await ctx.openDocument('sample.ts');
                await ctx.resetDocuments();
                await ctx.openDocument('sample.ts');
                harness.setDiagnostics(uri, []);
                harness.setDiagnostics(uri, []);
                expect(await settledWithin(ctx.waitForDiagnostics('sample.ts', 5000))).toEqual([]);
            });

            /** run `body` with a verbose context on the same harness, returning its ctx log lines */
            async function ctxLogs(body: (verbose: BenchContextImpl) => Promise<void>): Promise<string[]> {
                const lines: string[] = [];
                const spy = vi.spyOn(console, 'error').mockImplementation((line?: unknown) => {
                    lines.push(String(line));
                });
                try {
                    await body(new BenchContextImpl(harness as unknown as LspHarness, tmpDir, true));
                } finally {
                    spy.mockRestore();
                }
                return lines;
            }

            it('does not resolve a reopen with late close publishes and hints at it on timeout', async () => {
                const lines = await ctxLogs(async (verbose) => {
                    await verbose.openDocument('sample.ts');
                    harness.setDiagnostics(uri, [], 1);
                    await verbose.closeDocument('sample.ts');
                    // rust-analyzer clears a closed document more than once, the last after the reopen
                    harness.setDiagnostics(uri, []);
                    await verbose.openDocument('sample.ts');
                    harness.setDiagnostics(uri, []);
                    const result = await verbose.waitForDiagnostics('sample.ts', 50);
                    expect(result).toMatchObject({ timedOut: true, publishes: 0 });
                });
                expect(
                    lines.some((l) =>
                        l.includes(
                            'sample.ts saw only the 2 publishes clearing its close: the server may not republish',
                        ),
                    ),
                ).toBe(true);
            });

            it('says a reopen publish may have been credited to the close by the learned rule', async () => {
                const lines = await ctxLogs(async (verbose) => {
                    await verbose.openDocument('sample.ts');
                    await verbose.closeDocument('sample.ts');
                    // learn that the server publishes on close
                    harness.setDiagnostics(uri, []);
                    await verbose.openDocument('sample.ts');
                    await verbose.closeDocument('sample.ts');
                    await verbose.openDocument('sample.ts');
                    harness.setDiagnostics(uri, []);
                    const result = await verbose.waitForDiagnostics('sample.ts', 50);
                    expect(result).toMatchObject({ timedOut: true, publishes: 0 });
                });
                expect(
                    lines.some((l) =>
                        l.includes('sample.ts saw only the publish after the reopen credited to its close'),
                    ),
                ).toBe(true);
                expect(lines.some((l) => l.includes('may not republish'))).toBe(false);
            });

            it('logs the close window hold on the wait line', async () => {
                harness.tracker = new DiagnosticsTracker(() => {}, 40);
                const lines = await ctxLogs(async (verbose) => {
                    await verbose.openDocument('sample.ts');
                    await verbose.resetDocuments();
                    await verbose.openDocument('sample.ts');
                    harness.setDiagnostics(uri, []);
                    expect((await verbose.waitForDiagnostics('sample.ts', 5000)).closeWindowMs).toBeDefined();
                });
                expect(
                    lines.some(
                        (l) =>
                            l.includes('diagnostics/open sample.ts:') &&
                            /ms held in the close window \(not included\)/.test(l),
                    ),
                ).toBe(true);
            });

            it('gives no reopen hint for a timeout without close publishes', async () => {
                const lines = await ctxLogs(async (verbose) => {
                    await verbose.openDocument('sample.ts');
                    expect((await verbose.waitForDiagnostics('sample.ts', 20)).timedOut).toBe(true);
                });
                expect(lines.some((l) => l.includes('timeout'))).toBe(true);
                expect(lines.some((l) => l.includes('may not republish'))).toBe(false);
            });

            describe('silent servers', () => {
                const hint = 'has not published for diagnostics/open in 3 waits in a row';

                /** open, time out on and close sample.ts `n` times with `ctx` */
                async function silentOpens(verbose: BenchContextImpl, n: number): Promise<void> {
                    for (let i = 0; i < n; i++) {
                        await verbose.openDocument('sample.ts');
                        expect((await verbose.waitForDiagnostics('sample.ts', 10)).timedOut).toBe(true);
                        await verbose.closeDocument('sample.ts');
                    }
                }

                it('hints once when open waits time out without a publish in a row', async () => {
                    const lines = await ctxLogs((verbose) => silentOpens(verbose, 4));
                    expect(lines.filter((l) => l.includes(hint))).toHaveLength(1);
                });

                it('adds the plaintext note to the hint only after a fallback', async () => {
                    const note = 'Some documents were opened as plaintext';
                    const plain = await ctxLogs((verbose) => silentOpens(verbose, SILENT_WAIT_STREAK));
                    expect(plain.filter((l) => l.includes(hint))).toHaveLength(1);
                    expect(plain.some((l) => l.includes(note))).toBe(false);

                    const silence = new SilenceTracker();
                    silence.recordPlaintextFallback('.fallbackhint');
                    const lines: string[] = [];
                    const spy = vi.spyOn(console, 'error').mockImplementation((line?: unknown) => {
                        lines.push(String(line));
                    });
                    try {
                        await silentOpens(
                            new BenchContextImpl(harness as unknown as LspHarness, tmpDir, true, { silence }),
                            SILENT_WAIT_STREAK,
                        );
                    } finally {
                        spy.mockRestore();
                    }
                    expect(lines.filter((l) => l.includes(hint) && l.includes(note))).toHaveLength(1);
                });

                it('does not hint below the streak', async () => {
                    const lines = await ctxLogs((verbose) => silentOpens(verbose, SILENT_WAIT_STREAK - 1));
                    expect(lines.some((l) => l.includes('has not published'))).toBe(false);
                });

                it('restarts the streak after a resolved wait', async () => {
                    const lines = await ctxLogs(async (verbose) => {
                        await silentOpens(verbose, 2);
                        await verbose.openDocument('sample.ts');
                        harness.setDiagnostics(uri, [diag('found')]);
                        expect((await verbose.waitForDiagnostics('sample.ts', 1000)).timedOut).toBe(false);
                        await verbose.closeDocument('sample.ts');
                        await silentOpens(verbose, 2);
                    });
                    expect(lines.some((l) => l.includes('has not published'))).toBe(false);
                });

                it('does not count timeouts after publishes failing until', async () => {
                    const silence = new SilenceTracker();
                    const verbose = new BenchContextImpl(harness as unknown as LspHarness, tmpDir, false, { silence });
                    for (let i = 0; i < SILENT_WAIT_STREAK; i++) {
                        await verbose.openDocument('sample.ts');
                        harness.setDiagnostics(uri, [diag('one')]);
                        const result = await verbose.waitForDiagnostics('sample.ts', {
                            timeout: 10,
                            until: (d) => d.length > 1,
                        });
                        expect(result).toMatchObject({ timedOut: true, publishes: 1 });
                        await verbose.closeDocument('sample.ts');
                    }
                    expect(silence.silentWaits()).toBeUndefined();
                });

                it('does not count a reopen that saw only close publishes', async () => {
                    const silence = new SilenceTracker();
                    const verbose = new BenchContextImpl(harness as unknown as LspHarness, tmpDir, false, { silence });
                    await verbose.openDocument('sample.ts');
                    harness.setDiagnostics(uri, [], 1);
                    for (let i = 0; i < SILENT_WAIT_STREAK; i++) {
                        await verbose.closeDocument('sample.ts');
                        harness.setDiagnostics(uri, []);
                        await verbose.openDocument('sample.ts');
                        harness.setDiagnostics(uri, []);
                        expect((await verbose.waitForDiagnostics('sample.ts', 10)).timedOut).toBe(true);
                    }
                    expect(silence.silentWaits()).toBeUndefined();
                });

                it('adds up silent waits across contexts sharing a tracker, as with restart', async () => {
                    const silence = new SilenceTracker();
                    for (let i = 0; i < SILENT_WAIT_STREAK; i++) {
                        harness = new FakeHarness();
                        const fresh = new BenchContextImpl(harness as unknown as LspHarness, tmpDir, false, {
                            silence,
                        });
                        await silentOpens(fresh, 1);
                    }
                    expect(silence.silentWaits()).toEqual({
                        'diagnostics/open': { waits: SILENT_WAIT_STREAK, longest_streak: SILENT_WAIT_STREAK },
                    });
                });
            });

            describe('publishes failing until', () => {
                const hint = 'waits timed out after publishes that all failed `until`';

                async function trackedLogs(
                    silence: SilenceTracker,
                    body: (verbose: BenchContextImpl) => Promise<void>,
                ): Promise<string[]> {
                    const lines: string[] = [];
                    const spy = vi.spyOn(console, 'error').mockImplementation((line?: unknown) => {
                        lines.push(String(line));
                    });
                    try {
                        await body(new BenchContextImpl(harness as unknown as LspHarness, tmpDir, true, { silence }));
                    } finally {
                        spy.mockRestore();
                    }
                    return lines;
                }

                async function alternate(verbose: BenchContextImpl, n: number): Promise<void> {
                    for (let i = 0; i < n; i++) {
                        await verbose.openDocument('sample.ts');
                        harness.setDiagnostics(uri, [diag('one')]);
                        const rejected = await verbose.waitForDiagnostics('sample.ts', {
                            timeout: 10,
                            until: (d) => d.length > 1,
                        });
                        expect(rejected).toMatchObject({ timedOut: true, publishes: 1 });
                        const resolved = await verbose.waitForDiagnostics('sample.ts', {
                            timeout: 1000,
                            until: (d) => d.length === 1,
                        });
                        expect(resolved.timedOut).toBe(false);
                        await verbose.closeDocument('sample.ts');
                    }
                }

                it('logs a timeout after publishes all failing until', async () => {
                    const lines = await trackedLogs(new SilenceTracker(), (verbose) => alternate(verbose, 1));
                    expect(
                        lines.filter((l) => l.includes('1 publishes, all failing until (last: 1 diagnostics)')),
                    ).toHaveLength(1);
                    expect(lines.filter((l) => l.includes('all failing until'))).toHaveLength(1);
                });

                it('counts such timeouts alternating with resolving waits of the same method', async () => {
                    const silence = new SilenceTracker();
                    const lines = await trackedLogs(silence, (verbose) => alternate(verbose, SILENT_WAIT_STREAK + 1));
                    expect(silence.untilRejected()).toEqual({
                        'diagnostics/open': { waits: SILENT_WAIT_STREAK + 1 },
                    });
                    expect(silence.silentWaits()).toBeUndefined();
                    expect(
                        lines.filter((l) => l.includes(`${SILENT_WAIT_STREAK} diagnostics/open ${hint}`)),
                    ).toHaveLength(1);
                });

                it('adds the plaintext note to the hint only after a fallback', async () => {
                    const note = 'Some documents were opened as plaintext';
                    const plain = await trackedLogs(new SilenceTracker(), (verbose) =>
                        alternate(verbose, SILENT_WAIT_STREAK),
                    );
                    expect(plain.filter((l) => l.includes(hint))).toHaveLength(1);
                    expect(plain.some((l) => l.includes(note))).toBe(false);

                    const silence = new SilenceTracker();
                    silence.recordPlaintextFallback('.fallbackuntil');
                    const lines = await trackedLogs(silence, (verbose) => alternate(verbose, SILENT_WAIT_STREAK));
                    expect(lines.filter((l) => l.includes(hint) && l.includes(note))).toHaveLength(1);
                });

                it('does not note them below the threshold', async () => {
                    const silence = new SilenceTracker();
                    const lines = await trackedLogs(silence, (verbose) => alternate(verbose, SILENT_WAIT_STREAK - 1));
                    expect(silence.untilRejected()).toBeUndefined();
                    expect(lines.some((l) => l.includes(hint))).toBe(false);
                });

                it('does not note resolving waits or silent timeouts', async () => {
                    const silence = new SilenceTracker();
                    const lines = await trackedLogs(silence, async (verbose) => {
                        for (let i = 0; i < SILENT_WAIT_STREAK; i++) {
                            await verbose.openDocument('sample.ts');
                            expect((await verbose.waitForDiagnostics('sample.ts', { timeout: 10 })).timedOut).toBe(
                                true,
                            );
                            harness.setDiagnostics(uri, [diag('one')]);
                            const resolved = await verbose.waitForDiagnostics('sample.ts', {
                                timeout: 1000,
                                until: (d) => d.length > 0,
                            });
                            expect(resolved.timedOut).toBe(false);
                            await verbose.closeDocument('sample.ts');
                        }
                    });
                    expect(silence.untilRejected()).toBeUndefined();
                    expect(lines.some((l) => l.includes('failing until'))).toBe(false);
                });

                it('does not count a timeout that held a placeholder passing until', async () => {
                    const silence = new SilenceTracker();
                    harness.capabilities = { textDocumentSync: 2 };
                    harness.progress.serverStatusChanged({ health: 'ok', quiescent: false });
                    const lines = await trackedLogs(silence, async (verbose) => {
                        for (let i = 0; i < SILENT_WAIT_STREAK; i++) {
                            await verbose.openDocument('sample.ts');
                            const waiting = verbose.waitForDiagnostics('sample.ts', {
                                timeout: 30,
                                until: (d) => d.length === 0,
                            });
                            harness.setDiagnostics(uri, [diag('one')], 1);
                            harness.setDiagnostics(uri, [], 1);
                            const result = await waiting;
                            expect(result).toMatchObject({ timedOut: true, publishes: 2 });
                            await verbose.closeDocument('sample.ts');
                        }
                    });
                    expect(silence.untilRejected()).toBeUndefined();
                    expect(lines.some((l) => l.includes('empty publishes held'))).toBe(true);
                    expect(lines.some((l) => l.includes('failing until'))).toBe(false);
                });
            });

            describe('shortening waits known to time out', () => {
                const shortMs = 20;

                function shortening(silence: SilenceTracker, verbose = false): BenchContextImpl {
                    return new BenchContextImpl(harness as unknown as LspHarness, tmpDir, verbose, {
                        silence,
                        shortenSilentWaitsMs: shortMs,
                    });
                }

                async function silentOpen(
                    verbose: BenchContextImpl,
                    timeout: number,
                ): Promise<WaitForDiagnosticsResult> {
                    await verbose.openDocument('sample.ts');
                    const result = await verbose.waitForDiagnostics('sample.ts', timeout);
                    await verbose.closeDocument('sample.ts');
                    return result;
                }

                async function shortenedLogs(
                    silence: SilenceTracker,
                    body: (verbose: BenchContextImpl) => Promise<void>,
                ): Promise<string[]> {
                    const lines: string[] = [];
                    const spy = vi.spyOn(console, 'error').mockImplementation((line?: unknown) => {
                        lines.push(String(line));
                    });
                    try {
                        await body(shortening(silence, true));
                    } finally {
                        spy.mockRestore();
                    }
                    return lines;
                }

                function useCloseWindow(ms: number): void {
                    harness.tracker = new DiagnosticsTracker(() => {}, ms);
                    linkPlaceholders(harness.tracker, harness.progress);
                }

                beforeEach(() => {
                    useCloseWindow(0);
                });

                it('runs every silent wait to its full timeout without the option', async () => {
                    const silence = new SilenceTracker();
                    const plain = new BenchContextImpl(harness as unknown as LspHarness, tmpDir, false, { silence });
                    for (let i = 0; i < SILENT_WAIT_STREAK + 2; i++) {
                        const result = await silentOpen(plain, 60);
                        expect(result.timedOut).toBe(true);
                        expect(result.ms).toBeGreaterThanOrEqual(55);
                        expect(result).not.toHaveProperty('shortened');
                    }
                    expect(plain.collectTimings().some((t) => 'shortened' in t)).toBe(false);
                    expect(silence.silentWaits()).toEqual({
                        'diagnostics/open': { waits: SILENT_WAIT_STREAK + 2, longest_streak: SILENT_WAIT_STREAK + 2 },
                    });
                });

                it('shortens silent waits once SILENT_WAIT_STREAK of a method timed out in a row', async () => {
                    const silence = new SilenceTracker();
                    const lines = await shortenedLogs(silence, async (verbose) => {
                        for (let i = 0; i < SILENT_WAIT_STREAK; i++) {
                            const result = await silentOpen(verbose, 60);
                            expect(result.ms).toBeGreaterThanOrEqual(55);
                            expect(result).not.toHaveProperty('shortened');
                        }
                        const result = await silentOpen(verbose, 5000);
                        expect(result).toMatchObject({ timedOut: true, shortened: true, publishes: 0 });
                        expect(result.ms).toBeGreaterThanOrEqual(shortMs - 5);
                        expect(result.ms).toBeLessThan(1000);
                        const timings = verbose.collectTimings();
                        expect(timings.at(-1)).toMatchObject({
                            method: 'diagnostics/open',
                            result: 'timeout',
                            success: false,
                            shortened: true,
                        });
                        expect(timings.filter((t) => t.shortened)).toHaveLength(1);
                    });
                    expect(silence.silentWaits()).toEqual({
                        'diagnostics/open': {
                            waits: SILENT_WAIT_STREAK + 1,
                            longest_streak: SILENT_WAIT_STREAK + 1,
                            shortened: 1,
                        },
                    });
                    expect(
                        lines.some((l) =>
                            /diagnostics\/open sample\.ts: [\d.]+ms timeout \(shortened\), 0 diagnostics/.test(l),
                        ),
                    ).toBe(true);
                });

                it('restores the full timeout after a silent kind wait resolves', async () => {
                    const silence = new SilenceTracker();
                    const verbose = shortening(silence);
                    for (let i = 0; i < SILENT_WAIT_STREAK; i++) {
                        silence.record('diagnostics/open', uri, true);
                    }
                    await verbose.openDocument('sample.ts');
                    harness.setDiagnostics(uri, [diag('found')]);
                    const resolved = await verbose.waitForDiagnostics('sample.ts', 5000);
                    expect(resolved.timedOut).toBe(false);
                    await verbose.closeDocument('sample.ts');
                    const full = await silentOpen(verbose, 80);
                    expect(full).toMatchObject({ timedOut: true });
                    expect(full).not.toHaveProperty('shortened');
                    expect(full.ms).toBeGreaterThanOrEqual(75);
                });

                it('does not shorten waits of a server that publishes', async () => {
                    const silence = new SilenceTracker();
                    const verbose = shortening(silence);
                    for (let i = 0; i < SILENT_WAIT_STREAK + 3; i++) {
                        await verbose.openDocument('sample.ts');
                        setTimeout(() => harness.setDiagnostics(uri, i % 2 === 0 ? [] : [diag('found')]), shortMs * 2);
                        const result = await verbose.waitForDiagnostics('sample.ts', 1000);
                        expect(result.timedOut).toBe(false);
                        await verbose.closeDocument('sample.ts');
                    }
                    expect(verbose.collectTimings().some((t) => t.shortened)).toBe(false);
                    expect(silence.silentWaits()).toBeUndefined();
                });

                it('does not shorten a silent kind wait while the close window is open', async () => {
                    useCloseWindow(120);
                    const silence = new SilenceTracker();
                    const verbose = shortening(silence);
                    for (let i = 0; i < SILENT_WAIT_STREAK; i++) {
                        silence.record('diagnostics/open', uri, true);
                    }
                    await verbose.openDocument('sample.ts');
                    await verbose.closeDocument('sample.ts');
                    const closedAt = Date.now();
                    await verbose.openDocument('sample.ts');
                    const result = await verbose.waitForDiagnostics('sample.ts', 5000);
                    expect(result).toMatchObject({ timedOut: true, shortened: true });
                    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(115);
                    expect(Date.now() - closedAt).toBeLessThan(1000);
                });

                it('does not shorten a wait while a placeholder publish is held', async () => {
                    const silence = new SilenceTracker();
                    const verbose = shortening(silence);
                    for (let i = 0; i < SILENT_WAIT_STREAK; i++) {
                        silence.record('diagnostics/open', uri, true);
                    }
                    harness.capabilities = { textDocumentSync: 2 };
                    harness.progress.serverStatusChanged({ health: 'ok', quiescent: false });
                    await verbose.openDocument('sample.ts');
                    harness.setDiagnostics(uri, [], 1);
                    const result = await verbose.waitForDiagnostics('sample.ts', 100);
                    expect(result.timedOut).toBe(true);
                    expect(result).not.toHaveProperty('shortened');
                    expect(result.ms).toBeGreaterThanOrEqual(95);
                    expect(verbose.collectTimings().at(-1)).toMatchObject({ held_publishes: 1 });
                });

                it('does not shorten a wait while a pull answer is held', async () => {
                    const silence = new SilenceTracker();
                    const verbose = shortening(silence);
                    for (let i = 0; i < SILENT_WAIT_STREAK; i++) {
                        silence.record('diagnostics/open', uri, true);
                    }
                    harness.capabilities = { diagnosticProvider: { interFileDependencies: false } };
                    harness.response = { kind: 'full', items: [] };
                    harness.progress.serverStatusChanged({ health: 'ok', quiescent: false });
                    await verbose.openDocument('sample.ts');
                    const result = await verbose.waitForDiagnostics('sample.ts', { timeout: 150, pullAfterMs: 5 });
                    expect(result.timedOut).toBe(true);
                    expect(result).not.toHaveProperty('shortened');
                    expect(result.ms).toBeGreaterThanOrEqual(145);
                    expect(verbose.collectTimings().at(-1)).toMatchObject({ held_pulls: 1 });
                });

                it('does not shorten the push grace of a server whose delivery is unknown', async () => {
                    const silence = new SilenceTracker();
                    const verbose = shortening(silence);
                    for (let i = 0; i < SILENT_WAIT_STREAK; i++) {
                        silence.record('diagnostics/open', uri, true);
                    }
                    harness.capabilities = { diagnosticProvider: { interFileDependencies: false } };
                    harness.response = { kind: 'full', items: [diag('pulled')] };
                    await verbose.openDocument('sample.ts');
                    const result = await verbose.waitForDiagnostics('sample.ts', {
                        timeout: 5000,
                        pullAfterMs: shortMs * 3,
                    });
                    expect(result).toMatchObject({ timedOut: false, source: 'pull' });
                    expect(result).not.toHaveProperty('shortened');
                });

                describe('silent waits of several documents', () => {
                    function writeDocuments(): Record<string, string> {
                        const uris: Record<string, string> = {};
                        for (const file of ['a.ts', 'b.ts', 'c.ts']) {
                            fs.writeFileSync(path.join(tmpDir, file), '\n', 'utf-8');
                            uris[file] = `file://${path.resolve(tmpDir, file)}`;
                        }
                        return uris;
                    }

                    async function openWait(
                        verbose: BenchContextImpl,
                        file: string,
                        timeout: number,
                        fileUri?: string,
                    ): Promise<WaitForDiagnosticsResult> {
                        await verbose.openDocument(file);
                        if (fileUri) {
                            harness.setDiagnostics(fileUri, [diag('found')]);
                        }
                        const result = await verbose.waitForDiagnostics(file, timeout);
                        await verbose.closeDocument(file);
                        return result;
                    }

                    it('shortens silent documents interleaved with a resolving one', async () => {
                        const uris = writeDocuments();
                        const silence = new SilenceTracker();
                        const verbose = shortening(silence);
                        let waits = 0;
                        for (let i = 0; i < SILENT_WAIT_STREAK + 2; i++) {
                            for (const file of ['a.ts', 'b.ts']) {
                                const full = waits < SILENT_WAIT_STREAK;
                                waits++;
                                const result = await openWait(verbose, file, full ? 40 : 5000);
                                expect(result.timedOut).toBe(true);
                                if (full) {
                                    expect(result).not.toHaveProperty('shortened');
                                } else {
                                    expect(result).toMatchObject({ shortened: true });
                                    expect(result.ms).toBeLessThan(1000);
                                }
                            }
                            const resolved = await openWait(verbose, 'c.ts', 5000, uris['c.ts']);
                            expect(resolved.timedOut).toBe(false);
                            expect(resolved).not.toHaveProperty('shortened');
                        }
                        expect(silence.silentWaits()).toEqual({
                            'diagnostics/open': {
                                waits: 2 * (SILENT_WAIT_STREAK + 2),
                                longest_streak: SILENT_WAIT_STREAK + 2,
                                shortened: 2 * (SILENT_WAIT_STREAK + 2) - SILENT_WAIT_STREAK,
                            },
                        });
                    });

                    it('restores the full timeout only for the document whose wait resolved', async () => {
                        const uris = writeDocuments();
                        const silence = new SilenceTracker();
                        const verbose = shortening(silence);
                        for (let i = 0; i < SILENT_WAIT_STREAK; i++) {
                            silence.record('diagnostics/open', uris['a.ts'], true);
                            silence.record('diagnostics/open', uris['b.ts'], true);
                        }
                        expect((await openWait(verbose, 'a.ts', 5000, uris['a.ts'])).timedOut).toBe(false);
                        const a = await openWait(verbose, 'a.ts', 80);
                        expect(a.timedOut).toBe(true);
                        expect(a).not.toHaveProperty('shortened');
                        expect(a.ms).toBeGreaterThanOrEqual(75);
                        const b = await openWait(verbose, 'b.ts', 5000);
                        expect(b).toMatchObject({ timedOut: true, shortened: true });
                        expect(b.ms).toBeLessThan(1000);
                    });

                    it('sums silent waits over documents and keeps the longest streak of any', () => {
                        const silence = new SilenceTracker();
                        for (let i = 0; i < 4; i++) {
                            silence.record('diagnostics/open', 'file:///a.ts', true);
                        }
                        silence.recordShortened('silent', 'diagnostics/open', 'file:///a.ts');
                        for (let i = 0; i < 3; i++) {
                            silence.record('diagnostics/open', 'file:///b.ts', true);
                        }
                        silence.recordShortened('silent', 'diagnostics/open', 'file:///b.ts');
                        silence.record('diagnostics/open', 'file:///b.ts', false);
                        silence.record('diagnostics/edit', 'file:///a.ts', true);
                        expect(silence.shortens('silent', 'diagnostics/open', 'file:///a.ts')).toBe(true);
                        expect(silence.shortens('silent', 'diagnostics/open', 'file:///b.ts')).toBe(false);
                        expect(silence.shortens('silent', 'diagnostics/open')).toBe(false);
                        expect(silence.silentWaits()).toEqual({
                            'diagnostics/open': { waits: 7, longest_streak: 4, shortened: 2 },
                        });
                    });

                    it('signals the hint once per method when several documents reach the streak', () => {
                        const silence = new SilenceTracker();
                        const hints: boolean[] = [];
                        for (let i = 0; i < SILENT_WAIT_STREAK + 1; i++) {
                            hints.push(silence.record('diagnostics/open', 'file:///a.ts', true));
                            hints.push(silence.record('diagnostics/open', 'file:///b.ts', true));
                        }
                        expect(hints.filter((h) => h)).toHaveLength(1);
                        expect(hints[SILENT_WAIT_STREAK - 1]).toBe(true);
                        for (let i = 0; i < SILENT_WAIT_STREAK - 1; i++) {
                            silence.record('diagnostics/edit', 'file:///a.ts', true);
                        }
                        expect(silence.record('diagnostics/edit', 'file:///a.ts', true)).toBe(true);
                    });

                    it('does not signal the hint again after the pooled streak drops and rises', () => {
                        const silence = new SilenceTracker();
                        const hints: boolean[] = [];
                        for (const file of ['a', 'b', 'c']) {
                            hints.push(silence.record('diagnostics/open', `file:///${file}.ts`, true));
                        }
                        silence.record('diagnostics/open', 'file:///a.ts', false);
                        silence.record('diagnostics/open', 'file:///b.ts', false);
                        for (const file of ['a', 'b', 'd']) {
                            hints.push(silence.record('diagnostics/open', `file:///${file}.ts`, true));
                        }
                        expect(hints).toEqual([false, false, true, false, false, false]);
                    });

                    it('qualifies a method on silent waits pooled over documents', () => {
                        const silence = new SilenceTracker();
                        const hints: boolean[] = [];
                        for (const file of ['a', 'b', 'c']) {
                            hints.push(silence.record('diagnostics/open', `file:///${file}.ts`, true));
                        }
                        expect(hints).toEqual([false, false, true]);
                        for (const file of ['a', 'b', 'c']) {
                            expect(silence.shortens('silent', 'diagnostics/open', `file:///${file}.ts`)).toBe(true);
                        }
                        expect(silence.shortens('silent', 'diagnostics/edit', 'file:///a.ts')).toBe(false);
                        silence.recordShortened('silent', 'diagnostics/open', 'file:///b.ts');
                        expect(silence.silentWaits()).toEqual({
                            'diagnostics/open': { waits: 3, longest_streak: 1, shortened: 1 },
                        });
                    });

                    it('shortens a new document of a qualified method only from its second silent wait', () => {
                        const silence = new SilenceTracker();
                        for (const file of ['a', 'b', 'c']) {
                            silence.record('diagnostics/open', `file:///${file}.ts`, true);
                        }
                        expect(silence.shortens('silent', 'diagnostics/open', 'file:///d.ts')).toBe(false);
                        silence.record('diagnostics/open', 'file:///d.ts', true);
                        expect(silence.shortens('silent', 'diagnostics/open', 'file:///d.ts')).toBe(true);
                    });

                    it('lowers the pooled streak by the resolving document only', () => {
                        const silence = new SilenceTracker();
                        silence.record('diagnostics/open', 'file:///a.ts', true);
                        silence.record('diagnostics/open', 'file:///a.ts', true);
                        silence.record('diagnostics/open', 'file:///b.ts', true);
                        expect(silence.shortens('silent', 'diagnostics/open', 'file:///a.ts')).toBe(true);
                        expect(silence.shortens('silent', 'diagnostics/open', 'file:///b.ts')).toBe(true);
                        expect(silence.record('diagnostics/open', 'file:///a.ts', false)).toBe(false);
                        expect(silence.shortens('silent', 'diagnostics/open', 'file:///a.ts')).toBe(false);
                        expect(silence.shortens('silent', 'diagnostics/open', 'file:///b.ts')).toBe(false);
                        expect(silence.record('diagnostics/open', 'file:///c.ts', true)).toBe(false);
                        expect(silence.shortens('silent', 'diagnostics/open', 'file:///b.ts')).toBe(false);
                        expect(silence.record('diagnostics/open', 'file:///d.ts', true)).toBe(false);
                        for (const file of ['b', 'c', 'd']) {
                            expect(silence.shortens('silent', 'diagnostics/open', `file:///${file}.ts`)).toBe(true);
                        }
                        expect(silence.shortens('silent', 'diagnostics/open', 'file:///a.ts')).toBe(false);
                        silence.record('diagnostics/open', 'file:///a.ts', true);
                        expect(silence.shortens('silent', 'diagnostics/open', 'file:///a.ts')).toBe(true);
                    });

                    it('shortens each silent document after one timeout of its own once the method qualified', async () => {
                        writeDocuments();
                        fs.writeFileSync(path.join(tmpDir, 'd.ts'), '\n', 'utf-8');
                        const silence = new SilenceTracker();
                        const verbose = shortening(silence);
                        for (const file of ['a.ts', 'b.ts', 'c.ts']) {
                            const result = await openWait(verbose, file, 40);
                            expect(result.timedOut).toBe(true);
                            expect(result).not.toHaveProperty('shortened');
                        }
                        for (const file of ['a.ts', 'b.ts', 'c.ts']) {
                            const result = await openWait(verbose, file, 5000);
                            expect(result).toMatchObject({ timedOut: true, shortened: true });
                            expect(result.ms).toBeLessThan(1000);
                        }
                        const first = await openWait(verbose, 'd.ts', 80);
                        expect(first).not.toHaveProperty('shortened');
                        expect(first.ms).toBeGreaterThanOrEqual(75);
                        const second = await openWait(verbose, 'd.ts', 5000);
                        expect(second).toMatchObject({ timedOut: true, shortened: true });
                    });
                });

                describe('reopen waits', () => {
                    async function reopenOnly(
                        verbose: BenchContextImpl,
                        timeout: number,
                        file = 'sample.ts',
                    ): Promise<WaitForDiagnosticsResult> {
                        const fileUri = `file://${path.resolve(tmpDir, file)}`;
                        await verbose.closeDocument(file);
                        harness.setDiagnostics(fileUri, []);
                        await verbose.openDocument(file);
                        harness.setDiagnostics(fileUri, []);
                        return verbose.waitForDiagnostics(file, timeout);
                    }

                    async function reopenResolving(
                        verbose: BenchContextImpl,
                        file: string,
                    ): Promise<WaitForDiagnosticsResult> {
                        const fileUri = `file://${path.resolve(tmpDir, file)}`;
                        await verbose.closeDocument(file);
                        await verbose.openDocument(file);
                        harness.setDiagnostics(fileUri, [diag('found')]);
                        return verbose.waitForDiagnostics(file, 5000);
                    }

                    it('shortens reopen waits that saw only close publishes, no earlier than the close window ends', async () => {
                        useCloseWindow(60);
                        const silence = new SilenceTracker();
                        const lines = await shortenedLogs(silence, async (verbose) => {
                            await verbose.openDocument('sample.ts');
                            harness.setDiagnostics(uri, [], 1);
                            for (let i = 0; i < SILENT_WAIT_STREAK; i++) {
                                const result = await reopenOnly(verbose, 100);
                                expect(result).toMatchObject({ timedOut: true, publishes: 0 });
                                expect(result).not.toHaveProperty('shortened');
                            }
                            const closedAt = Date.now();
                            const result = await reopenOnly(verbose, 5000);
                            expect(result).toMatchObject({ timedOut: true, publishes: 0, shortened: true });
                            expect(Date.now() - closedAt).toBeGreaterThanOrEqual(55);
                            expect(Date.now() - closedAt).toBeLessThan(1000);
                        });
                        expect(silence.reopenWaits()).toEqual({
                            'diagnostics/open': {
                                waits: SILENT_WAIT_STREAK + 1,
                                longest_streak: SILENT_WAIT_STREAK + 1,
                                shortened: 1,
                            },
                        });
                        expect(silence.silentWaits()).toBeUndefined();
                        expect(lines.some((l) => l.includes('timeout (shortened)'))).toBe(true);
                    });

                    it('restores the full timeout after a reopen wait resolves', async () => {
                        const silence = new SilenceTracker();
                        const verbose = shortening(silence);
                        await verbose.openDocument('sample.ts');
                        harness.setDiagnostics(uri, [], 1);
                        for (let i = 0; i < SILENT_WAIT_STREAK; i++) {
                            silence.recordReopen('diagnostics/open', uri, true);
                        }
                        await verbose.closeDocument('sample.ts');
                        await verbose.openDocument('sample.ts');
                        harness.setDiagnostics(uri, [diag('found')]);
                        expect((await verbose.waitForDiagnostics('sample.ts', 5000)).timedOut).toBe(false);
                        const result = await reopenOnly(verbose, 80);
                        expect(result.timedOut).toBe(true);
                        expect(result).not.toHaveProperty('shortened');
                        expect(result.ms).toBeGreaterThanOrEqual(75);
                        expect(silence.reopenWaits()).toBeUndefined();
                    });

                    it('shortens a timing out document between reopens of a resolving one', async () => {
                        fs.writeFileSync(path.join(tmpDir, 'other.ts'), '\n', 'utf-8');
                        const otherUri = `file://${path.resolve(tmpDir, 'other.ts')}`;
                        const silence = new SilenceTracker();
                        const verbose = shortening(silence);
                        await verbose.openDocument('other.ts');
                        harness.setDiagnostics(otherUri, [diag('found')], 1);
                        await verbose.openDocument('sample.ts');
                        harness.setDiagnostics(uri, [], 1);
                        for (let i = 0; i < SILENT_WAIT_STREAK; i++) {
                            const resolved = await reopenResolving(verbose, 'other.ts');
                            expect(resolved.timedOut).toBe(false);
                            const result = await reopenOnly(verbose, 60);
                            expect(result).toMatchObject({ timedOut: true, publishes: 0 });
                            expect(result).not.toHaveProperty('shortened');
                        }
                        const resolved = await reopenResolving(verbose, 'other.ts');
                        expect(resolved.timedOut).toBe(false);
                        expect(resolved).not.toHaveProperty('shortened');
                        const result = await reopenOnly(verbose, 5000);
                        expect(result).toMatchObject({ timedOut: true, publishes: 0, shortened: true });
                        expect(result.ms).toBeLessThan(1000);
                        expect(silence.reopenWaits()).toEqual({
                            'diagnostics/open': {
                                waits: SILENT_WAIT_STREAK + 1,
                                longest_streak: SILENT_WAIT_STREAK + 1,
                                shortened: 1,
                            },
                        });
                    });

                    it('restores the full timeout only for the document whose reopen resolved', async () => {
                        fs.writeFileSync(path.join(tmpDir, 'other.ts'), '\n', 'utf-8');
                        const otherUri = `file://${path.resolve(tmpDir, 'other.ts')}`;
                        const silence = new SilenceTracker();
                        const verbose = shortening(silence);
                        await verbose.openDocument('sample.ts');
                        harness.setDiagnostics(uri, [], 1);
                        await verbose.openDocument('other.ts');
                        harness.setDiagnostics(otherUri, [], 1);
                        for (let i = 0; i < SILENT_WAIT_STREAK; i++) {
                            silence.recordReopen('diagnostics/open', uri, true);
                            silence.recordReopen('diagnostics/open', otherUri, true);
                        }
                        expect((await reopenResolving(verbose, 'other.ts')).timedOut).toBe(false);
                        const other = await reopenOnly(verbose, 80, 'other.ts');
                        expect(other.timedOut).toBe(true);
                        expect(other).not.toHaveProperty('shortened');
                        expect(other.ms).toBeGreaterThanOrEqual(75);
                        const sample = await reopenOnly(verbose, 5000);
                        expect(sample).toMatchObject({ timedOut: true, shortened: true });
                        expect(sample.ms).toBeLessThan(1000);
                    });

                    it('sums reopen waits over documents and keeps the longest streak of any', () => {
                        const silence = new SilenceTracker();
                        for (let i = 0; i < 4; i++) {
                            silence.recordReopen('diagnostics/open', 'file:///a.ts', true);
                        }
                        silence.recordShortened('reopen', 'diagnostics/open', 'file:///a.ts');
                        for (let i = 0; i < 3; i++) {
                            silence.recordReopen('diagnostics/open', 'file:///b.ts', true);
                        }
                        silence.recordShortened('reopen', 'diagnostics/open', 'file:///b.ts');
                        silence.recordReopen('diagnostics/open', 'file:///b.ts', false);
                        silence.recordReopen('diagnostics/edit', 'file:///a.ts', true);
                        expect(silence.shortens('reopen', 'diagnostics/open', 'file:///a.ts')).toBe(true);
                        expect(silence.shortens('reopen', 'diagnostics/open', 'file:///b.ts')).toBe(false);
                        expect(silence.shortens('reopen', 'diagnostics/open')).toBe(false);
                        expect(silence.reopenWaits()).toEqual({
                            'diagnostics/open': { waits: 7, longest_streak: 4, shortened: 2 },
                        });
                    });

                    it('qualifies a method on reopen waits pooled over documents', () => {
                        const silence = new SilenceTracker();
                        for (const file of ['a', 'b', 'c']) {
                            expect(silence.shortens('reopen', 'diagnostics/open', `file:///${file}.ts`)).toBe(false);
                            silence.recordReopen('diagnostics/open', `file:///${file}.ts`, true);
                        }
                        for (const file of ['a', 'b', 'c']) {
                            expect(silence.shortens('reopen', 'diagnostics/open', `file:///${file}.ts`)).toBe(true);
                        }
                        expect(silence.shortens('reopen', 'diagnostics/open', 'file:///d.ts')).toBe(false);
                        silence.recordReopen('diagnostics/open', 'file:///d.ts', true);
                        expect(silence.shortens('reopen', 'diagnostics/open', 'file:///d.ts')).toBe(true);
                        silence.recordReopen('diagnostics/open', 'file:///d.ts', false);
                        expect(silence.shortens('reopen', 'diagnostics/open', 'file:///d.ts')).toBe(false);
                        expect(silence.shortens('reopen', 'diagnostics/open', 'file:///a.ts')).toBe(true);
                        silence.recordReopen('diagnostics/open', 'file:///a.ts', false);
                        expect(silence.shortens('reopen', 'diagnostics/open', 'file:///b.ts')).toBe(false);
                        expect(silence.shortens('silent', 'diagnostics/open', 'file:///b.ts')).toBe(false);
                        expect(silence.silentWaits()).toBeUndefined();
                    });

                    it('shortens each reopening document after one timeout of its own once the method qualified', async () => {
                        const files = ['a.ts', 'b.ts', 'c.ts'];
                        for (const file of files) {
                            fs.writeFileSync(path.join(tmpDir, file), '\n', 'utf-8');
                        }
                        const silence = new SilenceTracker();
                        const verbose = shortening(silence);
                        for (const file of files) {
                            await verbose.openDocument(file);
                            harness.setDiagnostics(`file://${path.resolve(tmpDir, file)}`, [], 1);
                        }
                        for (const file of files) {
                            const result = await reopenOnly(verbose, 40, file);
                            expect(result).toMatchObject({ timedOut: true, publishes: 0 });
                            expect(result).not.toHaveProperty('shortened');
                        }
                        for (const file of files) {
                            const result = await reopenOnly(verbose, 5000, file);
                            expect(result).toMatchObject({ timedOut: true, publishes: 0, shortened: true });
                            expect(result.ms).toBeLessThan(1000);
                        }
                        expect(silence.reopenWaits()).toEqual({
                            'diagnostics/open': { waits: 6, longest_streak: 2, shortened: 3 },
                        });
                    });

                    it('still resolves with a close candidate accepted when the close window ends', async () => {
                        useCloseWindow(60);
                        const silence = new SilenceTracker();
                        const verbose = shortening(silence);
                        for (let i = 0; i < SILENT_WAIT_STREAK; i++) {
                            silence.recordReopen('diagnostics/open', uri, true);
                        }
                        await verbose.openDocument('sample.ts');
                        await verbose.closeDocument('sample.ts');
                        harness.setDiagnostics(uri, []);
                        await verbose.openDocument('sample.ts');
                        harness.setDiagnostics(uri, []);
                        const result = await verbose.waitForDiagnostics('sample.ts', 5000);
                        expect(result).toMatchObject({ timedOut: false, diagnostics: [] });
                        expect(result.closeWindowMs).toBeDefined();
                        expect(result).not.toHaveProperty('shortened');
                    });
                });

                describe('waits with publishes failing until', () => {
                    const rejecting = { until: (d: Diagnostic[]) => d.length > 1 };

                    async function rejectedThenResolved(
                        verbose: BenchContextImpl,
                        timeout: number,
                    ): Promise<WaitForDiagnosticsResult> {
                        await verbose.openDocument('sample.ts');
                        harness.setDiagnostics(uri, [diag('one')]);
                        const rejected = await verbose.waitForDiagnostics('sample.ts', { timeout, ...rejecting });
                        const resolved = await verbose.waitForDiagnostics('sample.ts', {
                            timeout: 1000,
                            until: (d) => d.length === 1,
                        });
                        expect(resolved.timedOut).toBe(false);
                        expect(resolved).not.toHaveProperty('shortened');
                        await verbose.closeDocument('sample.ts');
                        return rejected;
                    }

                    it('ends a wait after its rejected publish, alternating with resolving waits of the method', async () => {
                        const silence = new SilenceTracker();
                        const verbose = shortening(silence);
                        for (let i = 0; i < SILENT_WAIT_STREAK; i++) {
                            const result = await rejectedThenResolved(verbose, 60);
                            expect(result).toMatchObject({ timedOut: true, publishes: 1 });
                            expect(result).not.toHaveProperty('shortened');
                        }
                        const start = Date.now();
                        const result = await rejectedThenResolved(verbose, 5000);
                        expect(result).toMatchObject({ timedOut: true, publishes: 1, shortened: true });
                        expect(Date.now() - start).toBeLessThan(1000);
                        expect(silence.untilRejected()).toEqual({
                            'diagnostics/open': { waits: SILENT_WAIT_STREAK + 1, shortened: 1 },
                        });
                        expect(verbose.collectTimings().filter((t) => t.shortened)).toHaveLength(1);
                    });

                    it('restarts the deadline on each rejected publish', async () => {
                        const silence = new SilenceTracker();
                        const verbose = shortening(silence);
                        for (let i = 0; i < SILENT_WAIT_STREAK; i++) {
                            silence.recordUntilRejected('diagnostics/edit');
                        }
                        await verbose.openDocument('sample.ts');
                        harness.setDiagnostics(uri, [], 1);
                        await verbose.edit('sample.ts', op(0, 0, 0, 0, 'x'));
                        const start = Date.now();
                        for (const at of [10, 25, 40]) {
                            setTimeout(() => harness.setDiagnostics(uri, [diag('one')], 2), at);
                        }
                        const result = await verbose.waitForDiagnostics('sample.ts', { timeout: 5000, ...rejecting });
                        expect(result).toMatchObject({ timedOut: true, publishes: 3, shortened: true });
                        expect(Date.now() - start).toBeGreaterThanOrEqual(40 + shortMs - 5);
                    });

                    it('resolves on a passing publish within the shortened timeout and restores the full timeout', async () => {
                        const silence = new SilenceTracker();
                        const verbose = shortening(silence);
                        for (let i = 0; i < SILENT_WAIT_STREAK; i++) {
                            silence.recordUntilRejected('diagnostics/open');
                        }
                        await verbose.openDocument('sample.ts');
                        harness.setDiagnostics(uri, [diag('one')]);
                        setTimeout(() => harness.setDiagnostics(uri, [diag('one'), diag('two')]), shortMs / 4);
                        const resolved = await verbose.waitForDiagnostics('sample.ts', { timeout: 5000, ...rejecting });
                        expect(resolved).toMatchObject({ timedOut: false, publishes: 2 });
                        await verbose.closeDocument('sample.ts');
                        const result = await rejectedThenResolved(verbose, 80);
                        expect(result.timedOut).toBe(true);
                        expect(result).not.toHaveProperty('shortened');
                        expect(result.ms).toBeGreaterThanOrEqual(75);
                    });
                });
            });

            it('accepts an empty publish after reopen once the close window has passed', async () => {
                harness.tracker = new DiagnosticsTracker(() => {}, 0);
                await ctx.openDocument('sample.ts');
                await ctx.resetDocuments();
                await ctx.openDocument('sample.ts');
                await new Promise((r) => setTimeout(r, 5));
                // a clean file from a server that never publishes on close
                harness.setDiagnostics(uri, []);
                expect(await settledWithin(ctx.waitForDiagnostics('sample.ts', 5000))).toEqual([]);
            });

            it('times an empty publish accepted at the end of the close window from its receipt', async () => {
                harness.tracker = new DiagnosticsTracker(() => {}, 60);
                await ctx.openDocument('sample.ts');
                await ctx.resetDocuments();
                await ctx.openDocument('sample.ts');
                // a clean file from a server that never publishes on close
                harness.setDiagnostics(uri, []);
                const start = Date.now();
                const result = await ctx.waitForDiagnostics('sample.ts', 5000);
                expect(Date.now() - start).toBeGreaterThanOrEqual(40);
                const waitedMs = Date.now() - start;
                expect(waitedMs).toBeGreaterThanOrEqual(40);
                expect(result).toMatchObject({ diagnostics: [], timedOut: false, publishes: 1 });
                expect(result.ms).toBeLessThan(30);
                // the hold until the window ended is recorded apart from the duration
                expect(result.closeWindowMs).toBeGreaterThanOrEqual(30);
                expect(result.ms + (result.closeWindowMs ?? 0)).toBeLessThanOrEqual(waitedMs + 5);
                const [timing] = ctx.collectTimings().filter((t) => t.method === 'diagnostics/open');
                expect(timing?.close_window_ms).toBe(result.closeWindowMs);
                expect(harness.tracker.closeBehavior).toBe('silent');
            });

            it('records no close window hold when the window ended before the wait', async () => {
                harness.tracker = new DiagnosticsTracker(() => {}, 20);
                await ctx.openDocument('sample.ts');
                await ctx.resetDocuments();
                await ctx.openDocument('sample.ts');
                harness.setDiagnostics(uri, []);
                await new Promise((r) => setTimeout(r, 50));
                const result = await ctx.waitForDiagnostics('sample.ts', 5000);
                expect(result).toMatchObject({ diagnostics: [], timedOut: false, publishes: 1 });
                expect(result.closeWindowMs).toBeUndefined();
                expect(ctx.collectTimings().some((t) => t.close_window_ms !== undefined)).toBe(false);
            });

            it('records the close window hold of a further empty publish for a server not versioning', async () => {
                harness.tracker = new DiagnosticsTracker(() => {}, 60);
                await ctx.openDocument('sample.ts');
                await ctx.closeDocument('sample.ts');
                // the server clears the closed document, teaching that it publishes on close
                harness.setDiagnostics(uri, []);
                expect(harness.tracker.closeBehavior).toBe('publishes');
                await ctx.openDocument('sample.ts');
                // a further empty publish, held since the server does not version its publishes
                harness.setDiagnostics(uri, []);
                const result = await ctx.waitForDiagnostics('sample.ts', 5000);
                expect(result).toMatchObject({ diagnostics: [], timedOut: false, publishes: 1 });
                expect(result.closeWindowMs).toBeGreaterThanOrEqual(30);
                expect(harness.tracker.closeBehavior).toBe('publishes');
            });

            it('does not resolve a wait for a newer version with an old version publish', async () => {
                await ctx.openDocument('sample.ts');
                await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                harness.setDiagnostics(uri, [diag('v1')], 1);
                const wait = ctx.waitForDiagnostics('sample.ts', 5000);
                expect(await settledWithin(wait)).toBe('pending');
                harness.setDiagnostics(uri, [diag('v2')], 2);
                expect((await wait).diagnostics.map((d) => d.message)).toEqual(['v2']);
            });

            it('treats a cached unversioned publish from before the latest edit as stale', async () => {
                await ctx.openDocument('sample.ts');
                harness.setDiagnostics(uri, [diag('before edit')]);
                await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                const wait = ctx.waitForDiagnostics('sample.ts', 5000);
                expect(await settledWithin(wait)).toBe('pending');
                harness.setDiagnostics(uri, [diag('after edit')]);
                expect((await wait).diagnostics.map((d) => d.message)).toEqual(['after edit']);
            });

            it('falls back to the cached diagnostics on timeout', async () => {
                await ctx.openDocument('sample.ts');
                await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                harness.setDiagnostics(uri, [diag('v1')], 1);
                const result = await ctx.waitForDiagnostics('sample.ts', 10);
                expect(result.diagnostics.map((d) => d.message)).toEqual(['v1']);
                expect(result).toMatchObject({ timedOut: true, publishes: 0 });
            });

            it('accepts an options object as well as a bare timeout', async () => {
                await ctx.openDocument('sample.ts');
                const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 10 });
                expect(result).toEqual({
                    diagnostics: [],
                    timedOut: true,
                    publishes: 0,
                    source: 'push',
                    pulls: 0,
                    ms: result.ms,
                });
            });

            it('resolves with the diagnostics, one publish and timedOut false', async () => {
                await ctx.openDocument('sample.ts');
                const wait = ctx.waitForDiagnostics('sample.ts');
                harness.setDiagnostics(uri, [diag('a'), diag('b')]);
                const result = await wait;
                expect(result).toMatchObject({ timedOut: false, publishes: 1 });
                expect(result.diagnostics).toHaveLength(2);
                expect(result.ms).toBeGreaterThanOrEqual(0);
            });

            it('records a diagnostics/open timing with the diagnostic count', async () => {
                await ctx.openDocument('sample.ts');
                harness.setDiagnostics(uri, [diag('a'), diag('b')]);
                const result = await ctx.waitForDiagnostics('sample.ts', 5000);
                const timings = ctx.collectTimings();
                expect(timings).toEqual([
                    {
                        method: 'diagnostics/open',
                        duration_ms: result.ms,
                        success: true,
                        result: 'ok',
                        diagnostics: 2,
                    },
                ]);
            });

            it('labels a wait after an edit diagnostics/edit and an empty publish as empty', async () => {
                await ctx.openDocument('sample.ts');
                await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                harness.setDiagnostics(uri, [], 2);
                await ctx.waitForDiagnostics('sample.ts', 5000);
                expect(ctx.collectTimings()).toMatchObject([
                    { method: 'diagnostics/edit', success: true, result: 'empty', diagnostics: 0 },
                ]);
            });

            it('times from the latest didOpen to the publish, not from the call', async () => {
                await ctx.openDocument('sample.ts');
                harness.setDiagnostics(uri, [diag('early')]);
                await new Promise((r) => setTimeout(r, 50));
                const result = await ctx.waitForDiagnostics('sample.ts', 5000);
                expect(result.ms).toBeLessThan(40);
            });

            it('records a timeout as result timeout with the cached diagnostic count', async () => {
                await ctx.openDocument('sample.ts');
                await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                harness.setDiagnostics(uri, [diag('v1')], 1);
                const result = await ctx.waitForDiagnostics('sample.ts', 10);
                expect(result.timedOut).toBe(true);
                expect(ctx.collectTimings()).toEqual([
                    {
                        method: 'diagnostics/edit',
                        duration_ms: result.ms,
                        success: false,
                        result: 'timeout',
                        diagnostics: 1,
                    },
                ]);
            });

            it('decides the timeout by the timer, not by elapsed time', async () => {
                await ctx.openDocument('sample.ts');
                const wait = ctx.waitForDiagnostics('sample.ts', 5);
                // block the loop past the timeout, the publish then lands before the timer runs
                const until = Date.now() + 20;
                while (Date.now() < until) {
                    // busy wait
                }
                harness.setDiagnostics(uri, [diag('late')]);
                const result = await wait;
                expect(result).toMatchObject({ timedOut: false, publishes: 1 });
                expect(result.ms).toBeGreaterThan(5);
                expect(ctx.collectTimings()).toMatchObject([{ method: 'diagnostics/open', result: 'ok' }]);
            });

            it('labels a wait on a document that is not open diagnostics/wait', async () => {
                const wait = ctx.waitForDiagnostics('sample.ts', 5000);
                harness.setDiagnostics(uri, [diag('next')]);
                await wait;
                expect(ctx.collectTimings()).toMatchObject([
                    { method: 'diagnostics/wait', success: true, result: 'ok', diagnostics: 1 },
                ]);
            });

            it('waits for the next publish on a document that is not open', async () => {
                harness.setDiagnostics(uri, [diag('cached')]);
                const wait = ctx.waitForDiagnostics('sample.ts', 5000);
                expect(await settledWithin(wait)).toBe('pending');
                harness.setDiagnostics(uri, [diag('next')]);
                expect((await wait).diagnostics.map((d) => d.message)).toEqual(['next']);
            });
        });

        describe('until and settleMs', () => {
            let uri: string;
            const diag = (message: string): Diagnostic => ({ range: {}, message });
            const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
            const messages = (r: WaitForDiagnosticsResult) => r.diagnostics.map((d) => d.message);
            const nonEmpty = (d: Diagnostic[]) => d.length > 0;

            beforeEach(() => {
                uri = `file://${path.resolve(tmpDir, 'sample.ts')}`;
            });

            /** whether the wait is still pending after ms */
            async function pendingAfter(wait: Promise<unknown>, ms = 20): Promise<boolean> {
                const pending = Symbol('pending');
                const winner = await Promise.race([wait, sleep(ms).then(() => pending)]);
                return winner === pending;
            }

            it('skips an empty syntax pass and resolves on the semantic errors', async () => {
                await ctx.openDocument('sample.ts');
                const wait = ctx.waitForDiagnostics('sample.ts', { timeout: 5000, until: nonEmpty });
                // rust-analyzer: an empty publish from the syntax pass first
                harness.setDiagnostics(uri, []);
                expect(await pendingAfter(wait)).toBe(true);
                harness.setDiagnostics(uri, [diag('mismatched types')]);
                const result = await wait;
                expect(messages(result)).toEqual(['mismatched types']);
                expect(result).toMatchObject({ timedOut: false, publishes: 2 });
                expect(ctx.collectTimings()).toMatchObject([
                    { method: 'diagnostics/open', success: true, result: 'ok', diagnostics: 1 },
                ]);
            });

            it('skips an empty versioned pass after an edit', async () => {
                await ctx.openDocument('sample.ts');
                await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                harness.setDiagnostics(uri, [diag('old')], 1);
                harness.setDiagnostics(uri, [], 2);
                const wait = ctx.waitForDiagnostics('sample.ts', { timeout: 5000, until: nonEmpty });
                expect(await pendingAfter(wait)).toBe(true);
                harness.setDiagnostics(uri, [diag('type error')], 2);
                expect(await wait).toMatchObject({ timedOut: false, publishes: 2 });
            });

            it('resolves at once when the cached current publish satisfies until', async () => {
                await ctx.openDocument('sample.ts');
                harness.setDiagnostics(uri, [diag('early')]);
                const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, until: nonEmpty });
                expect(result).toMatchObject({ timedOut: false, publishes: 1 });
            });

            it('times out with the latest current publish when until is never satisfied', async () => {
                await ctx.openDocument('sample.ts');
                await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                harness.setDiagnostics(uri, [diag('stale')], 1);
                harness.setDiagnostics(uri, [], 2);
                const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 30, until: nonEmpty });
                expect(result).toMatchObject({ diagnostics: [], timedOut: true, publishes: 1 });
                expect(result.ms).toBeGreaterThanOrEqual(25);
                expect(ctx.collectTimings()).toMatchObject([
                    { method: 'diagnostics/edit', success: false, result: 'timeout', diagnostics: 0 },
                ]);
            });

            it('falls back to the cached diagnostics when no current publish arrived', async () => {
                await ctx.openDocument('sample.ts');
                await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                harness.setDiagnostics(uri, [diag('stale')], 1);
                const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 10, until: nonEmpty });
                expect(messages(result)).toEqual(['stale']);
                expect(result).toMatchObject({ timedOut: true, publishes: 0 });
            });

            it('settles on the latest publish of a burst, timing it without the quiet period', async () => {
                await ctx.openDocument('sample.ts');
                const start = Date.now();
                const wait = ctx.waitForDiagnostics('sample.ts', { timeout: 5000, settleMs: 60 });
                harness.setDiagnostics(uri, [diag('a')]);
                await sleep(20);
                harness.setDiagnostics(uri, [diag('a'), diag('b')]);
                await sleep(20);
                harness.setDiagnostics(uri, [diag('c')]);
                const result = await wait;
                const elapsed = Date.now() - start;
                expect(messages(result)).toEqual(['c']);
                expect(result).toMatchObject({ timedOut: false, publishes: 3 });
                expect(elapsed).toBeGreaterThanOrEqual(95);
                expect(result.ms).toBeLessThan(elapsed - 50);
            });

            it('starts settling only once until is satisfied', async () => {
                await ctx.openDocument('sample.ts');
                const wait = ctx.waitForDiagnostics('sample.ts', { timeout: 5000, until: nonEmpty, settleMs: 20 });
                harness.setDiagnostics(uri, []);
                expect(await pendingAfter(wait, 50)).toBe(true);
                harness.setDiagnostics(uri, [diag('first')]);
                await sleep(5);
                harness.setDiagnostics(uri, [diag('first'), diag('second')]);
                const result = await wait;
                expect(messages(result)).toEqual(['first', 'second']);
                expect(result).toMatchObject({ timedOut: false, publishes: 3 });
            });

            it('resolves with the latest publish, not timed out, when the timeout cuts the quiet period', async () => {
                await ctx.openDocument('sample.ts');
                const start = Date.now();
                const wait = ctx.waitForDiagnostics('sample.ts', { timeout: 40, settleMs: 5000 });
                harness.setDiagnostics(uri, [diag('only')]);
                const result = await wait;
                expect(Date.now() - start).toBeLessThan(1000);
                expect(result).toMatchObject({ timedOut: false, publishes: 1 });
                expect(ctx.collectTimings()).toMatchObject([{ result: 'ok', success: true }]);
            });

            it('counts the quiet period of a close window candidate from its receipt', async () => {
                harness.tracker = new DiagnosticsTracker(() => {}, 60);
                await ctx.openDocument('sample.ts');
                await ctx.resetDocuments();
                await ctx.openDocument('sample.ts');
                // a clean file from a server that never publishes on close
                harness.setDiagnostics(uri, []);
                const start = Date.now();
                const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, settleMs: 30 });
                // delivered at the end of the window, already quiet for longer than settleMs
                expect(Date.now() - start).toBeLessThan(85);
                expect(result).toMatchObject({ diagnostics: [], timedOut: false, publishes: 1 });
                expect(result.ms).toBeLessThan(30);
            });

            it('does not count a superseded close window candidate', async () => {
                await ctx.openDocument('sample.ts');
                await ctx.resetDocuments();
                await ctx.openDocument('sample.ts');
                harness.setDiagnostics(uri, []);
                const wait = ctx.waitForDiagnostics('sample.ts', { timeout: 5000, until: nonEmpty, settleMs: 10 });
                harness.setDiagnostics(uri, [diag('fresh')]);
                const result = await wait;
                expect(messages(result)).toEqual(['fresh']);
                expect(result.publishes).toBe(1);
                expect(result.closeWindowMs).toBeUndefined();
                expect(ctx.collectTimings().some((t) => t.close_window_ms !== undefined)).toBe(false);
            });

            it('rejects when until throws', async () => {
                await ctx.openDocument('sample.ts');
                const wait = ctx.waitForDiagnostics('sample.ts', {
                    timeout: 5000,
                    until: () => {
                        throw new Error('bad predicate');
                    },
                });
                harness.setDiagnostics(uri, [diag('a')]);
                await expect(wait).rejects.toThrow('bad predicate');
            });
        });

        describe('pull diagnostics', () => {
            let uri: string;
            const diag = (message: string, code?: string): Diagnostic => ({
                range: {},
                message,
                ...(code ? { code } : {}),
            });
            const full = (resultId: string, ...items: Diagnostic[]) => ({ kind: 'full', resultId, items });
            const unchanged = (resultId: string) => ({ kind: 'unchanged', resultId });
            const messages = (r: WaitForDiagnosticsResult) => r.diagnostics.map((d) => d.message);
            const pulls = () => harness.requests.filter((r) => r.method === 'textDocument/diagnostic');
            const previousResultIds = () =>
                pulls().map((r) => (r.params as { previousResultId?: string }).previousResultId);

            /** an error shaped like a vscode-jsonrpc ResponseError */
            function responseError(code: number, message: string): Error {
                return Object.assign(new Error(message), { code });
            }

            /**
             * Make the fake a pull only server: it advertises diagnosticProvider, never publishes,
             * and answers each pull with the next report (or throws it), repeating the last one
             */
            function servePulls(...reports: unknown[]): void {
                harness.capabilities = {
                    diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
                };
                harness.respond = (method) => {
                    if (method !== 'textDocument/diagnostic') {
                        return null;
                    }
                    const next = reports.length > 1 ? reports.shift() : reports[0];
                    if (next instanceof Error) {
                        throw next;
                    }
                    return typeof next === 'function' ? next() : next;
                };
            }

            beforeEach(() => {
                uri = `file://${path.resolve(tmpDir, 'sample.ts')}`;
            });

            it('auto: pulls from a pull only server once the grace period passes without a push', async () => {
                servePulls(full('1', diag('type error')));
                await ctx.openDocument('sample.ts');
                const start = Date.now();
                const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 30 });
                expect(Date.now() - start).toBeGreaterThanOrEqual(25);
                expect(messages(result)).toEqual(['type error']);
                expect(result).toMatchObject({ timedOut: false, source: 'pull', pulls: 1, publishes: 0 });
                // timed from didOpen like a push wait, the grace period is included and reported
                expect(result.graceMs).toBeGreaterThanOrEqual(25);
                expect(result.ms).toBeGreaterThanOrEqual(result.graceMs ?? Infinity);
                expect(pulls()[0].params).toEqual({ textDocument: { uri } });
                const timings = ctx.collectTimings();
                expect(timings).toMatchObject([
                    { method: 'diagnostics/pull/open', success: true, result: 'ok', diagnostics: 1 },
                ]);
                expect(timings[0].duration_ms).toBe(result.ms);
                expect(timings[0].grace_ms).toBe(result.graceMs);
            });

            it('auto: a pull at once is timed from the latest sync, without grace_ms', async () => {
                servePulls(full('1', diag('a')));
                await ctx.openDocument('sample.ts');
                await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 10 });
                expect(harness.diagnosticsDelivery()).toBe('pull');
                await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                await new Promise((resolve) => setTimeout(resolve, 30));
                const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 1000 });
                expect(result).toMatchObject({ source: 'pull', pulls: 1 });
                // the script's time between didChange and the wait counts, as for a push wait
                expect(result.ms).toBeGreaterThanOrEqual(25);
                expect(result.graceMs).toBeUndefined();
                const timings = ctx.collectTimings();
                expect(timings[1]).toMatchObject({ method: 'diagnostics/pull/edit', result: 'ok' });
                expect(timings[1].grace_ms).toBeUndefined();
            });

            it('auto: a repeated pull of an unchanged document is timed from the wait', async () => {
                servePulls(full('1', diag('a')));
                await ctx.openDocument('sample.ts');
                await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 10 });
                await new Promise((resolve) => setTimeout(resolve, 50));
                const again = await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 10 });
                expect(again).toMatchObject({ source: 'pull', pulls: 1 });
                // already pulled since didOpen, so the time since then is not attributed to this pull
                expect(again.ms).toBeLessThan(40);
            });

            it('auto: learns a pull only server and pulls at once on later waits', async () => {
                servePulls(full('1', diag('a')));
                await ctx.openDocument('sample.ts');
                await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 60 });
                expect(harness.diagnosticsDelivery()).toBe('pull');
                expect(harness.logs.some((l) => l.includes('only answers pulls'))).toBe(true);
                await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                const start = Date.now();
                const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 60 });
                expect(Date.now() - start).toBeLessThan(40);
                expect(result).toMatchObject({ source: 'pull', pulls: 1 });
            });

            it('auto: waits for pushes once the server published for any opened document', async () => {
                servePulls(full('1', diag('pulled')));
                fs.writeFileSync(path.join(tmpDir, 'pushed.ts'), '\n', 'utf-8');
                await ctx.openDocument('pushed.ts');
                harness.setDiagnostics(`file://${path.resolve(tmpDir, 'pushed.ts')}`, []);
                expect(harness.diagnosticsDelivery()).toBe('push');
                await ctx.openDocument('sample.ts');
                const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 60, pullAfterMs: 5 });
                expect(result).toMatchObject({ timedOut: true, source: 'push' });
                expect(pulls()).toEqual([]);
            });

            it('auto: still pulls after a stray publish for a document that was never opened', async () => {
                // ts7: advertises diagnosticProvider, never pushes for .ts files, but clears
                // tsconfig.json (never opened, lowercased URI) right after the first didOpen
                servePulls(full('1', diag('type error')));
                await ctx.openDocument('sample.ts');
                harness.setDiagnostics('file:///users/someone/project/tsconfig.json', []);
                expect(harness.diagnosticsDelivery()).toBe('unknown');
                expect(harness.logs.some((l) => l.includes('Server pushes diagnostics'))).toBe(false);
                const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 20 });
                expect(messages(result)).toEqual(['type error']);
                expect(result).toMatchObject({ timedOut: false, source: 'pull', pulls: 1, publishes: 0 });
                expect(harness.diagnosticsDelivery()).toBe('pull');
                // later waits pull at once, a further stray publish does not flip it to push
                harness.setDiagnostics('file:///users/someone/project/tsconfig.json', []);
                expect(harness.diagnosticsDelivery()).toBe('pull');
                await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                const start = Date.now();
                const edited = await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 1000 });
                expect(Date.now() - start).toBeLessThan(500);
                expect(edited).toMatchObject({ timedOut: false, source: 'pull', pulls: 1 });
                expect(ctx.collectTimings()).toMatchObject([
                    { method: 'diagnostics/pull/open', success: true, result: 'ok' },
                    { method: 'diagnostics/pull/edit', success: true, result: 'ok' },
                ]);
            });

            it('auto: a pull only server clearing a closed document keeps pulling (ruby-lsp)', async () => {
                const other = `file://${path.resolve(tmpDir, 'other.ts')}`;
                fs.writeFileSync(path.join(tmpDir, 'other.ts'), '\n', 'utf-8');
                let cleared = false;
                servePulls(() => {
                    if (pulls().length === 2 && !cleared) {
                        cleared = true;
                        harness.setDiagnostics(uri, []);
                    }
                    return full('1');
                });
                await ctx.openDocument('sample.ts');
                await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 10 });
                expect(harness.diagnosticsDelivery()).toBe('pull');
                await ctx.closeDocument('sample.ts');
                await ctx.openDocument('other.ts');
                const result = await ctx.waitForDiagnostics('other.ts', { timeout: 5000, pullAfterMs: 1000 });
                expect(cleared).toBe(true);
                expect(result).toMatchObject({ timedOut: false, source: 'pull', pulls: 1 });
                expect(harness.diagnosticsDelivery()).toBe('pull');
                expect(harness.logs.some((l) => l.includes('Server pushes diagnostics'))).toBe(false);
                expect(harness.logs.some((l) => l.includes(`Empty publish clearing closed ${uri}`))).toBe(true);
                expect(pulls().map((r) => (r.params as { textDocument: { uri: string } }).textDocument.uri)).toEqual([
                    uri,
                    other,
                ]);
                expect(ctx.collectTimings()).toMatchObject([
                    { method: 'diagnostics/pull/open', result: 'empty' },
                    { method: 'diagnostics/pull/open', result: 'empty' },
                ]);
            });

            it('auto: a publish flips a pull only server back to push', async () => {
                servePulls(full('1'));
                await ctx.openDocument('sample.ts');
                await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 10 });
                expect(harness.diagnosticsDelivery()).toBe('pull');
                await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                harness.setDiagnostics(uri, [diag('pushed')], 2);
                expect(harness.diagnosticsDelivery()).toBe('push');
                const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 10 });
                expect(result).toMatchObject({ source: 'push', pulls: 0 });
                expect(pulls()).toHaveLength(1);
            });

            it('auto: waits for pushes instead when a push arrived during the fallback pull', async () => {
                servePulls(async () => {
                    harness.setDiagnostics(uri, []);
                    return full('1');
                });
                await ctx.openDocument('sample.ts');
                const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 10 });
                expect(result).toMatchObject({ timedOut: false, source: 'push', publishes: 1 });
                expect(harness.diagnosticsDelivery()).toBe('push');
                // the abandoned pull records no timing, the push is timed from didOpen
                expect(ctx.collectTimings()).toMatchObject([{ method: 'diagnostics/open', success: true }]);
            });

            it('auto: rust-analyzer cold start, empty pull early, push later, no wait times out', async () => {
                // advertises diagnosticProvider, answers pulls with an empty placeholder while
                // loading, and starts pushing once loaded
                servePulls(full('1'));
                await ctx.openDocument('sample.ts');
                const opened = await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 10 });
                expect(opened).toMatchObject({ timedOut: false, source: 'pull', diagnostics: [], tentative: true });
                // the empty pull does not settle delivery as pull
                expect(harness.diagnosticsDelivery()).toBe('pull');
                expect(harness.tracker.deliveryTentative).toBe(true);
                expect(harness.logs.some((l) => l.includes('tentatively pull only'))).toBe(true);

                // the edit's wait pulls at once and keeps re-pulling the placeholder, until the
                // server pushes: the wait switches to pushes instead of running into its timeout
                await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                const start = Date.now();
                const edited = ctx.waitForDiagnostics('sample.ts', {
                    timeout: 5000,
                    pullAfterMs: 10,
                    until: (d) => d.length > 0,
                });
                await new Promise((r) => setTimeout(r, 60));
                expect(pulls().length).toBeGreaterThan(1);
                harness.setDiagnostics(uri, [diag('expected i32, found String')], 2);
                const editResult = await edited;
                expect(Date.now() - start).toBeLessThan(1000);
                expect(messages(editResult)).toEqual(['expected i32, found String']);
                expect(editResult).toMatchObject({ timedOut: false, source: 'push', pulls: 0, publishes: 1 });
                expect(editResult.tentative).toBeUndefined();
                expect(harness.diagnosticsDelivery()).toBe('push');
                expect(harness.tracker.deliveryTentative).toBe(false);
                const pullCount = pulls().length;

                // the fix edit is waited on for pushes
                await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                const fixed = ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 10 });
                await new Promise((r) => setTimeout(r, 20));
                harness.setDiagnostics(uri, [], 3);
                expect(await fixed).toMatchObject({ timedOut: false, source: 'push', diagnostics: [] });
                expect(pulls()).toHaveLength(pullCount);

                const timings = ctx.collectTimings();
                expect(timings).toMatchObject([
                    { method: 'diagnostics/pull/open', success: true, result: 'empty', tentative: true },
                    { method: 'diagnostics/edit', success: true, result: 'ok' },
                    { method: 'diagnostics/edit', success: true, result: 'empty' },
                ]);
                expect(timings[1].tentative).toBeUndefined();
                expect(timings.some((t) => t.result === 'timeout')).toBe(false);
            });

            it('auto: a push during a pull the server holds switches the wait to pushes', async () => {
                servePulls(full('1'));
                await ctx.openDocument('sample.ts');
                await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 10 });
                expect(harness.tracker.deliveryTentative).toBe(true);
                // the server holds the next pull until it is done loading, and pushes first
                harness.respond = () => new Promise(() => {});
                await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                const edited = ctx.waitForDiagnostics('sample.ts', { timeout: 5000 });
                await new Promise((r) => setTimeout(r, 20));
                expect(pulls()).toHaveLength(2);
                harness.setDiagnostics(uri, [diag('pushed')], 2);
                const result = await edited;
                expect(result).toMatchObject({ timedOut: false, source: 'push', publishes: 1 });
                expect(messages(result)).toEqual(['pushed']);
                expect(ctx.collectTimings()).toMatchObject([
                    { method: 'diagnostics/pull/open', tentative: true },
                    { method: 'diagnostics/edit', success: true },
                ]);
            });

            it('auto: a pull returning diagnostics settles a tentative pull only server', async () => {
                servePulls(full('1'), full('2', diag('a')));
                await ctx.openDocument('sample.ts');
                const opened = await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 10 });
                expect(opened.tentative).toBe(true);
                await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                const edited = await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 10 });
                expect(edited).toMatchObject({ source: 'pull', pulls: 1 });
                expect(edited.tentative).toBeUndefined();
                expect(harness.diagnosticsDelivery()).toBe('pull');
                expect(harness.tracker.deliveryTentative).toBe(false);
                expect(harness.logs.some((l) => l.includes('only answers pulls'))).toBe(true);
                const timings = ctx.collectTimings();
                expect(timings[0].tentative).toBe(true);
                expect(timings[1].tentative).toBeUndefined();
            });

            it('auto: does not learn pull only from a pull that timed out', async () => {
                servePulls(full('1'));
                await ctx.openDocument('sample.ts');
                const result = await ctx.waitForDiagnostics('sample.ts', {
                    timeout: 60,
                    pullAfterMs: 10,
                    until: (d) => d.length > 0,
                });
                expect(result).toMatchObject({ timedOut: true, source: 'pull' });
                expect(harness.diagnosticsDelivery()).toBe('unknown');
            });

            describe('busy servers', () => {
                const busy = () => harness.progress.serverStatusChanged({ health: 'ok', quiescent: false });
                const quiescent = () => harness.progress.serverStatusChanged({ health: 'ok', quiescent: true });

                it('holds an empty pull of a busy server and pulls again once it is quiescent', async () => {
                    // rust-analyzer under --restart: a carried tentative pull, then a placeholder while loading
                    servePulls(full('placeholder'), full('2'));
                    harness.tracker.seedDelivery('pull', true);
                    busy();
                    await ctx.openDocument('sample.ts');
                    const start = Date.now();
                    const waiting = ctx.waitForDiagnostics('sample.ts', { timeout: 5000 });
                    await new Promise((r) => setTimeout(r, 50));
                    expect(pulls()).toHaveLength(1);
                    expect(harness.logs.some((l) => l.includes('tentatively pull only'))).toBe(false);
                    quiescent();
                    const result = await waiting;
                    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
                    expect(result).toMatchObject({ timedOut: false, source: 'pull', diagnostics: [], pulls: 2 });
                    expect(result.tentative).toBe(true);
                    expect(result.graceMs).toBeUndefined();
                    // timed from didOpen, the wait for the server to load included
                    expect(result.ms).toBeGreaterThanOrEqual(45);
                    // the placeholder's resultId is not sent with the next pull
                    expect(previousResultIds()).toEqual([undefined, undefined]);
                    const timings = ctx.collectTimings();
                    expect(timings).toMatchObject([
                        { method: 'diagnostics/pull/open', success: true, result: 'empty', held_pulls: 1 },
                    ]);
                    expect(timings[0].grace_ms).toBeUndefined();
                });

                it('takes a push after a held empty pull', async () => {
                    servePulls(full('1'));
                    harness.tracker.seedDelivery('pull', true);
                    busy();
                    await ctx.openDocument('sample.ts');
                    const waiting = ctx.waitForDiagnostics('sample.ts', { timeout: 5000 });
                    await new Promise((r) => setTimeout(r, 20));
                    harness.setDiagnostics(uri, [diag('pushed')], 1);
                    const result = await waiting;
                    expect(result).toMatchObject({ timedOut: false, source: 'push', publishes: 1 });
                    expect(pulls()).toHaveLength(1);
                    expect(harness.diagnosticsDelivery()).toBe('push');
                    // the held pull is recorded on the push timing too
                    expect(ctx.collectTimings()).toMatchObject([
                        { method: 'diagnostics/open', success: true, held_pulls: 1 },
                    ]);
                });

                it('times out with the empty placeholder when the server stays busy', async () => {
                    servePulls(full('1'));
                    harness.tracker.seedDelivery('pull', true);
                    busy();
                    await ctx.openDocument('sample.ts');
                    const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 80 });
                    expect(result).toMatchObject({ timedOut: true, source: 'pull', diagnostics: [], pulls: 1 });
                    expect(ctx.collectTimings()).toMatchObject([
                        {
                            method: 'diagnostics/pull/open',
                            success: false,
                            result: 'timeout',
                            diagnostics: 0,
                            held_pulls: 1,
                        },
                    ]);
                    // nothing was learned from the placeholder
                    expect(harness.tracker.deliveryTentative).toBe(true);
                });

                it('resolves with an empty pull at once when the server never reports being busy (ts7)', async () => {
                    servePulls(full('1'));
                    harness.tracker.seedDelivery('pull', true);
                    await ctx.openDocument('sample.ts');
                    const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 5000 });
                    expect(result).toMatchObject({ timedOut: false, source: 'pull', pulls: 1, tentative: true });
                    expect(ctx.collectTimings()[0].held_pulls).toBeUndefined();
                });

                it('does not hold a busy empty pull once pull is settled', async () => {
                    servePulls(full('1'));
                    harness.markPullOnly('test');
                    busy();
                    await ctx.openDocument('sample.ts');
                    const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 5000 });
                    expect(result).toMatchObject({ timedOut: false, source: 'pull', pulls: 1 });
                });

                it('does not hold an empty pull while only flycheck progress runs after quiescence', async () => {
                    // rust-analyzer runs cargo check under a progress token once quiescent
                    servePulls(full('1'));
                    harness.tracker.seedDelivery('pull', true);
                    quiescent();
                    harness.progress.progress({ token: 'flycheck', value: { kind: 'begin', title: 'cargo check' } });
                    await ctx.openDocument('sample.ts');
                    const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 5000 });
                    expect(result).toMatchObject({ timedOut: false, source: 'pull', pulls: 1 });
                });
            });

            describe('placeholder publishes', () => {
                const busy = () => harness.progress.serverStatusChanged({ health: 'ok', quiescent: false });
                const quiescent = () => harness.progress.serverStatusChanged({ health: 'ok', quiescent: true });
                const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

                it('holds an empty publish while not quiescent and resolves with it at quiescence', async () => {
                    harness.capabilities = { textDocumentSync: 2 };
                    busy();
                    await ctx.openDocument('sample.ts');
                    const waiting = ctx.waitForDiagnostics('sample.ts', { timeout: 5000 });
                    await tick(10);
                    harness.setDiagnostics(uri, [], 1);
                    await tick(40);
                    // the placeholder neither resolved the wait nor taught push
                    expect(harness.diagnosticsDelivery()).toBe('unknown');
                    quiescent();
                    const result = await waiting;
                    expect(result).toMatchObject({ timedOut: false, source: 'push', diagnostics: [], publishes: 1 });
                    // timed to the quiescence, not to the placeholder
                    expect(result.ms).toBeGreaterThanOrEqual(45);
                    expect(pulls()).toEqual([]);
                    expect(ctx.collectTimings()).toMatchObject([
                        { method: 'diagnostics/open', success: true, result: 'empty', held_publishes: 1 },
                    ]);
                    // once trusted, a later wait takes the placeholder at once, still timed to the quiescence
                    const again = await ctx.waitForDiagnostics('sample.ts', { timeout: 5000 });
                    expect(again).toMatchObject({ timedOut: false, diagnostics: [] });
                    expect(again.ms).toBe(result.ms);
                });

                it('resolves with a newer publish after a held placeholder', async () => {
                    // rust-analyzer under --restart with push carried, as in S1
                    servePulls(full('1'));
                    harness.tracker.seedDelivery('push', false);
                    busy();
                    await ctx.openDocument('sample.ts');
                    const waiting = ctx.waitForDiagnostics('sample.ts', { timeout: 5000 });
                    harness.setDiagnostics(uri, [], 1);
                    await tick(20);
                    harness.setDiagnostics(uri, [diag('unused')], 1);
                    const result = await waiting;
                    expect(messages(result)).toEqual(['unused']);
                    expect(result).toMatchObject({ timedOut: false, source: 'push', publishes: 2 });
                    expect(pulls()).toEqual([]);
                    expect(ctx.collectTimings()).toMatchObject([
                        { method: 'diagnostics/open', success: true, diagnostics: 1, held_publishes: 1 },
                    ]);
                });

                it('resolves at once on a non-empty publish while not quiescent', async () => {
                    servePulls(full('1'));
                    busy();
                    await ctx.openDocument('sample.ts');
                    const waiting = ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 1000 });
                    harness.setDiagnostics(uri, [diag('error')], 1);
                    const result = await waiting;
                    expect(result).toMatchObject({ timedOut: false, source: 'push', publishes: 1 });
                    expect(result.ms).toBeLessThan(500);
                    expect(harness.diagnosticsDelivery()).toBe('push');
                    expect(ctx.collectTimings()[0].held_publishes).toBeUndefined();
                });

                it('resolves at once on an empty publish while only $/progress is open', async () => {
                    // a server that never sends experimental/serverStatus is not affected
                    servePulls(full('1'));
                    harness.progress.progress({ token: 'load', value: { kind: 'begin', title: 'loading' } });
                    expect(harness.isServerBusy()).toBe(true);
                    await ctx.openDocument('sample.ts');
                    const waiting = ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 1000 });
                    harness.setDiagnostics(uri, [], 1);
                    const result = await waiting;
                    expect(result).toMatchObject({ timedOut: false, source: 'push', diagnostics: [], publishes: 1 });
                    expect(result.ms).toBeLessThan(500);
                    expect(harness.diagnosticsDelivery()).toBe('push');
                    expect(ctx.collectTimings()[0].held_publishes).toBeUndefined();
                });

                it('times out with the held placeholder when the server never turns quiescent', async () => {
                    harness.capabilities = { textDocumentSync: 2 };
                    busy();
                    await ctx.openDocument('sample.ts');
                    const waiting = ctx.waitForDiagnostics('sample.ts', { timeout: 80 });
                    harness.setDiagnostics(uri, [], 1);
                    const result = await waiting;
                    expect(result).toMatchObject({ timedOut: true, source: 'push', diagnostics: [], publishes: 1 });
                    expect(ctx.collectTimings()).toMatchObject([
                        {
                            method: 'diagnostics/open',
                            success: false,
                            result: 'timeout',
                            diagnostics: 0,
                            held_publishes: 1,
                        },
                    ]);
                });

                it('holds an empty publish in push mode until quiescence, without pulling', async () => {
                    servePulls(full('1', diag('pulled')));
                    busy();
                    await ctx.openDocument('sample.ts');
                    const waiting = ctx.waitForDiagnostics('sample.ts', { timeout: 5000, mode: 'push' });
                    await tick(10);
                    harness.setDiagnostics(uri, [], 1);
                    await tick(40);
                    quiescent();
                    const result = await waiting;
                    expect(result).toMatchObject({ timedOut: false, source: 'push', diagnostics: [], publishes: 1 });
                    // timed to the quiescence, not to the placeholder
                    expect(result.ms).toBeGreaterThanOrEqual(45);
                    expect(pulls()).toEqual([]);
                    expect(ctx.collectTimings()).toMatchObject([
                        { method: 'diagnostics/open', success: true, result: 'empty', held_publishes: 1 },
                    ]);
                });

                it('resolves push mode with a newer publish after a held placeholder', async () => {
                    busy();
                    await ctx.openDocument('sample.ts');
                    const waiting = ctx.waitForDiagnostics('sample.ts', { timeout: 5000, mode: 'push' });
                    harness.setDiagnostics(uri, [], 1);
                    await tick(20);
                    harness.setDiagnostics(uri, [diag('unused')], 1);
                    const result = await waiting;
                    expect(messages(result)).toEqual(['unused']);
                    expect(result).toMatchObject({ timedOut: false, source: 'push', publishes: 2 });
                    expect(ctx.collectTimings()).toMatchObject([
                        { method: 'diagnostics/open', success: true, diagnostics: 1, held_publishes: 1 },
                    ]);
                });

                it('times out push mode with the held placeholder when the server never turns quiescent', async () => {
                    busy();
                    await ctx.openDocument('sample.ts');
                    const waiting = ctx.waitForDiagnostics('sample.ts', { timeout: 80, mode: 'push' });
                    harness.setDiagnostics(uri, [], 1);
                    const result = await waiting;
                    expect(result).toMatchObject({ timedOut: true, source: 'push', diagnostics: [], publishes: 1 });
                    expect(ctx.collectTimings()).toMatchObject([
                        { method: 'diagnostics/open', success: false, result: 'timeout', held_publishes: 1 },
                    ]);
                });

                it('resolves push mode at once on an empty publish while only $/progress is open', async () => {
                    harness.progress.progress({ token: 'load', value: { kind: 'begin', title: 'loading' } });
                    await ctx.openDocument('sample.ts');
                    const waiting = ctx.waitForDiagnostics('sample.ts', { timeout: 5000, mode: 'push' });
                    harness.setDiagnostics(uri, [], 1);
                    const result = await waiting;
                    expect(result).toMatchObject({ timedOut: false, source: 'push', publishes: 1 });
                    expect(result.ms).toBeLessThan(500);
                    expect(ctx.collectTimings()[0].held_publishes).toBeUndefined();
                });

                it('holds an empty pull in pull mode and pulls again once the server is quiescent', async () => {
                    servePulls(full('placeholder'), full('2'));
                    busy();
                    await ctx.openDocument('sample.ts');
                    const waiting = ctx.waitForDiagnostics('sample.ts', { timeout: 5000, mode: 'pull' });
                    await tick(50);
                    expect(pulls()).toHaveLength(1);
                    quiescent();
                    const result = await waiting;
                    expect(result).toMatchObject({ timedOut: false, source: 'pull', diagnostics: [], pulls: 2 });
                    // timed from the first pull, the wait for quiescence included
                    expect(result.ms).toBeGreaterThanOrEqual(45);
                    // the placeholder's resultId is not sent with the next pull
                    expect(previousResultIds()).toEqual([undefined, undefined]);
                    // pull mode learns nothing
                    expect(harness.diagnosticsDelivery()).toBe('unknown');
                    expect(ctx.collectTimings()).toMatchObject([
                        { method: 'diagnostics/pull/open', success: true, result: 'empty', held_pulls: 1 },
                    ]);
                });

                it('times out pull mode with the placeholder when the server stays busy', async () => {
                    servePulls(full('1'));
                    busy();
                    await ctx.openDocument('sample.ts');
                    const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 80, mode: 'pull' });
                    expect(result).toMatchObject({ timedOut: true, source: 'pull', diagnostics: [], pulls: 1 });
                    expect(ctx.collectTimings()).toMatchObject([
                        {
                            method: 'diagnostics/pull/open',
                            success: false,
                            result: 'timeout',
                            diagnostics: 0,
                            held_pulls: 1,
                        },
                    ]);
                });

                it('resolves pull mode at once on a non-empty pull while not quiescent', async () => {
                    servePulls(full('1', diag('error')));
                    busy();
                    await ctx.openDocument('sample.ts');
                    const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, mode: 'pull' });
                    expect(result).toMatchObject({ timedOut: false, source: 'pull', pulls: 1 });
                    expect(ctx.collectTimings()[0].held_pulls).toBeUndefined();
                });

                it('resolves pull mode at once on an empty pull of a server without a server status', async () => {
                    // ts7 never reports being busy, and an open $/progress token does not hold an explicit pull
                    servePulls(full('1'));
                    harness.progress.progress({ token: 'load', value: { kind: 'begin', title: 'loading' } });
                    await ctx.openDocument('sample.ts');
                    const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, mode: 'pull' });
                    expect(result).toMatchObject({ timedOut: false, source: 'pull', diagnostics: [], pulls: 1 });
                    expect(result.ms).toBeLessThan(500);
                    expect(ctx.collectTimings()[0].held_pulls).toBeUndefined();
                });
            });

            describe('workspace/diagnostic/refresh', () => {
                const busy = () => harness.progress.serverStatusChanged({ health: 'ok', quiescent: false });
                const quiescent = () => harness.progress.serverStatusChanged({ health: 'ok', quiescent: true });
                const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

                it('pulls on a refresh after a held placeholder and learns pull from its diagnostics', async () => {
                    // rust-analyzer under --restart: placeholders while loading, a refresh once it has diagnostics
                    let loaded = false;
                    servePulls(() => (loaded ? full('2', diag('type error')) : full('placeholder')));
                    harness.tracker.seedDelivery('pull', true);
                    busy();
                    await ctx.openDocument('sample.ts');
                    const waiting = ctx.waitForDiagnostics('sample.ts', { timeout: 5000 });
                    await tick(30);
                    expect(pulls()).toHaveLength(1);
                    loaded = true;
                    harness.refresh();
                    const result = await waiting;
                    expect(messages(result)).toEqual(['type error']);
                    expect(result).toMatchObject({ timedOut: false, source: 'pull', pulls: 2 });
                    expect(result.tentative).toBeUndefined();
                    expect(result.ms).toBeGreaterThanOrEqual(25);
                    expect(harness.diagnosticsDelivery()).toBe('pull');
                    expect(harness.tracker.deliveryTentative).toBe(false);
                    expect(harness.logs.some((l) => l.includes('on workspace/diagnostic/refresh'))).toBe(true);
                    expect(ctx.collectTimings()).toMatchObject([
                        { method: 'diagnostics/pull/open', success: true, result: 'ok', diagnostics: 1, held_pulls: 1 },
                    ]);
                    expect(harness.refreshListeners.size).toBe(0);
                });

                it('rust-analyzer cold S4: holds the placeholder pull and push until quiescence, no timeouts', async () => {
                    // replays verify/out/next3/rust-analyzer.S4.warmup0.trace.jsonl: busy from the start,
                    // an empty pull and an empty placeholder publish while loading, then quiescent
                    let loaded = false;
                    let broken = false;
                    servePulls(() => (loaded && broken ? full('e', diag('expected i32, found String')) : full('0')));
                    busy();
                    await ctx.openDocument('sample.ts');
                    const opening = ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 10 });
                    await tick(40);
                    // the pull after the grace is held, and so is the placeholder publish
                    expect(pulls()).toHaveLength(1);
                    harness.setDiagnostics(uri, [], 1);
                    await tick(20);
                    expect(harness.diagnosticsDelivery()).toBe('unknown');
                    loaded = true;
                    quiescent();
                    // once quiescent the wait pulls again, as after a held pull
                    const opened = await opening;
                    expect(opened).toMatchObject({ timedOut: false, source: 'pull', diagnostics: [], pulls: 2 });
                    expect(opened.ms).toBeGreaterThanOrEqual(55);
                    expect(harness.diagnosticsDelivery()).toBe('pull');
                    expect(harness.tracker.deliveryTentative).toBe(true);

                    // the error edit pulls at once and gets the error
                    await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                    broken = true;
                    const edited = await ctx.waitForDiagnostics('sample.ts', {
                        timeout: 5000,
                        until: (d) => d.length > 0,
                    });
                    expect(messages(edited)).toEqual(['expected i32, found String']);
                    expect(edited).toMatchObject({ timedOut: false, source: 'pull', pulls: 1 });
                    expect(harness.tracker.deliveryTentative).toBe(false);

                    // the fix edit pulls at once, no refresh and no push needed
                    await ctx.edit('sample.ts', op(0, 0, 0, 1, ''));
                    broken = false;
                    const fixed = await ctx.waitForDiagnostics('sample.ts', {
                        timeout: 5000,
                        until: (d) => d.length === 0,
                    });
                    expect(fixed).toMatchObject({ timedOut: false, source: 'pull', diagnostics: [], pulls: 1 });

                    const timings = ctx.collectTimings();
                    expect(timings).toMatchObject([
                        {
                            method: 'diagnostics/pull/open',
                            success: true,
                            result: 'empty',
                            held_pulls: 1,
                            held_publishes: 1,
                        },
                        { method: 'diagnostics/pull/edit', success: true, result: 'ok', diagnostics: 1 },
                        { method: 'diagnostics/pull/edit', success: true, result: 'empty' },
                    ]);
                    expect(timings.some((t) => t.result === 'timeout')).toBe(false);
                });

                it('learns pull from a refresh pull with diagnostics after push was learned', async () => {
                    // rust-analyzer stops pushing for a document once it was pulled and only refreshes
                    let broken = false;
                    let cancelNext = false;
                    servePulls(() => {
                        if (cancelNext) {
                            cancelNext = false;
                            throw responseError(-32802, 'server cancelled');
                        }
                        return broken ? full('e', diag('expected i32, found String')) : full('0');
                    });
                    quiescent();
                    await ctx.openDocument('sample.ts');
                    const opening = ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 1000 });
                    harness.setDiagnostics(uri, [], 1);
                    expect(await opening).toMatchObject({ timedOut: false, source: 'push', diagnostics: [] });
                    expect(harness.diagnosticsDelivery()).toBe('push');

                    // the error edit waits for a push that never comes, until the refresh
                    await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                    broken = true;
                    const editing = ctx.waitForDiagnostics('sample.ts', { timeout: 5000, until: (d) => d.length > 0 });
                    await tick(20);
                    expect(pulls()).toHaveLength(0);
                    // the first pull on refresh is cancelled, as rust-analyzer does while it recomputes
                    cancelNext = true;
                    harness.refresh();
                    const edited = await editing;
                    expect(messages(edited)).toEqual(['expected i32, found String']);
                    expect(edited).toMatchObject({ timedOut: false, source: 'pull', pulls: 2 });
                    expect(edited.ms).toBeGreaterThanOrEqual(15);
                    expect(harness.diagnosticsDelivery()).toBe('pull');
                    expect(harness.tracker.deliveryTentative).toBe(false);
                    expect(harness.logs.some((l) => l.includes('no longer waiting for pushes'))).toBe(true);
                    const timings = ctx.collectTimings();
                    expect(timings).toMatchObject([
                        { method: 'diagnostics/open', success: true, result: 'empty' },
                        { method: 'diagnostics/pull/edit', success: true, result: 'ok', diagnostics: 1 },
                    ]);
                    expect(timings[1].grace_ms).toBeUndefined();
                });

                it('sends no pull on a refresh without diagnosticProvider', async () => {
                    harness.capabilities = {};
                    await ctx.openDocument('sample.ts');
                    const waiting = ctx.waitForDiagnostics('sample.ts', { timeout: 5000 });
                    await tick(10);
                    harness.refresh();
                    await tick(10);
                    harness.setDiagnostics(uri, [diag('pushed')], 1);
                    const result = await waiting;
                    expect(result).toMatchObject({ timedOut: false, source: 'push', publishes: 1 });
                    expect(pulls()).toHaveLength(0);
                });

                it('resolves with an empty pull on refresh for a push server, which stays push', async () => {
                    // html, css and json advertise diagnosticProvider and push
                    servePulls(full('1'));
                    await ctx.openDocument('sample.ts');
                    harness.setDiagnostics(uri, [diag('a')], 1);
                    await ctx.waitForDiagnostics('sample.ts', { timeout: 5000 });
                    await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                    const waiting = ctx.waitForDiagnostics('sample.ts', { timeout: 5000 });
                    await tick(10);
                    expect(pulls()).toHaveLength(0);
                    harness.refresh();
                    const result = await waiting;
                    expect(result).toMatchObject({ timedOut: false, source: 'pull', diagnostics: [], pulls: 1 });
                    expect(harness.diagnosticsDelivery()).toBe('push');
                    expect(ctx.collectTimings()).toMatchObject([
                        { method: 'diagnostics/open', success: true },
                        { method: 'diagnostics/pull/edit', success: true, result: 'empty' },
                    ]);
                    // the next wait still waits for pushes
                    await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                    const next = ctx.waitForDiagnostics('sample.ts', { timeout: 5000 });
                    await tick(10);
                    harness.setDiagnostics(uri, [], 3);
                    expect(await next).toMatchObject({ source: 'push', publishes: 1 });
                    expect(pulls()).toHaveLength(1);
                });

                it('goes back to waiting for a push when the pull on refresh does not pass until', async () => {
                    servePulls(full('1', diag('stale')));
                    await ctx.openDocument('sample.ts');
                    harness.setDiagnostics(uri, [diag('stale')], 1);
                    await ctx.waitForDiagnostics('sample.ts', { timeout: 5000 });
                    await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                    const waiting = ctx.waitForDiagnostics('sample.ts', {
                        timeout: 5000,
                        until: (d) => d.length === 0,
                    });
                    await tick(10);
                    harness.refresh();
                    await tick(30);
                    // pulled once, not re-pulled with a backoff
                    expect(pulls()).toHaveLength(1);
                    harness.setDiagnostics(uri, [], 2);
                    const result = await waiting;
                    expect(result).toMatchObject({ timedOut: false, source: 'push', publishes: 1, diagnostics: [] });
                    expect(harness.diagnosticsDelivery()).toBe('push');
                    expect(ctx.collectTimings()).toMatchObject([
                        { method: 'diagnostics/open' },
                        { method: 'diagnostics/edit', success: true, result: 'empty' },
                    ]);
                });
            });

            it('auto: pulls at half the timeout when it is not longer than pullAfterMs', async () => {
                servePulls(full('1', diag('a')));
                await ctx.openDocument('sample.ts');
                const start = Date.now();
                const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 100 });
                const elapsed = Date.now() - start;
                expect(result).toMatchObject({ timedOut: false, source: 'pull' });
                expect(elapsed).toBeGreaterThanOrEqual(45);
                expect(elapsed).toBeLessThan(100);
            });

            it('auto: pulls from a server that registered diagnosticProvider dynamically', async () => {
                servePulls(full('1'));
                harness.capabilities = {};
                harness.registrations = [{ id: 'd', method: 'textDocument/diagnostic', registerOptions: {} }];
                await ctx.openDocument('sample.ts');
                const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 5000, pullAfterMs: 10 });
                expect(result).toMatchObject({ diagnostics: [], timedOut: false, source: 'pull' });
                expect(ctx.collectTimings()).toMatchObject([{ method: 'diagnostics/pull/open', result: 'empty' }]);
            });

            it('auto: stays with push when a current publish arrives within the grace period', async () => {
                servePulls(full('1', diag('pulled')));
                await ctx.openDocument('sample.ts');
                const wait = ctx.waitForDiagnostics('sample.ts', {
                    timeout: 5000,
                    pullAfterMs: 30,
                    until: (d) => d.length > 0,
                });
                // an empty syntax pass within the grace period commits the wait to push
                harness.setDiagnostics(uri, []);
                await new Promise((r) => setTimeout(r, 60));
                harness.setDiagnostics(uri, [diag('pushed')]);
                const result = await wait;
                expect(messages(result)).toEqual(['pushed']);
                expect(result).toMatchObject({ timedOut: false, source: 'push', pulls: 0, publishes: 2 });
                expect(pulls()).toEqual([]);
                expect(ctx.collectTimings()).toMatchObject([{ method: 'diagnostics/open' }]);
            });

            it('auto: behaves as push for a server without diagnosticProvider', async () => {
                harness.capabilities = { textDocumentSync: 2 };
                await ctx.openDocument('sample.ts');
                const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 40, pullAfterMs: 5 });
                expect(result).toMatchObject({ timedOut: true, source: 'push', pulls: 0 });
                expect(pulls()).toEqual([]);
            });

            it('push: never pulls, even from a pull only server', async () => {
                servePulls(full('1', diag('pulled')));
                await ctx.openDocument('sample.ts');
                const result = await ctx.waitForDiagnostics('sample.ts', { timeout: 40, mode: 'push', pullAfterMs: 5 });
                expect(result).toMatchObject({ timedOut: true, source: 'push' });
                expect(pulls()).toEqual([]);
            });

            it('pull: pulls at once and labels the timing by the latest sync', async () => {
                servePulls(full('1', diag('a')), full('2', diag('b')));
                await ctx.openDocument('sample.ts');
                await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                const start = Date.now();
                const result = await ctx.waitForDiagnostics('sample.ts', { mode: 'pull' });
                expect(Date.now() - start).toBeLessThan(100);
                expect(result).toMatchObject({ timedOut: false, source: 'pull', pulls: 1 });
                // pull mode learns nothing, so nothing is tentative
                expect(result.tentative).toBeUndefined();
                expect(harness.diagnosticsDelivery()).toBe('unknown');
                expect(ctx.collectTimings()).toMatchObject([{ method: 'diagnostics/pull/edit', result: 'ok' }]);
            });

            it('pull: is timed from the first pull request, not from the latest sync', async () => {
                servePulls(full('1', diag('a')));
                await ctx.openDocument('sample.ts');
                await new Promise((resolve) => setTimeout(resolve, 40));
                const result = await ctx.waitForDiagnostics('sample.ts', { mode: 'pull' });
                expect(result.ms).toBeLessThan(30);
                expect(result.graceMs).toBeUndefined();
                expect(ctx.collectTimings()[0].grace_ms).toBeUndefined();
            });

            it('re-pulls until satisfied, sending the previous resultId', async () => {
                servePulls(full('1'), full('2'), full('3', diag('semantic')));
                await ctx.openDocument('sample.ts');
                const result = await ctx.waitForDiagnostics('sample.ts', {
                    mode: 'pull',
                    timeout: 5000,
                    until: (d) => d.length > 0,
                });
                expect(messages(result)).toEqual(['semantic']);
                expect(result).toMatchObject({ timedOut: false, pulls: 3 });
                expect(previousResultIds()).toEqual([undefined, '1', '2']);
            });

            it('resolves an unchanged report to the previous diagnostics', async () => {
                servePulls(full('7', diag('kept')), unchanged('7'));
                await ctx.openDocument('sample.ts');
                await ctx.waitForDiagnostics('sample.ts', { mode: 'pull' });
                await ctx.edit('sample.ts', op(0, 0, 0, 0, ' '));
                const result = await ctx.waitForDiagnostics('sample.ts', { mode: 'pull' });
                expect(messages(result)).toEqual(['kept']);
                expect(previousResultIds()).toEqual([undefined, '7']);
                expect(ctx.collectTimings()).toMatchObject([
                    { method: 'diagnostics/pull/open', diagnostics: 1 },
                    { method: 'diagnostics/pull/edit', result: 'ok', diagnostics: 1 },
                ]);
            });

            it('forgets the resultId when the document closes', async () => {
                servePulls(full('1', diag('a')));
                await ctx.openDocument('sample.ts');
                await ctx.waitForDiagnostics('sample.ts', { mode: 'pull' });
                await ctx.closeDocument('sample.ts');
                await ctx.openDocument('sample.ts');
                await ctx.waitForDiagnostics('sample.ts', { mode: 'pull' });
                expect(previousResultIds()).toEqual([undefined, undefined]);
            });

            it('times out when no pulled report satisfies until', async () => {
                servePulls(full('1'));
                await ctx.openDocument('sample.ts');
                const result = await ctx.waitForDiagnostics('sample.ts', {
                    mode: 'pull',
                    timeout: 80,
                    until: (d) => d.length > 0,
                });
                expect(result).toMatchObject({ diagnostics: [], timedOut: true, source: 'pull' });
                expect(result.pulls).toBeGreaterThan(1);
                expect(result.ms).toBeGreaterThanOrEqual(70);
                expect(ctx.collectTimings()).toMatchObject([
                    { method: 'diagnostics/pull/open', success: false, result: 'timeout' },
                ]);
            });

            it('times out on a pull the server never answers', async () => {
                servePulls(() => new Promise(() => {}));
                await ctx.openDocument('sample.ts');
                const result = await ctx.waitForDiagnostics('sample.ts', { mode: 'pull', timeout: 30 });
                expect(result).toMatchObject({ timedOut: true, pulls: 1 });
            });

            it('retries ContentModified and ServerCancelled, then resolves', async () => {
                servePulls(
                    responseError(-32801, 'content modified'),
                    responseError(-32802, 'server cancelled'),
                    full('1', diag('a')),
                );
                await ctx.openDocument('sample.ts');
                const result = await ctx.waitForDiagnostics('sample.ts', { mode: 'pull', timeout: 5000 });
                expect(result).toMatchObject({ timedOut: false, pulls: 3 });
                expect(ctx.lastError).toBeUndefined();
                expect(ctx.collectTimings()).toMatchObject([{ success: true, result: 'ok' }]);
            });

            it('ends with an error on any other rejection', async () => {
                servePulls(responseError(-32603, 'internal error'), full('1'));
                await ctx.openDocument('sample.ts');
                const result = await ctx.waitForDiagnostics('sample.ts', { mode: 'pull', timeout: 5000 });
                expect(result).toMatchObject({ timedOut: false, pulls: 1 });
                expect(ctx.lastError).toMatchObject({ code: -32603, message: 'internal error' });
                expect(ctx.collectTimings()).toMatchObject([
                    { method: 'diagnostics/pull/open', success: false, result: 'error', error: 'internal error' },
                ]);
            });

            it('pull: records a skipped wait for a server without diagnosticProvider', async () => {
                harness.capabilities = { textDocumentSync: 2 };
                await ctx.openDocument('sample.ts');
                const result = await ctx.waitForDiagnostics('sample.ts', { mode: 'pull' });
                expect(result).toMatchObject({ timedOut: false, source: 'pull', pulls: 0, ms: 0 });
                expect(pulls()).toEqual([]);
                expect(ctx.collectTimings()).toMatchObject([
                    { method: 'diagnostics/pull/open', success: false, result: 'skipped' },
                ]);
            });

            it('codeAction matches codes against pulled diagnostics when nothing was pushed', async () => {
                servePulls(full('1', diag('a', 'x'), diag('b', 'y')));
                harness.capabilities = { ...harness.capabilities, codeActionProvider: true };
                await ctx.openDocument('sample.ts');
                await ctx.waitForDiagnostics('sample.ts', { mode: 'pull' });
                await ctx.codeAction(
                    'sample.ts',
                    { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                    ['y'],
                );
                const sent = harness.requests.find((r) => r.method === 'textDocument/codeAction');
                const params = sent?.params as { context: { diagnostics: Diagnostic[] } } | undefined;
                expect(params?.context.diagnostics.map((d) => d.message)).toEqual(['b']);
            });

            it('codeAction sends overlapping pulled diagnostics when nothing was pushed', async () => {
                const located = (message: string, line: number): Diagnostic => ({
                    range: { start: { line, character: 0 }, end: { line, character: 3 } },
                    message,
                });
                servePulls(full('1', located('a', 0), located('b', 2)));
                harness.capabilities = { ...harness.capabilities, codeActionProvider: true };
                await ctx.openDocument('sample.ts');
                await ctx.waitForDiagnostics('sample.ts', { mode: 'pull' });
                await ctx.codeAction(
                    'sample.ts',
                    { start: { line: 2, character: 1 }, end: { line: 2, character: 1 } },
                    { overlappingDiagnostics: true },
                );
                const sent = harness.requests.find((r) => r.method === 'textDocument/codeAction');
                const params = sent?.params as { context: { diagnostics: Diagnostic[] } } | undefined;
                expect(params?.context.diagnostics.map((d) => d.message)).toEqual(['b']);
            });
        });
    });
});

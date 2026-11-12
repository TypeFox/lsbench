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
    SaveSyncOptions,
    ServerCapabilities,
    WaitForDiagnosticsResult,
} from 'lsbench';
import { addRegisteredLanguage, BenchContextImpl, classifyResult, DiagnosticsTracker, ProgressTracker } from 'lsbench';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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

    waitForIdle(options: IdleWaitOptions): Promise<IdleWaitResult> {
        return this.progress.waitForIdle(options);
    }
}

/** shorthand for an edit replacing the range from (sl, sc) to (el, ec) */
function op(sl: number, sc: number, el: number, ec: number, text: string): EditOperation {
    return { range: { start: { line: sl, character: sc }, end: { line: el, character: ec } }, text };
}

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
                expect(result).toMatchObject({ diagnostics: [], timedOut: false, publishes: 1 });
                expect(result.ms).toBeLessThan(30);
                expect(harness.tracker.closeBehavior).toBe('silent');
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
                // timed from the pull, the grace period is not included
                expect(result.ms).toBeLessThan(25);
                expect(pulls()[0].params).toEqual({ textDocument: { uri } });
                expect(ctx.collectTimings()).toMatchObject([
                    { method: 'diagnostics/pull/open', success: true, result: 'ok', diagnostics: 1 },
                ]);
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
        });
    });
});

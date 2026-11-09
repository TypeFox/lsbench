import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Diagnostic, LspHarness } from 'lsbench';
import { addRegisteredLanguage, BenchContextImpl } from 'lsbench';
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
    private diagnostics = new Map<string, Diagnostic[]>();
    /** methods that should reject when requested */
    failMethods = new Set<string>();
    response: unknown = { ok: true };

    async sendRequest<R>(method: string, params: unknown): Promise<R> {
        this.requests.push({ method, params });
        if (this.failMethods.has(method)) {
            throw new Error(`simulated failure for ${method}`);
        }
        return this.response as R;
    }

    sendNotification(method: string, params: unknown): void {
        this.notifications.push({ method, params });
    }

    getDiagnostics(uri: string): Diagnostic[] {
        return this.diagnostics.get(uri) ?? [];
    }

    setDiagnostics(uri: string, diags: Diagnostic[]): void {
        this.diagnostics.set(uri, diags);
    }

    onDiagnostics(uri: string, _timeoutMs: number): Promise<Diagnostic[]> {
        return Promise.resolve(this.diagnostics.get(uri) ?? []);
    }
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
    });

    describe('notify and waitForDiagnostics', () => {
        it('forwards notify() straight to the harness', () => {
            ctx.notify('$/setTrace', { value: 'verbose' });
            expect(harness.notifications).toContainEqual({ method: '$/setTrace', params: { value: 'verbose' } });
        });

        it('waitForDiagnostics returns cached diagnostics for the document uri', async () => {
            const uri = `file://${path.resolve(tmpDir, 'sample.ts')}`;
            harness.setDiagnostics(uri, [{ range: {}, message: 'oops' }]);
            const diags = await ctx.waitForDiagnostics('sample.ts');
            expect(diags).toHaveLength(1);
            expect(diags[0].message).toBe('oops');
        });
    });
});

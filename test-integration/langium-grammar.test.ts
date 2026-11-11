import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRegisteredLanguage, BenchContextImpl, LspHarness, pathToUri, type RequestTiming } from 'lsbench';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// End-to-end test against Langium's own grammar language server, which registers
// far more providers than minilogo (formatter, semantic tokens, call and type
// hierarchy, code actions, ...). The server is a tiny entry script that node runs
// directly via type stripping, so no build step is needed.
//
// shapes.langium (0-indexed lines) that we target:
//    0:  /*                                    <- header comment, folds to line 2
//   11:  interface Shape extends NamedElement  <- `Shape` at 10..15, documented on line 10
//   19:  interface Rectangle   extends Shape{  <- deliberately unformatted
//   25:      members: @Shape[];                <- a reference to `Shape` at 14..19
//   36:      'drawing' name=ID elements+=ElementRule*;  <- call to `ElementRule` at 32..43
//   38:  ElementRule returns Element:          <- calls CircleRule on line 39
//   41:  CircleRule returns Circle:            <- calls ID, colorFragment, NUMBER on line 42
//   44:  RectangleRule   returns Rectangle :   <- deliberately unformatted
//   50:  fragment colorFragment:               <- lowercase, raises `rule-name-uppercase`

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, 'langium-grammar-server.ts');
const workspaceDir = path.join(here, 'langium-grammar');
const FILE = 'shapes.langium';

// `.langium` is registered by default, this keeps the suite explicit about it
addRegisteredLanguage('langium', '.langium');

/** a minimal LSP range shape for asserting on results */
type LspRange = { start: { line: number; character: number }; end: { line: number; character: number } };
type TextEdit = { range: LspRange; newText: string };
type HierarchyItem = { name: string; kind: number; uri: string; range: LspRange; selectionRange: LspRange };

/** drain recorded timings and return the last entry for `method` */
function timingFor(ctx: BenchContextImpl, method: string): RequestTiming | undefined {
    let found: RequestTiming | undefined;
    for (const timing of ctx.collectTimings()) {
        if (timing.method === method) {
            found = timing;
        }
    }
    return found;
}

/** assert the last request for `method` was timed and succeeded */
function expectTimedSuccess(ctx: BenchContextImpl, method: string): void {
    const timing = timingFor(ctx, method);
    expect(timing, `no timing recorded for ${method}`).toBeTruthy();
    expect(timing?.success, timing?.error).toBe(true);
    expect(timing?.duration_ms).toBeGreaterThanOrEqual(0);
}

/** `line:character` of a range start, for compact assertions */
function startOf(range: LspRange): string {
    return `${range.start.line}:${range.start.character}`;
}

describe('langium grammar language server (integration)', () => {
    let harness: LspHarness;
    let ctx: BenchContextImpl;
    let initialDiagnostics: Array<{ message: string; range: LspRange; data?: { code?: string } }>;

    beforeAll(async () => {
        harness = new LspHarness(
            { command: 'node', args: [serverEntry, '--stdio'] },
            workspaceDir,
            Boolean(process.env.LSBENCH_VERBOSE),
        );
        await harness.start();
        ctx = new BenchContextImpl(harness, workspaceDir, Boolean(process.env.LSBENCH_VERBOSE));

        await ctx.openDocument(FILE);
        // let the builder run so cross-references resolve before we query
        initialDiagnostics = (await ctx.waitForDiagnostics(FILE, 30_000)) as typeof initialDiagnostics;
    });

    afterAll(async () => {
        await harness?.stop();
    });

    it('reports the initialized server capabilities', () => {
        const caps = harness.capabilities;
        console.log('[langium-grammar] advertised capabilities:\n' + JSON.stringify(caps, null, 2));
        expect(caps).not.toBeNull();
        for (const key of [
            'completionProvider',
            'definitionProvider',
            'referencesProvider',
            'documentSymbolProvider',
            'documentHighlightProvider',
            'hoverProvider',
            'renameProvider',
            'codeActionProvider',
            'documentFormattingProvider',
            'documentRangeFormattingProvider',
            'foldingRangeProvider',
            'semanticTokensProvider',
            'callHierarchyProvider',
            'typeHierarchyProvider',
            'workspaceSymbolProvider',
        ]) {
            expect(caps?.[key], key).toBeTruthy();
        }
    });

    it('publishes only the lowercase fragment warning for the fixture', () => {
        expect(initialDiagnostics).toHaveLength(1);
        const [warning] = initialDiagnostics;
        expect(warning.data?.code).toBe('rule-name-uppercase');
        expect(startOf(warning.range)).toBe('50:9');
    });

    it('produces a document symbol tree rooted at the grammar', async () => {
        ctx.collectTimings();
        const symbols = (await ctx.documentSymbol(FILE)) as Array<{
            name: string;
            children?: Array<{ name: string }>;
        }> | null;
        expectTimedSuccess(ctx, 'textDocument/documentSymbol');

        expect(symbols).toHaveLength(1);
        expect(symbols?.[0].name).toBe('Shapes');
        const names = (symbols?.[0].children ?? []).map((s) => s.name);
        expect(names).toEqual(
            expect.arrayContaining(['NamedElement', 'Shape', 'Element', 'DrawingRule', 'colorFragment', 'ID']),
        );
    });

    it('hovers a `Shape` reference with its doc comment', async () => {
        ctx.collectTimings();
        const hover = (await ctx.hover(FILE, 25, 15)) as { contents: { kind: string; value: string } } | null;
        expectTimedSuccess(ctx, 'textDocument/hover');

        expect(hover?.contents.kind).toBe('markdown');
        expect(hover?.contents.value).toContain('A drawable element with an optional color.');
    });

    it('completes the `ElementRule` call from its prefix', async () => {
        ctx.collectTimings();
        // cursor right after the `E` of `ElementRule` on line 36
        const result = (await ctx.completion(FILE, 36, 33)) as { items: Array<{ label: string }> } | null;
        expectTimedSuccess(ctx, 'textDocument/completion');

        const labels = (result?.items ?? []).map((i) => i.label);
        expect(labels).toContain('ElementRule');
    });

    it('resolves go-to-definition from a rule call to the rule', async () => {
        type LocationLink = { targetUri: string; targetSelectionRange: LspRange };
        ctx.collectTimings();
        const result = (await ctx.definition(FILE, 36, 35)) as LocationLink[] | null;
        expectTimedSuccess(ctx, 'textDocument/definition');

        expect(result).toHaveLength(1);
        expect(result?.[0].targetUri).toContain(FILE);
        expect(result?.[0].targetSelectionRange).toEqual({
            start: { line: 38, character: 0 },
            end: { line: 38, character: 11 },
        });
    });

    it('finds the declaration and every reference to `Shape`', async () => {
        ctx.collectTimings();
        const refs = (await ctx.references(FILE, 11, 12)) as Array<{ uri: string; range: LspRange }> | null;
        expectTimedSuccess(ctx, 'textDocument/references');

        const starts = (refs ?? []).map((r) => startOf(r.range));
        expect(starts).toEqual(['11:10', '15:25', '19:30', '25:14', '48:34']);
    });

    it('highlights every occurrence of `Shape`', async () => {
        ctx.collectTimings();
        const highlights = (await ctx.documentHighlight(FILE, 25, 15)) as Array<{ range: LspRange }> | null;
        expectTimedSuccess(ctx, 'textDocument/documentHighlight');

        const starts = (highlights ?? []).map((h) => startOf(h.range));
        expect(starts).toEqual(['11:10', '15:25', '19:30', '25:14', '48:34']);
    });

    it('prepares a rename covering the `Shape` identifier', async () => {
        ctx.collectTimings();
        const result = (await ctx.prepareRename(FILE, 11, 12)) as LspRange | { range: LspRange } | null;
        expectTimedSuccess(ctx, 'textDocument/prepareRename');

        expect(result).toBeTruthy();
        // servers may return a bare Range or { range, placeholder }
        const range = result && 'range' in result ? result.range : (result as LspRange);
        expect(range).toEqual({ start: { line: 11, character: 10 }, end: { line: 11, character: 15 } });
    });

    it('renames `Shape` at its declaration and every reference', async () => {
        ctx.collectTimings();
        const result = (await ctx.rename(FILE, 11, 12, 'Figure')) as {
            changes: Record<string, TextEdit[]>;
        } | null;
        expectTimedSuccess(ctx, 'textDocument/rename');

        const uris = Object.keys(result?.changes ?? {});
        expect(uris).toHaveLength(1);
        expect(uris[0]).toContain(FILE);
        const edits = result?.changes[uris[0]] ?? [];
        expect(edits.map((e) => startOf(e.range))).toEqual(['11:10', '15:25', '19:30', '25:14', '48:34']);
        for (const edit of edits) {
            expect(edit.newText).toBe('Figure');
        }
    });

    it('formats the deliberately unformatted lines', async () => {
        ctx.collectTimings();
        const edits = (await ctx.formatting(FILE)) as TextEdit[] | null;
        expectTimedSuccess(ctx, 'textDocument/formatting');

        expect(edits?.length).toBeGreaterThan(0);
        // collapses the extra spaces in `Rectangle   extends` and `RectangleRule   returns`
        expect(edits).toContainEqual({
            range: { start: { line: 19, character: 19 }, end: { line: 19, character: 22 } },
            newText: ' ',
        });
        expect(edits).toContainEqual({
            range: { start: { line: 44, character: 13 }, end: { line: 44, character: 16 } },
            newText: ' ',
        });
    });

    it('formats only within the requested range', async () => {
        ctx.collectTimings();
        // the unformatted `interface Rectangle` block
        const edits = (await ctx.rangeFormatting(FILE, {
            start: { line: 19, character: 0 },
            end: { line: 22, character: 1 },
        })) as TextEdit[] | null;
        expectTimedSuccess(ctx, 'textDocument/rangeFormatting');

        expect(edits?.length).toBeGreaterThan(0);
        for (const edit of edits ?? []) {
            expect(edit.range.start.line).toBeGreaterThanOrEqual(19);
            expect(edit.range.end.line).toBeLessThanOrEqual(22);
        }
        expect(edits).toContainEqual({
            range: { start: { line: 19, character: 19 }, end: { line: 19, character: 22 } },
            newText: ' ',
        });
    });

    it('offers the uppercase quickfix when filtering by the data.code issue code', async () => {
        const range = initialDiagnostics[0].range;
        ctx.collectTimings();
        const actions = (await ctx.codeAction(FILE, range, ['rule-name-uppercase'])) as Array<{
            title: string;
            kind: string;
            edit: { changes: Record<string, TextEdit[]> };
        }> | null;
        expectTimedSuccess(ctx, 'textDocument/codeAction');

        expect(actions).toHaveLength(1);
        expect(actions?.[0].title).toBe('First letter to upper case');
        expect(actions?.[0].kind).toBe('quickfix');
        const edits = Object.values(actions?.[0].edit.changes ?? {})[0];
        expect(edits).toEqual([
            { range: { start: { line: 50, character: 9 }, end: { line: 50, character: 10 } }, newText: 'C' },
        ]);
    });

    it('returns folding ranges for the interfaces and the header comment', async () => {
        ctx.collectTimings();
        const ranges = (await ctx.foldingRange(FILE)) as Array<{
            startLine: number;
            endLine: number;
            kind?: string;
        }> | null;
        expectTimedSuccess(ctx, 'textDocument/foldingRange');

        const spans = (ranges ?? []).map((r) => `${r.startLine}-${r.endLine}${r.kind ? `:${r.kind}` : ''}`);
        expect(spans).toEqual(
            expect.arrayContaining(['0-2:comment', '6-7', '11-12', '15-16', '19-21', '24-25', '30-32']),
        );
    });

    describe('semantic tokens', () => {
        /** decode relative token data into `line:char type` entries using the advertised legend */
        function decode(data: number[]): string[] {
            const caps = harness.capabilities?.semanticTokensProvider as { legend: { tokenTypes: string[] } };
            const types = caps.legend.tokenTypes;
            const tokens: string[] = [];
            let line = 0;
            let character = 0;
            for (let i = 0; i < data.length; i += 5) {
                if (data[i] > 0) {
                    line += data[i];
                    character = data[i + 1];
                } else {
                    character += data[i + 1];
                }
                tokens.push(`${line}:${character} ${types[data[i + 3]]}`);
            }
            return tokens;
        }

        it('returns full tokens with a resultId', async () => {
            ctx.collectTimings();
            const result = (await ctx.semanticTokensFull(FILE)) as { resultId?: string; data: number[] } | null;
            expectTimedSuccess(ctx, 'textDocument/semanticTokens/full');

            expect(typeof result?.resultId).toBe('string');
            expect(result?.data.length).toBeGreaterThan(0);
            expect((result?.data.length ?? 0) % 5).toBe(0);
            const tokens = decode(result?.data ?? []);
            // `name` property and `string` type in NamedElement, a `Shape` cross-reference type
            expect(tokens).toEqual(expect.arrayContaining(['7:4 property', '7:10 type', '25:14 type']));
        });

        it('returns only the tokens within a range', async () => {
            ctx.collectTimings();
            const result = (await ctx.semanticTokensRange(FILE, {
                start: { line: 35, character: 0 },
                end: { line: 40, character: 0 },
            })) as { data: number[] } | null;
            expectTimedSuccess(ctx, 'textDocument/semanticTokens/range');

            // `name=` and `elements+=` in the DrawingRule body
            expect(decode(result?.data ?? [])).toEqual(['36:14 property', '36:22 property']);
        });

        // missing capability: semanticTokensProvider.full.delta is false
        it.skip('semanticTokensDelta (chained from the full resultId)');
    });

    describe('call hierarchy', () => {
        let item: HierarchyItem;

        beforeAll(async () => {
            ctx.collectTimings();
            const items = (await ctx.prepareCallHierarchy(FILE, 41, 3)) as HierarchyItem[] | null;
            expectTimedSuccess(ctx, 'textDocument/prepareCallHierarchy');
            expect(items).toHaveLength(1);
            item = (items ?? [])[0];
        });

        it('prepares an item for `CircleRule`', () => {
            expect(item.name).toBe('CircleRule');
            expect(item.selectionRange).toEqual({
                start: { line: 41, character: 0 },
                end: { line: 41, character: 10 },
            });
        });

        it('lists `ElementRule` as the incoming caller', async () => {
            ctx.collectTimings();
            const calls = (await ctx.callHierarchyIncomingCalls(item)) as Array<{
                from: HierarchyItem;
                fromRanges: LspRange[];
            }> | null;
            expectTimedSuccess(ctx, 'callHierarchy/incomingCalls');

            expect(calls).toHaveLength(1);
            expect(calls?.[0].from.name).toBe('ElementRule');
            expect(calls?.[0].fromRanges.map(startOf)).toEqual(['39:4']);
        });

        it('lists the terminals and fragment it calls as outgoing', async () => {
            ctx.collectTimings();
            const calls = (await ctx.callHierarchyOutgoingCalls(item)) as Array<{
                to: HierarchyItem;
                fromRanges: LspRange[];
            }> | null;
            expectTimedSuccess(ctx, 'callHierarchy/outgoingCalls');

            const targets = (calls ?? []).map((c) => c.to.name).sort();
            expect(targets).toEqual(['ID', 'NUMBER', 'colorFragment']);
            for (const call of calls ?? []) {
                expect(call.fromRanges[0].start.line).toBe(42);
            }
        });
    });

    describe('type hierarchy', () => {
        let item: HierarchyItem;

        beforeAll(async () => {
            ctx.collectTimings();
            const items = (await ctx.prepareTypeHierarchy(FILE, 11, 12)) as HierarchyItem[] | null;
            expectTimedSuccess(ctx, 'textDocument/prepareTypeHierarchy');
            expect(items).toHaveLength(1);
            item = (items ?? [])[0];
        });

        it('prepares an item for the `Shape` interface', () => {
            expect(item.name).toBe('Shape');
            expect(item.selectionRange).toEqual({
                start: { line: 11, character: 10 },
                end: { line: 11, character: 15 },
            });
        });

        it('lists `NamedElement` as the supertype', async () => {
            ctx.collectTimings();
            const types = (await ctx.typeHierarchySupertypes(item)) as HierarchyItem[] | null;
            expectTimedSuccess(ctx, 'typeHierarchy/supertypes');

            expect((types ?? []).map((t) => t.name)).toEqual(['NamedElement']);
        });

        it('lists `Circle` and `Rectangle` as subtypes', async () => {
            ctx.collectTimings();
            const types = (await ctx.typeHierarchySubtypes(item)) as HierarchyItem[] | null;
            expectTimedSuccess(ctx, 'typeHierarchy/subtypes');

            expect((types ?? []).map((t) => t.name).sort()).toEqual(['Circle', 'Rectangle']);
        });
    });

    it('finds the parser rules via workspace symbols', async () => {
        ctx.collectTimings();
        const symbols = (await ctx.workspaceSymbol('Rule')) as Array<{
            name: string;
            location: { uri: string; range: LspRange };
        }> | null;
        expectTimedSuccess(ctx, 'workspace/symbol');

        const names = (symbols ?? []).map((s) => s.name).sort();
        expect(names).toEqual(['CircleRule', 'DrawingRule', 'ElementRule', 'GroupRule', 'RectangleRule']);
        for (const symbol of symbols ?? []) {
            expect(symbol.location.uri).toContain(FILE);
        }
    });

    it('skips didSave and willSave since the server does not ask for them', async () => {
        // the grammar server advertises textDocumentSync save, willSave and willSaveWaitUntil as false
        expect(harness.saveSyncOptions()).toEqual({
            didSave: false,
            includeText: false,
            willSave: false,
            willSaveWaitUntil: false,
        });

        ctx.collectTimings();
        const sendNotification = vi.spyOn(harness, 'sendNotification');
        try {
            await ctx.saveDocument(FILE);
            await ctx.willSave(FILE);
            expect(sendNotification).not.toHaveBeenCalled();
        } finally {
            sendNotification.mockRestore();
        }
        expect(ctx.collectTimings()).toHaveLength(0);
    });

    it('records willSaveWaitUntil as skipped since the server does not ask for it', async () => {
        const sendRequest = vi.spyOn(harness, 'sendRequest');
        try {
            expect(await ctx.willSaveWaitUntil(FILE)).toBeNull();
            expect(sendRequest).not.toHaveBeenCalled();
        } finally {
            sendRequest.mockRestore();
        }
        expect(timingFor(ctx, 'textDocument/willSaveWaitUntil')?.result).toBe('skipped');
    });

    it('still times willSaveWaitUntil with skipUnsupported off', async () => {
        // a second context over the same server, sending without reopening the document
        const eager = new BenchContextImpl(harness, workspaceDir, false, { skipUnsupported: false });
        const uri = pathToUri(path.join(workspaceDir, FILE));
        // Langium answers with no edits when it has no willSaveWaitUntil handler
        const edits = await eager.request('textDocument/willSaveWaitUntil', { textDocument: { uri }, reason: 1 });
        expectTimedSuccess(eager, 'textDocument/willSaveWaitUntil');
        expect(edits).toEqual([]);

        const highlights = (await ctx.documentHighlight(FILE, 11, 12)) as unknown[] | null;
        expect(highlights).toHaveLength(5);
    });

    // runs last since it changes the open document (reverted at the end)
    it('republishes diagnostics after an edit', async () => {
        const grammarName = { start: { line: 4, character: 8 }, end: { line: 4, character: 9 } };

        await ctx.edit(FILE, { range: grammarName, text: 's' });
        const after = (await ctx.waitForDiagnostics(FILE, 30_000)) as typeof initialDiagnostics;
        const codes = after.map((d) => d.data?.code).sort();
        expect(codes).toEqual(['grammar-name-uppercase', 'rule-name-uppercase']);

        await ctx.edit(FILE, { range: grammarName, text: 'S' });
        const reverted = (await ctx.waitForDiagnostics(FILE, 30_000)) as typeof initialDiagnostics;
        expect(reverted.map((d) => d.data?.code)).toEqual(['rule-name-uppercase']);
    });

    // these methods are not advertised by the grammar server, so they are skipped
    // rather than asserting on "Unhandled method" errors or unadvertised handlers
    it('records requests to unadvertised providers as skipped, without a round trip', async () => {
        ctx.collectTimings();
        const sendRequest = vi.spyOn(harness, 'sendRequest');
        try {
            const range = { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } };
            expect(await ctx.declaration(FILE, 11, 12)).toBeNull();
            await ctx.signatureHelp(FILE, 11, 12);
            await ctx.inlayHint(FILE, range);
            await ctx.documentDiagnostic(FILE);
            await ctx.completionItemResolve({ label: 'x' });
            await ctx.codeActionResolve({ title: 'x' });
            await ctx.semanticTokensDelta(FILE, '1');
            expect(sendRequest).not.toHaveBeenCalled();
        } finally {
            sendRequest.mockRestore();
        }
        const timings = ctx.collectTimings();
        expect(timings.length).toBeGreaterThan(0);
        for (const timing of timings) {
            expect(timing, timing.method).toMatchObject({ result: 'skipped', duration_ms: 0 });
        }
    });

    it('does not advertise the providers whose tests are skipped below', () => {
        const caps = harness.capabilities as Record<string, unknown> | null;
        // if any of these start being advertised, un-skip the matching test below
        for (const key of [
            'declarationProvider',
            'typeDefinitionProvider',
            'implementationProvider',
            'signatureHelpProvider',
            'documentOnTypeFormattingProvider',
            'selectionRangeProvider',
            'documentLinkProvider',
            'codeLensProvider',
            'inlayHintProvider',
            'diagnosticProvider',
        ]) {
            expect(caps?.[key] ?? false, key).toBeFalsy();
        }
        const semantic = caps?.semanticTokensProvider as { full?: { delta?: boolean } };
        expect(semantic.full?.delta).toBeFalsy();
        // advertised providers without resolve support (codeActionProvider is a bare `true`)
        for (const key of ['completionProvider', 'codeActionProvider', 'workspaceSymbolProvider']) {
            const provider = caps?.[key] as { resolveProvider?: boolean } | boolean | undefined;
            expect(typeof provider === 'object' && provider.resolveProvider, `${key}.resolveProvider`).toBeFalsy();
        }
    });

    // missing capability: declarationProvider is false
    it.skip('declaration');
    // missing capability: typeDefinitionProvider is false
    it.skip('typeDefinition');
    // missing capability: implementationProvider is false
    it.skip('implementation');
    // missing capability: no signatureHelpProvider
    it.skip('signatureHelp');
    // missing capability: no documentOnTypeFormattingProvider (the formatter answers, but it is not advertised)
    it.skip('onTypeFormatting');
    // missing capability: no selectionRangeProvider
    it.skip('selectionRange');
    // missing capability: no documentLinkProvider
    it.skip('documentLink');
    // missing capability: no codeLensProvider
    it.skip('codeLens');
    // missing capability: no inlayHintProvider
    it.skip('inlayHint');
    // missing capability: no diagnosticProvider (the grammar server only pushes diagnostics)
    it.skip('documentDiagnostic / workspaceDiagnostic');
    // missing capability: completionProvider has no resolveProvider
    it.skip('completionItemResolve');
    // missing capability: codeActionProvider is `true`, without resolveProvider
    it.skip('codeActionResolve');
    // missing capability: workspaceSymbolProvider.resolveProvider is false
    it.skip('workspaceSymbolResolve');
    // missing capability: no codeLensProvider
    it.skip('codeLensResolve');
    // missing capability: no documentLinkProvider
    it.skip('documentLinkResolve');
    // missing capability: no inlayHintProvider
    it.skip('inlayHintResolve');
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addRegisteredLanguage, BenchContextImpl, LspHarness, type RequestTiming, type ServerConfig } from 'lsbench';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { examplesDir, serverEntry } from './minilogo.js';

// End-to-end test against a real, built Langium language server (minilogo).
// The server is spawned via `node <out>/language-server/main.js --stdio`, the
// same command the project's LS is normally launched with.
//
// test.logo (0-indexed lines) that we target:
//    9:  def square(x, y, scale) {   <- definition of `square`
//   24:  square(100,100,300)         <- a reference/call to `square`
//   33:          square(x * 30, ...) <- another reference/call to `square`
//   29:  for x = 0 to 10 {           <- outer loop, folds to line 34
//   30:      for y = 0 to 10 {       <- inner loop, folds to line 33

// register minilogo up-front
addRegisteredLanguage('minilogo', '.logo');

/** a minimal LSP range shape for asserting on results */
type LspRange = { start: { line: number; character: number }; end: { line: number; character: number } };

/** drain recorded timings and return the single entry for `method` */
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

function serverConfig(): ServerConfig {
    return {
        command: 'node',
        args: [serverEntry, '--stdio'],
    };
}

describe('minilogo language server (integration)', () => {
    let harness: LspHarness;
    let ctx: BenchContextImpl;

    beforeAll(async () => {
        harness = new LspHarness(serverConfig(), examplesDir, Boolean(process.env.LSBENCH_VERBOSE));
        await harness.start();
        ctx = new BenchContextImpl(harness, examplesDir, Boolean(process.env.LSBENCH_VERBOSE));

        await ctx.openDocument('test.logo');
        // let the builder run so cross-references resolve before we query
        await ctx.waitForDiagnostics('test.logo', 30_000);
    });

    afterAll(async () => {
        await harness?.stop();
    });

    it('reports the initialized server capabilities', () => {
        const caps = harness.capabilities;
        expect(caps).not.toBeNull();
        // Langium always advertises these
        expect(caps?.documentSymbolProvider).toBeTruthy();
        expect(caps?.definitionProvider).toBeTruthy();
    });

    it('produces document symbols for the definitions in test.logo', async () => {
        const symbols = (await ctx.documentSymbol('test.logo')) as Array<{ name: string }> | null;
        expect(Array.isArray(symbols)).toBe(true);
        const names = (symbols ?? []).map((s) => s.name);
        // `def square(...)` is a top-level definition
        expect(names).toContain('square');
    });

    it('resolves go-to-definition from a call site back to `def square`', async () => {
        // we advertise linkSupport, so Langium replies with LocationLink[]
        type LocationLink = { targetUri: string; targetSelectionRange: { start: { line: number } } };
        // position on the `square(100,100,300)` call at line 24
        const result = (await ctx.definition('test.logo', 24, 0)) as LocationLink[] | LocationLink | null;

        expect(result).toBeTruthy();
        const link = Array.isArray(result) ? result[0] : result;
        expect(link).toBeTruthy();
        expect(link?.targetUri).toContain('test.logo');
        // the `def square` name is on line 9
        expect(link?.targetSelectionRange.start.line).toBe(9);
    });

    it('finds references to `square` including the definition and call sites', async () => {
        // position on the `def square` name at line 9
        const refs = (await ctx.references('test.logo', 9, 8)) as Array<{ range: { start: { line: number } } }> | null;
        expect(Array.isArray(refs)).toBe(true);
        const lines = (refs ?? []).map((r) => r.range.start.line).sort((a, b) => a - b);
        // includes at least the two call sites (lines 24 and 33)
        expect(lines).toContain(24);
        expect(lines).toContain(33);
    });

    it('answers a hover request without error', async () => {
        // hover on the `square` name of the definition
        const hover = await ctx.hover('test.logo', 9, 8);
        // minilogo may or may not supply hover content; the contract we assert is
        // that the request round-trips successfully (null is an acceptable "no hover")
        expect(hover === null || typeof hover === 'object').toBe(true);
    });

    // ── methods added on this branch ────────────────────────────────────

    it('highlights `square` at its definition and both call sites', async () => {
        ctx.collectTimings();
        const highlights = (await ctx.documentHighlight('test.logo', 9, 6)) as Array<{ range: LspRange }> | null;
        expectTimedSuccess(ctx, 'textDocument/documentHighlight');

        expect(Array.isArray(highlights)).toBe(true);
        const starts = (highlights ?? []).map((h) => `${h.range.start.line}:${h.range.start.character}`);
        expect(starts).toEqual(expect.arrayContaining(['9:4', '24:0', '33:8']));
        expect(starts).toHaveLength(3);
    });

    it('prepares a rename covering the `square` identifier', async () => {
        ctx.collectTimings();
        const result = (await ctx.prepareRename('test.logo', 9, 6)) as LspRange | { range: LspRange } | null;
        expectTimedSuccess(ctx, 'textDocument/prepareRename');

        expect(result).toBeTruthy();
        // servers may return a bare Range or { range, placeholder }
        const range = result && 'range' in result ? result.range : (result as LspRange);
        expect(range.start).toEqual({ line: 9, character: 4 });
        expect(range.end).toEqual({ line: 9, character: 10 });
    });

    it('returns folding ranges for the multi-line def, loops, and header comment', async () => {
        ctx.collectTimings();
        const ranges = (await ctx.foldingRange('test.logo')) as Array<{
            startLine: number;
            endLine: number;
            kind?: string;
        }> | null;
        expectTimedSuccess(ctx, 'textDocument/foldingRange');

        expect(Array.isArray(ranges)).toBe(true);
        expect(ranges?.length).toBeGreaterThan(0);
        const spans = (ranges ?? []).map((r) => `${r.startLine}-${r.endLine}`);
        // `def square` body spans lines 9..22, folded up to the line before `}`
        expect(spans).toContain('9-21');
        expect(spans).toContain('29-34');
        expect(spans).toContain('30-33');
        let comment: { startLine: number; kind?: string } | undefined;
        for (const r of ranges ?? []) {
            if (r.kind === 'comment') {
                comment = r;
            }
        }
        expect(comment?.startLine).toBe(0);
    });

    it('finds `square` via workspace symbols across the examples', async () => {
        ctx.collectTimings();
        const symbols = (await ctx.workspaceSymbol('square')) as Array<{
            name: string;
            location: { uri: string; range: LspRange };
        }> | null;
        expectTimedSuccess(ctx, 'workspace/symbol');

        expect(Array.isArray(symbols)).toBe(true);
        let inTestLogo: { location: { range: LspRange } } | undefined;
        for (const symbol of symbols ?? []) {
            expect(symbol.name).toBe('square');
            if (symbol.location.uri.endsWith('/test.logo')) {
                inTestLogo = symbol;
            }
        }
        expect(inTestLogo?.location.range.start).toEqual({ line: 9, character: 4 });
    });

    it('sends didSave as an untimed notification and the server stays responsive', async () => {
        ctx.collectTimings();
        // minilogo advertises textDocumentSync.save = false, so it ignores didSave;
        // this checks the client side: no throw, no timing, and the server still answers
        await ctx.saveDocument('test.logo');
        expect(ctx.collectTimings()).toHaveLength(0);

        const highlights = (await ctx.documentHighlight('test.logo', 24, 2)) as unknown[] | null;
        expect(highlights).toHaveLength(3);

        await expect(ctx.saveDocument('not-open.logo')).rejects.toThrow(/not open/);
    });

    // the following methods are not advertised by minilogo (Langium 4.3 minilogo only
    // registers the providers listed in its initialize result), so they are skipped
    // rather than asserting on "Unhandled method" errors
    it('does not advertise the providers whose tests are skipped below', () => {
        const caps = harness.capabilities as Record<string, unknown> | null;
        // if any of these start being advertised, un-skip the matching test below
        for (const key of [
            'declarationProvider',
            'documentRangeFormattingProvider',
            'documentOnTypeFormattingProvider',
            'selectionRangeProvider',
            'documentLinkProvider',
            'codeLensProvider',
            'inlayHintProvider',
            'semanticTokensProvider',
            'callHierarchyProvider',
            'typeHierarchyProvider',
            'diagnosticProvider',
        ]) {
            expect(caps?.[key] ?? false, key).toBeFalsy();
        }
    });

    // missing capability: declarationProvider is false
    it.skip('declaration');
    // missing capability: documentRangeFormattingProvider is false
    it.skip('rangeFormatting');
    // missing capability: no documentOnTypeFormattingProvider
    it.skip('onTypeFormatting');
    // missing capability: no selectionRangeProvider
    it.skip('selectionRange');
    // missing capability: no documentLinkProvider
    it.skip('documentLink');
    // missing capability: no codeLensProvider
    it.skip('codeLens');
    // missing capability: no inlayHintProvider
    it.skip('inlayHint');
    // missing capability: no semanticTokensProvider (covers full, range, and delta)
    it.skip('semanticTokensFull / semanticTokensRange / semanticTokensDelta');
    // missing capability: no callHierarchyProvider
    it.skip('prepareCallHierarchy / callHierarchyIncomingCalls / callHierarchyOutgoingCalls');
    // missing capability: no typeHierarchyProvider
    it.skip('prepareTypeHierarchy / typeHierarchySupertypes / typeHierarchySubtypes');
    // missing capability: no diagnosticProvider (minilogo only pushes diagnostics)
    it.skip('documentDiagnostic / workspaceDiagnostic');
});

describe('runBenchmark against minilogo (integration)', () => {
    let tmpDir: string;
    let scriptPath: string;
    let outputPath: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-integration-'));
        outputPath = path.join(tmpDir, 'report.json');
        scriptPath = path.join(tmpDir, 'actions.ts');
        // a minimal action script exercising the timed request path
        fs.writeFileSync(
            scriptPath,
            `import type { BenchContext } from 'lsbench';
export default async function (ctx: BenchContext) {
    await ctx.openDocument('test.logo');
    await ctx.waitForDiagnostics('test.logo', 30_000);
    await ctx.documentSymbol('test.logo');
    await ctx.definition('test.logo', 24, 0);
    await ctx.closeDocument('test.logo');
}
`,
            'utf-8',
        );
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('runs a full benchmark and produces a report with timings', async () => {
        // imported lazily so the module graph doesn't pull the runner into unit tests
        const { runBenchmark } = await import('lsbench');

        const report = await runBenchmark({
            server: `node ${serverEntry} --stdio`,
            workspace: examplesDir,
            script: scriptPath,
            iterations: 2,
            warmup: 1,
            output: outputPath,
            restart: false,
            verbose: Boolean(process.env.LSBENCH_VERBOSE),
        });

        expect(report.iterations).toBe(2);
        expect(report.runs).toHaveLength(2);
        // documentSymbol was called each timed iteration and should have succeeded
        const symbolStats = report.summary['textDocument/documentSymbol'];
        expect(symbolStats).toBeTruthy();
        expect(symbolStats.count).toBe(2);
        expect(symbolStats.failure_rate).toBe(0);
    });
});

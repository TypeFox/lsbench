import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BenchContextImpl, LspHarness, type ServerConfig } from 'lsbench';
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

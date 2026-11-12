import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BenchOptions } from 'lsbench';
import { loadActionScript, resolveServerConfig, runBenchmark } from 'lsbench';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('resolveServerConfig', () => {
    it('splits a bare command with no args', () => {
        expect(resolveServerConfig('my-language-server')).toEqual({
            command: 'my-language-server',
            args: [],
            initializationOptions: undefined,
            clientCapabilities: undefined,
        });
    });

    it('splits a command with inline args', () => {
        const cfg = resolveServerConfig('typescript-language-server --stdio');
        expect(cfg.command).toBe('typescript-language-server');
        expect(cfg.args).toEqual(['--stdio']);
    });

    it('collapses runs of whitespace between tokens', () => {
        const cfg = resolveServerConfig('  cmd   --a    --b  ');
        expect(cfg.command).toBe('cmd');
        expect(cfg.args).toEqual(['--a', '--b']);
    });

    it('appends extra args after the inline ones', () => {
        const cfg = resolveServerConfig('cmd --stdio', ['--log-level', 'debug']);
        expect(cfg.args).toEqual(['--stdio', '--log-level', 'debug']);
    });

    it('passes initializationOptions through untouched', () => {
        const initOptions = { preferences: { includeCompletionsForModuleExports: true } };
        const cfg = resolveServerConfig('cmd', undefined, initOptions);
        expect(cfg.initializationOptions).toBe(initOptions);
    });

    it('passes clientCapabilities through untouched', () => {
        const caps = { experimental: { custom: true } };
        const cfg = resolveServerConfig('cmd', undefined, undefined, caps);
        expect(cfg.clientCapabilities).toBe(caps);
    });

    it('passes settings through untouched', () => {
        const settings = { html: { format: { enable: true } } };
        const cfg = resolveServerConfig('cmd', undefined, undefined, undefined, settings);
        expect(cfg.settings).toBe(settings);
    });

    it('sets allowExitCodes only when some are given', () => {
        expect(resolveServerConfig('cmd', undefined, undefined, undefined, undefined, [1]).allowExitCodes).toEqual([1]);
        expect(resolveServerConfig('cmd', undefined, undefined, undefined, undefined, [])).not.toHaveProperty(
            'allowExitCodes',
        );
    });
});

describe('loadActionScript', () => {
    let tmpDir: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-scripts-'));
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeScript(name: string, contents: string): string {
        const file = path.join(tmpDir, name);
        fs.writeFileSync(file, contents, 'utf-8');
        return file;
    }

    it('rejects non-TypeScript files', async () => {
        await expect(loadActionScript('actions.js')).rejects.toThrow(/must be a TypeScript \(\.ts\) file/);
    });

    it('loads a default-exported action function', async () => {
        const file = writeScript(
            'valid-actions.ts',
            `export default async function (ctx: unknown): Promise<void> {
                void ctx;
            }`,
        );

        const fn = await loadActionScript(file);
        expect(typeof fn).toBe('function');
        // the loaded action is callable and resolves
        await expect(fn({} as never)).resolves.toBeUndefined();
    });

    it('throws when the default export is not a function', async () => {
        const file = writeScript('not-a-fn.ts', `export default 42;`);
        await expect(loadActionScript(file)).rejects.toThrow(/must have a default-exported function/);
    });
});

/** a fake server that exits on shutdown without replying */
const crashOnShutdownServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
conn.onRequest('initialize', () => ({ capabilities: { hoverProvider: true } }));
conn.onRequest('textDocument/hover', () => null);
conn.onRequest('shutdown', () => process.exit(3));
conn.listen();
`;

describe('runBenchmark with a server crashing at shutdown', () => {
    let tmpDir: string;
    let script: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-crash-'));
        script = path.join(tmpDir, 'actions.ts');
        fs.writeFileSync(
            script,
            `export default async function (ctx: any): Promise<void> {
                await ctx.request('textDocument/hover', {});
            }`,
            'utf-8',
        );
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function options(restart: boolean, output: string): BenchOptions {
        return {
            server: process.execPath,
            serverArgs: ['--input-type=module', '-e', crashOnShutdownServer],
            workspace: tmpDir,
            script,
            iterations: 2,
            warmup: 1,
            output,
            restart,
            verbose: false,
        };
    }

    for (const restart of [false, true]) {
        it(`still writes the report and surfaces the exit (${restart ? 'restart' : 'keep alive'})`, async () => {
            const output = path.join(tmpDir, `report-${restart}.json`);
            const report = await runBenchmark(options(restart, output));

            expect(report.runs).toHaveLength(2);
            const expected = restart ? ['warmup 1', 'iteration 1', 'iteration 2'] : ['final teardown'];
            expect(report.abnormal_exits?.map((e) => e.during)).toEqual(expected);
            for (const exit of report.abnormal_exits ?? []) {
                expect(exit).toMatchObject({ code: 3, signal: null });
            }

            const written = JSON.parse(fs.readFileSync(output, 'utf-8'));
            expect(written.runs).toHaveLength(2);
            expect(written.abnormal_exits).toHaveLength(expected.length);
        });
    }
});

/** a fake server that replies to shutdown and exits cleanly */
const cleanServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
conn.onRequest('initialize', () => ({ capabilities: { hoverProvider: true } }));
conn.onRequest('textDocument/hover', () => null);
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
`;

describe('runBenchmark lifecycle timings', () => {
    let tmpDir: string;
    let script: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-lifecycle-'));
        script = path.join(tmpDir, 'actions.ts');
        fs.writeFileSync(
            script,
            `export default async function (ctx: any): Promise<void> {
                await ctx.request('textDocument/hover', {});
            }`,
            'utf-8',
        );
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function options(restart: boolean, output: string, waitIdle?: number): BenchOptions {
        return {
            ...(waitIdle !== undefined ? { waitIdle } : {}),
            server: process.execPath,
            serverArgs: ['--input-type=module', '-e', cleanServer],
            workspace: tmpDir,
            script,
            iterations: 2,
            warmup: 1,
            output,
            restart,
            verbose: false,
        };
    }

    const lifecycleMethods = ['lifecycle/spawn', 'lifecycle/initialize', 'lifecycle/shutdown'];

    it('attributes spawn, initialize and shutdown to every run with restart', async () => {
        const output = path.join(tmpDir, 'report-restart.json');
        const report = await runBenchmark(options(true, output));

        expect(report.lifecycle).toBeUndefined();
        for (const run of report.runs) {
            expect(run.requests.map((r) => r.method)).toEqual([
                'lifecycle/spawn',
                'lifecycle/initialize',
                'textDocument/hover',
                'lifecycle/shutdown',
            ]);
        }
        for (const method of lifecycleMethods) {
            expect(report.summary[method]).toMatchObject({ count: 2, failure_rate: 0 });
        }
        const written = JSON.parse(fs.readFileSync(output, 'utf-8'));
        expect(written.summary['lifecycle/shutdown'].count).toBe(2);
    });

    it('keeps lifecycle timings in a separate section in keep alive mode, including the final shutdown', async () => {
        const output = path.join(tmpDir, 'report-keep-alive.json');
        const report = await runBenchmark(options(false, output));

        expect(report.lifecycle?.map((t) => t.method)).toEqual(lifecycleMethods);
        for (const run of report.runs) {
            expect(run.requests.map((r) => r.method)).toEqual(['textDocument/hover']);
        }
        for (const method of lifecycleMethods) {
            expect(report.summary[method]).toMatchObject({ count: 1, failure_rate: 0 });
        }
        // the report rewritten after the final teardown carries the shutdown timing
        const written = JSON.parse(fs.readFileSync(output, 'utf-8'));
        expect(written.lifecycle).toHaveLength(3);
        expect(written.summary['lifecycle/shutdown'].count).toBe(1);
    });

    it('records lifecycle/idle after each start with waitIdle', async () => {
        const restart = await runBenchmark(options(true, path.join(tmpDir, 'report-idle-restart.json'), 2000));
        for (const run of restart.runs) {
            expect(run.requests.map((r) => r.method)).toEqual([
                'lifecycle/spawn',
                'lifecycle/initialize',
                'lifecycle/idle',
                'textDocument/hover',
                'lifecycle/shutdown',
            ]);
        }
        expect(restart.summary['lifecycle/idle']).toMatchObject({ count: 2, timeout_rate: 0 });

        const keepAlive = await runBenchmark(options(false, path.join(tmpDir, 'report-idle-keep-alive.json'), 2000));
        expect(keepAlive.lifecycle?.map((t) => t.method)).toEqual([
            'lifecycle/spawn',
            'lifecycle/initialize',
            'lifecycle/idle',
            'lifecycle/shutdown',
        ]);
    });
});

/**
 * a fake server picked by argv: fail replies to shutdown, then exits 1 on exit (as ts7 does);
 * quit exits 0 on shutdown without replying
 */
const exitCodeServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
const mode = process.argv[1];
conn.onRequest('initialize', () => ({ capabilities: { hoverProvider: true } }));
conn.onRequest('textDocument/hover', () => null);
conn.onRequest('shutdown', () => (mode === 'quit' ? process.exit(0) : null));
conn.onNotification('exit', () => process.exit(1));
conn.listen();
`;

describe('runBenchmark with allowExitCodes', () => {
    let tmpDir: string;
    let script: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-exit-codes-'));
        script = path.join(tmpDir, 'actions.ts');
        fs.writeFileSync(
            script,
            `export default async function (ctx: any): Promise<void> {
                await ctx.request('textDocument/hover', {});
            }`,
            'utf-8',
        );
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function options(mode: 'fail' | 'quit', restart: boolean, output: string, allowExitCodes?: number[]): BenchOptions {
        return {
            server: process.execPath,
            serverArgs: ['--input-type=module', '-e', exitCodeServer, mode],
            workspace: tmpDir,
            script,
            iterations: 2,
            warmup: 1,
            output,
            restart,
            verbose: false,
            allowExitCodes,
        };
    }

    it('records a non zero exit after a replied shutdown as abnormal without allowExitCodes', async () => {
        const report = await runBenchmark(options('fail', true, path.join(tmpDir, 'report-default.json')));
        expect(report.abnormal_exits).toHaveLength(3);
        expect(report.tolerated_exits).toBeUndefined();
    });

    for (const restart of [false, true]) {
        it(`records allowed exits as tolerated, not abnormal (${restart ? 'restart' : 'keep alive'})`, async () => {
            const output = path.join(tmpDir, `report-allowed-${restart}.json`);
            const report = await runBenchmark(options('fail', restart, output, [1]));

            expect(report.abnormal_exits).toBeUndefined();
            const expected = restart ? ['warmup 1', 'iteration 1', 'iteration 2'] : ['final teardown'];
            expect(report.tolerated_exits?.map((e) => e.during)).toEqual(expected);
            for (const exit of report.tolerated_exits ?? []) {
                expect(exit).toEqual({
                    during: exit.during,
                    code: 1,
                    signal: null,
                    reason: 'exited after shutdown with code 1 (allowed)',
                });
            }
            const written = JSON.parse(fs.readFileSync(output, 'utf-8'));
            expect(written.abnormal_exits).toBeUndefined();
            expect(written.tolerated_exits).toHaveLength(expected.length);
        });
    }

    it('keeps an exit 0 without a shutdown reply abnormal whatever codes are allowed', async () => {
        const report = await runBenchmark(options('quit', true, path.join(tmpDir, 'report-quit.json'), [0, 1]));
        expect(report.tolerated_exits).toBeUndefined();
        expect(report.abnormal_exits?.map((e) => [e.code, e.during])).toEqual([
            [0, 'warmup 1'],
            [0, 'iteration 1'],
            [0, 'iteration 2'],
        ]);
    });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BenchOptions, BenchReport } from 'lsbench';
import { LspHarness, loadActionScript, loadSetupScript, resolveServerConfig, runBenchmark } from 'lsbench';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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

    it('sets allowExitSignals only when some are given', () => {
        const args = ['cmd', undefined, undefined, undefined, undefined, undefined, undefined] as const;
        expect(resolveServerConfig(...args, ['SIGSEGV']).allowExitSignals).toEqual(['SIGSEGV']);
        expect(resolveServerConfig(...args, [])).not.toHaveProperty('allowExitSignals');
        expect(resolveServerConfig(...args)).not.toHaveProperty('allowExitSignals');
    });

    it('sets allowUnrepliedShutdown only when requested', () => {
        const args = ['cmd', undefined, undefined, undefined, undefined, undefined, undefined, undefined] as const;
        expect(resolveServerConfig(...args, true).allowUnrepliedShutdown).toBe(true);
        expect(resolveServerConfig(...args, false)).not.toHaveProperty('allowUnrepliedShutdown');
        expect(resolveServerConfig(...args)).not.toHaveProperty('allowUnrepliedShutdown');
    });

    it('sets advertisePullDiagnostics only when requested', () => {
        const args = ['cmd', undefined, undefined, undefined, undefined, undefined] as const;
        expect(resolveServerConfig(...args, true).advertisePullDiagnostics).toBe(true);
        expect(resolveServerConfig(...args, false)).not.toHaveProperty('advertisePullDiagnostics');
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

    it.each(['actions.cjs', 'actions.mts', 'actions.json', 'actions'])('rejects %s', async (name) => {
        await expect(loadActionScript(name)).rejects.toThrow(
            /must be a TypeScript \(\.ts\) or JavaScript \(\.js, \.mjs\) file/,
        );
    });

    it.each(['valid-actions.mjs', 'valid-actions.js'])('loads a JavaScript action from %s', async (name) => {
        const file = writeScript(
            name,
            `export default async function (ctx) {
                ctx.called = true;
            }`,
        );

        const fn = await loadActionScript(file);
        const ctx = {} as { called?: boolean };
        await expect(fn(ctx as never)).resolves.toBeUndefined();
        expect(ctx.called).toBe(true);
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

    it('loads the setup export next to the action', async () => {
        const file = writeScript(
            'with-setup.mjs',
            `export function setup(client) {
                client.notify('custom/ready', null);
            }
            export default async function () {}`,
        );

        const setup = await loadSetupScript(file);
        const sent: unknown[] = [];
        await setup?.({
            onNotification: () => {},
            onRequest: () => {},
            notify: (method, params) => sent.push([method, params]),
        });
        expect(sent).toEqual([['custom/ready', null]]);
        expect(typeof (await loadActionScript(file))).toBe('function');
    });

    it('returns no setup for a script without one', async () => {
        const file = writeScript('without-setup.mjs', `export default async function () {}`);
        await expect(loadSetupScript(file)).resolves.toBeUndefined();
    });

    it('throws when setup is not a function', async () => {
        const file = writeScript('bad-setup.mjs', `export const setup = 42; export default async function () {}`);
        await expect(loadSetupScript(file)).rejects.toThrow(/must export setup as a function/);
    });
});

const awaitingClientServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
const waiting = new Map();
let next = 0;
const ask = () => {
    const id = ++next;
    const answer = new Promise((resolve) => waiting.set(id, resolve));
    conn.sendNotification('custom/request', [id, 'projectInfo', {}]);
    return answer;
};
conn.onNotification('custom/response', ([id]) => waiting.get(id)?.());
conn.onRequest('initialize', async () => {
    await ask();
    return { capabilities: { hoverProvider: true } };
});
conn.onRequest('textDocument/hover', async () => {
    await ask();
    return { contents: 'answered' };
});
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
`;

describe('runBenchmark with a script setup', () => {
    let tmpDir: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-setup-'));
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    for (const restart of [false, true]) {
        it(`answers the server through setup on every spawn (${restart ? 'restart' : 'keep alive'})`, async () => {
            const script = path.join(tmpDir, `actions-${restart}.mjs`);
            fs.writeFileSync(
                script,
                `export const spawns = [];
                export function setup(client) {
                    spawns.push(spawns.length);
                    client.onNotification('custom/request', ([[id]]) => client.notify('custom/response', [id, null]));
                }
                export default async function (ctx) {
                    await ctx.request('textDocument/hover', {});
                }`,
                'utf-8',
            );
            const report = await runBenchmark({
                server: process.execPath,
                serverArgs: ['--input-type=module', '-e', awaitingClientServer],
                workspace: tmpDir,
                script,
                iterations: 2,
                warmup: 1,
                output: path.join(tmpDir, `report-${restart}.json`),
                restart,
                verbose: false,
            });

            const hovers = report.runs.flatMap((run) => run.requests.filter((t) => t.method === 'textDocument/hover'));
            expect(hovers.map((t) => t.result)).toEqual(['ok', 'ok']);
            const { spawns } = await import(pathToFileURL(script).href);
            expect(spawns).toHaveLength(restart ? 3 : 1);
        });
    }
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
            const expected = restart
                ? ['teardown of warmup 1', 'teardown of iteration 1', 'teardown of iteration 2']
                : ['final teardown'];
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

describe('runBenchmark with restart and a server crashing during an iteration', () => {
    let tmpDir: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-crash-mid-'));
        fs.writeFileSync(
            path.join(tmpDir, 'actions.ts'),
            // the server exits right after its hover reply, while the iteration still runs
            `export default async function (ctx: any): Promise<void> {
                await ctx.request('textDocument/hover', {});
                await new Promise((resolve) => setTimeout(resolve, 300));
            }`,
            'utf-8',
        );
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('labels the exit with the iteration, not its teardown', async () => {
        const server = crashOnShutdownServer.replace(
            "conn.onRequest('textDocument/hover', () => null);",
            "conn.onRequest('textDocument/hover', () => { setTimeout(() => process.exit(4), 20); return null; });",
        );
        const report = await runBenchmark({
            server: process.execPath,
            serverArgs: ['--input-type=module', '-e', server],
            workspace: tmpDir,
            script: path.join(tmpDir, 'actions.ts'),
            iterations: 2,
            warmup: 1,
            output: '',
            restart: true,
            verbose: false,
        });
        expect(report.abnormal_exits?.map((e) => [e.code, e.during])).toEqual([
            [4, 'warmup 1'],
            [4, 'iteration 1'],
            [4, 'iteration 2'],
        ]);
    });
});

describe('runBenchmark without restart and a server crashing during an iteration', () => {
    let tmpDir: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-crash-keep-'));
        fs.writeFileSync(
            path.join(tmpDir, 'actions.ts'),
            `export default async function (ctx: any): Promise<void> {
                await ctx.request('textDocument/hover', {});
            }`,
            'utf-8',
        );
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // exits 1 on its nth hover, without replying
    function crashOnHover(n: number): string {
        return crashOnShutdownServer.replace(
            "conn.onRequest('textDocument/hover', () => null);",
            `let hovers = 0;
            conn.onRequest('textDocument/hover', () => { if (++hovers === ${n}) { process.exit(1); } return null; });`,
        );
    }

    function options(n: number, output: string): BenchOptions {
        return {
            server: process.execPath,
            serverArgs: ['--input-type=module', '-e', crashOnHover(n)],
            workspace: tmpDir,
            script: path.join(tmpDir, 'actions.ts'),
            iterations: 4,
            warmup: 1,
            output,
            restart: false,
            verbose: false,
        };
    }

    it('labels the exit with the iteration and stops the run', async () => {
        const output = path.join(tmpDir, 'report-iteration.json');
        // hover 3 is the request of timed iteration 2
        const report = await runBenchmark(options(3, output));

        expect(report.runs.map((r) => r.iteration)).toEqual([1, 2]);
        const hovers = report.runs.map((r) => r.requests.find((t) => t.method === 'textDocument/hover'));
        expect(hovers.map((t) => t?.success)).toEqual([true, false]);
        expect(hovers[1]?.error).toMatch(/server exited unexpectedly \(code 1\)/);
        expect(report.abnormal_exits).toEqual([
            { during: 'iteration 2', code: 1, signal: null, reason: 'exited unexpectedly (code 1)' },
        ]);
        expect(report.lifecycle?.map((t) => t.method)).not.toContain('lifecycle/shutdown');

        const written = JSON.parse(fs.readFileSync(output, 'utf-8'));
        expect(written.runs).toHaveLength(2);
        expect(written.abnormal_exits).toEqual(report.abnormal_exits);
    });

    it('labels a crash during a warmup and writes the report with no runs', async () => {
        const output = path.join(tmpDir, 'report-warmup.json');
        const report = await runBenchmark(options(1, output));

        expect(report.runs).toEqual([]);
        expect(report.abnormal_exits?.map((e) => [e.code, e.during])).toEqual([[1, 'warmup 1']]);

        const written = JSON.parse(fs.readFileSync(output, 'utf-8'));
        expect(written.runs).toEqual([]);
        expect(written.abnormal_exits).toHaveLength(1);
    });
});

/**
 * a fake server that publishes a diagnostic on didOpen only when argv has "publish", not an
 * empty publish, which a reopen would credit to the close
 */
const quietServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
const publish = process.argv.includes('publish');
conn.onRequest('initialize', () => ({ capabilities: { textDocumentSync: 1 } }));
conn.onNotification('textDocument/didOpen', (p) => {
    if (publish) {
        conn.sendNotification('textDocument/publishDiagnostics', {
            uri: p.textDocument.uri,
            diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'x' }],
        });
    }
});
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
`;

describe('runBenchmark with a server silent on clean files', () => {
    let tmpDir: string;
    let script: string;
    let untilScript: string;
    let plaintextScript: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-silent-'));
        fs.writeFileSync(path.join(tmpDir, 'clean.runnerfallback'), 'x\n', 'utf-8');
        plaintextScript = path.join(tmpDir, 'plaintext.ts');
        fs.writeFileSync(
            plaintextScript,
            `export default async function (ctx: any): Promise<void> {
                await ctx.openDocument('clean.runnerfallback');
                await ctx.waitForDiagnostics('clean.runnerfallback', 100);
                await ctx.closeDocument('clean.runnerfallback');
            }`,
            'utf-8',
        );
        fs.writeFileSync(path.join(tmpDir, 'clean.ts'), 'export const x = 1;\n', 'utf-8');
        script = path.join(tmpDir, 'actions.ts');
        fs.writeFileSync(
            script,
            `export default async function (ctx: any): Promise<void> {
                await ctx.openDocument('clean.ts');
                await ctx.waitForDiagnostics('clean.ts', 100);
                await ctx.closeDocument('clean.ts');
            }`,
            'utf-8',
        );
        untilScript = path.join(tmpDir, 'until.ts');
        fs.writeFileSync(
            untilScript,
            `export default async function (ctx: any): Promise<void> {
                await ctx.openDocument('clean.ts');
                await ctx.waitForDiagnostics('clean.ts', { timeout: 100, until: (d: unknown[]) => d.length > 1 });
                await ctx.closeDocument('clean.ts');
            }`,
            'utf-8',
        );
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    async function run(
        publish: boolean,
        restart: boolean,
        actions = script,
        extra: Partial<BenchOptions> = {},
    ): Promise<{ report: BenchReport; lines: string[] }> {
        const lines: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
            lines.push(args.map(String).join(' '));
        });
        const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            const report = await runBenchmark({
                server: process.execPath,
                serverArgs: ['--input-type=module', '-e', quietServer, ...(publish ? ['publish'] : [])],
                workspace: tmpDir,
                script: actions,
                iterations: 1,
                warmup: 2,
                output: '',
                restart,
                verbose: false,
                ...extra,
            });
            return { report, lines };
        } finally {
            log.mockRestore();
            write.mockRestore();
        }
    }

    it('records silent waits counted across warmups and restarts, and notes them in the summary', async () => {
        const { report, lines } = await run(false, true);
        expect(report.summary['diagnostics/open']).toMatchObject({ count: 1, timeout_rate: 1 });
        expect(report.silent_waits).toEqual({ 'diagnostics/open': { waits: 3, longest_streak: 3 } });
        expect(lines.some((l) => l.includes('diagnostics/open: the server did not publish in 3 waits'))).toBe(true);
    });

    it('records plaintext fallbacks once and notes them with the silent waits in the summary', async () => {
        const errors: string[] = [];
        const error = vi.spyOn(console, 'error').mockImplementation((line?: unknown) => {
            errors.push(String(line));
        });
        try {
            const { report, lines } = await run(false, true, plaintextScript);
            expect(report.plaintext_fallbacks).toEqual(['.runnerfallback']);
            expect(report.silent_waits).toEqual({ 'diagnostics/open': { waits: 3, longest_streak: 3 } });
            expect(lines.some((l) => l.startsWith('  Opened as plaintext: .runnerfallback'))).toBe(true);
            expect(lines).toContain(
                '  Some documents were opened as plaintext, and the server may not serve that language id',
            );
        } finally {
            error.mockRestore();
        }
        expect(errors.filter((l) => l.includes('`.runnerfallback` has no registered language id'))).toHaveLength(1);
    });

    it('records no silent waits for a server that publishes', async () => {
        const { report, lines } = await run(true, false);
        expect(report.summary['diagnostics/open']).toMatchObject({ count: 1, timeout_rate: 0 });
        expect(report.silent_waits).toBeUndefined();
        expect(report.until_rejected).toBeUndefined();
        expect(report.plaintext_fallbacks).toBeUndefined();
        expect(lines.some((l) => l.includes('did not publish'))).toBe(false);
        expect(lines.some((l) => l.includes('failed until'))).toBe(false);
    });

    it('shortens silent waits after the streak with shortenSilentWaits, and reports them', async () => {
        const { report, lines } = await run(false, true, script, { iterations: 3, shortenSilentWaits: 10 });
        expect(report.summary['diagnostics/open']).toMatchObject({ count: 3, timeout_rate: 1, shortened: 2 });
        expect(report.silent_waits).toEqual({ 'diagnostics/open': { waits: 5, longest_streak: 5, shortened: 2 } });
        expect(report.reopen_waits).toBeUndefined();
        const timings = report.runs.flatMap((r) => r.requests).filter((t) => t.method === 'diagnostics/open');
        expect(timings.map((t) => t.shortened === true)).toEqual([false, true, true]);
        expect(lines.some((l) => l.includes('Shorten:    diagnostics waits known to time out to 10ms'))).toBe(true);
        expect(lines.some((l) => l.includes('2 waits of a kind known to time out shortened'))).toBe(true);
    });

    it('shortens no waits of a server that publishes', async () => {
        const { report } = await run(true, false, script, { iterations: 3, shortenSilentWaits: 10 });
        expect(report.summary['diagnostics/open']).not.toHaveProperty('shortened');
        expect(report.silent_waits).toBeUndefined();
    });

    it('records waits timing out after publishes all failing until, and notes them in the summary', async () => {
        const { report, lines } = await run(true, true, untilScript);
        expect(report.summary['diagnostics/open']).toMatchObject({ count: 1, timeout_rate: 1 });
        expect(report.until_rejected).toEqual({ 'diagnostics/open': { waits: 3 } });
        expect(report.silent_waits).toBeUndefined();
        expect(
            lines.some((l) => l.includes('diagnostics/open: 3 waits timed out after publishes that all failed until')),
        ).toBe(true);
    });
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
conn.onNotification('exit', () => (mode === 'segv' ? process.kill(process.pid, 'SIGSEGV') : process.exit(1)));
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

    function options(
        mode: 'fail' | 'quit' | 'segv',
        restart: boolean,
        output: string,
        allowExitCodes?: number[],
        allowExitSignals?: NodeJS.Signals[],
        allowUnrepliedShutdown?: boolean,
    ): BenchOptions {
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
            allowExitSignals,
            allowUnrepliedShutdown,
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
            const expected = restart
                ? ['teardown of warmup 1', 'teardown of iteration 1', 'teardown of iteration 2']
                : ['final teardown'];
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

    it('records an allowed signal after a replied shutdown as tolerated, not abnormal', async () => {
        const output = path.join(tmpDir, 'report-signal-allowed.json');
        const report = await runBenchmark(options('segv', true, output, undefined, ['SIGSEGV']));

        expect(report.abnormal_exits).toBeUndefined();
        expect(report.tolerated_exits).toEqual(
            ['teardown of warmup 1', 'teardown of iteration 1', 'teardown of iteration 2'].map((during) => ({
                during,
                code: null,
                signal: 'SIGSEGV',
                reason: 'exited after shutdown with signal SIGSEGV (allowed)',
            })),
        );
    });

    it('records a signal after a replied shutdown as abnormal when only codes are allowed', async () => {
        const report = await runBenchmark(options('segv', true, path.join(tmpDir, 'report-signal.json'), [1]));
        expect(report.tolerated_exits).toBeUndefined();
        expect(report.abnormal_exits?.map((e) => e.signal)).toEqual(['SIGSEGV', 'SIGSEGV', 'SIGSEGV']);
    });

    it('keeps an exit 0 without a shutdown reply abnormal whatever codes are allowed', async () => {
        const report = await runBenchmark(options('quit', true, path.join(tmpDir, 'report-quit.json'), [0, 1]));
        expect(report.tolerated_exits).toBeUndefined();
        expect(report.abnormal_exits?.map((e) => [e.code, e.during])).toEqual([
            [0, 'teardown of warmup 1'],
            [0, 'teardown of iteration 1'],
            [0, 'teardown of iteration 2'],
        ]);
    });

    for (const restart of [false, true]) {
        it(`records an exit 0 after an unreplied shutdown as tolerated with allowUnrepliedShutdown (${restart ? 'restart' : 'keep alive'})`, async () => {
            const output = path.join(tmpDir, `report-unreplied-${restart}.json`);
            const report = await runBenchmark(options('quit', restart, output, undefined, undefined, true));

            expect(report.abnormal_exits).toBeUndefined();
            const expected = restart
                ? ['teardown of warmup 1', 'teardown of iteration 1', 'teardown of iteration 2']
                : ['final teardown'];
            expect(report.tolerated_exits).toEqual(
                expected.map((during) => ({
                    during,
                    code: 0,
                    signal: null,
                    reason: 'exited after unreplied shutdown with code 0 (allowed)',
                })),
            );
            expect(report.summary['lifecycle/shutdown']?.failure_rate).toBe(0);
        });
    }
});

describe('runBenchmark progress lines', () => {
    let tmpDir: string;
    let script: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-progress-'));
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

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /** run two iterations after one warmup, returning stdout and console output in order as one string */
    async function capture(verbose: boolean): Promise<string> {
        const chunks: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
            chunks.push(String(chunk));
            return true;
        });
        for (const method of ['log', 'error'] as const) {
            vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
                chunks.push(`${args.map(String).join(' ')}\n`);
            });
        }
        await runBenchmark({
            server: process.execPath,
            serverArgs: ['--input-type=module', '-e', cleanServer],
            workspace: tmpDir,
            script,
            iterations: 2,
            warmup: 1,
            output: '',
            restart: false,
            verbose,
        });
        return chunks.join('');
    }

    it('ends the progress line and prints the iteration time on its own line under -v', async () => {
        const out = await capture(true);
        const lines = out.split('\n');
        // the ctx line of the hover lands on its own line, never after the progress line
        expect(out).not.toMatch(/\.\.\.\S/);
        for (const iteration of ['warmup 1/1', '1/2', '2/2']) {
            const start = lines.indexOf(`  Running iteration ${iteration}...`);
            expect(start).toBeGreaterThanOrEqual(0);
            expect(lines[start + 1]).toMatch(/^\[lsbench:ctx\] /);
            const suffix = iteration.startsWith('warmup') ? ' \\(warmup\\)' : '';
            const time = lines.findIndex((line) =>
                new RegExp(`^  Iteration ${iteration}: \\d+ms${suffix}$`).test(line),
            );
            expect(time).toBeGreaterThan(start + 1);
        }
    });

    it('keeps the time on the progress line without -v', async () => {
        const out = await capture(false);
        expect(out).toMatch(/^ {2}Running iteration warmup 1\/1\.\.\. \d+ms \(warmup\)$/m);
        expect(out).toMatch(/^ {2}Running iteration 1\/2\.\.\. \d+ms$/m);
        expect(out).toMatch(/^ {2}Running iteration 2\/2\.\.\. \d+ms$/m);
        expect(out).not.toMatch(/Iteration \d/);
    });
});

/**
 * a fake server advertising diagnosticProvider, picked by argv: pull answers every pull empty
 * and never publishes (as ts7 does); late answers its first start the same way, after 100ms,
 * as a server still loading would, and from its second start on also publishes for each
 * opened document 20ms after didOpen (as rust-analyzer does once loaded). argv[2] is a file
 * counting the starts
 */
const deliveryServer = `
import * as fs from 'node:fs';
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
const [mode, counter] = process.argv.slice(1);
const start = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf-8') : '0') + 1;
fs.writeFileSync(counter, String(start));
const pushes = mode === 'late' && start > 1;
conn.onRequest('initialize', () => ({
    capabilities: { textDocumentSync: 1, diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } },
}));
// busy: loads for 150ms after initialized like rust-analyzer, answering pulls empty meanwhile
conn.onNotification('initialized', () => {
    if (mode === 'busy') {
        conn.sendNotification('experimental/serverStatus', { health: 'ok', quiescent: false });
        setTimeout(() => conn.sendNotification('experimental/serverStatus', { health: 'ok', quiescent: true }), 150);
    }
});
conn.onNotification('textDocument/didOpen', ({ textDocument }) => {
    if (pushes) {
        const diagnostic = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'x' };
        setTimeout(() => conn.sendNotification('textDocument/publishDiagnostics', { uri: textDocument.uri, diagnostics: [diagnostic] }), 20);
    }
});
conn.onRequest('textDocument/diagnostic', async () => {
    if (mode === 'late') {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { kind: 'full', items: [] };
});
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
`;

describe('runBenchmark with restart carries the learned diagnostics delivery', () => {
    let tmpDir: string;
    let script: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-delivery-'));
        fs.writeFileSync(path.join(tmpDir, 'main.ts'), 'const a = 1;\n', 'utf-8');
        script = path.join(tmpDir, 'actions.ts');
        fs.writeFileSync(
            script,
            `export default async function (ctx: any): Promise<void> {
                await ctx.openDocument('main.ts');
                await ctx.waitForDiagnostics('main.ts', { timeout: 5000 });
            }`,
            'utf-8',
        );
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /** run two iterations after one warmup with restart and -v, returning the report and the logged lines */
    async function run(mode: 'pull' | 'late' | 'busy') {
        const lines: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
            lines.push(...String(chunk).split('\n'));
            return true;
        });
        for (const method of ['log', 'error'] as const) {
            vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
                lines.push(...args.map(String).join(' ').split('\n'));
            });
        }
        const report = await runBenchmark({
            server: process.execPath,
            serverArgs: ['--input-type=module', '-e', deliveryServer, mode, path.join(tmpDir, `starts-${mode}`)],
            workspace: tmpDir,
            script,
            iterations: 2,
            warmup: 1,
            output: '',
            restart: true,
            verbose: true,
        });
        return { report, lines };
    }

    /** the lines logged from the start of `iteration` to the start of the next */
    function linesOf(lines: string[], iteration: string, next?: string): string[] {
        const from = lines.indexOf(`  Running iteration ${iteration}...`);
        const to = next ? lines.indexOf(`  Running iteration ${next}...`) : lines.length;
        expect(from).toBeGreaterThanOrEqual(0);
        return lines.slice(from, to);
    }

    it('pulls at once after the warmup on a pull only server, without the push grace', async () => {
        const { report, lines } = await run('pull');
        const graces = lines.filter((l) => l.includes('No publish from the server within'));
        expect(graces).toHaveLength(1);
        expect(linesOf(lines, 'warmup 1/1', '1/2')).toContain(graces[0]);
        for (const iteration of ['1/2', '2/2']) {
            expect(linesOf(lines, iteration, iteration === '1/2' ? '2/2' : undefined)).toContain(
                '[lsbench] Carrying diagnostics delivery from the previous server: pull (tentative)',
            );
        }
        expect(report.runs).toHaveLength(2);
        for (const r of report.runs) {
            const pulls = r.requests.filter((t) => t.method === 'diagnostics/pull/open');
            expect(pulls).toHaveLength(1);
            expect(pulls[0]).toMatchObject({ success: true, diagnostics: 0, tentative: true });
            // pulled at once, so no grace is part of the timing, and a server never busy holds nothing
            expect(pulls[0].grace_ms).toBeUndefined();
            expect(pulls[0].held_pulls).toBeUndefined();
            // without carrying, each run would wait the 1000ms grace before pulling
            expect(r.total_ms).toBeLessThan(1000);
        }
        expect(report.summary['diagnostics/pull/open']).not.toHaveProperty('graced');
        expect(report.summary['diagnostics/pull/open']).not.toHaveProperty('held');
    });

    it('does not resolve a carried tentative pull with the placeholder of a busy server', async () => {
        const { report, lines } = await run('busy');
        expect(linesOf(lines, '1/2', '2/2')).toContain(
            '[lsbench] Carrying diagnostics delivery from the previous server: pull (tentative)',
        );
        for (const r of report.runs) {
            const pulls = r.requests.filter((t) => t.method === 'diagnostics/pull/open');
            expect(pulls).toHaveLength(1);
            // the pull at once is held, the one after quiescence resolves, timed from didOpen
            expect(pulls[0]).toMatchObject({ success: true, diagnostics: 0, tentative: true, held_pulls: 1 });
            expect(pulls[0].duration_ms).toBeGreaterThanOrEqual(100);
            expect(pulls[0].grace_ms).toBeUndefined();
        }
        expect(report.summary['diagnostics/pull/open']).toMatchObject({ held: 2 });
    });

    it('still flips a carried tentative pull to push when the restarted server pushes', async () => {
        const { report, lines } = await run('late');
        const warmup = linesOf(lines, 'warmup 1/1', '1/2');
        const first = linesOf(lines, '1/2', '2/2');
        const second = linesOf(lines, '2/2');
        // the warmup's server only answered pulls, empty, so pull is learned tentatively
        expect(warmup.some((l) => l.includes('tentatively pull only'))).toBe(true);
        expect(first).toContain('[lsbench] Carrying diagnostics delivery from the previous server: pull (tentative)');
        expect(first.some((l) => l.includes('Server pushes diagnostics'))).toBe(true);
        expect(first.some((l) => l.includes('No publish from the server within'))).toBe(false);
        // the push is carried on, not the tentative pull
        expect(second).toContain('[lsbench] Carrying diagnostics delivery from the previous server: push');
        expect(second.some((l) => l.includes('No publish from the server within'))).toBe(false);

        for (const r of report.runs) {
            const waits = r.requests.filter((t) => t.method.startsWith('diagnostics/'));
            expect(waits.at(-1)).toMatchObject({ method: 'diagnostics/open', diagnostics: 1 });
        }
        // the second run waits for the push alone, it does not pull
        expect(report.runs[1].requests.some((t) => t.method === 'diagnostics/pull/open')).toBe(false);
    });
});

const hoverServer = `
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

describe('runBenchmark with --trace', () => {
    let tmpDir: string;
    let script: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-trace-'));
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

    function readTrace(file: string): Array<Record<string, unknown>> {
        const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
        return lines.map((line) => JSON.parse(line));
    }

    for (const restart of [false, true]) {
        it(`traces messages, spawns and iterations (${restart ? 'restart' : 'keep alive'})`, async () => {
            const trace = path.join(tmpDir, `trace-${restart}.jsonl`);
            fs.writeFileSync(trace, 'left over from an earlier run\n');
            await runBenchmark({
                server: process.execPath,
                serverArgs: ['--input-type=module', '-e', hoverServer],
                workspace: tmpDir,
                script,
                iterations: 2,
                warmup: 1,
                output: '',
                restart,
                verbose: false,
                trace,
            });

            // the file is overwritten, every line parses and t never goes back
            const lines = readTrace(trace);
            let last = 0;
            for (const line of lines) {
                expect(typeof line.t).toBe('number');
                expect(line.t as number).toBeGreaterThanOrEqual(last);
                last = line.t as number;
            }

            const markers: unknown[] = [];
            for (const line of lines) {
                if ('iteration' in line) {
                    markers.push([line.iteration, line.warmup]);
                }
            }
            expect(markers).toEqual([
                [1, true],
                [1, false],
                [2, false],
            ]);

            let spawns = 0;
            for (const line of lines) {
                if (line.spawn) {
                    spawns++;
                    expect(line.command).toBe(process.execPath);
                }
            }
            expect(spawns).toBe(restart ? 3 : 1);

            // a restarted server spawns after its iteration's marker
            if (restart) {
                expect(lines[0]).toMatchObject({ iteration: 1, warmup: true });
                expect(lines[1]).toMatchObject({ spawn: true });
            }

            // both directions, a request and its response sharing an id
            const methods: string[] = [];
            for (const line of lines) {
                if (line.dir) {
                    const msg = line.msg as { method?: string; id?: number; result?: unknown };
                    methods.push(`${line.dir} ${msg.method ?? `response ${msg.id}`}`);
                }
            }
            expect(methods.slice(0, 3)).toEqual(['out initialize', 'in response 0', 'out initialized']);
            expect(methods.filter((m) => m === 'out textDocument/hover')).toHaveLength(3);
            expect(methods).toContain('out shutdown');
            expect(methods[methods.length - 1]).toBe('out exit');
        });
    }

    it('writes the trace when the server fails to start', async () => {
        const trace = path.join(tmpDir, 'trace-failed.jsonl');
        const failing = hoverServer.replace(
            "conn.onRequest('initialize', () => ({ capabilities: { hoverProvider: true } }));",
            "conn.onRequest('initialize', () => { throw new Error('no thanks'); });",
        );
        await expect(
            runBenchmark({
                server: process.execPath,
                serverArgs: ['--input-type=module', '-e', failing],
                workspace: tmpDir,
                script,
                iterations: 1,
                warmup: 0,
                output: '',
                restart: false,
                verbose: false,
                shutdownTimeout: 500,
                trace,
            }),
        ).rejects.toThrow();
        const lines = readTrace(trace);
        expect(lines[0]).toMatchObject({ spawn: true });
        expect(lines[1]).toMatchObject({ dir: 'out', msg: { method: 'initialize' } });
        expect(lines[2]).toMatchObject({
            dir: 'in',
            msg: { error: { message: expect.stringContaining('no thanks') } },
        });
    });
});

const failingStartServer = `
import * as fs from 'node:fs';
import * as rpc from 'vscode-jsonrpc/node';
const [pidFile, failOn] = process.argv.slice(1);
fs.appendFileSync(pidFile, \`\${process.pid}\\n\`);
const start = fs.readFileSync(pidFile, 'utf-8').trim().split('\\n').length;
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
conn.onRequest('initialize', () => {
    if (start === Number(failOn)) {
        throw new Error('nope');
    }
    return { capabilities: {} };
});
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
process.stdin.on('end', () => {});
setInterval(() => {}, 1000);
`;

describe('runBenchmark kills a server whose start failed', () => {
    let tmpDir: string;
    let plainScript: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-failed-start-'));
        plainScript = path.join(tmpDir, 'plain.mjs');
        fs.writeFileSync(plainScript, 'export default async function () {}', 'utf-8');
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    function isAlive(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    }

    function pids(pidFile: string): number[] {
        return fs.readFileSync(pidFile, 'utf-8').trim().split('\n').map(Number);
    }

    function options(name: string, failOn: number, script: string, restart: boolean): BenchOptions {
        return {
            server: process.execPath,
            serverArgs: ['--input-type=module', '-e', failingStartServer, path.join(tmpDir, name), String(failOn)],
            workspace: tmpDir,
            script,
            iterations: 1,
            warmup: 0,
            output: '',
            restart,
            verbose: false,
            shutdownTimeout: 500,
        };
    }

    for (const restart of [false, true]) {
        const mode = restart ? 'restart' : 'keep alive';

        it(`kills the server when initialize fails (${mode})`, async () => {
            vi.spyOn(console, 'log').mockImplementation(() => {});
            const name = `init-${mode}`;
            await expect(runBenchmark(options(name, 1, plainScript, restart))).rejects.toThrow(
                'Request initialize failed with message: nope',
            );
            const [pid] = pids(path.join(tmpDir, name));
            expect(isAlive(pid)).toBe(false);
        });

        it(`kills the server when setup throws (${mode})`, async () => {
            vi.spyOn(console, 'log').mockImplementation(() => {});
            const name = `setup-${mode}`;
            const setupScript = path.join(tmpDir, `${name}.mjs`);
            fs.writeFileSync(
                setupScript,
                `import * as fs from 'node:fs';
                export async function setup() {
                    while (!fs.existsSync(${JSON.stringify(path.join(tmpDir, name))})) {
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                    throw new Error('setup boom');
                }
                export default async function () {}`,
                'utf-8',
            );
            await expect(runBenchmark(options(name, 0, setupScript, restart))).rejects.toThrow(/^setup boom$/);
            const [pid] = pids(path.join(tmpDir, name));
            expect(isAlive(pid)).toBe(false);
        });
    }

    it('kills the server when the idle wait throws (keep alive)', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(LspHarness.prototype, 'waitForIdleAfterStart').mockRejectedValue(new Error('idle boom'));
        const name = 'idle-keep-alive';
        await expect(runBenchmark({ ...options(name, 0, plainScript, false), waitIdle: 1000 })).rejects.toThrow(
            /^idle boom$/,
        );
        const [pid] = pids(path.join(tmpDir, name));
        expect(isAlive(pid)).toBe(false);
    });

    it('keeps the collected runs and records the failed restart unchanged', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const name = 'second-start';
        const report = await runBenchmark({ ...options(name, 2, plainScript, true), iterations: 2 });
        expect(report.runs.map((r) => r.iteration)).toEqual([1]);
        expect(report.abnormal_exits).toEqual([
            {
                during: 'iteration 2',
                code: null,
                signal: null,
                reason: 'failed to start: Request initialize failed with message: nope',
            },
        ]);
        const started = pids(path.join(tmpDir, name));
        expect(started).toHaveLength(2);
        expect(isAlive(started[1])).toBe(false);
    });
});

const uriServer = `
import * as fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
let root = '';
conn.onRequest('initialize', (params) => {
    root = fileURLToPath(new URL(params.rootUri).href);
    return { capabilities: { textDocumentSync: 1 } };
});
conn.onNotification('textDocument/didOpen', ({ textDocument }) => {
    const file = fileURLToPath(new URL(textDocument.uri).href);
    if (fs.existsSync(file) && fs.statSync(root).isDirectory()) {
        const diagnostic = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'x' };
        conn.sendNotification('textDocument/publishDiagnostics', { uri: pathToFileURL(file).href, diagnostics: [diagnostic] });
    }
});
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
`;

describe('runBenchmark in a workspace whose path needs percent-encoding', () => {
    let tmpDir: string;
    let workspace: string;
    let script: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-uri-'));
        workspace = path.join(tmpDir, 'a#b 100%');
        fs.mkdirSync(workspace);
        fs.writeFileSync(path.join(workspace, 'main.ts'), 'const a = 1;\n', 'utf-8');
        script = path.join(tmpDir, 'actions.ts');
        fs.writeFileSync(
            script,
            `export default async function (ctx: any): Promise<void> {
                await ctx.openDocument('main.ts');
                await ctx.waitForDiagnostics('main.ts', 1000);
            }`,
            'utf-8',
        );
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('sends URIs the server resolves to the files and matches its publishes', async () => {
        const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const report = await runBenchmark({
                server: process.execPath,
                serverArgs: ['--input-type=module', '-e', uriServer],
                workspace,
                script,
                iterations: 1,
                warmup: 0,
                output: '',
            });
            expect(report.summary['diagnostics/open']).toMatchObject({ count: 1, timeout_rate: 0 });
        } finally {
            log.mockRestore();
            write.mockRestore();
        }
    });
});

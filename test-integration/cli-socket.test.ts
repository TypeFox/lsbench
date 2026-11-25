import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const langiumServer = path.join(here, 'langium-grammar-server.ts');
const langiumWorkspace = path.join(here, 'langium-grammar');

const listeningServer = `
import * as net from 'node:net';
import * as rpc from 'vscode-jsonrpc/node';
const mode = process.argv[2] ?? 'clean';
const server = net.createServer((socket) => {
    socket.on('error', () => {});
    const conn = rpc.createMessageConnection(new rpc.SocketMessageReader(socket), new rpc.SocketMessageWriter(socket));
    conn.onRequest('initialize', () => ({ capabilities: { hoverProvider: true } }));
    conn.onRequest('textDocument/hover', () => {
        if (mode === 'close') {
            setTimeout(() => socket.destroy(), 20);
            return new Promise(() => {});
        }
        return { contents: 'hover' };
    });
    conn.onRequest('shutdown', () => null);
    conn.onNotification('exit', () => socket.end());
    conn.listen();
});
server.listen(Number(process.argv[1]), '127.0.0.1', () => {
    process.stdout.write(server.address().port + '\\n');
});
`;

async function freePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

describe('lsbench CLI over socket transports', () => {
    let tmpDir: string;
    let hoverScript: string;
    let langiumScript: string;
    const started: ChildProcess[] = [];

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-cli-socket-'));
        hoverScript = path.join(tmpDir, 'hover.ts');
        fs.writeFileSync(
            hoverScript,
            `export default async function (ctx: any): Promise<void> {
                await ctx.request('textDocument/hover', {});
            }`,
            'utf-8',
        );
        langiumScript = path.join(tmpDir, 'langium.ts');
        fs.writeFileSync(
            langiumScript,
            `export default async function (ctx: any): Promise<void> {
                await ctx.openDocument('shapes.langium');
                await ctx.waitForDiagnostics('shapes.langium', 30000);
                await ctx.hover('shapes.langium', 25, 15);
            }`,
            'utf-8',
        );
    });

    afterEach(() => {
        for (const child of started.splice(0)) {
            child.kill();
        }
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function runCli(args: string[], output: string) {
        return spawnSync(process.execPath, [path.resolve('dist/cli.js'), '-o', output, ...args], {
            encoding: 'utf-8',
        });
    }

    function readReport(output: string) {
        return JSON.parse(fs.readFileSync(output, 'utf-8'));
    }

    async function startListeningServer(mode: string): Promise<number> {
        const child = spawn(process.execPath, ['--input-type=module', '-e', listeningServer, '0', mode], {
            stdio: ['ignore', 'pipe', 'inherit'],
        });
        started.push(child);
        return new Promise<number>((resolve, reject) => {
            child.once('error', reject);
            child.stdout?.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
        });
    }

    it('runs the langium server through a full iteration over --socket', () => {
        const output = path.join(tmpDir, 'socket.json');
        const result = runCli(
            [
                `node ${langiumServer} --socket={port}`,
                '--socket',
                '0',
                '-w',
                langiumWorkspace,
                '-s',
                langiumScript,
                '-n',
                '1',
                '--warmup',
                '0',
            ],
            output,
        );
        expect(result.stderr).not.toMatch(/abnormally|Fatal/);
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/Transport: {2}socket 0/);
        const report = readReport(output);
        expect(report.transport).toBe('socket 0');
        expect(report.runs).toHaveLength(1);
        expect(report.iteration_summary.median_ms).toBeGreaterThan(0);
        expect(report.summary['textDocument/hover']).toMatchObject({ count: 1, failure_rate: 0 });
        expect(report.summary['diagnostics/open']).toMatchObject({ count: 1, timeout_rate: 0 });
        expect(report.lifecycle.map((t: { method: string }) => t.method)).toEqual([
            'lifecycle/spawn',
            'lifecycle/connect',
            'lifecycle/initialize',
            'lifecycle/shutdown',
        ]);
        expect(report.abnormal_exits).toBeUndefined();
    });

    it('spawns a listening server and connects to it over --connect with --restart', async () => {
        const port = await freePort();
        const output = path.join(tmpDir, 'connect-spawn.json');
        const result = runCli(
            [
                process.execPath,
                '--connect',
                String(port),
                '-w',
                tmpDir,
                '-s',
                hoverScript,
                '-n',
                '2',
                '--warmup',
                '0',
                '--restart',
                '--',
                '--input-type=module',
                '-e',
                listeningServer,
                '{port}',
            ],
            output,
        );
        expect(result.stderr).not.toMatch(/abnormally|Fatal/);
        expect(result.status).toBe(0);
        const report = readReport(output);
        expect(report.runs).toHaveLength(2);
        expect(report.summary['textDocument/hover']).toMatchObject({ count: 2, failure_rate: 0 });
        expect(report.summary['lifecycle/connect']).toMatchObject({ count: 2, failure_rate: 0 });
    });

    it('connects to an already running server without a command', async () => {
        const port = await startListeningServer('clean');
        const output = path.join(tmpDir, 'connect-only.json');
        const result = runCli(
            ['--connect', `127.0.0.1:${port}`, '-w', tmpDir, '-s', hoverScript, '-n', '2', '--warmup', '0'],
            output,
        );
        expect(result.stderr).not.toMatch(/abnormally|Fatal/);
        expect(result.status).toBe(0);
        const report = readReport(output);
        expect(report.server).toBe(`connect 127.0.0.1:${port}`);
        expect(report.summary['textDocument/hover']).toMatchObject({ count: 2, failure_rate: 0 });
        expect(report.lifecycle.map((t: { method: string }) => t.method)).toEqual([
            'lifecycle/connect',
            'lifecycle/initialize',
            'lifecycle/shutdown',
        ]);
    });

    it('fails with a clear error when nothing listens on the --connect port', async () => {
        const port = await freePort();
        const started = Date.now();
        const result = runCli(
            ['--connect', String(port), '--connect-timeout', '500', '-w', tmpDir, '-s', hoverScript, '-n', '1'],
            path.join(tmpDir, 'refused.json'),
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`cannot connect to 127.0.0.1:${port} within 500ms (ECONNREFUSED)`);
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    it('reports a server closing the connection mid run like a crash', async () => {
        const port = await startListeningServer('close');
        const output = path.join(tmpDir, 'closed.json');
        const result = runCli(
            ['--connect', String(port), '-w', tmpDir, '-s', hoverScript, '-n', '2', '--warmup', '0'],
            output,
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(
            /exited abnormally during iteration 1 \(connection closed\): closed the connection unexpectedly/,
        );
        const report = readReport(output);
        expect(report.abnormal_exits).toEqual([
            { during: 'iteration 1', code: null, signal: null, reason: 'closed the connection unexpectedly' },
        ]);
        expect(report.summary['textDocument/hover']).toMatchObject({ count: 1, failure_rate: 1 });
    });

    it('rejects invalid transport options', () => {
        const base = ['-w', tmpDir, '-s', hoverScript];
        const cases: Array<[string[], string]> = [
            [base, 'a server command is required unless --connect is given'],
            [['srv', '--connect', '1', '--socket', '2', ...base], '--connect and --socket cannot be combined'],
            [['--connect', 'host:0', ...base], '--connect must be a port or host:port'],
            [['--connect', 'host:', ...base], '--connect must be a port or host:port'],
            [['srv', '--socket', '70000', ...base], '--socket must be a port from 0 to 65535'],
            [['--connect', '1', '--connect-timeout', '0', ...base], '--connect-timeout must be a positive integer'],
            [['--connect', '1', '--allow-exit-code', '1', ...base], '--allow-exit-code and --allow-exit-signal need'],
        ];
        for (const [args, message] of cases) {
            const result = runCli(args, path.join(tmpDir, 'invalid.json'));
            expect(result.status, args.join(' ')).toBe(1);
            expect(result.stderr, args.join(' ')).toContain(message);
        }
    });
});

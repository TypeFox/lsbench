import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { LspHarness, resolveServerConfig, WireTrace } from 'lsbench';
import * as rpc from 'vscode-jsonrpc/node';
import { afterEach, describe, expect, it } from 'vitest';

interface FakeServerOptions {
    onShutdown?: 'reply' | 'ignore';
    onExit?: 'close' | 'ignore';
    hoverCloses?: boolean;
}

interface FakeServer {
    port: number;
    connections: number;
    close(): Promise<void>;
}

const servers: FakeServer[] = [];

afterEach(async () => {
    for (const server of servers.splice(0)) {
        await server.close();
    }
});

async function fakeServer(options: FakeServerOptions = {}, port = 0): Promise<FakeServer> {
    const sockets = new Set<net.Socket>();
    const result: FakeServer = { port: 0, connections: 0, close: async () => {} };
    const server = net.createServer((socket) => {
        result.connections++;
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        const conn = rpc.createMessageConnection(
            new rpc.SocketMessageReader(socket),
            new rpc.SocketMessageWriter(socket),
        );
        conn.onRequest('initialize', () => ({ capabilities: { hoverProvider: true } }));
        conn.onRequest('textDocument/hover', () => {
            if (options.hoverCloses) {
                setTimeout(() => socket.destroy(), 20);
                return new Promise(() => {});
            }
            return { contents: 'hi' };
        });
        conn.onRequest('shutdown', () => (options.onShutdown === 'ignore' ? new Promise(() => {}) : null));
        conn.onNotification('exit', () => {
            if (options.onExit !== 'ignore') {
                socket.end();
            }
        });
        conn.listen();
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
    result.port = (server.address() as net.AddressInfo).port;
    result.close = () =>
        new Promise<void>((resolve) => {
            for (const socket of sockets) {
                socket.destroy();
            }
            server.close(() => resolve());
        });
    servers.push(result);
    return result;
}

async function freePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

function connectHarness(port: number, timeoutMs = 2000, trace?: WireTrace): LspHarness {
    return new LspHarness(
        { transport: { kind: 'connect', host: '127.0.0.1', port, timeoutMs } },
        process.cwd(),
        false,
        { trace },
    );
}

const connectingServer = `
import * as net from 'node:net';
import * as rpc from 'vscode-jsonrpc/node';
const mode = process.argv[2];
if (mode === 'exit') {
    process.stderr.write('no socket for me\\n');
    process.exit(4);
}
const socket = net.connect(Number(process.argv[1].split('=')[1]), '127.0.0.1');
const conn = rpc.createMessageConnection(new rpc.SocketMessageReader(socket), new rpc.SocketMessageWriter(socket));
conn.onRequest('initialize', () => ({ capabilities: { hoverProvider: true } }));
conn.onRequest('textDocument/hover', () => {
    if (mode === 'close') {
        setTimeout(() => socket.destroy(), 20);
        return new Promise(() => {});
    }
    return { contents: 'hi' };
});
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
process.stdout.write('stdout line\\n');
setInterval(() => {}, 1000);
`;

function socketHarness(mode = 'clean', port = 0, serverLog?: string): LspHarness {
    return new LspHarness(
        {
            command: process.execPath,
            args: ['--input-type=module', '-e', connectingServer, '--', '--socket={port}', mode],
            transport: { kind: 'socket', port, timeoutMs: 3000 },
        },
        process.cwd(),
        false,
        { serverLog },
    );
}

describe('LspHarness over --connect', () => {
    it('runs the handshake, a request and a clean stop, recording lifecycle/connect', async () => {
        const server = await fakeServer();
        const harness = connectHarness(server.port);
        await harness.start();
        expect(harness.capabilities).toEqual({ hoverProvider: true });
        expect(await harness.sendRequest('textDocument/hover', {})).toEqual({ contents: 'hi' });
        const exit = await harness.stop(1000);
        expect(exit).toEqual({
            code: null,
            signal: null,
            abnormal: false,
            reason: 'closed the connection after shutdown',
        });
        expect(harness.takeLifecycleTimings().map((t) => [t.method, t.success])).toEqual([
            ['lifecycle/connect', true],
            ['lifecycle/initialize', true],
            ['lifecycle/shutdown', true],
        ]);
    });

    it('fails with the endpoint after the timeout when nothing listens', async () => {
        const port = await freePort();
        const harness = connectHarness(port, 300);
        const started = Date.now();
        await expect(harness.start()).rejects.toThrow(
            `cannot connect to 127.0.0.1:${port} within 300ms (ECONNREFUSED)`,
        );
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(250);
        expect(elapsed).toBeLessThan(2000);
        expect(harness.takeLifecycleTimings()).toEqual([
            expect.objectContaining({ method: 'lifecycle/connect', success: false }),
        ]);
    });

    it('retries until a server starts listening', async () => {
        const port = await freePort();
        const harness = connectHarness(port, 3000);
        const starting = harness.start();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await fakeServer({}, port);
        await starting;
        expect(harness.capabilities).toEqual({ hoverProvider: true });
        await harness.stop(1000);
    });

    it('fails pending requests when the server closes the connection mid request', async () => {
        const server = await fakeServer({ hoverCloses: true });
        const harness = connectHarness(server.port);
        await harness.start();
        await expect(harness.sendRequest('textDocument/hover', {})).rejects.toThrow(
            'server closed the connection unexpectedly',
        );
        expect(harness.exit).toEqual({
            code: null,
            signal: null,
            abnormal: true,
            reason: 'closed the connection unexpectedly',
        });
        expect(() => harness.sendNotification('textDocument/didOpen', {})).toThrow(/closed the connection/);
        expect((await harness.stop(500))?.abnormal).toBe(true);
    });

    it('settles stop against a server that ignores exit and keeps the connection open', async () => {
        const server = await fakeServer({ onExit: 'ignore' });
        const harness = connectHarness(server.port);
        await harness.start();
        const started = Date.now();
        const exit = await harness.stop(1000);
        expect(Date.now() - started).toBeLessThan(3000);
        expect(exit).toMatchObject({ abnormal: false, reason: 'disconnected by lsbench' });
    });

    it('disconnects from a server that never replies to shutdown', async () => {
        const server = await fakeServer({ onShutdown: 'ignore' });
        const harness = connectHarness(server.port);
        await harness.start();
        const exit = await harness.stop(200);
        expect(exit).toMatchObject({ abnormal: false, reason: 'disconnected by lsbench' });
        expect(harness.takeLifecycleTimings()).toContainEqual(
            expect.objectContaining({ method: 'lifecycle/shutdown', success: false }),
        );
    });

    it('traces the transport instead of a command', async () => {
        const server = await fakeServer();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-socket-'));
        const file = path.join(dir, 'trace.jsonl');
        const trace = new WireTrace(file);
        const harness = connectHarness(server.port, 2000, trace);
        try {
            await harness.start();
            await harness.stop(1000);
            await trace.close();
            const first = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
            expect(first).toMatchObject({ spawn: true, transport: `connect 127.0.0.1:${server.port}` });
            expect(first.command).toBeUndefined();
            expect(first.args).toBeUndefined();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('spawns a given command before connecting and kills it on stop', async () => {
        const port = await freePort();
        const listening = `
import * as net from 'node:net';
import * as rpc from 'vscode-jsonrpc/node';
net.createServer((socket) => {
    const conn = rpc.createMessageConnection(new rpc.SocketMessageReader(socket), new rpc.SocketMessageWriter(socket));
    conn.onRequest('initialize', () => ({ capabilities: { pid: process.pid } }));
    conn.onRequest('shutdown', () => null);
    conn.onNotification('exit', () => process.exit(0));
    conn.listen();
}).listen(Number(process.argv[1]), '127.0.0.1');
`;
        const harness = new LspHarness(
            {
                command: process.execPath,
                args: ['--input-type=module', '-e', listening, '{port}'],
                transport: { kind: 'connect', host: '127.0.0.1', port, timeoutMs: 5000 },
            },
            process.cwd(),
        );
        await harness.start();
        const exit = await harness.stop(1000);
        expect(exit).toMatchObject({ code: 0, signal: null, abnormal: false });
        expect(harness.takeLifecycleTimings().map((t) => t.method)).toEqual([
            'lifecycle/spawn',
            'lifecycle/connect',
            'lifecycle/initialize',
            'lifecycle/shutdown',
        ]);
    });
});

describe('LspHarness over --socket', () => {
    it('accepts the spawned server, substitutes {port} and stops it cleanly', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-socket-'));
        const log = path.join(dir, 'server.log');
        const harness = socketHarness('clean', 0, log);
        try {
            await harness.start();
            expect(await harness.sendRequest('textDocument/hover', {})).toEqual({ contents: 'hi' });
            const exit = await harness.stop(1000);
            expect(exit).toMatchObject({ code: 0, signal: null, abnormal: false });
            expect(harness.takeLifecycleTimings().map((t) => t.method)).toEqual([
                'lifecycle/spawn',
                'lifecycle/connect',
                'lifecycle/initialize',
                'lifecycle/shutdown',
            ]);
            const text = fs.readFileSync(log, 'utf8');
            expect(text).toMatch(/ -- --socket=\d+ clean\n/);
            expect(text).not.toContain('{port}');
            expect(text).toContain('stdout line');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('closes its listener after the server connected', async () => {
        const port = await freePort();
        const harness = socketHarness('clean', port);
        await harness.start();
        try {
            await expect(
                new Promise((resolve, reject) => {
                    const socket = net.connect(port, '127.0.0.1');
                    socket.once('connect', () => {
                        socket.destroy();
                        resolve('connected');
                    });
                    socket.once('error', reject);
                }),
            ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
        } finally {
            await harness.stop(1000);
        }
    });

    it('fails the start with the exit and stderr when the server exits without connecting', async () => {
        const harness = socketHarness('exit');
        const started = Date.now();
        const error = await harness.start().then(
            () => new Error('started'),
            (err: Error) => err,
        );
        expect(error.message).toMatch(/Server exited before initialize \(code=4 signal=null\)/);
        expect(error.message).toContain('no socket for me');
        expect(Date.now() - started).toBeLessThan(2500);
        expect(harness.exit).toMatchObject({ code: 4, abnormal: true });
    });

    it('reports a closed connection as a crash even though the process lives on', async () => {
        const harness = socketHarness('close');
        await harness.start();
        await expect(harness.sendRequest('textDocument/hover', {})).rejects.toThrow(
            'server closed the connection unexpectedly',
        );
        const exit = await harness.stop(500);
        expect(exit).toMatchObject({ abnormal: true, reason: 'closed the connection unexpectedly' });
    });

    it('fails with a port already in use', async () => {
        const server = await fakeServer();
        const harness = socketHarness('clean', server.port);
        await expect(harness.start()).rejects.toThrow(`cannot listen on 127.0.0.1:${server.port} (EADDRINUSE)`);
    });
});

describe('resolveServerConfig transports', () => {
    it('allows a missing command with connect', () => {
        const transport = { kind: 'connect', host: 'localhost', port: 6005 } as const;
        expect(resolveServerConfig(undefined, { transport })).toEqual({
            command: undefined,
            args: [],
            initializationOptions: undefined,
            clientCapabilities: undefined,
            settings: undefined,
            transport,
        });
    });

    it('requires a command otherwise', () => {
        expect(() => resolveServerConfig(undefined)).toThrow('A server command is required');
        expect(() => resolveServerConfig('', { transport: { kind: 'socket', port: 0 } })).toThrow(
            'A server command is required',
        );
    });

    it('leaves stdio out of the config', () => {
        expect(resolveServerConfig('srv', { transport: { kind: 'stdio' } }).transport).toBeUndefined();
    });

    it('rejects a harness without a command unless it connects', async () => {
        const harness = new LspHarness({ transport: { kind: 'socket', port: 0 } }, process.cwd());
        await expect(harness.start()).rejects.toThrow('a server command is required unless the transport is connect');
    });
});

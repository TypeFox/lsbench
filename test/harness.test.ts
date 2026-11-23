import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DiagnosticsPublish, PublishStatus, SetupScript } from 'lsbench';
import {
    BenchContextImpl,
    DiagnosticsTracker,
    defaultClientCapabilities,
    expandSettings,
    LspHarness,
    linkPlaceholders,
    mergeCapabilities,
    ProgressTracker,
    pathToUri,
    pullDiagnosticClientCapabilities,
    resolveConfigurationSection,
    uriToPath,
    WireTrace,
} from 'lsbench';
import * as rpc from 'vscode-jsonrpc/node';
import { describe, expect, it, vi } from 'vitest';

describe('pathToUri', () => {
    it('produces a file:// URI from an absolute path', () => {
        expect(pathToUri('/tmp/project/file.ts')).toBe('file:///tmp/project/file.ts');
    });

    it('resolves relative paths against the cwd', () => {
        const expected = pathToFileURL(path.resolve('some/rel/path.ts')).href;
        expect(pathToUri('some/rel/path.ts')).toBe(expected);
    });

    it('percent-encodes #, ?, % and spaces', () => {
        expect(pathToUri('/tmp/a#b 100%/x?.ts')).toBe('file:///tmp/a%23b%20100%25/x%3F.ts');
    });
});

describe('uriToPath', () => {
    it('strips the file:// scheme', () => {
        expect(uriToPath('file:///tmp/project/file.ts')).toBe('/tmp/project/file.ts');
    });

    it('returns non-file URIs unchanged', () => {
        expect(uriToPath('/already/a/path.ts')).toBe('/already/a/path.ts');
        expect(uriToPath('untitled:Untitled-1')).toBe('untitled:Untitled-1');
    });

    it('decodes percent-encoding', () => {
        expect(uriToPath('file:///tmp/a%20b/x.ts')).toBe('/tmp/a b/x.ts');
        expect(uriToPath('file:///tmp/a%23b%20100%25/x%3F.ts')).toBe('/tmp/a#b 100%/x?.ts');
    });

    it('returns malformed file URIs unchanged', () => {
        expect(uriToPath('file:///tmp/a%2Fb.ts')).toBe('file:///tmp/a%2Fb.ts');
        expect(uriToPath('file://host/tmp/a.ts')).toBe('file://host/tmp/a.ts');
    });
});

describe('pathToUri / uriToPath round-trip', () => {
    it('recovers the original absolute path', () => {
        const abs = '/Users/example/workspace/src/index.ts';
        expect(uriToPath(pathToUri(abs))).toBe(abs);
    });

    it.each(['/tmp/a#b/x.ts', '/tmp/a?b/x.ts', '/tmp/100%/x.ts', '/tmp/a b/x.ts', 'rel/a#b 100%/x.ts'])(
        'recovers %s',
        (p) => {
            expect(uriToPath(pathToUri(p))).toBe(path.resolve(p));
        },
    );
});

/**
 * A fake server that, while handling initialize, sends each server-to-client request
 * and reports the client's replies back through its capabilities.
 */
const probeServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
const probes = JSON.parse(process.argv[1]);
conn.onRequest('initialize', async () => {
    const replies = {};
    for (const [method, params] of probes) {
        try {
            replies[method] = { result: await conn.sendRequest(method, params) };
        } catch (err) {
            replies[method] = { error: err.code };
        }
    }
    return { capabilities: { replies } };
});
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
`;

describe('LspHarness server-to-client requests', () => {
    it('answers requests the advertised client capabilities can trigger', async () => {
        const probes: Array<[string, unknown]> = [
            ['workspace/semanticTokens/refresh', null],
            ['workspace/inlayHint/refresh', null],
            ['workspace/codeLens/refresh', null],
            ['workspace/inlineValue/refresh', null],
            ['workspace/diagnostic/refresh', null],
            ['window/workDoneProgress/create', { token: 'tok' }],
            ['client/unregisterCapability', { unregisterations: [] }],
            ['window/showMessageRequest', { type: 3, message: 'pick one', actions: [{ title: 'ok' }] }],
            ['workspace/applyEdit', { edit: { changes: {} } }],
        ];
        const harness = new LspHarness(
            {
                command: process.execPath,
                args: ['--input-type=module', '-e', probeServer, JSON.stringify(probes)],
            },
            process.cwd(),
        );
        try {
            await harness.start();
            const replies = harness.capabilities?.replies as Record<string, { result?: unknown; error?: number }>;
            for (const [method] of probes.slice(0, -1)) {
                expect(replies[method], method).toEqual({ result: null });
            }
            expect(replies['workspace/applyEdit']).toEqual({
                result: { applied: false, failureReason: expect.any(String) },
            });
        } finally {
            await harness.stop();
        }
    });

    it('answers workspace/workspaceFolders with the folder sent in initialize', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-folders-'));
        const harness = new LspHarness(
            {
                command: process.execPath,
                args: [
                    '--input-type=module',
                    '-e',
                    probeServer,
                    JSON.stringify([['workspace/workspaceFolders', null]]),
                ],
            },
            root,
        );
        try {
            await harness.start();
            const replies = harness.capabilities?.replies as Record<string, { result?: unknown; error?: number }>;
            expect(replies['workspace/workspaceFolders']).toEqual({
                result: [{ uri: pathToUri(root), name: path.basename(root) }],
            });
        } finally {
            await harness.stop();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

const clientHookServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
const waiting = new Map();
let next = 0;
const ask = (name) => {
    const id = ++next;
    const answer = new Promise((resolve) => waiting.set(id, resolve));
    conn.sendNotification('custom/request', [id, name, { file: 'App.vue' }]);
    return answer;
};
conn.onNotification('custom/response', ([id, result]) => waiting.get(id)?.({ id, result }));
conn.onRequest('initialize', async () => {
    const replies = {};
    for (const method of ['custom/ask', 'custom/fail', 'custom/unknown']) {
        try {
            replies[method] = { result: await conn.sendRequest(method, { from: 'server' }) };
        } catch (err) {
            replies[method] = { error: err.code };
        }
    }
    return { capabilities: { hoverProvider: true, replies, projectInfo: await ask('projectInfo') } };
});
conn.onRequest('textDocument/hover', async () => {
    conn.sendNotification('custom/ignored', [1]);
    conn.sendNotification('custom/ignored', [2]);
    return ask('hover');
});
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
`;

describe('LspHarness setup', () => {
    const hookServer = { command: process.execPath, args: ['--input-type=module', '-e', clientHookServer] };
    const answeringSetup: SetupScript = (client) => {
        client.onNotification('custom/request', (params) => {
            const [[id]] = params as [[number, string, unknown]];
            setTimeout(() => client.notify('custom/response', [id, null]), 1);
        });
        client.onRequest('custom/ask', (params) => ({ answered: params }));
        client.onRequest('custom/fail', () => Promise.reject(new Error('nope')));
    };

    it('registers the handlers before initialize on every start', async () => {
        for (let spawn = 0; spawn < 2; spawn++) {
            const harness = new LspHarness(hookServer, process.cwd(), false, { setup: answeringSetup });
            try {
                await harness.start();
                expect(harness.capabilities?.projectInfo).toEqual({ id: 1, result: null });
                expect(harness.capabilities?.replies).toEqual({
                    'custom/ask': { result: { answered: { from: 'server' } } },
                    'custom/fail': { error: -32603 },
                    'custom/unknown': { error: -32601 },
                });
                expect(await harness.sendRequest('textDocument/hover', {})).toEqual({ id: 2, result: null });
            } finally {
                await harness.stop();
            }
        }
    });

    it('awaits an async setup before initialize', async () => {
        const setup: SetupScript = async (client) => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            answeringSetup(client);
        };
        const harness = new LspHarness(hookServer, process.cwd(), false, { setup });
        try {
            await harness.start();
            expect(harness.capabilities?.projectInfo).toEqual({ id: 1, result: null });
        } finally {
            await harness.stop();
        }
    });

    it('leaves a request awaiting a client notification hanging without a handler', async () => {
        const setup: SetupScript = (client) => {
            client.onNotification('custom/request', (params) => {
                const [[id, name]] = params as [[number, string, unknown]];
                if (name === 'projectInfo') {
                    client.notify('custom/response', [id, null]);
                }
            });
        };
        const harness = new LspHarness(hookServer, process.cwd(), false, { setup });
        try {
            await harness.start();
            const hover = harness.sendRequest('textDocument/hover', {});
            hover.catch(() => {});
            const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 300));
            expect(await Promise.race([hover, timeout])).toBe('timeout');
        } finally {
            await harness.stop();
        }
    });

    it('rejects handlers for methods lsbench handles itself', async () => {
        const errors: string[] = [];
        const setup: SetupScript = (client) => {
            for (const register of [
                () => client.onRequest('workspace/configuration', () => []),
                () => client.onNotification('$/progress', () => {}),
            ]) {
                try {
                    register();
                } catch (err: unknown) {
                    errors.push((err as Error).message);
                }
            }
            answeringSetup(client);
        };
        const harness = new LspHarness(hookServer, process.cwd(), false, { setup });
        try {
            await harness.start();
        } finally {
            await harness.stop();
        }
        expect(errors).toEqual([
            'setup cannot handle the request workspace/configuration, lsbench handles it itself',
            'setup cannot handle the notification $/progress, lsbench handles it itself',
        ]);
    });

    it('logs unhandled server messages once per method in verbose mode', async () => {
        const lines: string[] = [];
        const spy = vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
            lines.push(String(msg));
        });
        const harness = new LspHarness(hookServer, process.cwd(), true, { setup: answeringSetup });
        try {
            await harness.start();
            await harness.sendRequest('textDocument/hover', {});
            await harness.sendRequest('textDocument/hover', {});
        } finally {
            await harness.stop();
            spy.mockRestore();
        }
        const unhandled = lines.filter((line) => line.includes('Unhandled'));
        expect(unhandled).toEqual([
            "[lsbench] Unhandled request custom/unknown from the server, a script's setup can handle it",
            "[lsbench] Unhandled notification custom/ignored from the server, a script's setup can handle it",
        ]);
    });

    it('logs a failing notification handler without stopping the run', async () => {
        const lines: string[] = [];
        const spy = vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
            lines.push(String(msg));
        });
        const setup: SetupScript = (client) => {
            answeringSetup(client);
            client.onNotification('custom/ignored', () => {
                throw new Error('boom');
            });
        };
        const harness = new LspHarness(hookServer, process.cwd(), true, { setup });
        try {
            await harness.start();
            expect(await harness.sendRequest('textDocument/hover', {})).toEqual({ id: 2, result: null });
        } finally {
            await harness.stop();
            spy.mockRestore();
        }
        expect(lines.filter((line) => line.includes('boom'))).toEqual([
            '[lsbench] setup handler for custom/ignored failed: boom',
            '[lsbench] setup handler for custom/ignored failed: boom',
        ]);
    });
});

const closePublishServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
conn.onRequest('initialize', () => ({ capabilities: {} }));
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.onNotification('textDocument/didOpen', ({ textDocument }) => {
    conn.sendNotification('textDocument/publishDiagnostics', {
        uri: textDocument.uri,
        version: textDocument.version,
        diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'F401' }],
    });
});
conn.onNotification('textDocument/didClose', ({ textDocument }) => {
    conn.sendNotification('textDocument/publishDiagnostics', { uri: textDocument.uri, version: 1, diagnostics: [] });
});
conn.listen();
`;

const lateClosedInputServer = `
import * as fs from 'node:fs';
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
conn.onRequest('initialize', () => {
    process.stdin.destroy();
    fs.closeSync(0);
    setTimeout(() => process.exit(0), 500);
    return new Promise(() => {});
});
conn.listen();
`;

const failingStartServer = `
import * as fs from 'node:fs';
import * as rpc from 'vscode-jsonrpc/node';
const [pidFile, mode] = process.argv.slice(1);
fs.writeFileSync(pidFile, String(process.pid));
if (mode === 'exit') {
    process.exit(2);
}
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
conn.onRequest('initialize', () => {
    if (mode === 'init-error') {
        throw new Error('nope');
    }
    if (mode === 'init-null') {
        return null;
    }
    return { capabilities: {} };
});
conn.listen();
process.stdin.on('end', () => {});
setInterval(() => {}, 1000);
`;

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

describe('LspHarness failed start', () => {
    function failingHarness(mode: string, setup?: (pidFile: string) => SetupScript) {
        const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-failed-start-')), 'pid');
        const config = {
            command: process.execPath,
            args: ['--input-type=module', '-e', failingStartServer, pidFile, mode],
        };
        const harness = new LspHarness(config, process.cwd(), false, setup ? { setup: setup(pidFile) } : {});
        return { harness, pid: () => Number(fs.readFileSync(pidFile, 'utf-8')) };
    }

    it('kills the server when initialize fails', async () => {
        const { harness, pid } = failingHarness('init-error');
        await expect(harness.start()).rejects.toThrow('Request initialize failed with message: nope');
        expect(isAlive(pid())).toBe(false);
        expect(harness.exit).toMatchObject({ abnormal: false, reason: expect.stringMatching(/^killed by lsbench/) });
        const started = Date.now();
        expect(await harness.stop()).toBe(harness.exit);
        expect(Date.now() - started).toBeLessThan(100);
    });

    it('fails with invalid initialize result when initialize answers null', async () => {
        const { harness, pid } = failingHarness('init-null');
        await expect(harness.start()).rejects.toThrow('invalid initialize result: null');
        expect(isAlive(pid())).toBe(false);
        expect(harness.takeLifecycleTimings()).toContainEqual(
            expect.objectContaining({ method: 'lifecycle/initialize', success: false }),
        );
    });

    async function waitForFile(file: string): Promise<void> {
        while (!fs.existsSync(file)) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }

    const throwingSetups: Array<[string, (pidFile: string) => SetupScript]> = [
        [
            'sync',
            (pidFile) => () => {
                while (!fs.existsSync(pidFile)) {
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
                }
                throw new Error('setup boom');
            },
        ],
        [
            'async',
            (pidFile) => async () => {
                await waitForFile(pidFile);
                throw new Error('setup boom');
            },
        ],
    ];
    for (const [kind, setup] of throwingSetups) {
        it(`kills the server when a ${kind} setup throws`, async () => {
            const { harness, pid } = failingHarness('ok', setup);
            await expect(harness.start()).rejects.toThrow(/^setup boom$/);
            expect(isAlive(pid())).toBe(false);
            expect(harness.exit).toMatchObject({
                abnormal: false,
                reason: expect.stringMatching(/^killed by lsbench/),
            });
        });
    }

    it('keeps the real exit of a server that exits before initialize', async () => {
        const { harness } = failingHarness('exit');
        await expect(harness.start()).rejects.toThrow();
        expect(harness.exit).toMatchObject({ code: 2, signal: null, abnormal: true });
    });
});

describe('LspHarness start of a server exiting with stderr output', () => {
    function shellHarness(script: string) {
        return new LspHarness({ command: 'sh', args: ['-c', script] }, process.cwd(), false);
    }

    async function startError(harness: LspHarness): Promise<Error> {
        try {
            await harness.start();
        } catch (err: unknown) {
            return err as Error;
        }
        throw new Error('start did not fail');
    }

    it('keeps stderr written after the exit in the error', async () => {
        const harness = shellHarness('echo first >&2; (sleep 0.15; echo LAST >&2) & sleep 0.05; exit 1');
        const err = await startError(harness);
        expect(err.message).toBe(
            'Server exited before initialize (code=1 signal=null).\nServer stderr:\nfirst\nLAST\n',
        );
        expect(harness.exit).toMatchObject({ code: 1, abnormal: true });
    });

    it('keeps the last 4000 characters of a long trace written around the exit', async () => {
        const harness = shellHarness(
            'i=0; while [ $i -lt 300 ]; do echo "at frame $i of a long stack trace" >&2; i=$((i+1)); done; ' +
                '(sleep 0.15; echo END-OF-TRACE >&2) & sleep 0.05; exit 1',
        );
        const err = await startError(harness);
        const tail = err.message.split('\nServer stderr:\n')[1];
        expect(tail).toHaveLength(4000);
        expect(tail.endsWith('at frame 299 of a long stack trace\nEND-OF-TRACE\n')).toBe(true);
    });

    it('fails the start promptly when a grandchild keeps stderr open', async () => {
        const harness = shellHarness('echo before >&2; (sleep 5) & sleep 0.05; exit 1');
        const started = Date.now();
        const err = await startError(harness);
        expect(Date.now() - started).toBeLessThan(1000);
        expect(err.message).toBe('Server exited before initialize (code=1 signal=null).\nServer stderr:\nbefore\n');
    });

    for (const traced of [false, true]) {
        it(`rejects only the start when the initialize write fails${traced ? ' when tracing' : ''}`, async () => {
            const rejections: unknown[] = [];
            const onRejection = (reason: unknown) => rejections.push(reason);
            process.on('unhandledRejection', onRejection);
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-write-'));
            try {
                for (let i = 0; i < 5; i++) {
                    const trace = traced ? new WireTrace(path.join(dir, `trace-${i}.jsonl`)) : undefined;
                    const harness = new LspHarness(
                        { command: 'sh', args: ['-c', 'echo boom >&2; exit 1'] },
                        process.cwd(),
                        false,
                        { trace },
                    );
                    const err = await startError(harness);
                    await trace?.close();
                    expect(err.message).toBe(
                        'Server exited before initialize (code=1 signal=null).\nServer stderr:\nboom\n',
                    );
                }
                await new Promise((resolve) => setTimeout(resolve, 300));
                expect(rejections).toEqual([]);
            } finally {
                process.off('unhandledRejection', onRejection);
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    }

    it('fails the start promptly when a live server closes its input', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-closed-input-'));
        const marker = path.join(dir, 'closed');
        try {
            const harness = new LspHarness(
                { command: 'sh', args: ['-c', 'exec 0<&-; : > "$1"; sleep 5', 'sh', marker] },
                process.cwd(),
                false,
                {
                    setup: async () => {
                        while (!fs.existsSync(marker)) {
                            await new Promise((resolve) => setTimeout(resolve, 10));
                        }
                    },
                },
            );
            const started = Date.now();
            const err = await startError(harness);
            expect(Date.now() - started).toBeLessThan(2000);
            expect(err.message).toMatch(/^cannot write to server: /);
            expect(harness.exit).toMatchObject({ reason: expect.stringMatching(/^killed by lsbench/) });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('fails the start when a server that closed its input after initialize was sent exits', async () => {
        const harness = new LspHarness(
            { command: process.execPath, args: ['--input-type=module', '-e', lateClosedInputServer] },
            process.cwd(),
            false,
        );
        const err = await startError(harness);
        expect(err.message).toMatch(/^Server exited before initialize \(code=0 signal=null\)\./);
    });
});

describe('LspHarness publishes read before a reopen', () => {
    for (const traced of [false, true]) {
        it(`credits a close publish received after the reopen to the close${traced ? ' when tracing' : ''}`, async () => {
            const lines: string[] = [];
            vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
                lines.push(String(msg));
            });
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-reopen-'));
            const trace = traced ? new WireTrace(path.join(dir, 'trace.jsonl')) : undefined;
            const harness = new LspHarness(
                { command: process.execPath, args: ['--input-type=module', '-e', closePublishServer] },
                dir,
                true,
                { trace },
            );
            const uri = pathToUri(path.join(dir, 'broken.py'));
            const opened = { textDocument: { uri, languageId: 'python', version: 1, text: 'import os' } };
            const noteRead = DiagnosticsTracker.prototype.noteRead;
            let reopened = false;
            vi.spyOn(DiagnosticsTracker.prototype, 'noteRead').mockImplementation(function (
                this: DiagnosticsTracker,
                params,
            ) {
                noteRead.call(this, params);
                if (!reopened && params.diagnostics.length === 0) {
                    reopened = true;
                    harness.sendNotification('textDocument/didOpen', opened);
                }
            });
            try {
                await harness.start();
                harness.sendNotification('textDocument/didOpen', opened);
                await vi.waitFor(() => expect(harness.latestPublish(uri)?.generation).toBe(1));
                harness.sendNotification('textDocument/didClose', { textDocument: { uri } });
                await vi.waitFor(() => expect(harness.latestPublish(uri)?.generation).toBe(2));
                expect(reopened).toBe(true);
                expect(harness.latestPublish(uri)?.diagnostics).toHaveLength(1);
                const publishes = lines.filter((l) => l.includes('Publish broken.py'));
                expect(publishes).toEqual([
                    '[lsbench] Publish broken.py v=1 n=1 current: F401',
                    '[lsbench] Publish broken.py v=1 n=0 closed',
                    '[lsbench] Publish broken.py v=1 n=1 current: F401',
                ]);
            } finally {
                await harness.stop();
                await trace?.close();
                vi.restoreAllMocks();
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    }
});

describe('LspHarness workspace/diagnostic/refresh', () => {
    it('logs a refresh in verbose mode and tells the listeners', async () => {
        const lines: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
            lines.push(String(msg));
        });
        const harness = new LspHarness(
            {
                command: process.execPath,
                args: [
                    '--input-type=module',
                    '-e',
                    probeServer,
                    JSON.stringify([['workspace/diagnostic/refresh', null]]),
                ],
            },
            process.cwd(),
            true,
        );
        let refreshes = 0;
        harness.onDiagnosticRefresh(() => refreshes++);
        try {
            await harness.start();
            expect(refreshes).toBe(1);
            expect(lines).toContain('[lsbench] Server requested workspace/diagnostic/refresh');
        } finally {
            await harness.stop();
            vi.restoreAllMocks();
        }
    });
});

/** a fake server that ignores SIGTERM and never exits on its own */
const stubbornServer = `
import * as rpc from 'vscode-jsonrpc/node';
process.on('SIGTERM', () => {});
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
conn.onRequest('initialize', () => ({ capabilities: { pid: process.pid } }));
conn.onRequest('shutdown', () => null);
conn.listen();
setInterval(() => {}, 1000);
`;

/**
 * a fake server whose shutdown behavior is picked by argv: crash (exit 3 without a reply),
 * quit (exit 0 without a reply), hang, fail (reply, then exit 1 on exit) or clean
 */
const shutdownServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
const mode = process.argv[1];
conn.onRequest('initialize', () => ({ capabilities: {} }));
conn.onRequest('shutdown', () => {
    if (mode === 'crash') {
        process.exit(3);
    }
    if (mode === 'quit') {
        process.exit(0);
    }
    if (mode === 'segv-early') {
        process.kill(process.pid, 'SIGSEGV');
        return new Promise(() => {});
    }
    if (mode === 'hang') {
        return new Promise(() => {});
    }
    if (mode.startsWith('reject')) {
        return new rpc.ResponseError(-32603, 'no');
    }
    return null;
});
conn.onNotification('exit', () => {
    if (mode === 'reject-ignore') {
        return;
    }
    if (mode === 'reject-5') {
        process.exit(5);
    }
    if (mode === 'segv') {
        process.kill(process.pid, 'SIGSEGV');
        return;
    }
    process.exit(mode === 'fail' || mode === 'reject' ? 1 : 0);
});
conn.listen();
`;

function shutdownHarness(
    mode:
        | 'crash'
        | 'quit'
        | 'hang'
        | 'fail'
        | 'reject'
        | 'reject-5'
        | 'reject-ignore'
        | 'segv'
        | 'segv-early'
        | 'clean',
    allowExitCodes?: number[],
    allowExitSignals?: NodeJS.Signals[],
    allowUnrepliedShutdown?: boolean,
): LspHarness {
    return new LspHarness(
        {
            command: process.execPath,
            args: ['--input-type=module', '-e', shutdownServer, mode],
            allowExitCodes,
            allowExitSignals,
            allowUnrepliedShutdown,
        },
        process.cwd(),
    );
}

describe('LspHarness.stop', () => {
    it('sends exit after a shutdown error reply and reports the exit code', async () => {
        const harness = shutdownHarness('reject');
        await harness.start();
        const exit = await harness.stop();
        expect(exit).toMatchObject({
            code: 1,
            signal: null,
            abnormal: false,
            reason: 'exited after failed shutdown with code 1',
        });
        expect(exit?.tolerated).toBeUndefined();
        expect(harness.takeLifecycleTimings()).toContainEqual(
            expect.objectContaining({
                method: 'lifecycle/shutdown',
                success: false,
                error: 'shutdown request failed',
            }),
        );
    });

    it('kills a server that ignores exit after a shutdown error reply once the wait passes', async () => {
        const harness = shutdownHarness('reject-ignore');
        await harness.start();
        const started = Date.now();
        const exit = await harness.stop();
        expect(Date.now() - started).toBeGreaterThanOrEqual(900);
        expect(exit).toMatchObject({ signal: 'SIGTERM', abnormal: false });
        expect(exit?.reason).toMatch(/killed by lsbench/);
    });

    it('reports an unexpected exit code after a shutdown error reply as abnormal unless allowed', async () => {
        const harness = shutdownHarness('reject-5');
        await harness.start();
        expect(await harness.stop()).toMatchObject({
            code: 5,
            abnormal: true,
            reason: 'exited after failed shutdown with code 5',
        });
        const allowed = shutdownHarness('reject-5', [5]);
        await allowed.start();
        expect(await allowed.stop()).toMatchObject({
            code: 5,
            abnormal: false,
            tolerated: true,
            reason: 'exited after failed shutdown with code 5 (allowed)',
        });
    });

    it('settles and reports the exit code when the server exits on shutdown without replying', async () => {
        const harness = shutdownHarness('crash');
        await harness.start();
        const exit = await harness.stop();
        expect(exit).toMatchObject({ code: 3, signal: null, abnormal: true });
        expect(exit?.reason).toMatch(/unexpectedly \(code 3\)/);
        expect(harness.exit).toBe(exit);
    });

    it('reports a server that crashed before stop was called', async () => {
        const harness = shutdownHarness('crash');
        await harness.start();
        // crash the server out of band, by asking it to shut down directly
        harness.sendRequest('shutdown', null).catch(() => {});
        await new Promise<void>((resolve) => {
            const poll = setInterval(() => {
                if (harness.exit) {
                    clearInterval(poll);
                    resolve();
                }
            }, 10);
        });
        const exit = await harness.stop();
        expect(exit).toMatchObject({ code: 3, abnormal: true });
    });

    it('kills a server that never replies to shutdown once the timeout passes', async () => {
        const harness = shutdownHarness('hang');
        await harness.start();
        const started = Date.now();
        const exit = await harness.stop(200);
        expect(Date.now() - started).toBeLessThan(3000);
        expect(exit).toMatchObject({ signal: 'SIGTERM', abnormal: false });
    });

    it('reports a clean exit after shutdown and exit', async () => {
        const harness = shutdownHarness('clean');
        await harness.start();
        expect(await harness.stop()).toMatchObject({
            code: 0,
            signal: null,
            abnormal: false,
            reason: 'exited cleanly',
        });
    });

    it('reports a non zero exit after a replied shutdown as abnormal by default', async () => {
        const harness = shutdownHarness('fail');
        await harness.start();
        const exit = await harness.stop();
        expect(exit).toMatchObject({ code: 1, abnormal: true, reason: 'exited after shutdown with code 1' });
        expect(exit?.tolerated).toBeUndefined();
    });

    it('tolerates an allowed exit code after a replied shutdown', async () => {
        const harness = shutdownHarness('fail', [1]);
        await harness.start();
        expect(await harness.stop()).toMatchObject({
            code: 1,
            signal: null,
            abnormal: false,
            tolerated: true,
            reason: 'exited after shutdown with code 1 (allowed)',
        });
    });

    it('does not tolerate an exit code that is not allowed', async () => {
        const harness = shutdownHarness('fail', [2]);
        await harness.start();
        expect(await harness.stop()).toMatchObject({ code: 1, abnormal: true });
    });

    it('reports a signal after a replied shutdown as abnormal by default', async () => {
        const harness = shutdownHarness('segv');
        await harness.start();
        const exit = await harness.stop();
        expect(exit).toMatchObject({
            code: null,
            signal: 'SIGSEGV',
            abnormal: true,
            reason: 'exited after shutdown with signal SIGSEGV',
        });
        expect(exit?.tolerated).toBeUndefined();
    });

    it('tolerates an allowed signal after a replied shutdown', async () => {
        const harness = shutdownHarness('segv', undefined, ['SIGSEGV']);
        await harness.start();
        expect(await harness.stop()).toMatchObject({
            code: null,
            signal: 'SIGSEGV',
            abnormal: false,
            tolerated: true,
            reason: 'exited after shutdown with signal SIGSEGV (allowed)',
        });
    });

    it('does not tolerate a signal that is not allowed', async () => {
        const harness = shutdownHarness('segv', [1], ['SIGABRT']);
        await harness.start();
        const exit = await harness.stop();
        expect(exit).toMatchObject({ signal: 'SIGSEGV', abnormal: true });
        expect(exit?.tolerated).toBeUndefined();
    });

    it('keeps a signal without a shutdown reply abnormal even when it is allowed', async () => {
        const harness = shutdownHarness('segv-early', undefined, ['SIGSEGV']);
        await harness.start();
        const exit = await harness.stop();
        expect(exit).toMatchObject({ signal: 'SIGSEGV', abnormal: true });
        expect(exit?.tolerated).toBeUndefined();
        expect(exit?.reason).toMatch(/unexpectedly \(signal SIGSEGV\)/);
    });

    for (const [mode, code] of [
        ['quit', 0],
        ['crash', 3],
    ] as const) {
        it(`keeps an exit without a shutdown reply abnormal even when code ${code} is allowed`, async () => {
            const harness = shutdownHarness(mode, [0, 1, 3]);
            await harness.start();
            const exit = await harness.stop();
            expect(exit).toMatchObject({ code, abnormal: true });
            expect(exit?.tolerated).toBeUndefined();
            expect(exit?.reason).toMatch(/unexpectedly/);
        });
    }

    it('tolerates an exit with code 0 after an unreplied shutdown when allowed', async () => {
        const harness = shutdownHarness('quit', undefined, undefined, true);
        await harness.start();
        harness.takeLifecycleTimings();
        expect(await harness.stop()).toMatchObject({
            code: 0,
            signal: null,
            abnormal: false,
            tolerated: true,
            reason: 'exited after unreplied shutdown with code 0 (allowed)',
        });
        const [shutdown, ...rest] = harness.takeLifecycleTimings();
        expect(rest).toEqual([]);
        expect(shutdown).toMatchObject({ method: 'lifecycle/shutdown', success: true, result: 'ok' });
        expect(shutdown.error).toBeUndefined();
    });

    it('keeps an exit with code 0 after an unreplied shutdown abnormal without the flag', async () => {
        const harness = shutdownHarness('quit');
        await harness.start();
        harness.takeLifecycleTimings();
        const exit = await harness.stop();
        expect(exit).toMatchObject({ code: 0, abnormal: true, reason: 'exited unexpectedly (code 0)' });
        expect(exit?.tolerated).toBeUndefined();
        expect(harness.takeLifecycleTimings()).toEqual([
            expect.objectContaining({ method: 'lifecycle/shutdown', success: false }),
        ]);
    });

    it('tolerates a non zero code after an unreplied shutdown only when the code is allowed', async () => {
        const denied = shutdownHarness('crash', undefined, undefined, true);
        await denied.start();
        const deniedExit = await denied.stop();
        expect(deniedExit).toMatchObject({ code: 3, abnormal: true, reason: 'exited unexpectedly (code 3)' });
        expect(deniedExit?.tolerated).toBeUndefined();

        const allowed = shutdownHarness('crash', [3], undefined, true);
        await allowed.start();
        expect(await allowed.stop()).toMatchObject({
            code: 3,
            abnormal: false,
            tolerated: true,
            reason: 'exited after unreplied shutdown with code 3 (allowed)',
        });
    });

    it('tolerates a signal after an unreplied shutdown only when the signal is allowed', async () => {
        const denied = shutdownHarness('segv-early', undefined, undefined, true);
        await denied.start();
        const deniedExit = await denied.stop();
        expect(deniedExit).toMatchObject({ signal: 'SIGSEGV', abnormal: true });
        expect(deniedExit?.tolerated).toBeUndefined();

        const allowed = shutdownHarness('segv-early', undefined, ['SIGSEGV'], true);
        await allowed.start();
        expect(await allowed.stop()).toMatchObject({
            code: null,
            signal: 'SIGSEGV',
            abnormal: false,
            tolerated: true,
            reason: 'exited after unreplied shutdown with signal SIGSEGV (allowed)',
        });
    });

    it('keeps an exit before stop sent shutdown abnormal even with the flag', async () => {
        const harness = shutdownHarness('quit', undefined, undefined, true);
        await harness.start();
        harness.sendRequest('shutdown', null).catch(() => {});
        await new Promise<void>((resolve) => {
            const poll = setInterval(() => {
                if (harness.exit) {
                    clearInterval(poll);
                    resolve();
                }
            }, 10);
        });
        const exit = await harness.stop();
        expect(exit).toMatchObject({ code: 0, abnormal: true, reason: 'exited unexpectedly (code 0)' });
        expect(exit?.tolerated).toBeUndefined();
    });

    it('records spawn, initialize and shutdown timings', async () => {
        const harness = shutdownHarness('clean');
        await harness.start();
        const startTimings = harness.takeLifecycleTimings();
        expect(startTimings.map((t) => [t.method, t.success, t.result])).toEqual([
            ['lifecycle/spawn', true, 'ok'],
            ['lifecycle/initialize', true, 'ok'],
        ]);
        expect(harness.takeLifecycleTimings()).toEqual([]);
        await harness.stop();
        const [shutdown, ...rest] = harness.takeLifecycleTimings();
        expect(rest).toEqual([]);
        // shutdown replies null by spec, which is still a plain ok for a lifecycle step
        expect(shutdown).toMatchObject({ method: 'lifecycle/shutdown', success: true, result: 'ok' });
        expect(shutdown.duration_ms).toBeGreaterThan(0);
    });

    it('records a failed shutdown timing when the server never replies', async () => {
        const crash = shutdownHarness('crash');
        await crash.start();
        crash.takeLifecycleTimings();
        await crash.stop();
        expect(crash.takeLifecycleTimings()).toEqual([
            expect.objectContaining({
                method: 'lifecycle/shutdown',
                success: false,
                result: 'error',
                error: expect.stringMatching(/exited before replying/),
            }),
        ]);

        const hang = shutdownHarness('hang');
        await hang.start();
        hang.takeLifecycleTimings();
        await hang.stop(200);
        expect(hang.takeLifecycleTimings()).toEqual([
            expect.objectContaining({
                method: 'lifecycle/shutdown',
                success: false,
                error: 'no shutdown reply within 200ms',
            }),
        ]);
    });

    it('records a failed spawn timing when the command does not exist', async () => {
        const harness = new LspHarness({ command: 'lsbench-no-such-server' }, process.cwd());
        await expect(harness.start()).rejects.toThrow(/failed to spawn/);
        expect(harness.takeLifecycleTimings()).toEqual([
            expect.objectContaining({
                method: 'lifecycle/spawn',
                success: false,
                result: 'error',
                error: expect.stringMatching(/ENOENT/),
            }),
        ]);
    });

    it('force kills a server that ignores SIGTERM', async () => {
        const harness = new LspHarness(
            { command: process.execPath, args: ['--input-type=module', '-e', stubbornServer] },
            process.cwd(),
        );
        await harness.start();
        const pid = harness.capabilities?.pid as number;
        await harness.stop();

        // signal 0 only probes for existence, and throws once the process is gone
        let alive = true;
        try {
            process.kill(pid, 0);
        } catch {
            alive = false;
        }
        if (alive) {
            process.kill(pid, 'SIGKILL');
        }
        expect(alive).toBe(false);
    });

    it('gives up on a server that survives SIGKILL and records the exit as abnormal', async () => {
        const harness = new LspHarness(
            { command: process.execPath, args: ['--input-type=module', '-e', stubbornServer] },
            process.cwd(),
        );
        await harness.start();
        const pid = harness.capabilities?.pid as number;
        const child = (harness as unknown as { process: import('node:child_process').ChildProcess }).process;
        const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
        try {
            const started = Date.now();
            const exit = await harness.stop(100);
            expect(Date.now() - started).toBeLessThan(9000);
            expect(kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
            expect(exit).toEqual({ code: null, signal: null, abnormal: true, reason: 'did not exit after SIGKILL' });

            const exited = new Promise((resolve) => child.once('exit', resolve));
            process.kill(pid, 'SIGKILL');
            await exited;
            expect(harness.exit).toEqual(exit);
        } finally {
            kill.mockRestore();
            try {
                process.kill(pid, 'SIGKILL');
            } catch {}
        }
    }, 15000);
});

/**
 * A fake server advertising the textDocumentSync capability given in argv, which on
 * request forwards client/registerCapability or client/unregisterCapability to the client.
 */
const syncServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
const sync = JSON.parse(process.argv[1]);
conn.onRequest('initialize', () => ({ capabilities: sync === null ? {} : { textDocumentSync: sync } }));
conn.onRequest('test/forward', ([method, params]) => conn.sendRequest(method, params));
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
`;

/** a fake server that holds hover requests and exits 5 shortly after receiving one */
const crashOnHoverServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
conn.onRequest('initialize', () => ({ capabilities: { hoverProvider: true } }));
conn.onRequest('textDocument/hover', () => {
    setTimeout(() => process.exit(5), 50);
    return new Promise(() => {});
});
conn.onRequest('shutdown', () => null);
conn.listen();
`;

const cancelServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
const state = { started: [], cancelled: [] };
conn.onRequest('initialize', () => ({ capabilities: {} }));
conn.onRequest('test/hang', (params, token) => {
    state.started.push(params.n);
    token.onCancellationRequested(() => state.cancelled.push(params.n));
    return new Promise(() => {});
});
conn.onRequest('test/state', () => state);
conn.onRequest('shutdown', () => null);
conn.listen();
`;

describe('LspHarness.sendRequest with a cancellation token', () => {
    it('sends $/cancelRequest and rejects at once when the token is cancelled', async () => {
        const harness = new LspHarness(
            { command: process.execPath, args: ['--input-type=module', '-e', cancelServer] },
            process.cwd(),
        );
        await harness.start();
        try {
            const poll = async (done: (state: { started: number[]; cancelled: number[] }) => boolean) => {
                for (let attempt = 0; attempt < 100; attempt++) {
                    const state = await harness.sendRequest<{ started: number[]; cancelled: number[] }>(
                        'test/state',
                        {},
                    );
                    if (done(state)) {
                        return state;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                throw new Error('server state never matched');
            };

            const source = new rpc.CancellationTokenSource();
            const hang = harness.sendRequest('test/hang', { n: 1 }, source.token);
            await poll((state) => state.started.includes(1));
            source.cancel();
            await expect(hang).rejects.toThrow('test/hang cancelled');
            expect((await poll((state) => state.cancelled.includes(1))).cancelled).toEqual([1]);

            const done = new rpc.CancellationTokenSource();
            done.cancel();
            await expect(harness.sendRequest('test/hang', { n: 2 }, done.token)).rejects.toThrow('test/hang cancelled');
        } finally {
            await harness.stop(500);
        }
    });
});

function crashOnHoverHarness(): LspHarness {
    return new LspHarness(
        { command: process.execPath, args: ['--input-type=module', '-e', crashOnHoverServer] },
        process.cwd(),
    );
}

describe('LspHarness with a server exiting while a request is pending', () => {
    it('rejects the pending request, fails later requests and notifications fast, and still stops', async () => {
        const harness = crashOnHoverHarness();
        await harness.start();
        const started = Date.now();
        await expect(harness.sendRequest('textDocument/hover', {})).rejects.toThrow(
            /server exited unexpectedly \(code 5\)/,
        );
        expect(Date.now() - started).toBeLessThan(2000);
        expect(harness.exit).toMatchObject({ code: 5, abnormal: true });

        await expect(harness.sendRequest('textDocument/hover', {})).rejects.toThrow(/server exited/);
        expect(() => harness.sendNotification('textDocument/didOpen', {})).toThrow(
            /cannot send textDocument\/didOpen: server exited/,
        );

        const exit = await harness.stop(500);
        expect(exit).toMatchObject({ code: 5, signal: null, abnormal: true });
        expect(exit?.reason).toMatch(/unexpectedly \(code 5\)/);
        // no shutdown request is sent to a server already gone
        expect(harness.takeLifecycleTimings().map((t) => t.method)).toEqual([
            'lifecycle/spawn',
            'lifecycle/initialize',
        ]);
    });

    it('records the timed request as an error and lets the script go on failing fast', async () => {
        const harness = crashOnHoverHarness();
        await harness.start();
        try {
            const ctx = new BenchContextImpl(harness, process.cwd());
            expect(await ctx.request('textDocument/hover', {})).toBeNull();
            expect(await ctx.request('textDocument/hover', {})).toBeNull();
            const timings = ctx.collectTimings();
            expect(timings).toHaveLength(2);
            for (const timing of timings) {
                expect(timing).toMatchObject({ method: 'textDocument/hover', success: false, result: 'error' });
                expect(timing.error).toMatch(/server exited unexpectedly \(code 5\)/);
            }
            // resetting documents after the crash does not throw
            await ctx.resetDocuments();
        } finally {
            expect(await harness.stop(500)).toMatchObject({ code: 5, abnormal: true });
        }
    });
});

async function withSyncServer(sync: unknown, body: (harness: LspHarness) => Promise<void>): Promise<void> {
    const harness = new LspHarness(
        {
            command: process.execPath,
            args: ['--input-type=module', '-e', syncServer, JSON.stringify(sync)],
        },
        process.cwd(),
    );
    try {
        await harness.start();
        await body(harness);
    } finally {
        await harness.stop();
    }
}

describe('LspHarness.saveSyncOptions', () => {
    const none = { didSave: false, includeText: false, willSave: false, willSaveWaitUntil: false };

    const staticCases: Array<[string, unknown, typeof none]> = [
        ['no textDocumentSync', null, none],
        ['a bare TextDocumentSyncKind wants didSave without text', 2, { ...none, didSave: true }],
        ['save: false', { change: 2, save: false }, none],
        ['save: true', { save: true }, { ...none, didSave: true }],
        ['save: {} without includeText', { save: {} }, { ...none, didSave: true }],
        ['save: { includeText: true }', { save: { includeText: true } }, { ...none, didSave: true, includeText: true }],
        [
            'willSave and willSaveWaitUntil',
            { willSave: true, willSaveWaitUntil: true },
            { ...none, willSave: true, willSaveWaitUntil: true },
        ],
    ];

    for (const [name, sync, expected] of staticCases) {
        it(`reads the static capability: ${name}`, async () => {
            await withSyncServer(sync, async (harness) => {
                expect(harness.saveSyncOptions()).toEqual(expected);
            });
        });
    }

    it('merges dynamic registrations and drops them on unregister', async () => {
        await withSyncServer({ change: 2, save: false }, async (harness) => {
            await harness.sendRequest('test/forward', [
                'client/registerCapability',
                {
                    registrations: [
                        { id: 'save', method: 'textDocument/didSave', registerOptions: { includeText: true } },
                        { id: 'will', method: 'textDocument/willSave', registerOptions: {} },
                        { id: 'until', method: 'textDocument/willSaveWaitUntil' },
                        { id: 'hover', method: 'textDocument/hover' },
                    ],
                },
            ]);
            expect(harness.saveSyncOptions()).toEqual({
                didSave: true,
                includeText: true,
                willSave: true,
                willSaveWaitUntil: true,
            });

            await harness.sendRequest('test/forward', [
                'client/unregisterCapability',
                {
                    unregisterations: [
                        { id: 'save', method: 'textDocument/didSave' },
                        { id: 'until', method: 'textDocument/willSaveWaitUntil' },
                    ],
                },
            ]);
            expect(harness.saveSyncOptions()).toEqual({ ...none, willSave: true });
        });
    });

    it('tracks every dynamic registration, not only save related ones', async () => {
        await withSyncServer(null, async (harness) => {
            expect(harness.capabilities).toEqual({});
            const hover = { id: 'hover', method: 'textDocument/hover', registerOptions: { documentSelector: [] } };
            await harness.sendRequest('test/forward', [
                'client/registerCapability',
                { registrations: [hover, { id: 'save', method: 'textDocument/didSave' }] },
            ]);
            expect(harness.registrations.map((r) => r.id)).toEqual(['hover', 'save']);
            expect(harness.registrations[0]).toEqual(hover);

            await harness.sendRequest('test/forward', [
                'client/unregisterCapability',
                { unregisterations: [{ id: 'hover', method: 'textDocument/hover' }] },
            ]);
            expect(harness.registrations.map((r) => r.id)).toEqual(['save']);
        });
    });
});

describe('LspHarness.changeSyncKind', () => {
    it('assumes incremental sync before initialize', () => {
        expect(new LspHarness({ command: process.execPath }, process.cwd()).changeSyncKind()).toBe(2);
    });

    const staticCases: Array<[string, unknown, number]> = [
        ['no textDocumentSync', null, 2],
        ['a bare None', 0, 0],
        ['a bare Full', 1, 1],
        ['a bare Incremental', 2, 2],
        ['change: 1', { change: 1, save: true }, 1],
        ['change: 0', { change: 0 }, 0],
        ['an object without change', { openClose: true }, 2],
        ['an unknown kind', 7, 2],
    ];

    for (const [name, sync, expected] of staticCases) {
        it(`reads the static capability: ${name}`, async () => {
            await withSyncServer(sync, async (harness) => {
                expect(harness.changeSyncKind()).toBe(expected);
            });
        });
    }

    it('lets dynamic didChange registrations override the static kind, the most demanding first', async () => {
        await withSyncServer(2, async (harness) => {
            await harness.sendRequest('test/forward', [
                'client/registerCapability',
                {
                    registrations: [
                        { id: 'none', method: 'textDocument/didChange', registerOptions: { syncKind: 0 } },
                        { id: 'hover', method: 'textDocument/hover' },
                    ],
                },
            ]);
            expect(harness.changeSyncKind()).toBe(0);

            await harness.sendRequest('test/forward', [
                'client/registerCapability',
                {
                    registrations: [
                        { id: 'full', method: 'textDocument/didChange', registerOptions: { syncKind: 1 } },
                        { id: 'incr', method: 'textDocument/didChange', registerOptions: { syncKind: 2 } },
                    ],
                },
            ]);
            expect(harness.changeSyncKind()).toBe(1);

            await harness.sendRequest('test/forward', [
                'client/unregisterCapability',
                {
                    unregisterations: [
                        { id: 'full', method: 'textDocument/didChange' },
                        { id: 'none', method: 'textDocument/didChange' },
                    ],
                },
            ]);
            expect(harness.changeSyncKind()).toBe(2);

            await harness.sendRequest('test/forward', [
                'client/unregisterCapability',
                { unregisterations: [{ id: 'incr', method: 'textDocument/didChange' }] },
            ]);
            expect(harness.changeSyncKind()).toBe(2);
        });
    });
});

describe('mergeCapabilities', () => {
    it('merges nested objects recursively', () => {
        const merged = mergeCapabilities(
            { workspace: { configuration: true, symbol: { dynamicRegistration: true } } },
            { workspace: { symbol: { resolveSupport: { properties: ['x'] } } } },
        );
        expect(merged).toEqual({
            workspace: {
                configuration: true,
                symbol: { dynamicRegistration: true, resolveSupport: { properties: ['x'] } },
            },
        });
    });

    it('replaces arrays and scalars instead of merging them', () => {
        const merged = mergeCapabilities(
            { hover: { contentFormat: ['markdown', 'plaintext'], dynamicRegistration: true } },
            { hover: { contentFormat: ['plaintext'], dynamicRegistration: false } },
        );
        expect(merged).toEqual({ hover: { contentFormat: ['plaintext'], dynamicRegistration: false } });
    });

    it('lets an override replace an object with a scalar and the reverse', () => {
        const merged = mergeCapabilities({ a: { b: 1 }, c: true }, { a: false, c: { d: 2 } });
        expect(merged).toEqual({ a: false, c: { d: 2 } });
    });

    it('does not mutate its inputs', () => {
        const base = { a: { b: 1 } };
        const override = { a: { c: 2 } };
        mergeCapabilities(base, override);
        expect(base).toEqual({ a: { b: 1 } });
        expect(override).toEqual({ a: { c: 2 } });
    });
});

describe('defaultClientCapabilities', () => {
    it('advertises dynamic file watching with relative patterns', () => {
        const workspace = defaultClientCapabilities().workspace as Record<string, unknown>;
        expect(workspace.didChangeWatchedFiles).toEqual({ dynamicRegistration: true, relativePatternSupport: true });
    });

    it('advertises work done progress and the rust-analyzer server status', () => {
        const caps = defaultClientCapabilities();
        expect(caps.window).toEqual({ workDoneProgress: true });
        expect(caps.experimental).toEqual({ serverStatusNotification: true });
    });

    it('does not advertise pull diagnostics, so servers supporting both keep pushing', () => {
        const textDocument = defaultClientCapabilities().textDocument as Record<string, unknown>;
        expect(textDocument.diagnostic).toBeUndefined();
        expect(textDocument.publishDiagnostics).toBeDefined();
    });

    it('advertises diagnostics refresh support, which lsbench handles', () => {
        const workspace = defaultClientCapabilities().workspace as Record<string, unknown>;
        expect(workspace.diagnostics).toEqual({ refreshSupport: true });
    });
});

describe('pullDiagnosticClientCapabilities', () => {
    it('is the textDocument.diagnostic capability without dynamic registration or related documents', () => {
        expect(pullDiagnosticClientCapabilities()).toEqual({
            textDocument: { diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false } },
        });
    });
});

/** a fake server that echoes the client capabilities and registers a file watcher */
const echoCapabilitiesServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
conn.onRequest('initialize', (params) => ({ capabilities: { received: params.capabilities } }));
conn.onNotification('initialized', async () => {
    await conn.sendRequest('client/registerCapability', {
        registrations: [
            {
                id: 'watch-1',
                method: 'workspace/didChangeWatchedFiles',
                registerOptions: { watchers: [{ globPattern: '**/*.ts' }] },
            },
        ],
    });
});
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
`;

describe('LspHarness client capabilities', () => {
    function echoHarness(clientCapabilities?: Record<string, unknown>, advertisePullDiagnostics?: boolean): LspHarness {
        return new LspHarness(
            {
                command: process.execPath,
                args: ['--input-type=module', '-e', echoCapabilitiesServer],
                clientCapabilities,
                advertisePullDiagnostics,
            },
            process.cwd(),
        );
    }

    it('sends the defaults when no capabilities are configured', async () => {
        const harness = echoHarness();
        try {
            await harness.start();
            expect(harness.capabilities?.received).toEqual(defaultClientCapabilities());
        } finally {
            await harness.stop();
        }
    });

    it('sends the configured capabilities deep merged over the defaults', async () => {
        const harness = echoHarness({
            workspace: { didChangeWatchedFiles: { relativePatternSupport: false } },
            textDocument: { hover: { contentFormat: ['plaintext'] } },
            experimental: { custom: true },
        });
        try {
            await harness.start();
            const received = harness.capabilities?.received as Record<string, Record<string, Record<string, unknown>>>;
            expect(received.workspace.didChangeWatchedFiles).toEqual({
                dynamicRegistration: true,
                relativePatternSupport: false,
            });
            expect(received.workspace.configuration).toBe(true);
            expect(received.textDocument.hover).toEqual({ dynamicRegistration: true, contentFormat: ['plaintext'] });
            expect(received.textDocument.completion).toEqual(
                (defaultClientCapabilities().textDocument as Record<string, unknown>).completion,
            );
            expect(received.experimental).toEqual({ serverStatusNotification: true, custom: true });
        } finally {
            await harness.stop();
        }
    });

    it('advertises pull diagnostics over the defaults when opted in', async () => {
        const harness = echoHarness(undefined, true);
        try {
            await harness.start();
            const received = harness.capabilities?.received as Record<string, Record<string, unknown>>;
            expect(received.textDocument.diagnostic).toEqual({
                dynamicRegistration: false,
                relatedDocumentSupport: false,
            });
            expect(received.textDocument.publishDiagnostics).toBeDefined();
            expect(received.workspace.diagnostics).toEqual({ refreshSupport: true });
        } finally {
            await harness.stop();
        }
    });

    it('lets the configured capabilities override the opted in pull capability', async () => {
        const harness = echoHarness({ textDocument: { diagnostic: { relatedDocumentSupport: true } } }, true);
        try {
            await harness.start();
            const received = harness.capabilities?.received as Record<string, Record<string, unknown>>;
            expect(received.textDocument.diagnostic).toEqual({
                dynamicRegistration: false,
                relatedDocumentSupport: true,
            });
        } finally {
            await harness.stop();
        }
    });

    it('accepts and tracks file watcher registrations', async () => {
        const harness = echoHarness();
        try {
            await harness.start();
            await expect
                .poll(() => harness.registrations.map((r) => r.method))
                .toEqual(['workspace/didChangeWatchedFiles']);
        } finally {
            await harness.stop();
        }
    });
});

describe('expandSettings', () => {
    it('expands dotted keys into nested objects', () => {
        expect(expandSettings({ 'html.format.enable': true, 'js/ts': { checkJs: true } })).toEqual({
            html: { format: { enable: true } },
            'js/ts': { checkJs: true },
        });
    });

    it('expands dotted keys below nested objects', () => {
        expect(expandSettings({ json: { 'schemas.enable': false } })).toEqual({ json: { schemas: { enable: false } } });
    });

    it('deep merges dotted keys with nested objects at the same path', () => {
        expect(
            expandSettings({
                html: { format: { enable: true }, suggest: { html5: true } },
                'html.format': { wrapLineLength: 80 },
                'html.validate.scripts': false,
            }),
        ).toEqual({
            html: {
                format: { enable: true, wrapLineLength: 80 },
                suggest: { html5: true },
                validate: { scripts: false },
            },
        });
    });

    it('lets a key without dots win a conflict over a dotted one, regardless of order', () => {
        expect(expandSettings({ a: { b: 'nested' }, 'a.b': 'flat' })).toEqual({ a: { b: 'nested' } });
        expect(expandSettings({ 'a.b': 'flat', a: { b: 'nested' } })).toEqual({ a: { b: 'nested' } });
        expect(expandSettings({ 'a.b': 1, a: 2 })).toEqual({ a: 2 });
    });

    it('keeps the keys of language override sections flat', () => {
        expect(expandSettings({ '[yaml]': { 'editor.tabSize': 2 } })).toEqual({ '[yaml]': { 'editor.tabSize': 2 } });
        expect(expandSettings({ '[javascript][typescript]': { 'editor.tabSize': 4 } })).toEqual({
            '[javascript][typescript]': { 'editor.tabSize': 4 },
        });
    });

    it('splits a dotted key after a language override section and keeps the rest flat', () => {
        expect(expandSettings({ '[yaml].editor.tabSize': 2 })).toEqual({ '[yaml]': { 'editor.tabSize': 2 } });
    });

    it('expands other sections next to a language override section', () => {
        expect(expandSettings({ '[yaml]': { 'editor.tabSize': 2 }, 'yaml.format.enable': true })).toEqual({
            '[yaml]': { 'editor.tabSize': 2 },
            yaml: { format: { enable: true } },
        });
    });

    it('merges language override keys flat, letting the plain section win', () => {
        expect(
            expandSettings({
                '[yaml]': { 'editor.tabSize': 2, 'editor.insertSpaces': true },
                '[yaml].editor.tabSize': 4,
                '[yaml].editor.wordWrap': 'on',
            }),
        ).toEqual({ '[yaml]': { 'editor.tabSize': 2, 'editor.insertSpaces': true, 'editor.wordWrap': 'on' } });
    });

    it('expands bracketed keys below the top level', () => {
        expect(expandSettings({ foo: { '[bar]': { 'a.b': 1 } } })).toEqual({ foo: { '[bar]': { a: { b: 1 } } } });
    });

    it('does not mutate the input', () => {
        const settings = {
            html: { format: { enable: true } },
            'html.format': { wrapLineLength: 80 },
            '[yaml]': { 'editor.tabSize': 2 },
            '[yaml].editor.insertSpaces': true,
        };
        const copy = structuredClone(settings);
        expandSettings(settings);
        expect(settings).toEqual(copy);
    });
});

describe('resolveConfigurationSection', () => {
    const settings = expandSettings({
        html: { format: { enable: true }, suggest: { html5: true } },
        'js/ts': { implicitProjectConfig: { checkJs: true } },
        'css.lint': { emptyRules: 'warning' },
        '[yaml]': { 'editor.tabSize': 2 },
        'yaml.format.enable': true,
        off: null,
    });

    it('resolves a language override section to its flat keys', () => {
        expect(resolveConfigurationSection(settings, '[yaml]')).toEqual({ 'editor.tabSize': 2 });
        expect(resolveConfigurationSection(settings, 'yaml')).toEqual({ format: { enable: true } });
    });

    it('resolves a dotted path into nested objects', () => {
        expect(resolveConfigurationSection(settings, 'html')).toEqual({
            format: { enable: true },
            suggest: { html5: true },
        });
        expect(resolveConfigurationSection(settings, 'html.format')).toEqual({ enable: true });
        expect(resolveConfigurationSection(settings, 'html.format.enable')).toBe(true);
    });

    it('resolves section keys without dots as a single key', () => {
        expect(resolveConfigurationSection(settings, 'js/ts')).toEqual({ implicitProjectConfig: { checkJs: true } });
        expect(resolveConfigurationSection(settings, 'js/ts.implicitProjectConfig.checkJs')).toBe(true);
    });

    it('resolves sections given as flat dotted keys, and their parents', () => {
        expect(resolveConfigurationSection(settings, 'css.lint')).toEqual({ emptyRules: 'warning' });
        expect(resolveConfigurationSection(settings, 'css')).toEqual({ lint: { emptyRules: 'warning' } });
    });

    it('returns null for unknown sections', () => {
        expect(resolveConfigurationSection(settings, 'python')).toBeNull();
        expect(resolveConfigurationSection(settings, 'html.missing')).toBeNull();
        expect(resolveConfigurationSection(settings, 'html.format.enable.deeper')).toBeNull();
        expect(resolveConfigurationSection(settings, 'off')).toBeNull();
        expect(resolveConfigurationSection(settings, 'toString')).toBeNull();
    });

    it('returns the whole settings without a section', () => {
        expect(resolveConfigurationSection(settings)).toBe(settings);
        expect(resolveConfigurationSection(settings, null)).toBe(settings);
        expect(resolveConfigurationSection(settings, '')).toBe(settings);
    });
});

/**
 * A fake server that, after initialized, requests the configuration items given in
 * argv and records any didChangeConfiguration, both reported back by test/dump.
 */
const settingsServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
const items = JSON.parse(process.argv[1]);
const dump = { configuration: undefined, didChangeConfiguration: [] };
conn.onRequest('initialize', () => ({ capabilities: {} }));
conn.onNotification('initialized', async () => {
    dump.configuration = await conn.sendRequest('workspace/configuration', { items });
});
conn.onNotification('workspace/didChangeConfiguration', (params) => {
    dump.didChangeConfiguration.push(params);
});
conn.onRequest('test/dump', () => dump);
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
`;

describe('LspHarness settings', () => {
    const items = [{ section: 'html.format' }, { section: 'html' }, { section: 'js/ts' }, { section: 'python' }, {}];

    interface SettingsDump {
        configuration?: unknown[];
        didChangeConfiguration: unknown[];
    }

    async function dumpWith(settings?: Record<string, unknown>, verbose = false): Promise<SettingsDump> {
        const harness = new LspHarness(
            {
                command: process.execPath,
                args: ['--input-type=module', '-e', settingsServer, JSON.stringify(items)],
                settings,
            },
            process.cwd(),
            verbose,
        );
        try {
            await harness.start();
            let dump: SettingsDump = { didChangeConfiguration: [] };
            await expect
                .poll(async () => {
                    dump = await harness.sendRequest<SettingsDump>('test/dump', null);
                    return dump.configuration !== undefined;
                })
                .toBe(true);
            return dump;
        } finally {
            await harness.stop();
        }
    }

    it('answers an empty object per item and sends no didChangeConfiguration without settings', async () => {
        const dump = await dumpWith();
        expect(dump.configuration).toEqual([{}, {}, {}, {}, {}]);
        expect(dump.didChangeConfiguration).toEqual([]);
    });

    it('resolves each item section and sends the expanded settings once after initialized', async () => {
        const expanded = {
            html: { format: { enable: true }, suggest: { html5: true } },
            'js/ts': { implicitProjectConfig: { checkJs: true } },
        };
        const dump = await dumpWith({
            'html.format.enable': true,
            html: { suggest: { html5: true } },
            'js/ts': { implicitProjectConfig: { checkJs: true } },
        });
        expect(dump.configuration).toEqual([{ enable: true }, expanded.html, expanded['js/ts'], null, expanded]);
        expect(dump.didChangeConfiguration).toEqual([{ settings: expanded }]);
    });

    it('logs the expanded settings sent with didChangeConfiguration in verbose mode', async () => {
        const lines: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
            lines.push(String(msg));
        });
        try {
            await dumpWith({ 'json.format.enable': true }, true);
            await dumpWith(undefined, true);
        } finally {
            vi.restoreAllMocks();
        }
        const sent = lines.filter((line) => line.startsWith('[lsbench] Sending workspace/'));
        expect(sent).toEqual([
            '[lsbench] Sending workspace/didChangeConfiguration: {"json":{"format":{"enable":true}}}',
        ]);
    });
});

async function firstPublish(
    tracker: DiagnosticsTracker,
    uri: string,
    accept: (publish: DiagnosticsPublish) => boolean,
    timeoutMs: number,
): Promise<DiagnosticsPublish | undefined> {
    const result = await tracker.waitForPublishes(uri, accept, { timeoutMs });
    return result.timedOut ? undefined : result.publish;
}

describe('DiagnosticsTracker', () => {
    const uri = 'file:///w/a.ts';
    const open = (version = 1) => ({ textDocument: { uri, languageId: 'typescript', version, text: '' } });

    it('takes a publish without a diagnostics array as empty and warns once', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const tracker = new DiagnosticsTracker();
            tracker.noteNotification('textDocument/didOpen', open());
            const wait = firstPublish(tracker, uri, () => true, 1000);
            const malformed = { uri } as unknown as Parameters<DiagnosticsTracker['receive']>[0];
            expect(tracker.receive(malformed)).toMatchObject({ uri, diagnostics: [] });
            expect((await wait)?.diagnostics).toEqual([]);
            tracker.receive({ uri: 'file:///w/b.ts' } as unknown as Parameters<DiagnosticsTracker['receive']>[0]);
            expect(error.mock.calls).toEqual([
                [`[lsbench] Warning: publishDiagnostics for ${uri} has no diagnostics array, taken as empty`],
            ]);
        } finally {
            error.mockRestore();
        }
    });

    it('bumps the generation on each didOpen and stamps publishes with it', () => {
        const tracker = new DiagnosticsTracker();
        tracker.noteNotification('textDocument/didOpen', open());
        expect(tracker.receive({ uri, diagnostics: [{ range: {}, message: 'a' }] }).generation).toBe(1);
        tracker.noteNotification('textDocument/didClose', { textDocument: { uri } });
        tracker.noteNotification('textDocument/didOpen', open());
        expect(tracker.document(uri)).toMatchObject({ generation: 2, open: true, version: 1 });
    });

    it('marks empty publishes while the server is not quiescent as placeholders, trusted once it is', () => {
        const tracker = new DiagnosticsTracker();
        const progress = new ProgressTracker();
        linkPlaceholders(tracker, progress);
        tracker.noteNotification('textDocument/didOpen', open());
        // $/progress alone does not make a placeholder
        progress.progress({ token: 't', value: { kind: 'begin', title: 'indexing' } });
        expect(tracker.receive({ uri, version: 1, diagnostics: [] }).placeholder).toBeUndefined();
        tracker.clear();
        tracker.noteNotification('textDocument/didOpen', open());
        progress.serverStatusChanged({ quiescent: false });
        expect(tracker.receive({ uri: 'file:///w/other.ts', diagnostics: [] }).placeholder).toBeUndefined();
        expect(tracker.receive({ uri, version: 1, diagnostics: [{ range: {}, message: 'a' }] }).placeholder).toBe(
            undefined,
        );
        tracker.clear();
        tracker.noteNotification('textDocument/didOpen', open());
        const placeholder = tracker.receive({ uri, version: 1, diagnostics: [] });
        expect(placeholder.placeholder).toBe(true);
        // a placeholder does not teach push
        expect(tracker.delivery).toBe('unknown');
        expect(placeholder.trustedAt).toBeUndefined();
        progress.serverStatusChanged({ quiescent: true });
        expect(typeof placeholder.trustedAt).toBe('bigint');
    });

    it('tracks versions from didChange and keeps publish versions', () => {
        const tracker = new DiagnosticsTracker();
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.noteNotification('textDocument/didChange', { textDocument: { uri, version: 4 }, contentChanges: [] });
        expect(tracker.document(uri)?.version).toBe(4);
        const publish = tracker.receive({ uri, version: 4, diagnostics: [] });
        expect(publish.version).toBe(4);
        expect(publish.seq).toBeGreaterThan(tracker.document(uri)?.syncSeq ?? Infinity);
        expect(typeof publish.receivedAt).toBe('bigint');
    });

    it('records which notification last synced the document', () => {
        const tracker = new DiagnosticsTracker();
        tracker.noteNotification('textDocument/didOpen', open());
        expect(tracker.document(uri)?.syncedBy).toBe('didOpen');
        tracker.noteNotification('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [] });
        expect(tracker.document(uri)?.syncedBy).toBe('didChange');
        tracker.noteNotification('textDocument/didClose', { textDocument: { uri } });
        tracker.noteNotification('textDocument/didOpen', open());
        expect(tracker.document(uri)?.syncedBy).toBe('didOpen');
    });

    it('does not credit a versioned or non empty publish after reopen to the closed generation', () => {
        const tracker = new DiagnosticsTracker();
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.noteNotification('textDocument/didClose', { textDocument: { uri } });
        tracker.noteNotification('textDocument/didOpen', open());
        expect(tracker.receive({ uri, version: 1, diagnostics: [] }).generation).toBe(2);
    });

    describe('publish URI normalization', () => {
        const opened = 'file:///Users/Me/My Project/a.ts';
        const openNote = { textDocument: { uri: opened, languageId: 'typescript', version: 1, text: '' } };
        const message = [{ range: {}, message: 'x' }];

        it('matches a percent-encoded publish to the document opened unencoded, on any platform', async () => {
            const tracker = new DiagnosticsTracker(undefined, undefined, undefined, 'linux');
            tracker.noteNotification('textDocument/didOpen', openNote);
            const wait = firstPublish(tracker, opened, () => true, 5000);
            const publish = tracker.receive({ uri: 'file:///Users/Me/My%20Project/a.ts', diagnostics: message });
            expect(publish.generation).toBe(1);
            expect(await wait).toBe(publish);
            expect(tracker.latestPublish(opened)).toBe(publish);
            // the publish keeps the URI the server sent
            expect(publish.uri).toBe('file:///Users/Me/My%20Project/a.ts');
        });

        it.each([
            ['raw', 'file:///tmp/a#b 100%/x.ts'],
            ['encoded the same', 'file:///tmp/a%23b%20100%25/x.ts'],
            ['encoded differently', 'file:///tmp/a%23b%20100%25/%78.%74s'],
        ])('matches a publish %s to a document opened with pathToUri', async (_how, published) => {
            const tracker = new DiagnosticsTracker(undefined, undefined, undefined, 'linux');
            const uri = pathToUri('/tmp/a#b 100%/x.ts');
            tracker.noteNotification('textDocument/didOpen', {
                textDocument: { uri, languageId: 'typescript', version: 1, text: '' },
            });
            const wait = firstPublish(tracker, uri, () => true, 5000);
            const publish = tracker.receive({ uri: published, diagnostics: message });
            expect(publish.generation).toBe(1);
            expect(await wait).toBe(publish);
        });

        it.each(['darwin', 'win32'] as const)('matches a publish differing only in case on %s', async (platform) => {
            const statuses: string[] = [];
            const tracker = new DiagnosticsTracker(
                undefined,
                undefined,
                (_publish, status) => statuses.push(status),
                platform,
            );
            tracker.noteNotification('textDocument/didOpen', openNote);
            const wait = firstPublish(tracker, opened, () => true, 5000);
            const publish = tracker.receive({ uri: 'file:///users/me/my%20project/a.ts', diagnostics: message });
            expect(statuses).toEqual(['current']);
            expect(publish.generation).toBe(1);
            expect(await wait).toBe(publish);
            expect(tracker.document('FILE:///USERS/ME/MY PROJECT/A.TS')?.open).toBe(true);
        });

        it('keeps case-sensitive matching on linux and logs a hint once per URI', () => {
            const logs: string[] = [];
            const statuses: string[] = [];
            const tracker = new DiagnosticsTracker(
                (msg) => logs.push(msg),
                undefined,
                (_publish, status) => statuses.push(status),
                'linux',
            );
            tracker.noteNotification('textDocument/didOpen', openNote);
            const lowered = 'file:///users/me/my%20project/a.ts';
            expect(tracker.receive({ uri: lowered, diagnostics: message }).generation).toBe(0);
            tracker.receive({ uri: lowered, diagnostics: [] });
            expect(statuses).toEqual(['unopened', 'unopened']);
            expect(tracker.latestPublish(opened)).toBeUndefined();
            const hints = logs.filter((l) => l.includes('apart from case'));
            expect(hints).toHaveLength(1);
            expect(hints[0]).toContain(lowered);
            expect(hints[0]).toContain(opened);
        });

        it('does not hint for an unopened publish that matches no open document', () => {
            const logs: string[] = [];
            const tracker = new DiagnosticsTracker((msg) => logs.push(msg), undefined, undefined, 'linux');
            tracker.noteNotification('textDocument/didOpen', openNote);
            tracker.receive({ uri: 'file:///Users/Me/My%20Project/tsconfig.json', diagnostics: [] });
            expect(logs.filter((l) => l.includes('apart from case'))).toEqual([]);
        });

        it('matches a malformed percent-encoded URI as it is', () => {
            const tracker = new DiagnosticsTracker(undefined, undefined, undefined, 'linux');
            const odd = 'file:///w/100%.ts';
            tracker.noteNotification('textDocument/didOpen', { textDocument: { uri: odd, version: 1 } });
            expect(tracker.receive({ uri: odd, diagnostics: [] }).generation).toBe(1);
        });
    });

    describe('close window rule', () => {
        const close = { textDocument: { uri } };
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        /** accepts publishes of the current open generation */
        const current = (tracker: DiagnosticsTracker) => (p: DiagnosticsPublish) =>
            p.generation === tracker.document(uri)?.generation;

        function reopened(windowMs: number, logs: string[] = []): DiagnosticsTracker {
            const tracker = new DiagnosticsTracker((msg) => logs.push(msg), windowMs);
            tracker.noteNotification('textDocument/didOpen', open());
            tracker.receive({ uri, diagnostics: [{ range: {}, message: 'first' }] });
            tracker.noteNotification('textDocument/didClose', close);
            tracker.noteNotification('textDocument/didOpen', open());
            return tracker;
        }

        it('tells when the close window ends while it is open and the server may publish on close', async () => {
            const tracker = new DiagnosticsTracker(() => {}, 40);
            tracker.noteNotification('textDocument/didOpen', open());
            expect(tracker.closeWindowEndsAt(uri)).toBeUndefined();
            const before = process.hrtime.bigint();
            tracker.noteNotification('textDocument/didClose', close);
            const endsAt = tracker.closeWindowEndsAt(uri);
            expect(endsAt).toBeDefined();
            expect(endsAt! - before).toBeGreaterThanOrEqual(40_000_000n);
            expect(endsAt! - process.hrtime.bigint()).toBeLessThanOrEqual(40_000_000n);
            await sleep(60);
            expect(tracker.closeWindowEndsAt(uri)).toBeUndefined();
            expect(tracker.closeBehavior).toBe('silent');
            tracker.noteNotification('textDocument/didOpen', open());
            tracker.noteNotification('textDocument/didClose', close);
            expect(tracker.closeWindowEndsAt(uri)).toBeUndefined();
        });

        it('lets a later publish supersede the tentative empty one and learns the server publishes on close', async () => {
            const logs: string[] = [];
            const tracker = reopened(1000, logs);
            const stale = tracker.receive({ uri, diagnostics: [] });
            const wait = firstPublish(tracker, uri, current(tracker), 5000);
            expect(tracker.latestPublish(uri)?.seq).not.toBe(stale.seq);
            const fresh = tracker.receive({ uri, diagnostics: [{ range: {}, message: 'fresh' }] });
            expect((await wait)?.diagnostics.map((d) => d.message)).toEqual(['fresh']);
            // neither the superseded candidate nor a publish delivered on receipt is stamped
            expect(stale.acceptedAt).toBeUndefined();
            expect(fresh.acceptedAt).toBeUndefined();
            expect(tracker.closeBehavior).toBe('publishes');
            expect(logs.some((l) => l.includes('Server publishes on close'))).toBe(true);
        });

        it('accepts the tentative publish when the window ends, keeping its receipt time', async () => {
            const logs: string[] = [];
            const tracker = reopened(40, logs);
            const candidate = tracker.receive({ uri, diagnostics: [] });
            const wait = firstPublish(tracker, uri, current(tracker), 5000);
            const accepted = await wait;
            expect(accepted).toBe(candidate);
            expect(process.hrtime.bigint() - candidate.receivedAt).toBeGreaterThan(20_000_000n);
            // stamped with its delivery at the end of the window
            expect(candidate.acceptedAt).toBeDefined();
            expect((candidate.acceptedAt ?? 0n) - candidate.receivedAt).toBeGreaterThan(20_000_000n);
            expect(tracker.closeBehavior).toBe('silent');
            expect(logs.some((l) => l.includes('the close window rule is off'))).toBe(true);
        });

        it('turns the rule off once the server is known not to publish on close', async () => {
            const tracker = reopened(20);
            tracker.receive({ uri, diagnostics: [] });
            await sleep(40);
            expect(tracker.closeBehavior).toBe('silent');
            tracker.noteNotification('textDocument/didClose', close);
            tracker.noteNotification('textDocument/didOpen', open());
            const publish = tracker.receive({ uri, diagnostics: [] });
            expect(publish.generation).toBe(3);
            expect(tracker.latestPublish(uri)).toBe(publish);
        });

        it('learns silence from a close with no publish within the window', async () => {
            const tracker = new DiagnosticsTracker(() => {}, 10);
            tracker.noteNotification('textDocument/didOpen', open());
            tracker.noteNotification('textDocument/didClose', close);
            await sleep(30);
            expect(tracker.closeBehavior).toBe('silent');
        });

        it('credits the empty publish to the close at once when the server publishes on close', () => {
            const tracker = new DiagnosticsTracker(() => {}, 1000);
            tracker.noteNotification('textDocument/didOpen', open());
            tracker.noteNotification('textDocument/didClose', close);
            tracker.receive({ uri, diagnostics: [] });
            expect(tracker.closeBehavior).toBe('publishes');
            tracker.noteNotification('textDocument/didOpen', open());
            tracker.noteNotification('textDocument/didClose', close);
            tracker.noteNotification('textDocument/didOpen', open());
            const stale = tracker.receive({ uri, diagnostics: [] });
            expect(stale.generation).toBe(2);
            expect(tracker.latestPublish(uri)).toBe(stale);
        });

        /** a server that cleared the closed document once already, as rust-analyzer does, then reopened */
        function clearedAndReopened(windowMs: number, versioned: boolean, statuses: PublishStatus[] = []) {
            const logs: string[] = [];
            const tracker = new DiagnosticsTracker(
                (msg) => logs.push(msg),
                windowMs,
                (_p, status) => statuses.push(status),
            );
            tracker.noteNotification('textDocument/didOpen', open());
            tracker.receive({ uri, diagnostics: [], ...(versioned ? { version: 1 } : {}) });
            tracker.noteNotification('textDocument/didClose', close);
            tracker.receive({ uri, diagnostics: [] });
            tracker.noteNotification('textDocument/didOpen', open());
            return { tracker, logs };
        }

        it('credits a further unversioned empty publish after the reopen to the close for a versioning server', () => {
            const statuses: PublishStatus[] = [];
            const { tracker, logs } = clearedAndReopened(1000, true, statuses);
            expect(tracker.closeBehavior).toBe('publishes');
            const late = tracker.receive({ uri, diagnostics: [] });
            expect(statuses).toEqual(['current', 'closed', 'stale']);
            expect(late.generation).toBe(1);
            expect(tracker.document(uri)?.closePublishes).toBe(2);
            expect(logs.some((l) => l.includes('the server versions its publishes'))).toBe(true);
            // the server's own publish for the reopen is current
            const fresh = tracker.receive({ uri, version: 1, diagnostics: [] });
            expect(fresh.generation).toBe(2);
            expect(statuses.at(-1)).toBe('current');
            tracker.clear();
        });

        it('holds a further empty publish after the reopen as a candidate for a server not versioning', async () => {
            const statuses: PublishStatus[] = [];
            const { tracker } = clearedAndReopened(40, false, statuses);
            const late = tracker.receive({ uri, diagnostics: [] });
            expect(statuses.at(-1)).toBe('close candidate');
            expect(tracker.latestPublish(uri)).not.toBe(late);
            // not superseded: accepted with its receipt time, without unlearning publishes on close
            expect(await firstPublish(tracker, uri, current(tracker), 5000)).toBe(late);
            expect(late.acceptedAt).toBeDefined();
            expect(tracker.closeBehavior).toBe('publishes');
        });

        it('lets a publish supersede a further empty candidate held after the reopen', async () => {
            const { tracker } = clearedAndReopened(1000, false);
            tracker.receive({ uri, diagnostics: [] });
            const wait = firstPublish(tracker, uri, current(tracker), 5000);
            tracker.receive({ uri, diagnostics: [{ range: {}, message: 'fresh' }] });
            expect((await wait)?.diagnostics.map((d) => d.message)).toEqual(['fresh']);
            tracker.clear();
        });

        it('counts the publishes clearing a close, resetting on the next close', () => {
            const { tracker } = clearedAndReopened(1000, true);
            expect(tracker.document(uri)?.closePublishes).toBe(1);
            tracker.noteNotification('textDocument/didClose', close);
            expect(tracker.document(uri)?.closePublishes).toBe(0);
            tracker.clear();
        });

        it('forgets what it learned on clear', () => {
            const tracker = new DiagnosticsTracker(() => {}, 1000);
            tracker.noteNotification('textDocument/didOpen', open());
            tracker.noteNotification('textDocument/didClose', close);
            tracker.receive({ uri, diagnostics: [] });
            tracker.clear();
            expect(tracker.closeBehavior).toBe('unknown');
        });

        describe('publishes read before a sync and received after it', () => {
            function tracking() {
                const statuses: PublishStatus[] = [];
                const logs: string[] = [];
                const tracker = new DiagnosticsTracker(
                    (msg) => logs.push(msg),
                    1000,
                    (_p, status) => statuses.push(status),
                );
                return { tracker, statuses, logs };
            }

            function readBeforeReopen(
                tracker: DiagnosticsTracker,
                params: { uri: string; version?: number; diagnostics: [] },
            ) {
                tracker.noteNotification('textDocument/didClose', close);
                tracker.noteRead(params);
                tracker.noteNotification('textDocument/didOpen', open());
                return tracker.receive(params);
            }

            it('credits a versioned empty close publish read before the reopen to the close', async () => {
                const { tracker, statuses } = tracking();
                tracker.noteNotification('textDocument/didOpen', open());
                const wait = firstPublish(tracker, uri, current(tracker), 5000);
                tracker.noteNotification('textDocument/didClose', close);
                await Promise.resolve();
                const params = { uri, version: 1, diagnostics: [] as [] };
                tracker.noteRead(params);
                tracker.noteNotification('textDocument/didOpen', open());
                const late = tracker.receive(params);
                expect(statuses).toEqual(['closed']);
                expect(late.generation).toBe(1);
                expect(tracker.closeBehavior).toBe('publishes');
                expect(tracker.document(uri)).toMatchObject({ closePublishes: 1, closePublishesAfterReopen: 0 });
                const reopenWait = firstPublish(tracker, uri, current(tracker), 5000);
                const fresh = tracker.receive({ uri, version: 1, diagnostics: [{ range: {}, message: 'F401' }] });
                expect(statuses.at(-1)).toBe('current');
                expect(await reopenWait).toBe(fresh);
                expect(await wait).toBe(fresh);
                tracker.clear();
            });

            it('credits it to the close once the server is known to publish on close', () => {
                const { tracker, statuses } = tracking();
                tracker.noteNotification('textDocument/didOpen', open());
                tracker.noteNotification('textDocument/didClose', close);
                tracker.receive({ uri, version: 1, diagnostics: [] });
                tracker.noteNotification('textDocument/didOpen', open());
                expect(tracker.closeBehavior).toBe('publishes');
                const late = readBeforeReopen(tracker, { uri, version: 1, diagnostics: [] });
                expect(statuses).toEqual(['closed', 'closed']);
                expect(late.generation).toBe(2);
                expect(tracker.document(uri)?.generation).toBe(3);
                tracker.clear();
            });

            it('does not hold an unversioned empty close publish read before the reopen as a candidate', () => {
                const { tracker, statuses } = tracking();
                tracker.noteNotification('textDocument/didOpen', open());
                const late = readBeforeReopen(tracker, { uri, diagnostics: [] });
                expect(statuses).toEqual(['closed']);
                expect(tracker.latestPublish(uri)).toBe(late);
                expect(tracker.closeBehavior).toBe('publishes');
                const next = tracker.receive({ uri, diagnostics: [] });
                expect(statuses.at(-1)).toBe('close candidate');
                expect(tracker.latestPublish(uri)).not.toBe(next);
                tracker.clear();
            });

            it('keeps a publish read before the first didOpen unopened', () => {
                const { tracker, statuses } = tracking();
                const params = { uri, version: 1, diagnostics: [] as [] };
                tracker.noteRead(params);
                tracker.noteNotification('textDocument/didOpen', open());
                expect(tracker.receive(params).generation).toBe(0);
                expect(statuses).toEqual(['unopened']);
            });

            it('marks a publish read for an earlier open stale', () => {
                const { tracker, statuses } = tracking();
                tracker.noteNotification('textDocument/didOpen', open());
                const params = { uri, version: 1, diagnostics: [{ range: {}, message: 'old' }] };
                tracker.noteRead(params);
                tracker.noteNotification('textDocument/didClose', close);
                tracker.noteNotification('textDocument/didOpen', open());
                const late = tracker.receive(params);
                expect(statuses).toEqual(['stale']);
                expect(late.generation).toBe(1);
                expect(tracker.document(uri)).toMatchObject({ closePublishes: 0, closePublishesAfterReopen: 0 });
                expect(tracker.closeBehavior).toBe('unknown');
                tracker.clear();
            });

            it('classifies by the state at receipt without a noted read', () => {
                const { tracker, statuses } = tracking();
                tracker.noteNotification('textDocument/didOpen', open());
                tracker.noteNotification('textDocument/didClose', close);
                tracker.noteNotification('textDocument/didOpen', open());
                expect(tracker.receive({ uri, version: 1, diagnostics: [] }).generation).toBe(2);
                expect(statuses).toEqual(['current']);
                tracker.clear();
            });
        });

        describe('servers clearing each close once', () => {
            const other = 'file:///w/b.ts';

            function tracking(windowMs: number) {
                const logs: string[] = [];
                const statuses: PublishStatus[] = [];
                const tracker = new DiagnosticsTracker(
                    (msg) => logs.push(msg),
                    windowMs,
                    (_p, status) => statuses.push(status),
                );
                tracker.noteNotification('textDocument/didOpen', open());
                return { tracker, logs, statuses };
            }

            function closeClearReopen(tracker: DiagnosticsTracker, clearAfterReopen = false): DiagnosticsPublish {
                tracker.noteNotification('textDocument/didClose', close);
                if (!clearAfterReopen) {
                    tracker.receive({ uri, diagnostics: [] });
                }
                tracker.noteNotification('textDocument/didOpen', open());
                if (clearAfterReopen) {
                    tracker.receive({ uri, diagnostics: [] });
                }
                return tracker.receive({ uri, diagnostics: [] });
            }

            async function learnedOnce(windowMs = 20) {
                const tracking_ = tracking(windowMs);
                for (let i = 0; i < 3; i++) {
                    closeClearReopen(tracking_.tracker, i === 1);
                    await sleep(windowMs * 2);
                }
                return tracking_;
            }

            it('learns once after three closes in a row cleared by one publish, logging it once', async () => {
                const { tracker, logs, statuses } = tracking(20);
                for (let i = 0; i < 2; i++) {
                    closeClearReopen(tracker, i === 1);
                    await sleep(40);
                }
                expect(statuses.filter((s) => s === 'close candidate')).toHaveLength(2);
                expect(tracker.closeClears).toBe('unknown');
                closeClearReopen(tracker);
                await sleep(40);
                expect(tracker.closeClears).toBe('once');
                expect(tracker.closeBehavior).toBe('publishes');
                closeClearReopen(tracker);
                await sleep(40);
                expect(logs.filter((l) => l.includes('Server clears each close once'))).toHaveLength(1);
                tracker.clear();
            });

            it('accepts a further empty publish at once once learned', async () => {
                const { tracker, logs, statuses } = await learnedOnce();
                for (const clearAfterReopen of [false, true]) {
                    const reopen = closeClearReopen(tracker, clearAfterReopen);
                    expect(statuses.at(-1)).toBe('current');
                    expect(reopen.generation).toBe(tracker.document(uri)?.generation);
                    expect(tracker.latestPublish(uri)).toBe(reopen);
                    expect(await firstPublish(tracker, uri, current(tracker), 5)).toBe(reopen);
                    expect(reopen.acceptedAt).toBeUndefined();
                    expect(tracker.closeWindowEndsAt(uri)).toBeUndefined();
                    await sleep(40);
                    expect(reopen.acceptedAt).toBeUndefined();
                }
                expect(logs.filter((l) => l.includes('after didClose, accepted at once'))).toHaveLength(2);
                expect(tracker.closeClears).toBe('once');
                tracker.clear();
            });

            it('learns more from a candidate held after a clear and superseded, holding candidates again', async () => {
                const { tracker, logs, statuses } = tracking(20);
                closeClearReopen(tracker);
                expect(statuses.at(-1)).toBe('close candidate');
                tracker.receive({ uri, diagnostics: [{ range: {}, message: 'fresh' }] });
                expect(tracker.closeClears).toBe('more');
                expect(logs.some((l) => l.includes('Server may clear a close more than once'))).toBe(true);
                for (let i = 0; i < 4; i++) {
                    await sleep(40);
                    closeClearReopen(tracker);
                    expect(statuses.at(-1)).toBe('close candidate');
                }
                tracker.clear();
            });

            it('learns more from a second empty publish after one was accepted at once', async () => {
                const { tracker, logs, statuses } = await learnedOnce();
                const reopen = closeClearReopen(tracker);
                expect(statuses.at(-1)).toBe('current');
                const second = tracker.receive({ uri, diagnostics: [] });
                expect(statuses.at(-1)).toBe('close candidate');
                expect(tracker.latestPublish(uri)).toBe(reopen);
                expect(tracker.closeWindowEndsAt(uri)).toBeDefined();
                expect(tracker.closeClears).toBe('more');
                expect(logs.some((l) => l.includes('a second clear'))).toBe(true);
                await sleep(40);
                expect(tracker.latestPublish(uri)).toBe(second);
                closeClearReopen(tracker);
                expect(statuses.at(-1)).toBe('close candidate');
                tracker.clear();
            });

            it('learns more from a close cleared twice while closed', () => {
                const { tracker } = tracking(1000);
                tracker.noteNotification('textDocument/didClose', close);
                tracker.receive({ uri, diagnostics: [] });
                expect(tracker.closeClears).toBe('unknown');
                tracker.receive({ uri, diagnostics: [] });
                expect(tracker.closeClears).toBe('more');
                tracker.clear();
            });

            it('learns more from a further publish credited to the close for a versioning server', () => {
                const statuses: PublishStatus[] = [];
                const { tracker } = clearedAndReopened(1000, true, statuses);
                tracker.receive({ uri, diagnostics: [] });
                expect(statuses.at(-1)).toBe('stale');
                expect(tracker.closeClears).toBe('more');
                tracker.clear();
            });

            it('does not count revalidation publishes for a closed document towards once', async () => {
                const { tracker, statuses } = tracking(20);
                tracker.noteNotification('textDocument/didOpen', {
                    textDocument: { uri: other, languageId: 'typescript', version: 1, text: '' },
                });
                closeClearReopen(tracker);
                await sleep(40);
                closeClearReopen(tracker);
                await sleep(40);
                for (let i = 0; i < 3; i++) {
                    tracker.noteNotification('textDocument/didClose', close);
                    tracker.noteNotification('textDocument/didChange', {
                        textDocument: { uri: other, version: i + 2 },
                        contentChanges: [],
                    });
                    tracker.receive({ uri, diagnostics: [] });
                    tracker.noteNotification('textDocument/didOpen', open());
                    tracker.receive({ uri, diagnostics: [] });
                    expect(statuses.at(-1)).toBe('close candidate');
                    await sleep(40);
                }
                expect(tracker.closeClears).toBe('unknown');
                closeClearReopen(tracker);
                await sleep(40);
                closeClearReopen(tracker);
                await sleep(40);
                expect(tracker.closeClears).toBe('unknown');
                closeClearReopen(tracker);
                await sleep(40);
                expect(tracker.closeClears).toBe('once');
                tracker.clear();
            });

            it('changes nothing for a server learned silent', async () => {
                const logs: string[] = [];
                const tracker = reopened(20, logs);
                tracker.receive({ uri, diagnostics: [] });
                await sleep(40);
                expect(tracker.closeBehavior).toBe('silent');
                for (let i = 0; i < 4; i++) {
                    tracker.noteNotification('textDocument/didClose', close);
                    tracker.noteNotification('textDocument/didOpen', open());
                    const publish = tracker.receive({ uri, diagnostics: [] });
                    expect(tracker.latestPublish(uri)).toBe(publish);
                    await sleep(40);
                }
                expect(tracker.closeClears).toBe('unknown');
                expect(logs.some((l) => l.includes('after didClose, accepted at once'))).toBe(false);
                tracker.clear();
            });

            it('still marks a publish accepted at once as a placeholder while the server is loading', async () => {
                const { tracker, statuses } = await learnedOnce();
                let loading = false;
                tracker.markPlaceholdersWhile(() => loading);
                tracker.noteNotification('textDocument/didClose', close);
                tracker.receive({ uri, diagnostics: [] });
                tracker.noteNotification('textDocument/didOpen', open());
                loading = true;
                const reopen = tracker.receive({ uri, diagnostics: [] });
                expect(statuses.at(-1)).toBe('current');
                expect(reopen.placeholder).toBe(true);
                expect(tracker.delivery).toBe('unknown');
                tracker.clear();
            });

            it('forgets once on clear', async () => {
                const { tracker } = await learnedOnce();
                tracker.clear();
                expect(tracker.closeClears).toBe('unknown');
                tracker.noteNotification('textDocument/didOpen', open());
                closeClearReopen(tracker);
                expect(tracker.closeClears).toBe('unknown');
                tracker.clear();
            });
        });

        describe('revalidation publishes for closed documents', () => {
            const other = 'file:///w/b.ts';
            const openOther = { textDocument: { uri: other, languageId: 'typescript', version: 1, text: '' } };

            /** open and close `uri`, then sync `other` with `method` before a publish arrives for `uri` */
            function closedThenOtherSynced(method: 'didOpen' | 'didChange' | 'didClose', logs: string[] = []) {
                const statuses: PublishStatus[] = [];
                const tracker = new DiagnosticsTracker(
                    (msg) => logs.push(msg),
                    1000,
                    (_p, status) => statuses.push(status),
                );
                if (method !== 'didOpen') {
                    tracker.noteNotification('textDocument/didOpen', openOther);
                }
                tracker.noteNotification('textDocument/didOpen', open());
                tracker.noteNotification('textDocument/didClose', close);
                if (method === 'didChange') {
                    tracker.noteNotification('textDocument/didChange', {
                        textDocument: { uri: other, version: 2 },
                        contentChanges: [],
                    });
                } else if (method === 'didClose') {
                    tracker.noteNotification('textDocument/didClose', { textDocument: { uri: other } });
                } else {
                    tracker.noteNotification('textDocument/didOpen', openOther);
                }
                return { tracker, statuses };
            }

            it.each(['didOpen', 'didChange', 'didClose'] as const)(
                'does not learn publishes from a publish for a closed document after a %s of another',
                (method) => {
                    const logs: string[] = [];
                    const { tracker, statuses } = closedThenOtherSynced(method, logs);
                    tracker.receive({ uri, diagnostics: [] });
                    expect(statuses).toEqual(['closed']);
                    expect(tracker.document(uri)?.closePublishes).toBe(1);
                    expect(tracker.closeBehavior).toBe('unknown');
                    expect(logs.some((l) => l.includes('may be revalidation'))).toBe(true);
                    expect(logs.some((l) => l.includes('Server publishes on close'))).toBe(false);
                    tracker.clear();
                },
            );

            it('accepts the reopen publish after a revalidation publish as current', async () => {
                const { tracker, statuses } = closedThenOtherSynced('didOpen');
                tracker.receive({ uri, diagnostics: [] });
                tracker.noteNotification('textDocument/didClose', { textDocument: { uri: other } });
                tracker.noteNotification('textDocument/didOpen', open());
                const wait = firstPublish(tracker, uri, current(tracker), 5000);
                const reopen = tracker.receive({ uri, diagnostics: [] });
                expect(statuses.at(-1)).toBe('current');
                expect(reopen.generation).toBe(2);
                expect(await wait).toBe(reopen);
                tracker.clear();
            });

            it('does not learn publishes from a non empty publish for a closed document', () => {
                const tracker = new DiagnosticsTracker(() => {}, 1000);
                tracker.noteNotification('textDocument/didOpen', open());
                tracker.noteNotification('textDocument/didClose', close);
                tracker.receive({ uri, diagnostics: [{ range: {}, message: 'x' }] });
                expect(tracker.closeBehavior).toBe('unknown');
                tracker.clear();
            });

            it('does not learn publishes from a publish for a closed document after the close window', async () => {
                const tracker = new DiagnosticsTracker(() => {}, 10);
                tracker.noteNotification('textDocument/didOpen', open());
                tracker.noteNotification('textDocument/didClose', close);
                await sleep(30);
                expect(tracker.closeBehavior).toBe('silent');
                tracker.receive({ uri, diagnostics: [] });
                expect(tracker.closeBehavior).toBe('silent');
            });

            it('does not flip a learned silent to publishes', async () => {
                const tracker = new DiagnosticsTracker(() => {}, 10);
                tracker.noteNotification('textDocument/didOpen', open());
                tracker.noteNotification('textDocument/didClose', close);
                await sleep(30);
                tracker.noteNotification('textDocument/didOpen', open());
                tracker.noteNotification('textDocument/didClose', close);
                tracker.receive({ uri, diagnostics: [] });
                expect(tracker.closeBehavior).toBe('silent');
                tracker.clear();
            });

            it('counts publishes credited to the close after the reopen', () => {
                const tracker = new DiagnosticsTracker(() => {}, 1000);
                tracker.noteNotification('textDocument/didOpen', open());
                tracker.noteNotification('textDocument/didClose', close);
                tracker.receive({ uri, diagnostics: [] });
                tracker.noteNotification('textDocument/didOpen', open());
                tracker.noteNotification('textDocument/didClose', close);
                tracker.noteNotification('textDocument/didOpen', open());
                tracker.receive({ uri, diagnostics: [] });
                expect(tracker.document(uri)).toMatchObject({ closePublishes: 1, closePublishesAfterReopen: 1 });
                tracker.clear();
            });
        });
    });

    it('resolves from the cache, and unregisters a wait once it settles', async () => {
        const tracker = new DiagnosticsTracker();
        tracker.receive({ uri, diagnostics: [] });
        expect(await firstPublish(tracker, uri, () => true, 1000)).toBeDefined();
        expect(await firstPublish(tracker, uri, () => false, 5)).toBeUndefined();
        const listeners = (tracker as unknown as { listeners: Map<string, unknown> }).listeners;
        expect(listeners.size).toBe(0);
    });

    it('unregisters a settling wait once its quiet period ends or the timeout cuts it', async () => {
        const tracker = new DiagnosticsTracker();
        const listeners = (tracker as unknown as { listeners: Map<string, unknown> }).listeners;
        const settled = tracker.waitForPublishes(uri, () => true, { timeoutMs: 1000, settleMs: 10 });
        tracker.receive({ uri, diagnostics: [] });
        tracker.receive({ uri, diagnostics: [] });
        expect(await settled).toMatchObject({ timedOut: false, publishes: 2 });
        expect(listeners.size).toBe(0);
        const cut = tracker.waitForPublishes(uri, () => true, { timeoutMs: 10, settleMs: 1000 });
        expect(await cut).toMatchObject({ timedOut: false, publishes: 1 });
        expect(listeners.size).toBe(0);
    });

    it('learns whether the server pushes or only answers pulls', () => {
        const tracker = new DiagnosticsTracker();
        expect(tracker.delivery).toBe('unknown');
        tracker.markPullOnly('test');
        expect(tracker.delivery).toBe('pull');
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.receive({ uri, diagnostics: [] });
        expect(tracker.delivery).toBe('push');
        // a push is never overruled by a pull
        tracker.markPullOnly('test');
        expect(tracker.delivery).toBe('push');
        tracker.clear();
        expect(tracker.delivery).toBe('unknown');
    });

    it('starts from a seeded delivery, a push still flips a seeded tentative pull', () => {
        const logs: string[] = [];
        const tracker = new DiagnosticsTracker((msg) => logs.push(msg));
        tracker.seedDelivery('unknown', false);
        expect(tracker.delivery).toBe('unknown');
        expect(logs).toEqual([]);
        tracker.seedDelivery('pull', true);
        expect(tracker.delivery).toBe('pull');
        expect(tracker.deliveryTentative).toBe(true);
        expect(logs).toEqual(['Carrying diagnostics delivery from the previous server: pull (tentative)']);
        // a seed never overrides what the tracker already holds
        tracker.seedDelivery('push', false);
        expect(tracker.delivery).toBe('pull');
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.receive({ uri, diagnostics: [] });
        expect(tracker.delivery).toBe('push');
        expect(tracker.deliveryTentative).toBe(false);

        const pushed = new DiagnosticsTracker();
        pushed.seedDelivery('push', true);
        expect(pushed.delivery).toBe('push');
        // only pull is ever tentative
        expect(pushed.deliveryTentative).toBe(false);
    });

    it('learns pull only tentatively from empty pulls, a push or a non tentative learn overturns it', () => {
        const logs: string[] = [];
        const changes: string[] = [];
        const tracker = new DiagnosticsTracker((msg) => logs.push(msg));
        const unsubscribe = tracker.onDeliveryChange((delivery) => changes.push(delivery));
        expect(tracker.deliveryTentative).toBe(false);
        tracker.markPullOnly('empty pull', true);
        expect(tracker.delivery).toBe('pull');
        expect(tracker.deliveryTentative).toBe(true);
        // a further empty pull changes nothing and logs nothing
        tracker.markPullOnly('empty pull', true);
        expect(logs.filter((l) => l.includes('tentatively pull only'))).toHaveLength(1);
        // a pull with diagnostics settles it
        tracker.markPullOnly('pull with diagnostics');
        expect(tracker.delivery).toBe('pull');
        expect(tracker.deliveryTentative).toBe(false);
        expect(logs.some((l) => l.includes('only answers pulls'))).toBe(true);
        // a settled pull is not made tentative again
        tracker.markPullOnly('empty pull', true);
        expect(tracker.deliveryTentative).toBe(false);
        expect(changes).toEqual(['pull']);

        tracker.clear();
        expect(changes).toEqual(['pull', 'unknown']);
        tracker.markPullOnly('empty pull', true);
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.receive({ uri, diagnostics: [] });
        expect(tracker.delivery).toBe('push');
        expect(tracker.deliveryTentative).toBe(false);
        expect(changes).toEqual(['pull', 'unknown', 'pull', 'push']);
        // no change, no call
        tracker.receive({ uri, diagnostics: [] });
        unsubscribe();
        tracker.clear();
        expect(changes).toEqual(['pull', 'unknown', 'pull', 'push']);
    });

    it('learns push only from publishes for documents the client opened', () => {
        const logs: string[] = [];
        const statuses: PublishStatus[] = [];
        const tracker = new DiagnosticsTracker(
            (msg) => logs.push(msg),
            undefined,
            (_publish, status) => statuses.push(status),
        );
        tracker.noteNotification('textDocument/didOpen', open());
        // ts7 clears a never opened tsconfig.json right after the first didOpen
        tracker.receive({ uri: 'file:///users/someone/project/tsconfig.json', diagnostics: [] });
        expect(statuses).toEqual(['unopened']);
        expect(tracker.delivery).toBe('unknown');
        expect(logs.some((l) => l.includes('Server pushes diagnostics'))).toBe(false);
        // so a pull fallback can still learn the server as pull only
        tracker.markPullOnly('test');
        expect(tracker.delivery).toBe('pull');
        tracker.receive({ uri: 'file:///users/someone/project/tsconfig.json', diagnostics: [] });
        expect(tracker.delivery).toBe('pull');
        // a publish for the opened document does teach push
        tracker.receive({ uri, diagnostics: [] });
        expect(statuses).toEqual(['unopened', 'unopened', 'current']);
        expect(tracker.delivery).toBe('push');
    });

    it('learns push from a stale publish for an opened document', () => {
        const statuses: PublishStatus[] = [];
        const tracker = new DiagnosticsTracker(undefined, undefined, (_publish, status) => statuses.push(status));
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.noteNotification('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [] });
        tracker.receive({ uri, version: 1, diagnostics: [] });
        expect(statuses).toEqual(['stale']);
        expect(tracker.delivery).toBe('push');
    });

    it('does not learn push from a close window candidate', () => {
        const statuses: PublishStatus[] = [];
        const tracker = new DiagnosticsTracker(undefined, 1000, (_publish, status) => statuses.push(status));
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.noteNotification('textDocument/didClose', { textDocument: { uri } });
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.receive({ uri, diagnostics: [] });
        expect(statuses).toEqual(['close candidate']);
        expect(tracker.delivery).toBe('unknown');
        tracker.clear();
    });

    it('does not learn push from an empty publish clearing a closed document after a tentative pull', () => {
        const logs: string[] = [];
        const statuses: PublishStatus[] = [];
        const tracker = new DiagnosticsTracker(
            (msg) => logs.push(msg),
            undefined,
            (_publish, status) => statuses.push(status),
        );
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.markPullOnly('empty pull', true);
        tracker.noteNotification('textDocument/didClose', { textDocument: { uri } });
        tracker.receive({ uri, diagnostics: [] });
        expect(statuses).toEqual(['closed']);
        expect(tracker.delivery).toBe('pull');
        expect(tracker.deliveryTentative).toBe(true);
        expect(tracker.closeBehavior).toBe('publishes');
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.noteNotification('textDocument/didClose', { textDocument: { uri } });
        tracker.receive({ uri, diagnostics: [] });
        expect(tracker.delivery).toBe('pull');
        expect(logs.filter((l) => l.includes('does not show the server pushes'))).toEqual([
            `Empty publish clearing closed ${uri} does not show the server pushes`,
        ]);
        expect(logs.some((l) => l.includes('Server pushes diagnostics'))).toBe(false);
        tracker.clear();
        tracker.markPullOnly('empty pull', true);
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.noteNotification('textDocument/didClose', { textDocument: { uri } });
        tracker.receive({ uri, diagnostics: [] });
        expect(logs.filter((l) => l.includes('does not show the server pushes'))).toHaveLength(2);
        tracker.clear();
    });

    it('learns push from a non empty publish for a closed document', () => {
        const tracker = new DiagnosticsTracker();
        tracker.markPullOnly('empty pull', true);
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.noteNotification('textDocument/didClose', { textDocument: { uri } });
        tracker.receive({ uri, diagnostics: [{ range: {}, message: 'a' }] });
        expect(tracker.delivery).toBe('push');
        tracker.clear();
    });

    it('does not learn push from an empty publish credited to the previous close after a reopen', () => {
        const statuses: PublishStatus[] = [];
        const tracker = new DiagnosticsTracker(undefined, 1000, (_publish, status) => statuses.push(status));
        tracker.markPullOnly('empty pull', true);
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.noteNotification('textDocument/didClose', { textDocument: { uri } });
        tracker.receive({ uri, diagnostics: [] });
        expect(tracker.closeBehavior).toBe('publishes');
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.noteNotification('textDocument/didClose', { textDocument: { uri } });
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.receive({ uri, diagnostics: [] });
        expect(statuses).toEqual(['closed', 'stale']);
        expect(tracker.delivery).toBe('pull');
        tracker.clear();
    });

    it('does not learn push from an empty unversioned publish after a reopen of a server learned silent', async () => {
        const statuses: PublishStatus[] = [];
        const tracker = new DiagnosticsTracker(undefined, 20, (_publish, status) => statuses.push(status));
        tracker.markPullOnly('empty pull', true);
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.noteNotification('textDocument/didClose', { textDocument: { uri } });
        await new Promise((r) => setTimeout(r, 40));
        expect(tracker.closeBehavior).toBe('silent');
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.noteNotification('textDocument/didClose', { textDocument: { uri } });
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.receive({ uri, diagnostics: [] });
        expect(statuses).toEqual(['current']);
        expect(tracker.delivery).toBe('pull');
        tracker.clear();
    });

    it('learns push from a versioned empty publish after a reopen', () => {
        const tracker = new DiagnosticsTracker(undefined, 1000);
        tracker.markPullOnly('empty pull', true);
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.noteNotification('textDocument/didClose', { textDocument: { uri } });
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.receive({ uri, version: 1, diagnostics: [] });
        expect(tracker.delivery).toBe('push');
        tracker.clear();
    });

    it('learns push from an empty publish for an opened document after a tentative pull', () => {
        const tracker = new DiagnosticsTracker();
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.markPullOnly('empty pull', true);
        tracker.receive({ uri, diagnostics: [] });
        expect(tracker.delivery).toBe('push');
        tracker.clear();
    });

    it('ends a wait through its signal with what it saw so far, unregistering it', async () => {
        const tracker = new DiagnosticsTracker();
        const listeners = (tracker as unknown as { listeners: Map<string, unknown> }).listeners;
        const abort = new AbortController();
        const wait = tracker.waitForPublishes(uri, () => true, {
            timeoutMs: 1000,
            until: (p) => p.diagnostics.length > 0,
            signal: abort.signal,
        });
        tracker.receive({ uri, diagnostics: [] });
        abort.abort();
        const result = await wait;
        expect(result).toMatchObject({ timedOut: false, aborted: true, publishes: 1 });
        expect(result.publish?.diagnostics).toEqual([]);
        expect(listeners.size).toBe(0);
    });

    it('resolves at once for an already aborted signal', async () => {
        const tracker = new DiagnosticsTracker();
        tracker.receive({ uri, diagnostics: [] });
        const result = await tracker.waitForPublishes(uri, () => true, {
            timeoutMs: 1000,
            signal: AbortSignal.abort(),
        });
        expect(result).toEqual({ publishes: 0, timedOut: false, aborted: true });
    });
});

describe('ProgressTracker', () => {
    const begin = (token: string | number, title = `task ${token}`) => ({ token, value: { kind: 'begin', title } });
    const end = (token: string | number) => ({ token, value: { kind: 'end' } });
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('resolves after the quiet period when the server never reports progress', async () => {
        const tracker = new ProgressTracker();
        const started = Date.now();
        const result = await tracker.waitForIdle({ timeoutMs: 1000, quietMs: 50 });
        expect(result).toEqual({ idle: true, timedOut: false, ms: 0 });
        expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    });

    it('is busy by server status once one arrived, by active tokens otherwise', () => {
        const tracker = new ProgressTracker();
        expect(tracker.busy).toBe(false);
        tracker.progress(begin('index'));
        expect(tracker.busy).toBe(true);
        // a server status takes precedence over tokens, rust-analyzer's flycheck runs after quiescence
        tracker.serverStatusChanged({ health: 'ok', quiescent: true });
        expect(tracker.busy).toBe(false);
        expect(tracker.idle).toBe(false);
        tracker.progress(end('index'));
        tracker.serverStatusChanged({ health: 'ok', quiescent: false });
        expect(tracker.busy).toBe(true);
        tracker.clear();
        expect(tracker.busy).toBe(false);
    });

    it('notifies once per change from busy to not busy', () => {
        const tracker = new ProgressTracker();
        let calls = 0;
        const stop = tracker.onNotBusy(() => calls++);
        tracker.progress(begin('a'));
        tracker.progress(begin('b'));
        tracker.progress(end('a'));
        expect(calls).toBe(0);
        tracker.progress(end('b'));
        expect(calls).toBe(1);
        tracker.serverStatusChanged({ health: 'ok', quiescent: false });
        tracker.serverStatusChanged({ health: 'ok', quiescent: false });
        tracker.serverStatusChanged({ health: 'ok', quiescent: true });
        tracker.serverStatusChanged({ health: 'ok', quiescent: true });
        expect(calls).toBe(2);
        // tokens after quiescence do not make the server busy, so their end notifies nothing
        tracker.progress(begin('cargo check'));
        tracker.progress(end('cargo check'));
        expect(calls).toBe(2);
        stop();
        tracker.serverStatusChanged({ health: 'ok', quiescent: false });
        tracker.serverStatusChanged({ health: 'ok', quiescent: true });
        expect(calls).toBe(2);
    });

    it('waits until every active token has ended', async () => {
        const tracker = new ProgressTracker();
        tracker.progress(begin('a'));
        tracker.progress(begin(1));
        expect(tracker.idle).toBe(false);
        const wait = tracker.waitForIdle({ timeoutMs: 1000, quietMs: 20 });
        await sleep(30);
        tracker.progress({ token: 'a', value: { kind: 'report', message: 'halfway' } });
        tracker.progress(end('a'));
        expect(tracker.activeTitles).toEqual(['task 1']);
        await sleep(30);
        tracker.progress(end(1));
        const result = await wait;
        expect(result.idle).toBe(true);
        expect(result.timedOut).toBe(false);
        expect(result.ms).toBeGreaterThanOrEqual(50);
    });

    it('does not resolve between back to back tokens', async () => {
        const tracker = new ProgressTracker();
        tracker.progress(begin('load'));
        const wait = tracker.waitForIdle({ timeoutMs: 1000, quietMs: 60 });
        let resolved = false;
        void wait.then(() => {
            resolved = true;
        });
        tracker.progress(end('load'));
        await sleep(20);
        tracker.progress(begin('index'));
        await sleep(80);
        expect(resolved).toBe(false);
        tracker.progress(end('index'));
        const result = await wait;
        expect(result.idle).toBe(true);
        expect(result.ms).toBeGreaterThanOrEqual(90);
    });

    it('treats tokens as distinct by value and type, and ignores unknown ends and partial results', () => {
        const tracker = new ProgressTracker();
        tracker.progress(begin(1));
        tracker.progress(end('1'));
        tracker.progress({ token: 'partial', value: [] as unknown as { kind?: unknown } });
        expect(tracker.activeTitles).toEqual(['task 1']);
        tracker.progress(end(1));
        expect(tracker.idle).toBe(true);
    });

    it('stays busy until a server status, once received, is quiescent', async () => {
        const tracker = new ProgressTracker();
        tracker.serverStatusChanged({ health: 'ok', quiescent: false });
        expect(tracker.idle).toBe(false);
        const wait = tracker.waitForIdle({ timeoutMs: 1000, quietMs: 20 });
        await sleep(30);
        tracker.serverStatusChanged({ health: 'ok', quiescent: true });
        const result = await wait;
        expect(result).toMatchObject({ idle: true, timedOut: false });
        expect(result.ms).toBeGreaterThanOrEqual(25);
        expect(tracker.serverStatus?.quiescent).toBe(true);
    });

    it('is busy while a token is active even when the server status is quiescent', () => {
        const tracker = new ProgressTracker();
        tracker.serverStatusChanged({ quiescent: true });
        tracker.progress(begin('a'));
        expect(tracker.idle).toBe(false);
    });

    it('times out while a token never ends', async () => {
        const tracker = new ProgressTracker();
        tracker.progress(begin('stuck'));
        const result = await tracker.waitForIdle({ timeoutMs: 50, quietMs: 10 });
        expect(result.idle).toBe(false);
        expect(result.timedOut).toBe(true);
        expect(result.ms).toBeGreaterThanOrEqual(40);
    });

    it('counts the quiet period from the start of the wait when the server was idle before', async () => {
        const tracker = new ProgressTracker();
        tracker.progress(begin('a'));
        tracker.progress(end('a'));
        await sleep(60);
        const started = Date.now();
        const result = await tracker.waitForIdle({ timeoutMs: 1000, quietMs: 40 });
        expect(result.ms).toBe(0);
        expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    });

    it('logs progress begin and end titles', () => {
        const logs: string[] = [];
        const tracker = new ProgressTracker((msg) => logs.push(msg));
        tracker.create('t');
        tracker.progress({ token: 't', value: { kind: 'begin', title: 'Indexing', message: '1/3' } });
        tracker.progress(end('t'));
        expect(logs).toContain('Progress begin: Indexing (1/3)');
        expect(logs).toContain('Progress end: Indexing');
    });

    it('forgets active tokens and the server status on clear', () => {
        const tracker = new ProgressTracker();
        tracker.progress(begin('a'));
        tracker.serverStatusChanged({ quiescent: false });
        tracker.clear();
        expect(tracker.idle).toBe(true);
        expect(tracker.serverStatus).toBeUndefined();
    });
});

/**
 * A fake server that, after initialized, creates a progress token, loads for loadMs
 * (argv) under it and reports a non quiescent server status meanwhile
 */
const progressServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
const loadMs = Number(process.argv[1]);
conn.onRequest('initialize', () => ({ capabilities: {} }));
conn.onNotification('initialized', async () => {
    conn.sendNotification('experimental/serverStatus', { health: 'ok', quiescent: false });
    await conn.sendRequest('window/workDoneProgress/create', { token: 'load' });
    conn.sendNotification('$/progress', { token: 'load', value: { kind: 'begin', title: 'Loading' } });
    setTimeout(() => {
        conn.sendNotification('$/progress', { token: 'load', value: { kind: 'end' } });
        conn.sendNotification('experimental/serverStatus', { health: 'ok', quiescent: true });
    }, loadMs);
});
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
`;

describe('LspHarness idle waits', () => {
    function progressHarness(loadMs: number): LspHarness {
        return new LspHarness(
            { command: process.execPath, args: ['--input-type=module', '-e', progressServer, String(loadMs)] },
            process.cwd(),
        );
    }

    it('waits for server initiated progress and the server status after initialized', async () => {
        const harness = progressHarness(200);
        try {
            await harness.start();
            harness.takeLifecycleTimings();
            const result = await harness.waitForIdleAfterStart({ timeoutMs: 5000 });
            expect(result).toMatchObject({ idle: true, timedOut: false });
            expect(result.ms).toBeGreaterThanOrEqual(150);
            expect(harness.takeLifecycleTimings()).toEqual([
                { method: 'lifecycle/idle', duration_ms: expect.any(Number), success: true, result: 'ok' },
            ]);
        } finally {
            await harness.stop();
        }
    });

    it('records a timeout as lifecycle/idle when the server stays busy', async () => {
        const harness = progressHarness(10_000);
        try {
            await harness.start();
            harness.takeLifecycleTimings();
            const result = await harness.waitForIdleAfterStart({ timeoutMs: 300 });
            expect(result).toMatchObject({ idle: false, timedOut: true });
            expect(harness.takeLifecycleTimings()).toEqual([
                { method: 'lifecycle/idle', duration_ms: expect.any(Number), success: false, result: 'timeout' },
            ]);
        } finally {
            await harness.stop();
        }
    });
});

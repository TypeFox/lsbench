import * as path from 'node:path';
import { LspHarness, pathToUri, uriToPath } from 'lsbench';
import { describe, expect, it } from 'vitest';

describe('pathToUri', () => {
    it('produces a file:// URI from an absolute path', () => {
        expect(pathToUri('/tmp/project/file.ts')).toBe('file:///tmp/project/file.ts');
    });

    it('resolves relative paths against the cwd', () => {
        const expected = `file://${path.resolve('some/rel/path.ts')}`;
        expect(pathToUri('some/rel/path.ts')).toBe(expected);
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
});

describe('pathToUri / uriToPath round-trip', () => {
    it('recovers the original absolute path', () => {
        const abs = '/Users/example/workspace/src/index.ts';
        expect(uriToPath(pathToUri(abs))).toBe(abs);
    });
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

describe('LspHarness.stop', () => {
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
});

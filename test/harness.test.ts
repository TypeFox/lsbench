import * as path from 'node:path';
import type { DiagnosticsPublish, PublishStatus } from 'lsbench';
import {
    DiagnosticsTracker,
    defaultClientCapabilities,
    expandSettings,
    LspHarness,
    mergeCapabilities,
    ProgressTracker,
    pathToUri,
    resolveConfigurationSection,
    uriToPath,
} from 'lsbench';
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
    if (mode === 'hang') {
        return new Promise(() => {});
    }
    return null;
});
conn.onNotification('exit', () => process.exit(mode === 'fail' ? 1 : 0));
conn.listen();
`;

function shutdownHarness(mode: 'crash' | 'quit' | 'hang' | 'fail' | 'clean', allowExitCodes?: number[]): LspHarness {
    return new LspHarness(
        { command: process.execPath, args: ['--input-type=module', '-e', shutdownServer, mode], allowExitCodes },
        process.cwd(),
    );
}

describe('LspHarness.stop', () => {
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

describe('LspHarness.saveSyncOptions', () => {
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
    function echoHarness(clientCapabilities?: Record<string, unknown>): LspHarness {
        return new LspHarness(
            {
                command: process.execPath,
                args: ['--input-type=module', '-e', echoCapabilitiesServer],
                clientCapabilities,
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

    it('does not mutate the input', () => {
        const settings = { html: { format: { enable: true } }, 'html.format': { wrapLineLength: 80 } };
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
        off: null,
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

    async function dumpWith(settings?: Record<string, unknown>): Promise<SettingsDump> {
        const harness = new LspHarness(
            {
                command: process.execPath,
                args: ['--input-type=module', '-e', settingsServer, JSON.stringify(items)],
                settings,
            },
            process.cwd(),
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
});

describe('DiagnosticsTracker', () => {
    const uri = 'file:///w/a.ts';
    const open = (version = 1) => ({ textDocument: { uri, languageId: 'typescript', version, text: '' } });

    it('bumps the generation on each didOpen and stamps publishes with it', () => {
        const tracker = new DiagnosticsTracker();
        tracker.noteNotification('textDocument/didOpen', open());
        expect(tracker.receive({ uri, diagnostics: [{ range: {}, message: 'a' }] }).generation).toBe(1);
        tracker.noteNotification('textDocument/didClose', { textDocument: { uri } });
        tracker.noteNotification('textDocument/didOpen', open());
        expect(tracker.document(uri)).toMatchObject({ generation: 2, open: true, version: 1 });
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
            const wait = tracker.waitFor(opened, () => true, 5000);
            const publish = tracker.receive({ uri: 'file:///Users/Me/My%20Project/a.ts', diagnostics: message });
            expect(publish.generation).toBe(1);
            expect(await wait).toBe(publish);
            expect(tracker.latestPublish(opened)).toBe(publish);
            // the publish keeps the URI the server sent
            expect(publish.uri).toBe('file:///Users/Me/My%20Project/a.ts');
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
            const wait = tracker.waitFor(opened, () => true, 5000);
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

        it('lets a later publish supersede the tentative empty one and learns the server publishes on close', async () => {
            const logs: string[] = [];
            const tracker = reopened(1000, logs);
            const stale = tracker.receive({ uri, diagnostics: [] });
            const wait = tracker.waitFor(uri, current(tracker), 5000);
            expect(tracker.latestPublish(uri)?.seq).not.toBe(stale.seq);
            tracker.receive({ uri, diagnostics: [{ range: {}, message: 'fresh' }] });
            expect((await wait)?.diagnostics.map((d) => d.message)).toEqual(['fresh']);
            expect(tracker.closeBehavior).toBe('publishes');
            expect(logs.some((l) => l.includes('Server publishes on close'))).toBe(true);
        });

        it('accepts the tentative publish when the window ends, keeping its receipt time', async () => {
            const logs: string[] = [];
            const tracker = reopened(40, logs);
            const candidate = tracker.receive({ uri, diagnostics: [] });
            const wait = tracker.waitFor(uri, current(tracker), 5000);
            const accepted = await wait;
            expect(accepted).toBe(candidate);
            expect(process.hrtime.bigint() - candidate.receivedAt).toBeGreaterThan(20_000_000n);
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
            expect(await tracker.waitFor(uri, current(tracker), 5000)).toBe(late);
            expect(tracker.closeBehavior).toBe('publishes');
        });

        it('lets a publish supersede a further empty candidate held after the reopen', async () => {
            const { tracker } = clearedAndReopened(1000, false);
            tracker.receive({ uri, diagnostics: [] });
            const wait = tracker.waitFor(uri, current(tracker), 5000);
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
    });

    it('resolves from the cache, and unregisters a wait once it settles', async () => {
        const tracker = new DiagnosticsTracker();
        tracker.receive({ uri, diagnostics: [] });
        expect(await tracker.waitFor(uri, () => true, 1000)).toBeDefined();
        expect(await tracker.waitFor(uri, () => false, 5)).toBeUndefined();
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

    it('learns push from a publish for a closed document', () => {
        const tracker = new DiagnosticsTracker();
        tracker.noteNotification('textDocument/didOpen', open());
        tracker.noteNotification('textDocument/didClose', { textDocument: { uri } });
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

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import type { PublishStatus } from 'lsbench';
import { DiagnosticsTracker, formatPublishLine, LspHarness, ServerOutput, WireLog, WireTrace } from 'lsbench';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('formatPublishLine', () => {
    const root = '/w';
    const diag = (message: string) => ({ range: {}, message });

    it('shows the workspace relative path, version, count, status and first message', () => {
        const line = formatPublishLine(
            { uri: 'file:///w/src/a.ts', version: 3, diagnostics: [diag('first'), diag('second')] },
            'current',
            root,
        );
        expect(line).toBe('Publish src/a.ts v=3 n=2 current: first');
    });

    it('shows - for an unversioned publish and no message for an empty one', () => {
        const line = formatPublishLine({ uri: 'file:///w/a.ts', diagnostics: [] }, 'stale', root);
        expect(line).toBe('Publish a.ts v=- n=0 stale');
    });

    it('decodes the relative path and keeps files whose name starts with ..', () => {
        expect(formatPublishLine({ uri: 'file:///w/..foo', diagnostics: [] }, 'current', root)).toBe(
            'Publish ..foo v=- n=0 current',
        );
        expect(formatPublishLine({ uri: 'file:///w/sub%20dir/a%23b.ts', diagnostics: [] }, 'current', root)).toBe(
            'Publish sub dir/a#b.ts v=- n=0 current',
        );
    });

    it('falls back to the URI outside the workspace and for other schemes', () => {
        expect(formatPublishLine({ uri: 'file:///other/a.ts', diagnostics: [] }, 'unopened', root)).toBe(
            'Publish file:///other/a.ts v=- n=0 unopened',
        );
        expect(formatPublishLine({ uri: 'file:///a.ts', diagnostics: [] }, 'unopened', root)).toBe(
            'Publish file:///a.ts v=- n=0 unopened',
        );
        expect(formatPublishLine({ uri: 'file:///w/a%2Fb.ts', diagnostics: [] }, 'unopened', root)).toBe(
            'Publish file:///w/a%2Fb.ts v=- n=0 unopened',
        );
        expect(formatPublishLine({ uri: 'untitled:Untitled-1', diagnostics: [] }, 'unopened', root)).toBe(
            'Publish untitled:Untitled-1 v=- n=0 unopened',
        );
    });

    it('puts the first message on one line, truncated to 100 characters', () => {
        const long = `line one\n  line two ${'x'.repeat(200)}`;
        const line = formatPublishLine(
            { uri: 'file:///w/a.ts', version: 1, diagnostics: [diag(long)] },
            'current',
            root,
        );
        const message = line.slice(line.indexOf(': ') + 2);
        expect(message).toHaveLength(100);
        expect(message.startsWith('line one line two xxx')).toBe(true);
        expect(message.endsWith('...')).toBe(true);
    });
});

describe('DiagnosticsTracker publish classification', () => {
    const uri = 'file:///w/a.ts';
    const open = (version = 1) => ({ textDocument: { uri, languageId: 'typescript', version, text: '' } });

    function tracker(): { tracker: DiagnosticsTracker; statuses: PublishStatus[] } {
        const statuses: PublishStatus[] = [];
        return {
            tracker: new DiagnosticsTracker(
                () => {},
                1000,
                (_, status) => statuses.push(status),
            ),
            statuses,
        };
    }

    it('classifies current, stale, closed and unopened publishes', () => {
        const { tracker: t, statuses } = tracker();
        t.receive({ uri, diagnostics: [] });
        t.noteNotification('textDocument/didOpen', open());
        t.receive({ uri, version: 1, diagnostics: [] });
        t.noteNotification('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [] });
        t.receive({ uri, version: 1, diagnostics: [] });
        t.receive({ uri, diagnostics: [] });
        t.noteNotification('textDocument/didClose', { textDocument: { uri } });
        t.receive({ uri, diagnostics: [] });
        expect(statuses).toEqual(['unopened', 'current', 'stale', 'current', 'closed']);
    });

    it('classifies a held empty publish after a reopen as close candidate', () => {
        const { tracker: t, statuses } = tracker();
        t.noteNotification('textDocument/didOpen', open());
        t.noteNotification('textDocument/didClose', { textDocument: { uri } });
        t.noteNotification('textDocument/didOpen', open());
        t.receive({ uri, diagnostics: [] });
        t.receive({ uri, diagnostics: [{ range: {}, message: 'fresh' }] });
        expect(statuses).toEqual(['close candidate', 'current']);
    });
});

describe('ServerOutput', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-server-output-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('prefixes each line with [server] in verbose mode, holding partial stderr lines', () => {
        const out: string[] = [];
        const output = new ServerOutput(undefined, true, (text) => out.push(text));
        output.stderr('one\ntw');
        output.stderr('o\nthr');
        output.message('log a\nlog b');
        output.flush();
        expect(out.join('')).toBe('[server] one\n[server] two\n[server] log a\n[server] log b\n[server] thr\n');
    });

    it('drops output without verbose mode or a file', () => {
        const out: string[] = [];
        const output = new ServerOutput(undefined, false, (text) => out.push(text));
        output.stderr('one\n');
        output.message('log');
        expect(out).toEqual([]);
    });

    it('appends to the file with a header per server start, never to the console', async () => {
        const file = path.join(tmpDir, 'server.log');
        fs.writeFileSync(file, 'earlier run\n');
        const out: string[] = [];
        const output = new ServerOutput(file, true, (text) => out.push(text));
        output.open('my-server', ['--stdio']);
        output.stderr('err line\npartial');
        output.message('log line');
        await output.close();
        output.open('my-server', ['--stdio']);
        output.message('second start');
        await output.close();
        output.message('after close');

        const lines = fs.readFileSync(file, 'utf-8').split('\n');
        expect(lines[0]).toBe('earlier run');
        expect(lines[1]).toMatch(/^===== \d{4}-\d\d-\d\dT[\d:.]+Z server start: my-server --stdio$/);
        expect(lines.slice(2, 5)).toEqual(['err line', 'log line', 'partial']);
        expect(lines[5]).toMatch(/server start: my-server --stdio$/);
        expect(lines.slice(6)).toEqual(['second start', '']);
        expect(out).toEqual([]);
    });

    it('keeps writing to the new file stream when the previous one errors late', async () => {
        const file = path.join(tmpDir, 'server.log');
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const output = new ServerOutput(file, false);
            output.open('my-server', []);
            const first = (output as unknown as { stream: fs.WriteStream }).stream;
            output.open('my-server', []);
            first.emit('error', new Error('late'));
            output.message('after the late error');
            await output.close();
            expect(fs.readFileSync(file, 'utf-8')).toContain('after the late error\n');
            expect(error).toHaveBeenCalledWith(`[lsbench] Cannot write server log ${file}: late`);
        } finally {
            error.mockRestore();
        }
    });
});

/** a fake server that writes to stderr, logs and publishes for the file named by argv while initializing */
const chattyServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
conn.onRequest('initialize', () => {
    process.stderr.write('stderr hello\\n');
    conn.sendNotification('window/logMessage', { type: 3, message: 'log hello' });
    conn.sendNotification('window/showMessage', { type: 3, message: 'show hello' });
    conn.sendNotification('$/logTrace', { message: 'trace hello' });
    return { capabilities: {} };
});
conn.onNotification('initialized', () => {
    conn.sendNotification('textDocument/publishDiagnostics', {
        uri: process.argv[1],
        version: 1,
        diagnostics: [{ range: {}, message: 'schema error' }],
    });
});
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
`;

describe('LspHarness verbose output', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-verbose-'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /** run the chatty server until its publish arrives, capturing stdout and stderr */
    async function run(serverLog?: string): Promise<string> {
        const captured: string[] = [];
        const capture = (chunk: unknown) => {
            captured.push(String(chunk));
            return true;
        };
        vi.spyOn(process.stdout, 'write').mockImplementation(capture);
        vi.spyOn(process.stderr, 'write').mockImplementation(capture);
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => capture(`${args.join(' ')}\n`));
        vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => capture(`${args.join(' ')}\n`));
        const uri = `file://${tmpDir}/src/config.yaml`;
        const harness = new LspHarness(
            { command: process.execPath, args: ['--input-type=module', '-e', chattyServer, uri] },
            tmpDir,
            true,
            { serverLog },
        );
        try {
            await harness.start();
            await vi.waitFor(() => expect(harness.latestPublish(uri)).toBeDefined());
            // stderr and notifications race each other, wait until all server output landed
            const landed = () => (serverLog ? fs.readFileSync(serverLog, 'utf-8') : captured.join(''));
            await vi.waitFor(() => expect(landed()).toMatch(/stderr hello[^]*trace hello|trace hello[^]*stderr hello/));
        } finally {
            await harness.stop();
        }
        vi.restoreAllMocks();
        return captured.join('');
    }

    it('logs publishes and prefixes server output on the console', async () => {
        const out = await run();
        expect(out).toContain('[lsbench] Publish src/config.yaml v=1 n=1 unopened: schema error\n');
        for (const line of ['stderr hello', 'log hello', 'showMessage: show hello', 'trace: trace hello']) {
            expect(out).toContain(`[server] ${line}\n`);
        }
    });

    it('writes server output to the server log instead of the console', async () => {
        const file = path.join(tmpDir, 'server.log');
        const out = await run(file);
        expect(out).toContain('[lsbench] Publish src/config.yaml');
        // the spawn line quotes the server source, so look for whole output lines only
        expect(out).not.toContain('[server]');
        expect(out).not.toMatch(/^(stderr|log) hello$/m);
        const log = fs.readFileSync(file, 'utf-8');
        expect(log).toMatch(/^===== .* server start: /);
        for (const line of ['stderr hello', 'log hello', 'showMessage: show hello', 'trace: trace hello']) {
            expect(log).toContain(`${line}\n`);
        }
    });
});

describe('WireTrace', () => {
    function readLines(file: string): Array<Record<string, unknown>> {
        return fs
            .readFileSync(file, 'utf-8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
    }

    it('writes messages, spawns and iterations as JSON lines and drops lines after close', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-wire-trace-'));
        try {
            const file = path.join(dir, 'trace.jsonl');
            const trace = new WireTrace(file, process.hrtime.bigint());
            trace.spawn('server', ['--stdio']);
            trace.iteration(2, false);
            trace.message('out', { jsonrpc: '2.0', id: 1, method: 'textDocument/hover', params: {} } as never);
            trace.message('in', { jsonrpc: '2.0', id: 1, result: null } as never);
            await trace.close();
            trace.message('in', { jsonrpc: '2.0', method: 'late' } as never);
            await trace.close();

            const lines = readLines(file);
            expect(lines).toEqual([
                { t: expect.any(Number), spawn: true, iso: expect.any(String), command: 'server', args: ['--stdio'] },
                { t: expect.any(Number), iteration: 2, warmup: false },
                {
                    t: expect.any(Number),
                    dir: 'out',
                    msg: { jsonrpc: '2.0', id: 1, method: 'textDocument/hover', params: {} },
                },
                { t: expect.any(Number), dir: 'in', msg: { jsonrpc: '2.0', id: 1, result: null } },
            ]);
            for (let i = 1; i < lines.length; i++) {
                expect(lines[i].t as number).toBeGreaterThanOrEqual(lines[i - 1].t as number);
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('measures t from the origin in milliseconds', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-wire-trace-'));
        try {
            const file = path.join(dir, 'trace.jsonl');
            // an origin 5 seconds ago
            const trace = new WireTrace(file, process.hrtime.bigint() - 5_000_000_000n);
            trace.iteration(1, true);
            await trace.close();
            const [line] = readLines(file);
            expect(line.t as number).toBeGreaterThanOrEqual(5000);
            expect(line.t as number).toBeLessThan(6000);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('WireLog', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    function wireLog(): { log: WireLog; lines: string[]; advance: (ms: number) => void } {
        const lines: string[] = [];
        let now = 1000;
        const log = new WireLog(
            '/w',
            (line) => lines.push(line),
            () => now,
        );
        return { log, lines, advance: (ms) => (now += ms) };
    }

    const uri = 'file:///w/src/main.ts';

    it('pairs an outgoing request with its response, timing and summarizing it', () => {
        const { log, lines, advance } = wireLog();
        log.message('out', {
            jsonrpc: '2.0',
            id: 4,
            method: 'textDocument/completion',
            params: { textDocument: { uri }, position: { line: 12, character: 8 } },
        } as never);
        advance(38.4);
        log.message('in', { jsonrpc: '2.0', id: 4, result: { isIncomplete: false, items: [{}, {}] } } as never);
        expect(lines).toEqual([
            '→ textDocument/completion #4 src/main.ts:12:8',
            '← textDocument/completion #4 (38ms) 2 items',
        ]);
    });

    it('summarizes null, locations, items and diagnostic reports', () => {
        const { log, lines } = wireLog();
        const results = [
            null,
            [{ uri, range: {} }],
            [{ targetUri: uri }, { targetUri: uri }],
            [{ label: 'a' }],
            [],
            { kind: 'full', items: [{}, {}, {}] },
            { kind: 'unchanged', resultId: '1' },
            { contents: 'hover' },
        ];
        for (const [id, result] of results.entries()) {
            log.message('out', { jsonrpc: '2.0', id, method: 'm' } as never);
            log.message('in', { jsonrpc: '2.0', id, result } as never);
        }
        const replies = lines.filter((line) => line.startsWith('←')).map((line) => line.replace(/^.*\) /, ''));
        expect(replies).toEqual([
            'null',
            '1 location',
            '2 locations',
            '1 item',
            '0 items',
            '3 diagnostics',
            'unchanged',
            'ok',
        ]);
    });

    it('shows the code and message of an error response, and a cancelled request', () => {
        const { log, lines } = wireLog();
        log.message('out', { jsonrpc: '2.0', id: 1, method: 'textDocument/hover', params: {} } as never);
        log.message('in', {
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32601, message: 'Unhandled method\ntextDocument/hover' },
        } as never);
        log.message('out', { jsonrpc: '2.0', id: 2, method: 'textDocument/definition' } as never);
        log.message('out', { jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 2 } } as never);
        log.message('in', { jsonrpc: '2.0', id: 2, error: { code: -32800, message: 'Request cancelled' } } as never);
        expect(lines).toEqual([
            '→ textDocument/hover #1',
            '← textDocument/hover #1 (0ms) error -32601 Unhandled method textDocument/hover',
            '→ textDocument/definition #2',
            '→ $/cancelRequest #2 (textDocument/definition)',
            '← textDocument/definition #2 (0ms) cancelled -32800 Request cancelled',
        ]);
    });

    it('shows a server request and the reply to it', () => {
        const { log, lines } = wireLog();
        log.message('in', { jsonrpc: '2.0', id: 0, method: 'workspace/configuration', params: { items: [] } } as never);
        log.message('out', { jsonrpc: '2.0', id: 0, result: [null] } as never);
        log.message('in', { jsonrpc: '2.0', id: 1, method: 'window/workDoneProgress/create', params: {} } as never);
        log.message('out', { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'nope' } } as never);
        expect(lines).toEqual([
            '← workspace/configuration #0 (server request)',
            '→ workspace/configuration #0 reply',
            '← window/workDoneProgress/create #1 (server request)',
            '→ window/workDoneProgress/create #1 error -32603 nope',
        ]);
    });

    it('shows notifications both ways, counting published diagnostics by severity', () => {
        const { log, lines } = wireLog();
        log.message('out', { jsonrpc: '2.0', method: 'initialized', params: {} } as never);
        log.message('out', {
            jsonrpc: '2.0',
            method: 'textDocument/didOpen',
            params: { textDocument: { uri: 'file:///other/a.ts', languageId: 'typescript', version: 1, text: '' } },
        } as never);
        log.message('in', {
            jsonrpc: '2.0',
            method: 'textDocument/publishDiagnostics',
            params: { uri, diagnostics: [{ severity: 1 }, { severity: 1 }, { severity: 2 }, {}] },
        } as never);
        log.message('in', {
            jsonrpc: '2.0',
            method: 'textDocument/publishDiagnostics',
            params: { uri, diagnostics: [] },
        } as never);
        log.message('in', { jsonrpc: '2.0', method: 'custom/status', params: { busy: true } } as never);
        expect(lines).toEqual([
            '→ initialized',
            '→ textDocument/didOpen file:///other/a.ts',
            '← textDocument/publishDiagnostics src/main.ts: 2 errors, 1 warning, 1 diagnostic',
            '← textDocument/publishDiagnostics src/main.ts: no diagnostics',
            '← custom/status',
        ]);
    });

    it('leaves out progress and log notifications the console already shows', () => {
        const { log, lines } = wireLog();
        for (const method of ['$/progress', 'window/logMessage', '$/logTrace']) {
            log.message('in', { jsonrpc: '2.0', method, params: {} } as never);
        }
        expect(lines).toEqual([]);
    });

    it('prints a response to an unknown id without a duration', () => {
        const { log, lines } = wireLog();
        log.message('in', { jsonrpc: '2.0', id: 9, result: null } as never);
        expect(lines).toEqual(['← response #9 null']);
    });

    it('colors arrows, methods, durations and errors when color is forced', () => {
        vi.stubEnv('FORCE_COLOR', '1');
        const { log, lines, advance } = wireLog();
        log.message('out', { jsonrpc: '2.0', id: 1, method: 'textDocument/hover' } as never);
        advance(1500);
        log.message('in', { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'boom' } } as never);
        expect(lines).toEqual([
            '\x1b[36m→\x1b[39m \x1b[1mtextDocument/hover\x1b[22m \x1b[2m#1\x1b[22m',
            '\x1b[32m←\x1b[39m \x1b[1mtextDocument/hover\x1b[22m \x1b[2m#1\x1b[22m ' +
                '\x1b[1m\x1b[33m(1500ms)\x1b[39m\x1b[22m \x1b[31merror -32603 boom\x1b[39m',
        ]);
    });
});

const wireServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
conn.onRequest('initialize', () => ({ capabilities: { hoverProvider: true, completionProvider: {} } }));
conn.onNotification('initialized', async () => {
    await conn.sendRequest('workspace/configuration', { items: [{ section: 'demo' }] });
    conn.sendNotification('custom/ready', {});
});
conn.onRequest('textDocument/completion', () => ({ isIncomplete: false, items: [{ label: 'a' }, { label: 'b' }] }));
conn.onRequest('textDocument/hover', () => {
    throw new rpc.ResponseError(-32603, 'hover broke');
});
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
`;

describe('LspHarness wire lines in verbose mode', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    async function run(): Promise<string[]> {
        const lines: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
            lines.push(args.join(' '));
        });
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const harness = new LspHarness(
            { command: process.execPath, args: ['--input-type=module', '-e', wireServer] },
            os.tmpdir(),
            true,
        );
        try {
            await harness.start();
            await vi.waitFor(() => expect(stripVTControlCharacters(lines.join('\n'))).toContain('← custom/ready'));
            const uri = pathToFileURL(path.join(os.tmpdir(), 'main.ts')).href;
            await harness.sendRequest('textDocument/completion', {
                textDocument: { uri },
                position: { line: 12, character: 8 },
            });
            await expect(harness.sendRequest('textDocument/hover', {})).rejects.toThrow('hover broke');
        } finally {
            await harness.stop();
        }
        vi.restoreAllMocks();
        return lines;
    }

    it('logs requests, responses, notifications, server requests and errors', async () => {
        vi.stubEnv('FORCE_COLOR', '0');
        const lines = await run();
        const expected = [
            /^\[lsbench\] → initialize #0$/,
            /^\[lsbench\] ← initialize #0 \(\d+ms\) ok$/,
            /^\[lsbench\] → initialized$/,
            /^\[lsbench\] ← workspace\/configuration #0 \(server request\)$/,
            /^\[lsbench\] → workspace\/configuration #0 reply$/,
            /^\[lsbench\] ← custom\/ready$/,
            /^\[lsbench\] → textDocument\/completion #1 main\.ts:12:8$/,
            /^\[lsbench\] ← textDocument\/completion #1 \(\d+ms\) 2 items$/,
            /^\[lsbench\] → textDocument\/hover #2$/,
            /^\[lsbench\] ← textDocument\/hover #2 \(\d+ms\) error -32603 hover broke$/,
            /^\[lsbench\] → shutdown #3$/,
            /^\[lsbench\] → exit$/,
        ];
        let from = 0;
        for (const pattern of expected) {
            const index = lines.findIndex((line, i) => i >= from && pattern.test(line));
            expect(index, `${pattern} after line ${from} in\n${lines.join('\n')}`).toBeGreaterThanOrEqual(from);
            from = index + 1;
        }
    });

    it('colors the lines when color is forced', async () => {
        vi.stubEnv('FORCE_COLOR', '1');
        const lines = await run();
        expect(lines).toContain(
            '\x1b[2m\x1b[35m[lsbench]\x1b[39m\x1b[22m \x1b[36m→\x1b[39m \x1b[1minitialize\x1b[22m \x1b[2m#0\x1b[22m',
        );
        expect(lines.some((line) => line.includes('\x1b[31merror -32603 hover broke\x1b[39m'))).toBe(true);
    });
});

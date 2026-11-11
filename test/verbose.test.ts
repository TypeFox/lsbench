import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PublishStatus } from 'lsbench';
import { DiagnosticsTracker, formatPublishLine, LspHarness, ServerOutput } from 'lsbench';
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

    it('falls back to the URI outside the workspace and for other schemes', () => {
        expect(formatPublishLine({ uri: 'file:///other/a.ts', diagnostics: [] }, 'unopened', root)).toBe(
            'Publish file:///other/a.ts v=- n=0 unopened',
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

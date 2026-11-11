import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// runs the built CLI end to end with --server-log and -v, against a fake server that
// writes to stderr, logs a message and publishes diagnostics for an opened document

const chattyServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
conn.onRequest('initialize', () => {
    process.stderr.write('stderr hello\\n');
    conn.sendNotification('window/logMessage', { type: 3, message: 'log hello' });
    return { capabilities: { textDocumentSync: 1 } };
});
conn.onNotification('textDocument/didOpen', ({ textDocument }) => {
    conn.sendNotification('textDocument/publishDiagnostics', {
        uri: textDocument.uri,
        version: textDocument.version,
        diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'schema error' }],
    });
});
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
`;

describe('lsbench CLI with --server-log', () => {
    let tmpDir: string;
    let script: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-cli-server-log-'));
        fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'a: 1\n', 'utf-8');
        script = path.join(tmpDir, 'actions.ts');
        fs.writeFileSync(
            script,
            `export default async function (ctx: any): Promise<void> {
                await ctx.openDocument('config.yaml');
                await ctx.waitForDiagnostics('config.yaml', { timeout: 5000 });
                await ctx.closeDocument('config.yaml');
            }`,
            'utf-8',
        );
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function runCli(...flags: string[]) {
        return spawnSync(
            process.execPath,
            [
                path.resolve('dist/cli.js'),
                process.execPath,
                '-w',
                tmpDir,
                '-s',
                script,
                '-n',
                '1',
                '--warmup',
                '0',
                '-v',
                ...flags,
                '--',
                '--input-type=module',
                '-e',
                chattyServer,
            ],
            { encoding: 'utf-8' },
        );
    }

    it('logs publishes and prefixes server output without --server-log', () => {
        const result = runCli();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain('[lsbench] Publish config.yaml v=1 n=1 current: schema error');
        expect(result.stderr).toMatch(/^\[server\] stderr hello$/m);
        expect(result.stderr).toMatch(/^\[server\] log hello$/m);
    });

    it('appends server output to the file with a header per run, keeping the console clean', () => {
        const log = path.join(tmpDir, 'server.log');
        for (let i = 0; i < 2; i++) {
            const result = runCli('--server-log', log);
            expect(result.status, result.stderr).toBe(0);
            expect(result.stderr).toContain('[lsbench] Publish config.yaml');
            expect(result.stderr).not.toContain('[server]');
            expect(result.stdout).not.toContain('[server]');
        }
        const content = fs.readFileSync(log, 'utf-8');
        expect(content.match(/^===== .* server start: /gm)).toHaveLength(2);
        expect(content.match(/^stderr hello$/gm)).toHaveLength(2);
        expect(content.match(/^log hello$/gm)).toHaveLength(2);
    });

    it('rejects a server log that cannot be written', () => {
        const result = runCli('--server-log', path.join(tmpDir, 'missing', 'server.log'));
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/Error: Cannot write server log/);
    });
});

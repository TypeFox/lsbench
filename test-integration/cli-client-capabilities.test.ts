import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// runs the built CLI end to end with --client-capabilities-file, against a fake
// server that echoes the client capabilities it received back as its own

const echoServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
conn.onRequest('initialize', (params) => ({ capabilities: { received: params.capabilities } }));
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
`;

describe('lsbench CLI with --client-capabilities-file', () => {
    let tmpDir: string;
    let script: string;
    let dumpFile: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-cli-caps-'));
        script = path.join(tmpDir, 'actions.ts');
        dumpFile = path.join(tmpDir, 'received.json');
        // the script dumps what the server echoed back, so the test can inspect it
        fs.writeFileSync(
            script,
            `import * as fs from 'node:fs';
            export default async function (ctx: any): Promise<void> {
                fs.writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify(ctx.capabilities.received));
            }`,
            'utf-8',
        );
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function runCli(capsFile: string) {
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
                '--client-capabilities-file',
                capsFile,
                '--',
                '--input-type=module',
                '-e',
                echoServer,
            ],
            { encoding: 'utf-8' },
        );
    }

    function writeCaps(name: string, content: string): string {
        const file = path.join(tmpDir, name);
        fs.writeFileSync(file, content, 'utf-8');
        return file;
    }

    it('sends the file deep merged over the default client capabilities', () => {
        const capsFile = writeCaps(
            'caps.json',
            JSON.stringify({
                textDocument: { hover: { contentFormat: ['plaintext'] } },
                experimental: { custom: true },
            }),
        );
        const result = runCli(capsFile);
        expect(result.status, result.stderr).toBe(0);
        const received = JSON.parse(fs.readFileSync(dumpFile, 'utf-8'));
        expect(received.textDocument.hover).toEqual({ dynamicRegistration: true, contentFormat: ['plaintext'] });
        expect(received.workspace.didChangeWatchedFiles).toEqual({
            dynamicRegistration: true,
            relativePatternSupport: true,
        });
        expect(received.experimental).toEqual({ custom: true });
    });

    it('rejects a missing file', () => {
        const result = runCli(path.join(tmpDir, 'missing.json'));
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/Client capabilities file not found/);
    });

    it('rejects invalid JSON', () => {
        const result = runCli(writeCaps('invalid.json', '{ not json'));
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/Failed to parse client capabilities file/);
    });

    it('rejects JSON that is not an object', () => {
        const result = runCli(writeCaps('array.json', '[1, 2]'));
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/must contain a JSON object/);
    });
});

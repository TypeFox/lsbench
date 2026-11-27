import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const server = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
conn.onRequest('initialize', () => ({ capabilities: { hoverProvider: true } }));
conn.onNotification('initialized', async () => {
    await conn.sendRequest('workspace/configuration', { items: [{ section: 'demo' }] });
    conn.sendNotification('window/logMessage', { type: 3, message: 'configured' });
});
conn.onRequest('textDocument/hover', () => {
    throw new rpc.ResponseError(-32603, 'hover broke');
});
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
`;

describe('lsbench CLI with --verbose', () => {
    let tmpDir: string;
    let script: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-cli-verbose-'));
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

    function run(env: Record<string, string | undefined>, extra: string[] = []) {
        const childEnv: NodeJS.ProcessEnv = { ...process.env };
        delete childEnv.FORCE_COLOR;
        delete childEnv.NO_COLOR;
        for (const [key, value] of Object.entries(env)) {
            childEnv[key] = value;
        }
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
                ...extra,
                '--',
                '--input-type=module',
                '-e',
                server,
            ],
            { encoding: 'utf-8', env: childEnv },
        );
    }

    it('prints each message with direction, method, id and timing', () => {
        const result = run({ NO_COLOR: '1' });
        expect(result.status).toBe(0);
        expect(result.stderr).not.toContain('\x1b[');
        expect(result.stderr).toMatch(/^\[lsbench\] → initialize #0$/m);
        expect(result.stderr).toMatch(/^\[lsbench\] ← initialize #0 \(\d+ms\) ok$/m);
        expect(result.stderr).toMatch(/^\[lsbench\] → initialized$/m);
        expect(result.stderr).toMatch(/^\[lsbench\] ← workspace\/configuration #0 \(server request\)$/m);
        expect(result.stderr).toMatch(/^\[lsbench\] → workspace\/configuration #0 reply$/m);
        expect(result.stderr).toMatch(/^\[lsbench\] → textDocument\/hover #1$/m);
        expect(result.stderr).toMatch(/^\[lsbench\] ← textDocument\/hover #1 \(\d+ms\) error -32603 hover broke$/m);
        expect(result.stderr).toMatch(/^\[server\] configured$/m);
    });

    it('colors the console when color is forced and keeps trace and server log files plain', () => {
        const trace = path.join(tmpDir, 'trace.jsonl');
        const serverLog = path.join(tmpDir, 'server.log');
        const result = run({ FORCE_COLOR: '1' }, ['--trace', trace, '--server-log', serverLog]);
        expect(result.status).toBe(0);
        expect(result.stderr).toContain('\x1b[36m→\x1b[39m \x1b[1minitialize\x1b[22m');
        expect(result.stderr).toContain('\x1b[31merror -32603 hover broke\x1b[39m');
        expect(fs.readFileSync(trace, 'utf-8')).not.toContain('\x1b[');
        expect(fs.readFileSync(serverLog, 'utf-8')).toContain('configured\n');
        expect(fs.readFileSync(serverLog, 'utf-8')).not.toContain('\x1b[');
    });
});

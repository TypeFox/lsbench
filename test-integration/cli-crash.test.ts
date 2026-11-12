import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// runs the built CLI end to end against a fake server that exits on shutdown
// without replying, and expects the report to survive and the exit to be non zero

const crashOnShutdownServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
conn.onRequest('initialize', () => ({ capabilities: { hoverProvider: true } }));
conn.onRequest('textDocument/hover', () => null);
conn.onRequest('shutdown', () => process.exit(3));
conn.listen();
`;

// replies to shutdown, then exits 1 on exit, as typescript 7 does
const exitOneServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
conn.onRequest('initialize', () => ({ capabilities: { hoverProvider: true } }));
conn.onRequest('textDocument/hover', () => null);
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(1));
conn.listen();
`;

// exits 0 on shutdown without replying, the fix 4 fake server
const quitOnShutdownServer = crashOnShutdownServer.replace('process.exit(3)', 'process.exit(0)');

describe('lsbench CLI with a server crashing at shutdown', () => {
    let tmpDir: string;
    let script: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-cli-crash-'));
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

    it('exits non zero with the exit code logged, and still writes the report', () => {
        const output = path.join(tmpDir, 'cli-report.json');
        const result = spawnSync(
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
                '-o',
                output,
                '--',
                '--input-type=module',
                '-e',
                crashOnShutdownServer,
            ],
            { encoding: 'utf-8' },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/exited abnormally during final teardown \(exit code 3\)/);
        const report = JSON.parse(fs.readFileSync(output, 'utf-8'));
        expect(report.runs).toHaveLength(1);
        // the crash at shutdown is kept as a failed lifecycle/shutdown timing
        expect(report.summary['lifecycle/shutdown']).toMatchObject({ count: 1, failure_rate: 1 });
        expect(report.summary['lifecycle/initialize']).toMatchObject({ count: 1, failure_rate: 0 });
    });

    function runCli(server: string, output: string, extra: string[]) {
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
                '2',
                '--warmup',
                '0',
                '--restart',
                '-o',
                output,
                ...extra,
                '--',
                '--input-type=module',
                '-e',
                server,
            ],
            { encoding: 'utf-8' },
        );
    }

    it('exits zero with --allow-exit-code for a server exiting 1 after a replied shutdown', () => {
        const output = path.join(tmpDir, 'cli-allowed.json');
        const result = runCli(exitOneServer, output, ['--allow-exit-code', '1']);
        expect(result.stderr).not.toMatch(/abnormally/);
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/Tolerated exits: 2 \(code 1 after shutdown, allowed\)/);
        const report = JSON.parse(fs.readFileSync(output, 'utf-8'));
        expect(report.abnormal_exits).toBeUndefined();
        expect(report.tolerated_exits).toHaveLength(2);
    });

    it('still exits non zero without --allow-exit-code for that server', () => {
        const result = runCli(exitOneServer, path.join(tmpDir, 'cli-not-allowed.json'), []);
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/exited abnormally during teardown of iteration 1 \(exit code 1\)/);
    });

    it('still exits non zero for a server exiting 0 without a shutdown reply, whatever is allowed', () => {
        const output = path.join(tmpDir, 'cli-quit.json');
        const result = runCli(quitOnShutdownServer, output, ['--allow-exit-code', '0', '--allow-exit-code', '1']);
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/exited abnormally during teardown of iteration 1 \(exit code 0\)/);
        const report = JSON.parse(fs.readFileSync(output, 'utf-8'));
        expect(report.abnormal_exits).toHaveLength(2);
        expect(report.tolerated_exits).toBeUndefined();
    });

    it('rejects an invalid --allow-exit-code', () => {
        const result = runCli(exitOneServer, path.join(tmpDir, 'cli-invalid.json'), ['--allow-exit-code', 'one']);
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/--allow-exit-code must be a non-negative integer/);
    });
});

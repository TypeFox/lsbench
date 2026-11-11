import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BenchReport } from 'lsbench';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// runs the built CLI end to end with --wait-idle, against a fake server that reports
// loading progress for a while after initialized

const progressServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
conn.onRequest('initialize', () => ({ capabilities: { hoverProvider: true } }));
conn.onNotification('initialized', async () => {
    await conn.sendRequest('window/workDoneProgress/create', { token: 'load' });
    conn.sendNotification('$/progress', { token: 'load', value: { kind: 'begin', title: 'Loading workspace' } });
    setTimeout(() => conn.sendNotification('$/progress', { token: 'load', value: { kind: 'end' } }), 300);
});
conn.onRequest('textDocument/hover', () => null);
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
`;

describe('lsbench CLI with --wait-idle', () => {
    let tmpDir: string;
    let script: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-cli-idle-'));
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

    function runCli(output: string, ...flags: string[]) {
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
                '-o',
                output,
                ...flags,
                '--',
                '--input-type=module',
                '-e',
                progressServer,
            ],
            { encoding: 'utf-8' },
        );
    }

    function idleTimings(output: string) {
        const report = JSON.parse(fs.readFileSync(output, 'utf-8')) as BenchReport;
        return report.lifecycle?.filter((t) => t.method === 'lifecycle/idle') ?? [];
    }

    it('waits for the server to become idle with the default timeout and logs progress titles', () => {
        const output = path.join(tmpDir, 'bare.json');
        const result = runCli(output, '--verbose', '--wait-idle');
        expect(result.status, result.stderr).toBe(0);
        const [idle] = idleTimings(output);
        expect(idle).toMatchObject({ result: 'ok', success: true });
        expect(idle.duration_ms).toBeGreaterThanOrEqual(250);
        expect(result.stderr).not.toMatch(/Warning: server not idle/);
        expect(result.stdout).toMatch(/Wait idle: {2}up to 30000ms/);
        expect(result.stderr).toMatch(/Progress begin: Loading workspace/);
        expect(result.stderr).toMatch(/Progress end: Loading workspace/);
    });

    it('records a timeout when the server is not idle within the given ms', () => {
        const output = path.join(tmpDir, 'short.json');
        const result = runCli(output, '--wait-idle', '50');
        expect(result.status, result.stderr).toBe(0);
        expect(idleTimings(output)).toMatchObject([{ result: 'timeout', success: false }]);
        expect(result.stderr).toMatch(/Warning: server not idle after 50ms/);
    });

    it('does not wait without the flag', () => {
        const output = path.join(tmpDir, 'none.json');
        const result = runCli(output);
        expect(result.status, result.stderr).toBe(0);
        expect(idleTimings(output)).toEqual([]);
    });

    it('rejects an invalid value', () => {
        const result = runCli(path.join(tmpDir, 'invalid.json'), '--wait-idle', 'soon');
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/--wait-idle must be a positive integer/);
    });
});

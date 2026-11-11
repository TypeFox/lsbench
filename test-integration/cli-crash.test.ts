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
});

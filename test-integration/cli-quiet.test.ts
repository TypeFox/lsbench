import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const cleanServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
conn.onRequest('initialize', () => ({ capabilities: { hoverProvider: true } }));
conn.onRequest('textDocument/hover', () => null);
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
`;

const crashOnShutdownServer = cleanServer.replace(
    "conn.onRequest('shutdown', () => null);",
    "conn.onRequest('shutdown', () => process.exit(3));",
);

describe('lsbench CLI with --quiet', () => {
    let tmpDir: string;
    let script: string;
    let throwing: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-cli-quiet-'));
        script = path.join(tmpDir, 'actions.ts');
        fs.writeFileSync(
            script,
            `export default async function (ctx: any): Promise<void> {
                await ctx.request('textDocument/hover', {});
            }`,
            'utf-8',
        );
        throwing = path.join(tmpDir, 'throwing.ts');
        fs.writeFileSync(
            throwing,
            `export default async function (): Promise<void> {
                throw new Error('boom');
            }`,
            'utf-8',
        );
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function cli(args: string[]) {
        return spawnSync(process.execPath, [path.resolve('dist/cli.js'), ...args], { encoding: 'utf-8' });
    }

    function run(server: string, actions: string, extra: string[]) {
        return cli([
            process.execPath,
            '-w',
            tmpDir,
            '-s',
            actions,
            '-n',
            '1',
            '--warmup',
            '0',
            ...extra,
            '--',
            '--input-type=module',
            '-e',
            server,
        ]);
    }

    it('prints nothing for a passing run, exits 0 and writes the report', () => {
        const output = path.join(tmpDir, 'report.json');
        const result = run(cleanServer, script, ['-q', '-o', output]);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(JSON.parse(fs.readFileSync(output, 'utf-8')).runs).toHaveLength(1);
    });

    it('prints the error of a failing run on stderr and exits non zero', () => {
        const output = path.join(tmpDir, 'crash.json');
        const result = run(crashOnShutdownServer, script, ['--quiet', '-o', output]);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(/exited abnormally during final teardown \(exit code 3\)/);
        expect(result.stderr).not.toContain('Warning:');
        expect(result.status).toBe(1);
    });

    it('prints action script errors on stderr', () => {
        const result = run(cleanServer, throwing, ['-q']);
        expect(result.stdout).toBe('');
        expect(result.stderr.trim().split('\n')).toEqual([
            'Error: iteration 1 failed: boom',
            'Error: action script failed in 1 of 1 iterations',
        ]);
        expect(result.status).toBe(1);
    });

    it('rejects --quiet with --verbose before starting the server', () => {
        const result = run(cleanServer, script, ['-q', '-v']);
        expect(result.stdout).toBe('');
        expect(result.stderr.trim()).toBe('Error: --quiet and --verbose cannot be combined');
        expect(result.status).toBe(1);
    });

    it('writes a baseline silently and still prints the check verdict', () => {
        const output = path.join(tmpDir, 'baseline-report.json');
        expect(run(cleanServer, script, ['-q', '-o', output]).status).toBe(0);
        const baseline = path.join(tmpDir, 'baseline.json');

        const written = cli(['baseline', output, '-o', baseline, '-q']);
        expect(written.stdout).toBe('');
        expect(written.status).toBe(0);
        expect(fs.existsSync(baseline)).toBe(true);

        const checked = cli(['check', output, '-b', baseline, '-q', '--slack-ms', '1000']);
        expect(checked.stdout).not.toBe('');
        expect(checked.status).toBe(0);

        const json = cli(['check', output, '-b', baseline, '-q', '--json', '--slack-ms', '1000']);
        expect(JSON.parse(json.stdout)).toMatchObject({ pass: true });
        expect(json.status).toBe(0);
    });
});

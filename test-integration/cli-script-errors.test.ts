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

describe('lsbench CLI with a throwing action script', () => {
    let tmpDir: string;
    let passing: string;
    let throwing: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-cli-script-errors-'));
        passing = path.join(tmpDir, 'passing.ts');
        fs.writeFileSync(
            passing,
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

    function run(actions: string, extra: string[]) {
        return cli([
            process.execPath,
            '-w',
            tmpDir,
            '-s',
            actions,
            '-n',
            '2',
            '--warmup',
            '1',
            ...extra,
            '--',
            '--input-type=module',
            '-e',
            cleanServer,
        ]);
    }

    for (const restart of [false, true]) {
        it(`prints the error on stderr, records it and exits 1 (${restart ? 'restart' : 'keep alive'})`, () => {
            const output = path.join(tmpDir, `throwing-${restart}.json`);
            const result = run(throwing, ['-o', output, ...(restart ? ['--restart'] : [])]);
            expect(result.stderr).toContain('ERROR: boom');
            expect(result.stderr).toContain('Error: action script failed in 2 of 2 iterations and 1 of 1 warmups');
            expect(result.stdout).not.toContain('boom');
            expect(result.status).toBe(1);

            const report = JSON.parse(fs.readFileSync(output, 'utf-8'));
            expect(report.runs.map((r: { error?: string }) => r.error)).toEqual(['boom', 'boom']);
            expect(report.script_errors).toEqual([
                { during: 'warmup 1', message: 'boom' },
                { during: 'iteration 1', message: 'boom' },
                { during: 'iteration 2', message: 'boom' },
            ]);
            expect(report.iteration_summary.failed).toBe(2);
        });
    }

    it('exits 0 and keeps the report shape for a passing script', () => {
        const output = path.join(tmpDir, 'passing.json');
        const result = run(passing, ['-o', output]);
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        const report = JSON.parse(fs.readFileSync(output, 'utf-8'));
        expect(report.script_errors).toBeUndefined();
        expect(report.iteration_summary).not.toHaveProperty('failed');
        for (const r of report.runs) {
            expect(r).not.toHaveProperty('error');
        }
    });

    it('fails the check of a report with failed iterations', () => {
        const clean = path.join(tmpDir, 'clean.json');
        expect(run(passing, ['-q', '-o', clean]).status).toBe(0);
        const baseline = path.join(tmpDir, 'baseline.json');
        expect(cli(['baseline', clean, '-o', baseline, '-q']).status).toBe(0);
        const failing = path.join(tmpDir, 'failing.json');
        expect(run(throwing, ['-q', '-o', failing]).status).toBe(1);

        const checked = cli(['check', failing, '-b', baseline, '--json']);
        expect(checked.status).toBe(1);
        expect(JSON.parse(checked.stdout).failures).toContainEqual({
            method: '(run)',
            field: 'failed_iterations',
            baseline: 0,
            actual: 2,
            rule: 'iterations must not fail',
        });
    });
});

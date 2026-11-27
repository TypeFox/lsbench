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

const START = '\u001b]7501;';
const END = '\u001b\\';

function reports(text: string): Record<string, string>[] {
    const found: Record<string, string>[] = [];
    for (let at = text.indexOf(START); at !== -1; at = text.indexOf(START, at + 1)) {
        const body = text.slice(at + START.length, text.indexOf(END, at));
        const fields: Record<string, string> = {};
        for (const pair of body.split(':')) {
            const at = pair.indexOf('=');
            const key = pair.slice(0, at);
            const value = pair.slice(at + 1);
            fields[key] = key === 'title' || key === 'msg' ? Buffer.from(value, 'base64').toString('utf8') : value;
        }
        found.push(fields);
    }
    return found;
}

describe('lsbench CLI with --status', () => {
    let tmpDir: string;
    let script: string;
    let throwing: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-cli-status-'));
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

    function run(actions: string, extra: string[], env: Record<string, string> = {}) {
        const { LSBENCH_STATUS: _ignored, ...base } = process.env;
        return spawnSync(
            process.execPath,
            [
                path.resolve('dist/cli.js'),
                process.execPath,
                '-w',
                tmpDir,
                '-s',
                actions,
                '-n',
                '4',
                '--warmup',
                '1',
                ...extra,
                '--',
                '--input-type=module',
                '-e',
                cleanServer,
            ],
            { encoding: 'utf-8', env: { ...base, ...env } },
        );
    }

    it('reports working with increasing progress and ends done', () => {
        const result = run(script, ['--status', '-o', path.join(tmpDir, 'report.json')]);
        expect(result.status).toBe(0);
        expect(result.stdout).not.toContain('\u001b]7501');
        const states = reports(result.stderr);
        expect(states.map((report) => [report.state, report.progress, report.msg])).toEqual([
            ['working', undefined, `Starting ${process.execPath}`],
            ['working', undefined, 'Warmup 1/1'],
            ['working', '0', 'Iteration 1/4'],
            ['working', '25', 'Iteration 2/4'],
            ['working', '50', 'Iteration 3/4'],
            ['working', '75', 'Iteration 4/4'],
            ['done', undefined, expect.stringMatching(/^Median \d+(\.\d+)?ms over 4 iterations$/)],
        ]);
        for (const report of states) {
            expect(report).toMatchObject({ app: 'lsbench', title: path.basename(tmpDir) });
        }
    });

    it('stays working across restarts', () => {
        const result = run(script, ['--restart', '-q'], { LSBENCH_STATUS: '1' });
        expect(result.status).toBe(0);
        const states = reports(result.stderr);
        expect(states.filter((report) => report.msg?.startsWith('Starting'))).toHaveLength(5);
        expect(states.slice(0, -1).every((report) => report.state === 'working')).toBe(true);
        expect(states.at(-1)?.state).toBe('done');
    });

    it('ends with error when the action script throws', () => {
        const result = run(throwing, ['--status', '-q']);
        expect(result.status).toBe(1);
        expect(reports(result.stderr).at(-1)).toMatchObject({
            state: 'error',
            msg: 'action script failed in 4 of 4 iterations and 1 of 1 warmups',
        });
    });

    it('reports nothing on a pipe by default, nor with --no-status', () => {
        for (const result of [run(script, []), run(script, ['--no-status'], { LSBENCH_STATUS: '1' })]) {
            expect(result.status).toBe(0);
            expect(result.stdout).not.toContain('\u001b]7501');
            expect(result.stderr).not.toContain('\u001b]7501');
        }
    });
});

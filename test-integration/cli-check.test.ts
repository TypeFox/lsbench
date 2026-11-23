import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('lsbench check baseline format', () => {
    let tmpDir: string;
    let reportFile: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-cli-check-'));
        reportFile = path.join(tmpDir, 'report.json');
        fs.writeFileSync(
            reportFile,
            JSON.stringify({ iterations: 1, warmup: 0, restart_between_iterations: false, summary: {} }),
            'utf-8',
        );
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function check(format: unknown): ReturnType<typeof spawnSync> {
        const baselineFile = path.join(tmpDir, 'baseline.json');
        const base = {
            lsbench_baseline: format,
            iterations: 1,
            warmup: 0,
            restart_between_iterations: false,
            summary: {},
        };
        fs.writeFileSync(baselineFile, JSON.stringify(base), 'utf-8');
        return spawnSync(process.execPath, [path.resolve('dist/cli.js'), 'check', reportFile, '-b', baselineFile], {
            encoding: 'utf-8',
        });
    }

    it('accepts a baseline of the current format', () => {
        expect(check(1).status).toBe(0);
    });

    it.each([
        [2, 'unsupported baseline format 2 (supported: 1)'],
        ['1', 'unsupported baseline format "1" (supported: 1)'],
    ])('rejects format %j', (format, message) => {
        const result = check(format);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(message);
    });
});

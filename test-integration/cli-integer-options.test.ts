import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('lsbench CLI integer options', () => {
    let tmpDir: string;
    let script: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-cli-int-'));
        script = path.join(tmpDir, 'actions.ts');
        fs.writeFileSync(script, 'export default async function (): Promise<void> {}', 'utf-8');
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it.each([
        [['-n', '10abc'], '--iterations must be a positive integer'],
        [['-n', '1.5'], '--iterations must be a positive integer'],
        [['-n', '1e3'], '--iterations must be a positive integer'],
        [['--warmup', 'x1'], '--warmup must be a non-negative integer'],
        [['--warmup', '1x'], '--warmup must be a non-negative integer'],
        [['--shutdown-timeout', '5s'], '--shutdown-timeout must be a positive integer'],
        [['--content-modified-retries', '2x'], '--content-modified-retries must be a non-negative integer'],
        [['--request-timeout', '5s'], '--request-timeout must be a positive integer'],
        [['--allow-exit-code', '1x'], '--allow-exit-code must be a non-negative integer'],
        [['--wait-idle', '5s'], '--wait-idle must be a positive integer'],
        [['--shorten-silent-waits', '5s'], '--shorten-silent-waits must be a positive integer'],
    ])('rejects %j', (flags, message) => {
        const result = spawnSync(
            process.execPath,
            [path.resolve('dist/cli.js'), 'false', '-w', tmpDir, '-s', script, ...flags],
            { encoding: 'utf-8' },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`Error: ${message}`);
        expect(result.stdout).toBe('');
    });
});

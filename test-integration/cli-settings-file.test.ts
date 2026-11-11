import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// runs the built CLI end to end with --settings-file, against a fake server that
// requests configuration after initialized and reports what it received

const settingsServer = `
import * as rpc from 'vscode-jsonrpc/node';
const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);
const dump = { configuration: undefined, didChangeConfiguration: [] };
conn.onRequest('initialize', () => ({ capabilities: {} }));
conn.onNotification('initialized', async () => {
    dump.configuration = await conn.sendRequest('workspace/configuration', {
        items: [{ section: 'html.format' }, { section: 'unknown' }],
    });
});
conn.onNotification('workspace/didChangeConfiguration', (params) => {
    dump.didChangeConfiguration.push(params);
});
conn.onRequest('test/dump', () => dump);
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
`;

describe('lsbench CLI with --settings-file', () => {
    let tmpDir: string;
    let script: string;
    let dumpFile: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-cli-settings-'));
        script = path.join(tmpDir, 'actions.ts');
        dumpFile = path.join(tmpDir, 'received.json');
        // the script polls the server until it answered configuration, then dumps it
        fs.writeFileSync(
            script,
            `import * as fs from 'node:fs';
            export default async function (ctx: any): Promise<void> {
                let dump: any;
                for (let i = 0; i < 100; i++) {
                    dump = await ctx.request('test/dump', null);
                    if (dump.configuration !== undefined) {
                        break;
                    }
                    await ctx.sleep(20);
                }
                fs.writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify(dump));
            }`,
            'utf-8',
        );
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function runCli(settingsFile: string) {
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
                '--settings-file',
                settingsFile,
                '--',
                '--input-type=module',
                '-e',
                settingsServer,
            ],
            { encoding: 'utf-8' },
        );
    }

    function writeSettings(name: string, content: string): string {
        const file = path.join(tmpDir, name);
        fs.writeFileSync(file, content, 'utf-8');
        return file;
    }

    it('answers configuration from the file and sends the expanded settings', () => {
        const settings = { 'html.format': { enable: true } };
        const result = runCli(writeSettings('settings.json', JSON.stringify(settings)));
        expect(result.status, result.stderr).toBe(0);
        const received = JSON.parse(fs.readFileSync(dumpFile, 'utf-8'));
        expect(received.configuration).toEqual([{ enable: true }, null]);
        expect(received.didChangeConfiguration).toEqual([{ settings: { html: { format: { enable: true } } } }]);
    });

    it('rejects a missing file', () => {
        const result = runCli(path.join(tmpDir, 'missing.json'));
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/Settings file not found/);
    });

    it('rejects invalid JSON', () => {
        const result = runCli(writeSettings('invalid.json', '{ not json'));
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/Failed to parse settings file/);
    });

    it('rejects JSON that is not an object', () => {
        const result = runCli(writeSettings('array.json', '[1, 2]'));
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/Settings file must contain a JSON object/);
    });
});

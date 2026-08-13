import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadActionScript, resolveServerConfig } from 'lsbench';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('resolveServerConfig', () => {
    it('splits a bare command with no args', () => {
        expect(resolveServerConfig('my-language-server')).toEqual({
            command: 'my-language-server',
            args: [],
            initializationOptions: undefined,
        });
    });

    it('splits a command with inline args', () => {
        const cfg = resolveServerConfig('typescript-language-server --stdio');
        expect(cfg.command).toBe('typescript-language-server');
        expect(cfg.args).toEqual(['--stdio']);
    });

    it('collapses runs of whitespace between tokens', () => {
        const cfg = resolveServerConfig('  cmd   --a    --b  ');
        expect(cfg.command).toBe('cmd');
        expect(cfg.args).toEqual(['--a', '--b']);
    });

    it('appends extra args after the inline ones', () => {
        const cfg = resolveServerConfig('cmd --stdio', ['--log-level', 'debug']);
        expect(cfg.args).toEqual(['--stdio', '--log-level', 'debug']);
    });

    it('passes initializationOptions through untouched', () => {
        const initOptions = { preferences: { includeCompletionsForModuleExports: true } };
        const cfg = resolveServerConfig('cmd', undefined, initOptions);
        expect(cfg.initializationOptions).toBe(initOptions);
    });
});

describe('loadActionScript', () => {
    let tmpDir: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsbench-scripts-'));
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeScript(name: string, contents: string): string {
        const file = path.join(tmpDir, name);
        fs.writeFileSync(file, contents, 'utf-8');
        return file;
    }

    it('rejects non-TypeScript files', async () => {
        await expect(loadActionScript('actions.js')).rejects.toThrow(/must be a TypeScript \(\.ts\) file/);
    });

    it('loads a default-exported action function', async () => {
        const file = writeScript(
            'valid-actions.ts',
            `export default async function (ctx: unknown): Promise<void> {
                void ctx;
            }`,
        );

        const fn = await loadActionScript(file);
        expect(typeof fn).toBe('function');
        // the loaded action is callable and resolves
        await expect(fn({} as never)).resolves.toBeUndefined();
    });

    it('throws when the default export is not a function', async () => {
        const file = writeScript('not-a-fn.ts', `export default 42;`);
        await expect(loadActionScript(file)).rejects.toThrow(/must have a default-exported function/);
    });
});

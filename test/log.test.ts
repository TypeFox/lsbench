import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, type LogLevel, logLevelOf } from '../src/log.js';

afterEach(() => {
    vi.restoreAllMocks();
});

function capture(level: LogLevel): { stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        stdout.push(String(chunk));
        return true;
    });
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
        stdout.push(`${String(line)}\n`);
    });
    vi.spyOn(console, 'error').mockImplementation((line?: unknown) => {
        stderr.push(String(line));
    });
    const logger = createLogger(level);
    logger.info('info');
    logger.progress('progress');
    logger.warn('warn');
    logger.error('error');
    return { stdout, stderr };
}

describe('createLogger', () => {
    it('writes only errors in quiet mode', () => {
        expect(capture('quiet')).toEqual({ stdout: [], stderr: ['error'] });
    });

    for (const level of ['normal', 'verbose'] as const) {
        it(`writes info and progress to stdout, warnings and errors to stderr in ${level} mode`, () => {
            expect(capture(level)).toEqual({ stdout: ['info\n', 'progress'], stderr: ['warn', 'error'] });
        });
    }

    it('prints an empty line for info without a message', () => {
        const lines: unknown[] = [];
        vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
            lines.push(line);
        });
        createLogger('normal').info();
        expect(lines).toEqual(['']);
    });
});

describe('logLevelOf', () => {
    it('derives the level from the quiet and verbose flags', () => {
        expect(logLevelOf({})).toBe('normal');
        expect(logLevelOf({ verbose: true })).toBe('verbose');
        expect(logLevelOf({ quiet: true })).toBe('quiet');
        expect(logLevelOf({ quiet: false, verbose: false })).toBe('normal');
    });

    it('rejects quiet together with verbose', () => {
        expect(() => logLevelOf({ quiet: true, verbose: true })).toThrow('quiet and verbose cannot be combined.');
    });
});

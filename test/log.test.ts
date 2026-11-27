import * as tty from 'node:tty';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createLogger,
    errorLabel,
    type LogLevel,
    logLevelOf,
    prefix,
    style,
    styleOut,
    warningLabel,
} from '../src/log.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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

describe('style', () => {
    function asTerminal(): void {
        const stderr = process.stderr as unknown as Record<string, unknown>;
        vi.stubEnv('TERM', 'xterm-256color');
        vi.stubEnv('FORCE_COLOR', undefined);
        vi.stubEnv('NO_COLOR', undefined);
        vi.stubEnv('NODE_DISABLE_COLORS', undefined);
        vi.stubEnv('CI', undefined);
        Object.defineProperty(stderr, 'isTTY', { value: true, configurable: true });
        Object.defineProperty(stderr, 'getColorDepth', {
            value: tty.WriteStream.prototype.getColorDepth,
            configurable: true,
        });
    }

    afterEach(() => {
        const stderr = process.stderr as unknown as Record<string, unknown>;
        delete stderr.isTTY;
        delete stderr.getColorDepth;
    });

    it('colors with FORCE_COLOR set', () => {
        vi.stubEnv('FORCE_COLOR', '1');
        expect(style('red', 'error')).toBe('\x1b[31merror\x1b[39m');
        expect(prefix('lsbench')).toBe('\x1b[2m\x1b[35m[lsbench]\x1b[39m\x1b[22m');
    });

    it('stays plain when stderr is not a TTY', () => {
        vi.stubEnv('FORCE_COLOR', undefined);
        expect(process.stderr.isTTY).toBeFalsy();
        expect(style('red', 'error')).toBe('error');
        expect(prefix('server')).toBe('[server]');
    });

    it('colors a terminal unless NO_COLOR is set', () => {
        asTerminal();
        expect(style('red', 'error')).toBe('\x1b[31merror\x1b[39m');
        vi.stubEnv('NO_COLOR', '1');
        expect(style('red', 'error')).toBe('error');
        expect(prefix('lsbench:ctx')).toBe('[lsbench:ctx]');
    });

    it('styles error and warning labels', () => {
        vi.stubEnv('FORCE_COLOR', '1');
        expect(errorLabel()).toBe('\x1b[1m\x1b[31mError:\x1b[39m\x1b[22m');
        expect(errorLabel('ERROR:')).toBe('\x1b[1m\x1b[31mERROR:\x1b[39m\x1b[22m');
        expect(warningLabel()).toBe('\x1b[33mWarning:\x1b[39m');
        vi.stubEnv('NO_COLOR', '1');
        vi.stubEnv('FORCE_COLOR', undefined);
        expect(errorLabel()).toBe('Error:');
        expect(warningLabel()).toBe('Warning:');
    });

    it('checks stdout for stdout text', () => {
        asTerminal();
        const stdout = process.stdout as unknown as Record<string, unknown>;
        const wasTTY = stdout.isTTY;
        Object.defineProperty(stdout, 'isTTY', { value: false, configurable: true });
        try {
            expect(style('red', 'x')).toBe('\x1b[31mx\x1b[39m');
            expect(styleOut('red', 'x')).toBe('x');
        } finally {
            Object.defineProperty(stdout, 'isTTY', { value: wasTTY, configurable: true });
        }
    });
});

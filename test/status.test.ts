import { describe, expect, it } from 'vitest';
import {
    createRunStatus,
    createStatusReporter,
    encodeStatus,
    STATUS_MAX_SEQUENCE_LENGTH,
    STATUS_MSG_MAX_BYTES,
    STATUS_TITLE_MAX_BYTES,
    type StatusReport,
    sanitizeStatusText,
    statusEnabled,
} from '../src/status.js';

function decode(sequence: string): Record<string, string> {
    const start = '\u001b]7501;';
    const end = '\u001b\\';
    expect(sequence.startsWith(start)).toBe(true);
    expect(sequence.endsWith(end)).toBe(true);
    const fields: Record<string, string> = {};
    for (const pair of sequence.slice(start.length, -end.length).split(':')) {
        const at = pair.indexOf('=');
        const key = pair.slice(0, at);
        const value = pair.slice(at + 1);
        fields[key] = key === 'title' || key === 'msg' ? Buffer.from(value, 'base64').toString('utf8') : value;
    }
    return fields;
}

function hasControl(text: string): boolean {
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
            return true;
        }
    }
    return false;
}

describe('encodeStatus', () => {
    it('writes state and app, with title and msg in base64', () => {
        const sequence = encodeStatus({ state: 'working', progress: 40, title: 'workspace', msg: 'Iteration 3/5' });
        expect(sequence).toBe(
            `\u001b]7501;state=working:app=lsbench:progress=40:title=${Buffer.from('workspace').toString('base64')}:msg=${Buffer.from('Iteration 3/5').toString('base64')}\u001b\\`,
        );
    });

    it('round trips multibyte UTF-8', () => {
        const fields = decode(encodeStatus({ state: 'done', title: 'Größe ✓', msg: 'Median 12ms 🚀' }));
        expect(fields).toEqual({ state: 'done', app: 'lsbench', title: 'Größe ✓', msg: 'Median 12ms 🚀' });
    });

    it('leaves out progress, title and msg when absent or empty', () => {
        expect(encodeStatus({ state: 'working' })).toBe('\u001b]7501;state=working:app=lsbench\u001b\\');
        expect(encodeStatus({ state: 'error', title: '', msg: '\n' })).toBe(
            '\u001b]7501;state=error:app=lsbench\u001b\\',
        );
    });

    it('rounds and clamps progress', () => {
        expect(decode(encodeStatus({ state: 'working', progress: 33.4 })).progress).toBe('33');
        expect(decode(encodeStatus({ state: 'working', progress: -5 })).progress).toBe('0');
        expect(decode(encodeStatus({ state: 'working', progress: 150 })).progress).toBe('100');
        expect(decode(encodeStatus({ state: 'working', progress: Number.NaN }))).not.toHaveProperty('progress');
    });

    it('keeps only the first line and replaces control characters', () => {
        const fields = decode(
            encodeStatus({ state: 'error', title: 'a\u0007b\u009bc', msg: 'boom \u001b[31mred\tx\nat foo' }),
        );
        expect(fields.title).toBe('a b c');
        expect(fields.msg).toBe('boom  [31mred x');
        expect(hasControl(fields.title)).toBe(false);
        expect(hasControl(fields.msg)).toBe(false);
    });

    it('truncates title and msg by decoded bytes without splitting a code point', () => {
        const fields = decode(encodeStatus({ state: 'error', title: 'é'.repeat(200), msg: '€'.repeat(1000) }));
        expect(Buffer.byteLength(fields.title)).toBe(STATUS_TITLE_MAX_BYTES);
        expect(fields.title).toBe('é'.repeat(96));
        expect(Buffer.byteLength(fields.msg)).toBeLessThanOrEqual(STATUS_MSG_MAX_BYTES);
        expect(fields.msg).toBe('€'.repeat(682));
    });

    it('stays within the sequence limit for the longest title and msg', () => {
        const sequence = encodeStatus({
            state: 'working',
            progress: 100,
            title: 'x'.repeat(1000),
            msg: 'y'.repeat(5000),
        });
        expect(sequence.length).toBeLessThanOrEqual(STATUS_MAX_SEQUENCE_LENGTH);
    });
});

describe('sanitizeStatusText', () => {
    it('handles CRLF and trims', () => {
        expect(sanitizeStatusText('  first\r\nsecond', 100)).toBe('first');
    });

    it('cuts at the byte limit', () => {
        expect(sanitizeStatusText('abcdef', 3)).toBe('abc');
        expect(sanitizeStatusText('ab€', 4)).toBe('ab');
    });
});

describe('statusEnabled', () => {
    const tty = { isTTY: true };
    const pipe = { isTTY: false };

    it('follows the terminal by default', () => {
        expect(statusEnabled(undefined, {}, tty)).toBe(true);
        expect(statusEnabled(undefined, {}, pipe)).toBe(false);
        expect(statusEnabled(undefined, {}, {})).toBe(false);
    });

    it('lets LSBENCH_STATUS override the terminal check', () => {
        expect(statusEnabled(undefined, { LSBENCH_STATUS: '0' }, tty)).toBe(false);
        expect(statusEnabled(undefined, { LSBENCH_STATUS: '1' }, pipe)).toBe(true);
        expect(statusEnabled(undefined, { LSBENCH_STATUS: 'yes' }, pipe)).toBe(false);
    });

    it('lets the flag override LSBENCH_STATUS', () => {
        expect(statusEnabled(true, { LSBENCH_STATUS: '0' }, pipe)).toBe(true);
        expect(statusEnabled(false, { LSBENCH_STATUS: '1' }, tty)).toBe(false);
    });
});

describe('createStatusReporter', () => {
    it('writes encoded reports when enabled', () => {
        const chunks: string[] = [];
        createStatusReporter(true, { write: (chunk: string) => chunks.push(chunk) }).report({ state: 'done' });
        expect(chunks).toEqual([encodeStatus({ state: 'done' })]);
    });

    it('writes nothing when disabled', () => {
        const chunks: string[] = [];
        createStatusReporter(false, { write: (chunk: string) => chunks.push(chunk) }).report({ state: 'done' });
        expect(chunks).toEqual([]);
    });
});

describe('createRunStatus', () => {
    function recorder() {
        const reports: StatusReport[] = [];
        const status = createRunStatus({ report: (report) => reports.push(report) }, { server: 'srv', title: 'ws' });
        return { reports, status };
    }

    it('stays working with increasing progress through a keep alive run and ends done', () => {
        const { reports, status } = recorder();
        status.onProgress({ kind: 'server-start' });
        status.onProgress({ kind: 'iteration', warmup: true, index: 1, total: 1 });
        status.onProgress({ kind: 'iteration', warmup: false, index: 1, total: 4 });
        status.onProgress({ kind: 'iteration', warmup: false, index: 2, total: 4 });
        status.onProgress({ kind: 'iteration', warmup: false, index: 3, total: 4 });
        status.onProgress({ kind: 'iteration', warmup: false, index: 4, total: 4 });
        status.done('Median 5ms over 4 iterations');
        expect(reports).toEqual([
            { state: 'working', progress: undefined, title: 'ws', msg: 'Starting srv' },
            { state: 'working', title: 'ws', msg: 'Warmup 1/1' },
            { state: 'working', progress: 0, title: 'ws', msg: 'Iteration 1/4' },
            { state: 'working', progress: 25, title: 'ws', msg: 'Iteration 2/4' },
            { state: 'working', progress: 50, title: 'ws', msg: 'Iteration 3/4' },
            { state: 'working', progress: 75, title: 'ws', msg: 'Iteration 4/4' },
            { state: 'done', title: 'ws', msg: 'Median 5ms over 4 iterations' },
        ]);
    });

    it('keeps the current progress on restarts and ends with error on failure', () => {
        const { reports, status } = recorder();
        status.onProgress({ kind: 'server-start' });
        status.onProgress({ kind: 'iteration', warmup: false, index: 1, total: 2 });
        status.onProgress({ kind: 'server-start' });
        status.onProgress({ kind: 'iteration', warmup: false, index: 2, total: 2 });
        status.error('action script failed in 1 of 2 iterations');
        expect(reports.map((report) => [report.state, report.progress, report.msg])).toEqual([
            ['working', undefined, 'Starting srv'],
            ['working', 0, 'Iteration 1/2'],
            ['working', 0, 'Starting srv'],
            ['working', 50, 'Iteration 2/2'],
            ['error', undefined, 'action script failed in 1 of 2 iterations'],
        ]);
    });
});

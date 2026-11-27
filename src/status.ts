import type { BenchProgressEvent } from './types.js';

type StatusState = 'working' | 'done' | 'error' | 'clear';

export interface StatusReport {
    state: StatusState;
    progress?: number;
    title?: string;
    msg?: string;
}

export const STATUS_TITLE_MAX_BYTES = 192;
export const STATUS_MSG_MAX_BYTES = 2048;
export const STATUS_MAX_SEQUENCE_LENGTH = 4096;

function isControl(char: string): boolean {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

export function sanitizeStatusText(text: string, maxBytes: number): string {
    const line = text.split(/\r\n|\r|\n/, 1)[0] ?? '';
    let clean = '';
    for (const char of line) {
        clean += isControl(char) ? ' ' : char;
    }
    let bytes = 0;
    let result = '';
    for (const char of clean.trim()) {
        const size = Buffer.byteLength(char, 'utf8');
        if (bytes + size > maxBytes) {
            break;
        }
        bytes += size;
        result += char;
    }
    return result.trimEnd();
}

function base64(text: string): string {
    return Buffer.from(text, 'utf8').toString('base64');
}

export function encodeStatus(report: StatusReport): string {
    const fields = [`state=${report.state}`, 'app=lsbench'];
    if (report.progress !== undefined && Number.isFinite(report.progress)) {
        fields.push(`progress=${Math.min(100, Math.max(0, Math.round(report.progress)))}`);
    }
    const title = report.title === undefined ? '' : sanitizeStatusText(report.title, STATUS_TITLE_MAX_BYTES);
    if (title) {
        fields.push(`title=${base64(title)}`);
    }
    const msg = report.msg === undefined ? '' : sanitizeStatusText(report.msg, STATUS_MSG_MAX_BYTES);
    if (msg) {
        fields.push(`msg=${base64(msg)}`);
    }
    return `\u001b]7501;${fields.join(':')}\u001b\\`;
}

export function statusEnabled(
    flag: boolean | undefined,
    env: NodeJS.ProcessEnv = process.env,
    stream: { isTTY?: boolean } = process.stderr,
): boolean {
    if (flag !== undefined) {
        return flag;
    }
    if (env.LSBENCH_STATUS === '1') {
        return true;
    }
    if (env.LSBENCH_STATUS === '0') {
        return false;
    }
    return stream.isTTY === true;
}

export interface StatusReporter {
    report(report: StatusReport): void;
}

export function createStatusReporter(
    enabled: boolean,
    stream: { write(chunk: string): unknown } = process.stderr,
): StatusReporter {
    return {
        report(report) {
            if (enabled) {
                stream.write(encodeStatus(report));
            }
        },
    };
}

export interface RunStatus {
    onProgress(event: BenchProgressEvent): void;
    done(msg: string): void;
    error(msg: string): void;
}

export function createRunStatus(reporter: StatusReporter, labels: { server: string; title: string }): RunStatus {
    let progress: number | undefined;
    const { title } = labels;
    return {
        onProgress(event) {
            if (event.kind === 'server-start') {
                reporter.report({ state: 'working', progress, title, msg: `Starting ${labels.server}` });
                return;
            }
            if (event.warmup) {
                reporter.report({ state: 'working', title, msg: `Warmup ${event.index}/${event.total}` });
                return;
            }
            progress = Math.round((100 * (event.index - 1)) / event.total);
            reporter.report({ state: 'working', progress, title, msg: `Iteration ${event.index}/${event.total}` });
        },
        done(msg) {
            reporter.report({ state: 'done', title, msg });
        },
        error(msg) {
            reporter.report({ state: 'error', title, msg });
        },
    };
}

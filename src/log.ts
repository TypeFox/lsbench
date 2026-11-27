import { styleText } from 'node:util';

export type LogLevel = 'quiet' | 'normal' | 'verbose';

export interface Logger {
    readonly level: LogLevel;
    info(message?: string): void;
    progress(text: string): void;
    warn(message: string): void;
    error(message: string): void;
}

export function logLevelOf(options: { quiet?: boolean; verbose?: boolean }): LogLevel {
    if (options.quiet && options.verbose) {
        throw new Error('quiet and verbose cannot be combined.');
    }
    if (options.quiet) {
        return 'quiet';
    }
    return options.verbose ? 'verbose' : 'normal';
}

export function createLogger(level: LogLevel): Logger {
    const quiet = level === 'quiet';
    return {
        level,
        info(message = '') {
            if (!quiet) {
                console.log(message);
            }
        },
        progress(text) {
            if (!quiet) {
                process.stdout.write(text);
            }
        },
        warn(message) {
            if (!quiet) {
                console.error(message);
            }
        },
        error(message) {
            console.error(message);
        },
    };
}

export type StyleFormat = Parameters<typeof styleText>[0];

export function style(format: StyleFormat, text: string, stream: NodeJS.WriteStream = process.stderr): string {
    return styleText(format, text, { stream });
}

export function styleOut(format: StyleFormat, text: string): string {
    return style(format, text, process.stdout);
}

export function errorLabel(label = 'Error:'): string {
    return style(['bold', 'red'], label);
}

export function warningLabel(label = 'Warning:'): string {
    return style('yellow', label);
}

const PREFIX_STYLES = {
    lsbench: ['dim', 'magenta'],
    'lsbench:ctx': ['dim', 'blue'],
    server: 'gray',
} as const satisfies Record<string, StyleFormat>;

export function prefix(source: keyof typeof PREFIX_STYLES): string {
    return style(PREFIX_STYLES[source], `[${source}]`);
}

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

import type { BenchOptions, ServerTransport } from './types.js';

/** Round to N decimal places */
export function round(value: number, decimals = 3): number {
    const f = 10 ** decimals;
    return Math.round(value * f) / f;
}

export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export function transportLabel(transport: ServerTransport | undefined): string | undefined {
    if (transport?.kind === 'connect') {
        return `connect ${transport.host}:${transport.port}`;
    }
    if (transport?.kind === 'socket') {
        return `socket ${transport.port}`;
    }
    return undefined;
}

export function serverLabel(opts: Pick<BenchOptions, 'server' | 'transport'>): string {
    return opts.server ?? transportLabel(opts.transport) ?? '';
}

/** Round to N decimal places */
export function round(value: number, decimals = 3): number {
    const f = 10 ** decimals;
    return Math.round(value * f) / f;
}

export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

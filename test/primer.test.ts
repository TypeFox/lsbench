import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { getPrimer } from '../src/primer.js';
import { createProgram, DEFAULT_SHORTEN_SILENT_WAITS_MS, DEFAULT_WAIT_IDLE_MS } from '../src/program.js';

const BARE_FLAG_DEFAULTS: Record<string, number> = {
    '--wait-idle': DEFAULT_WAIT_IDLE_MS,
    '--shorten-silent-waits': DEFAULT_SHORTEN_SILENT_WAITS_MS,
};

const NEXT_FLAG = /(?:^|[\s,])(?:-[a-zA-Z], )?--[a-z]/m;

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cliReference(primer: string): string {
    const start = primer.indexOf('## CLI reference');
    const end = primer.indexOf('\n## ', start + 1);
    return primer.slice(start, end === -1 ? undefined : end);
}

function commandScope(reference: string, name: string): string {
    if (name === 'run') {
        return reference;
    }
    const lines = reference.split('\n');
    const first = lines.findIndex((line) => line.startsWith(`    ${name} `));
    if (first === -1) {
        return '';
    }
    let last = first + 1;
    while (last < lines.length && !/^ {4}\S/.test(lines[last]) && lines[last].trim() !== '') {
        last++;
    }
    return lines.slice(first, last).join('\n');
}

function findFlag(scope: string, flag: string): number {
    const match = new RegExp(`(?<![\\w-])${escapeRegExp(flag)}(?![\\w-])`).exec(scope);
    return match ? match.index : -1;
}

function expectedDefault(long: string, defaultValue: unknown): string | undefined {
    if (long in BARE_FLAG_DEFAULTS) {
        return String(BARE_FLAG_DEFAULTS[long]);
    }
    if (typeof defaultValue === 'number' || (typeof defaultValue === 'string' && defaultValue !== '')) {
        return String(defaultValue);
    }
    return undefined;
}

function primerProblems(program: Command, primer: string): string[] {
    const reference = cliReference(primer);
    const problems: string[] = [];
    for (const command of program.commands) {
        const name = command.name();
        if (name === 'prime') {
            continue;
        }
        const scope = commandScope(reference, name);
        if (!scope) {
            problems.push(`${name}: command missing`);
            continue;
        }
        for (const option of command.options) {
            const long = option.long ?? '';
            let at = findFlag(scope, long);
            let flag = long;
            if (at === -1 && option.short) {
                at = findFlag(scope, option.short);
                flag = option.short;
            }
            if (at === -1) {
                problems.push(`${name} ${long}: missing`);
                continue;
            }
            const value = expectedDefault(long, option.defaultValue);
            if (value === undefined) {
                continue;
            }
            const rest = scope.slice(at + flag.length);
            const next = NEXT_FLAG.exec(rest);
            const description = next ? rest.slice(0, next.index) : rest;
            if (!new RegExp(`\\(default:? ${escapeRegExp(value)}\\)`).test(description)) {
                problems.push(`${name} ${long}: default ${value} missing`);
            }
        }
    }
    return problems;
}

describe('primer CLI reference', () => {
    it('lists every option of run, baseline and check with its default', () => {
        expect(primerProblems(createProgram(), getPrimer())).toEqual([]);
    });

    it('reports an option the primer leaves out', () => {
        const program = createProgram();
        const run = program.commands.find((command) => command.name() === 'run');
        run?.option('--extra-flag <n>', 'not in the primer', '7');
        expect(primerProblems(program, getPrimer())).toEqual(['run --extra-flag: missing']);
    });

    it('reports a default that differs from the primer', () => {
        const primer = getPrimer().replace('(default: 10)', '(default: 12)').replace('(default 0.1)', '(default 0.2)');
        expect(primerProblems(createProgram(), primer)).toEqual([
            'run --iterations: default 10 missing',
            'check --rate-tolerance: default 0.1 missing',
        ]);
    });

    it('reports a bare flag value that differs from the primer', () => {
        const primer = getPrimer().replace('(default: 30000)', '(default: 1000)');
        expect(primerProblems(createProgram(), primer)).toEqual(['run --wait-idle: default 30000 missing']);
    });

    it('reports an option missing from a subcommand', () => {
        const primer = getPrimer().replace('--json', '--machine');
        expect(primerProblems(createProgram(), primer)).toEqual(['check --json: missing']);
    });
});

import * as path from 'node:path';
import { pathToUri, uriToPath } from 'lsbench';
import { describe, expect, it } from 'vitest';

describe('pathToUri', () => {
    it('produces a file:// URI from an absolute path', () => {
        expect(pathToUri('/tmp/project/file.ts')).toBe('file:///tmp/project/file.ts');
    });

    it('resolves relative paths against the cwd', () => {
        const expected = `file://${path.resolve('some/rel/path.ts')}`;
        expect(pathToUri('some/rel/path.ts')).toBe(expected);
    });
});

describe('uriToPath', () => {
    it('strips the file:// scheme', () => {
        expect(uriToPath('file:///tmp/project/file.ts')).toBe('/tmp/project/file.ts');
    });

    it('returns non-file URIs unchanged', () => {
        expect(uriToPath('/already/a/path.ts')).toBe('/already/a/path.ts');
        expect(uriToPath('untitled:Untitled-1')).toBe('untitled:Untitled-1');
    });
});

describe('pathToUri / uriToPath round-trip', () => {
    it('recovers the original absolute path', () => {
        const abs = '/Users/example/workspace/src/index.ts';
        expect(uriToPath(pathToUri(abs))).toBe(abs);
    });
});

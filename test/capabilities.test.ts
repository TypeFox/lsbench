import type { Registration } from 'lsbench';
import { METHOD_PROVIDERS, summarizeSupport, supportsMethod } from 'lsbench';
import { describe, expect, it } from 'vitest';

describe('supportsMethod', () => {
    it('treats every method as supported before initialize', () => {
        expect(supportsMethod(null, [], 'textDocument/hover')).toBe(true);
    });

    it('treats methods without a provider mapping as supported', () => {
        expect(supportsMethod({}, [], 'custom/request')).toBe(true);
        expect(supportsMethod({}, [], 'workspace/executeCommand')).toBe(true);
    });

    it('reads static providers, which may be true or an options object', () => {
        expect(supportsMethod({ hoverProvider: true }, [], 'textDocument/hover')).toBe(true);
        expect(supportsMethod({ hoverProvider: {} }, [], 'textDocument/hover')).toBe(true);
        expect(supportsMethod({ hoverProvider: false }, [], 'textDocument/hover')).toBe(false);
        expect(supportsMethod({}, [], 'textDocument/hover')).toBe(false);
    });

    it('requires the option inside the provider for resolve and sub requests', () => {
        const caps = {
            completionProvider: { triggerCharacters: ['.'] },
            renameProvider: true,
            semanticTokensProvider: { full: true, legend: {} },
        };
        expect(supportsMethod(caps, [], 'textDocument/completion')).toBe(true);
        expect(supportsMethod(caps, [], 'completionItem/resolve')).toBe(false);
        expect(supportsMethod(caps, [], 'textDocument/rename')).toBe(true);
        expect(supportsMethod(caps, [], 'textDocument/prepareRename')).toBe(false);
        expect(supportsMethod(caps, [], 'textDocument/semanticTokens/full')).toBe(true);
        expect(supportsMethod(caps, [], 'textDocument/semanticTokens/full/delta')).toBe(false);
        expect(supportsMethod(caps, [], 'textDocument/semanticTokens/range')).toBe(false);

        const full = {
            completionProvider: { resolveProvider: true },
            renameProvider: { prepareProvider: true },
            semanticTokensProvider: { full: { delta: true }, range: true },
        };
        expect(supportsMethod(full, [], 'completionItem/resolve')).toBe(true);
        expect(supportsMethod(full, [], 'textDocument/prepareRename')).toBe(true);
        expect(supportsMethod(full, [], 'textDocument/semanticTokens/full/delta')).toBe(true);
        expect(supportsMethod(full, [], 'textDocument/semanticTokens/range')).toBe(true);
    });

    it('maps hierarchy follow up requests to the prepare provider', () => {
        const caps = { callHierarchyProvider: true };
        expect(supportsMethod(caps, [], 'callHierarchy/incomingCalls')).toBe(true);
        expect(supportsMethod(caps, [], 'typeHierarchy/subtypes')).toBe(false);
    });

    it('accepts dynamic registrations, checking the option in registerOptions', () => {
        const regs: Registration[] = [
            { id: '1', method: 'textDocument/hover' },
            { id: '2', method: 'textDocument/completion', registerOptions: { resolveProvider: true } },
            { id: '3', method: 'textDocument/diagnostic', registerOptions: { workspaceDiagnostics: false } },
            { id: '4', method: 'textDocument/semanticTokens', registerOptions: { full: { delta: true } } },
        ];
        expect(supportsMethod({}, regs, 'textDocument/hover')).toBe(true);
        expect(supportsMethod({}, regs, 'completionItem/resolve')).toBe(true);
        expect(supportsMethod({}, regs, 'textDocument/diagnostic')).toBe(true);
        expect(supportsMethod({}, regs, 'workspace/diagnostic')).toBe(false);
        expect(supportsMethod({}, regs, 'textDocument/semanticTokens/full/delta')).toBe(true);
        expect(supportsMethod({}, regs, 'textDocument/semanticTokens/range')).toBe(false);
    });

    it('reads willSaveWaitUntil from textDocumentSync or its own registration', () => {
        expect(supportsMethod({ textDocumentSync: 2 }, [], 'textDocument/willSaveWaitUntil')).toBe(false);
        expect(
            supportsMethod({ textDocumentSync: { willSaveWaitUntil: true } }, [], 'textDocument/willSaveWaitUntil'),
        ).toBe(true);
        const regs = [{ id: 'w', method: 'textDocument/willSaveWaitUntil', registerOptions: { documentSelector: [] } }];
        expect(supportsMethod({}, regs, 'textDocument/willSaveWaitUntil')).toBe(true);
    });
});

describe('summarizeSupport', () => {
    it('splits every mapped method into supported and unsupported', () => {
        const { supported, unsupported } = summarizeSupport({ hoverProvider: true }, [
            { id: 'd', method: 'textDocument/definition' },
        ]);
        expect(supported).toEqual(['textDocument/hover', 'textDocument/definition']);
        expect(unsupported).toHaveLength(Object.keys(METHOD_PROVIDERS).length - 2);
        expect(unsupported).toContain('textDocument/completion');
    });
});

import type { Registration, ServerCapabilities } from './types.js';

/** What a server must advertise to answer a request */
export interface ProviderRequirement {
    /** ServerCapabilities key of the provider, e.g. hoverProvider */
    provider: string;
    /** dotted path inside the provider that must be truthy, e.g. resolveProvider */
    option?: string;
    /** method a dynamic registration of the provider uses */
    registration: string;
    /** dotted path inside the registerOptions that must be truthy, defaults to `option`, '' for none */
    registrationOption?: string;
}

/**
 * The provider capability behind each request the BenchContext sends.
 * Requests whose method is missing here are always sent
 */
export const METHOD_PROVIDERS: Readonly<Record<string, ProviderRequirement>> = {
    'textDocument/hover': { provider: 'hoverProvider', registration: 'textDocument/hover' },
    'textDocument/completion': { provider: 'completionProvider', registration: 'textDocument/completion' },
    'completionItem/resolve': {
        provider: 'completionProvider',
        option: 'resolveProvider',
        registration: 'textDocument/completion',
    },
    'textDocument/signatureHelp': { provider: 'signatureHelpProvider', registration: 'textDocument/signatureHelp' },
    'textDocument/definition': { provider: 'definitionProvider', registration: 'textDocument/definition' },
    'textDocument/declaration': { provider: 'declarationProvider', registration: 'textDocument/declaration' },
    'textDocument/typeDefinition': { provider: 'typeDefinitionProvider', registration: 'textDocument/typeDefinition' },
    'textDocument/implementation': { provider: 'implementationProvider', registration: 'textDocument/implementation' },
    'textDocument/references': { provider: 'referencesProvider', registration: 'textDocument/references' },
    'textDocument/documentHighlight': {
        provider: 'documentHighlightProvider',
        registration: 'textDocument/documentHighlight',
    },
    'textDocument/documentSymbol': { provider: 'documentSymbolProvider', registration: 'textDocument/documentSymbol' },
    'textDocument/codeAction': { provider: 'codeActionProvider', registration: 'textDocument/codeAction' },
    'codeAction/resolve': {
        provider: 'codeActionProvider',
        option: 'resolveProvider',
        registration: 'textDocument/codeAction',
    },
    'textDocument/codeLens': { provider: 'codeLensProvider', registration: 'textDocument/codeLens' },
    'codeLens/resolve': {
        provider: 'codeLensProvider',
        option: 'resolveProvider',
        registration: 'textDocument/codeLens',
    },
    'textDocument/documentLink': { provider: 'documentLinkProvider', registration: 'textDocument/documentLink' },
    'documentLink/resolve': {
        provider: 'documentLinkProvider',
        option: 'resolveProvider',
        registration: 'textDocument/documentLink',
    },
    'textDocument/formatting': { provider: 'documentFormattingProvider', registration: 'textDocument/formatting' },
    'textDocument/rangeFormatting': {
        provider: 'documentRangeFormattingProvider',
        registration: 'textDocument/rangeFormatting',
    },
    'textDocument/onTypeFormatting': {
        provider: 'documentOnTypeFormattingProvider',
        registration: 'textDocument/onTypeFormatting',
    },
    'textDocument/rename': { provider: 'renameProvider', registration: 'textDocument/rename' },
    'textDocument/prepareRename': {
        provider: 'renameProvider',
        option: 'prepareProvider',
        registration: 'textDocument/rename',
    },
    'textDocument/foldingRange': { provider: 'foldingRangeProvider', registration: 'textDocument/foldingRange' },
    'textDocument/selectionRange': { provider: 'selectionRangeProvider', registration: 'textDocument/selectionRange' },
    'textDocument/inlayHint': { provider: 'inlayHintProvider', registration: 'textDocument/inlayHint' },
    'inlayHint/resolve': {
        provider: 'inlayHintProvider',
        option: 'resolveProvider',
        registration: 'textDocument/inlayHint',
    },
    'textDocument/semanticTokens/full': {
        provider: 'semanticTokensProvider',
        option: 'full',
        registration: 'textDocument/semanticTokens',
    },
    'textDocument/semanticTokens/full/delta': {
        provider: 'semanticTokensProvider',
        option: 'full.delta',
        registration: 'textDocument/semanticTokens',
    },
    'textDocument/semanticTokens/range': {
        provider: 'semanticTokensProvider',
        option: 'range',
        registration: 'textDocument/semanticTokens',
    },
    'workspace/symbol': { provider: 'workspaceSymbolProvider', registration: 'workspace/symbol' },
    'workspaceSymbol/resolve': {
        provider: 'workspaceSymbolProvider',
        option: 'resolveProvider',
        registration: 'workspace/symbol',
    },
    'textDocument/prepareCallHierarchy': {
        provider: 'callHierarchyProvider',
        registration: 'textDocument/prepareCallHierarchy',
    },
    'callHierarchy/incomingCalls': {
        provider: 'callHierarchyProvider',
        registration: 'textDocument/prepareCallHierarchy',
    },
    'callHierarchy/outgoingCalls': {
        provider: 'callHierarchyProvider',
        registration: 'textDocument/prepareCallHierarchy',
    },
    'textDocument/prepareTypeHierarchy': {
        provider: 'typeHierarchyProvider',
        registration: 'textDocument/prepareTypeHierarchy',
    },
    'typeHierarchy/supertypes': {
        provider: 'typeHierarchyProvider',
        registration: 'textDocument/prepareTypeHierarchy',
    },
    'typeHierarchy/subtypes': { provider: 'typeHierarchyProvider', registration: 'textDocument/prepareTypeHierarchy' },
    'textDocument/diagnostic': { provider: 'diagnosticProvider', registration: 'textDocument/diagnostic' },
    'workspace/diagnostic': {
        provider: 'diagnosticProvider',
        option: 'workspaceDiagnostics',
        registration: 'textDocument/diagnostic',
    },
    // a registration of willSaveWaitUntil itself carries no flag
    'textDocument/willSaveWaitUntil': {
        provider: 'textDocumentSync',
        option: 'willSaveWaitUntil',
        registration: 'textDocument/willSaveWaitUntil',
        registrationOption: '',
    },
};

/**
 * Whether the server answers `method`, from its static capabilities or a dynamic registration.
 * Methods missing from METHOD_PROVIDERS, and any method before initialize, count as supported
 */
export function supportsMethod(
    capabilities: ServerCapabilities | null,
    registrations: Iterable<Registration>,
    method: string,
): boolean {
    const req = METHOD_PROVIDERS[method];
    if (!req || !capabilities) {
        return true;
    }
    if (isEnabled(capabilities[req.provider], req.option)) {
        return true;
    }
    const regOption = req.registrationOption ?? req.option;
    for (const reg of registrations) {
        if (reg.method === req.registration && (!regOption || isEnabled(reg.registerOptions, regOption))) {
            return true;
        }
    }
    return false;
}

/** Split the methods of METHOD_PROVIDERS into those the server answers and those it does not */
export function summarizeSupport(
    capabilities: ServerCapabilities | null,
    registrations: Iterable<Registration>,
): { supported: string[]; unsupported: string[] } {
    const regs = [...registrations];
    const supported: string[] = [];
    const unsupported: string[] = [];
    for (const method of Object.keys(METHOD_PROVIDERS)) {
        if (supportsMethod(capabilities, regs, method)) {
            supported.push(method);
        } else {
            unsupported.push(method);
        }
    }
    return { supported, unsupported };
}

/** Whether the value at the dotted `option` path inside `value` (or `value` itself) is truthy */
function isEnabled(value: unknown, option?: string): boolean {
    if (option) {
        for (const key of option.split('.')) {
            if (typeof value !== 'object' || value === null) {
                return false;
            }
            value = (value as Record<string, unknown>)[key];
        }
    }
    return Boolean(value);
}

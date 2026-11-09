# CHANGELOG

## Unreleased

Adds many more LSP requests to `BenchContext`, plus a fix for `addRegisteredLanguage`.

### New BenchContext methods

- **Navigation:** `declaration`, `documentHighlight`, `prepareRename`
- **Formatting:** `rangeFormatting`, `onTypeFormatting`
- **Document structure:** `foldingRange`, `selectionRange`, `documentLink`, `codeLens`, `inlayHint`
- **Semantic tokens:** `semanticTokensFull`, `semanticTokensRange`, `semanticTokensDelta`
- **Workspace symbols:** `workspaceSymbol`
- **Call/type hierarchy:** `prepareCallHierarchy`, `callHierarchyIncomingCalls`, `callHierarchyOutgoingCalls`, `prepareTypeHierarchy`, `typeHierarchySupertypes`, `typeHierarchySubtypes`
- **Pull diagnostics:** `documentDiagnostic`, `workspaceDiagnostic`. The `textDocument.diagnostic` client capability is intentionally not advertised, since some servers switch from push to pull diagnostics when it is present, which would break `waitForDiagnostics`.
- **Document lifecycle:** `saveDocument`

### Fixes

- `codeAction` diagnostic code filtering now also matches `data.code`, so quick fixes from servers like Langium that store their issue code in `data` can be triggered.
- `addRegisteredLanguage` stored the extension mapping backwards (language id to extension instead of extension to language id). Extensions are now also lowercased to match `detectLanguageId`.

## v0.1.0

First release!
Updates a number of things from the original prototype, such as running action scripts via ts instead of js, and dropping some unused constructs.
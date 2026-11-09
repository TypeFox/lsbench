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
- **Document lifecycle:** `saveDocument`, `willSave`, `willSaveWaitUntil` (timed)

### Save handling

- Save related sync options are read from the static `textDocumentSync` capability and from dynamic registrations of `textDocument/didSave`, `textDocument/willSave` and `textDocument/willSaveWaitUntil`. A bare `TextDocumentSyncKind` number implies `didSave` without text, matching `vscode-languageclient`. They are available via `LspHarness.saveSyncOptions()`.
- `saveDocument` only sends `didSave` when the server wants it, and includes the current document text when it asks for `includeText`. `willSave` is also only sent when wanted, while `willSaveWaitUntil` is always sent since it is timed.

### Fixes

- `edit` now applies each edit to the locally tracked document text, in order, following LSP incremental `didChange` semantics. Previously the tracked text never changed after `openDocument`.

- `codeAction` diagnostic code filtering now also matches `data.code`, so quick fixes from servers like Langium that store their issue code in `data` can be triggered.
- `addRegisteredLanguage` stored the extension mapping backwards (language id to extension instead of extension to language id). Extensions are now also lowercased to match `detectLanguageId`.

## v0.1.0

First release!
Updates a number of things from the original prototype, such as running action scripts via ts instead of js, and dropping some unused constructs.
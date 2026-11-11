# CHANGELOG

## Unreleased

### Breaking changes

- `waitForDiagnostics` now resolves with `{ diagnostics, timedOut, publishes, ms }` instead of the diagnostics array. Scripts that used the array need `(await ctx.waitForDiagnostics(path)).diagnostics`. Its second argument may be an options object `{ timeout }`, and a bare timeout number still works.
- A timed out wait is now reported (`timedOut: true`, result `timeout`) instead of silently resolving with the cached diagnostics. The timeout comes from the timer itself, never from elapsed time.

### Wait predicates and settle windows

- `waitForDiagnostics` options gain `until: (diagnostics) => boolean`, which resolves on the first current publish passing it (for example `(d) => d.length > 0` to skip the empty syntax pass of rust-analyzer or zls), and `settleMs`, which keeps waiting after the resolving publish until no current publish arrived for that long and resolves with the latest. `timeout` caps both.
- `publishes` now counts every current publish the wait saw, including those failing `until`. On timeout, `diagnostics` are those of the latest current publish when one arrived, otherwise the cached ones.
- With `settleMs`, `ms` is the time to the latest publish before the quiet period, the quiet period itself is not included. A timeout during the quiet period is not a timeout, the wait resolves with the latest publish.

### Pull diagnostics in waits

- `waitForDiagnostics` options gain `mode: 'push' | 'pull' | 'auto'` (default `auto`) and `pullAfterMs` (default 1000). In `auto` mode lsbench learns per server process whether a server advertising `diagnosticProvider` pushes: until it sent any publish, a wait pulls through `textDocument/diagnostic` after `pullAfterMs` without one (at half the timeout when that is not longer), and once such a pull resolved without a push the server counts as pull only and is pulled at once. Any publish makes auto waits wait for pushes for the rest of the session, so servers that push and also advertise `diagnosticProvider` (rust-analyzer) keep being measured by their pushes, while pull only servers such as ts7 no longer time out on every wait.
- Pulls repeat with a short backoff until `until` passes or the timeout, send `previousResultId`, and resolve `unchanged` reports to the previous diagnostics. Pulled waits are recorded as `diagnostics/pull/open`, `diagnostics/pull/edit` or `diagnostics/pull/wait`, timed from the first pull to the resolving response.
- The result gains `source` (`push` or `pull`) and `pulls`.
- `textDocument.diagnostic` stays unadvertised in the default client capabilities, since servers built on `vscode-languageserver` stop pushing when it is present.

### Close publishes

- An empty, unversioned publish after a quick reopen is no longer dropped outright as the clearing publish of the close. It is held for the rest of a 1000 ms window after the `didClose`, superseded by any later publish, and otherwise accepted with its own receipt time. lsbench learns per server whether it publishes on close and then decides at once, so servers that never clear closed documents (such as Langium) no longer time out on every reopen of a clean file.

### Time to diagnostics

- Each `waitForDiagnostics` records a timing, `diagnostics/open` or `diagnostics/edit` by the latest sync of the document (`diagnostics/wait` for a document that is not open), measured from that `didOpen` or `didChange` to the matching publish and carrying the diagnostic count in `diagnostics`.
- `RequestResult` gains `timeout`, and `MethodStats` gains `timeout_rate`. Timeouts are left out of the duration stats and of `failure_rate`, and the printed table adds a Tmout% column when any wait timed out.

## v0.2.0

Adds most remaining LSP requests to `BenchContext`, server-aware save handling, answers for common server to client requests, and a second integration suite against Langium's grammar language server.

### New BenchContext methods

- **Navigation:** `declaration`, `documentHighlight`, `prepareRename`
- **Formatting:** `rangeFormatting`, `onTypeFormatting`
- **Document structure:** `foldingRange`, `selectionRange`, `documentLink`, `codeLens`, `inlayHint`
- **Semantic tokens:** `semanticTokensFull`, `semanticTokensRange`, `semanticTokensDelta`
- **Workspace symbols:** `workspaceSymbol`
- **Call/type hierarchy:** `prepareCallHierarchy`, `callHierarchyIncomingCalls`, `callHierarchyOutgoingCalls`, `prepareTypeHierarchy`, `typeHierarchySupertypes`, `typeHierarchySubtypes`
- **Pull diagnostics:** `documentDiagnostic`, `workspaceDiagnostic`. The `textDocument.diagnostic` client capability is intentionally not advertised, since some servers switch from push to pull diagnostics when it is present, which would break `waitForDiagnostics`.
- **Resolve:** `completionItemResolve`, `codeActionResolve`, `codeLensResolve`, `inlayHintResolve`, `documentLinkResolve`, `workspaceSymbolResolve`
- **Document lifecycle:** `saveDocument`, `willSave`, `willSaveWaitUntil` (timed)

### Save handling

- Save related sync options are read from the static `textDocumentSync` capability and from dynamic registrations of `textDocument/didSave`, `textDocument/willSave` and `textDocument/willSaveWaitUntil`. A bare `TextDocumentSyncKind` number implies `didSave` without text, matching `vscode-languageclient`. They are available via `LspHarness.saveSyncOptions()`, and `SaveSyncOptions` is exported.
- `saveDocument` only sends `didSave` when the server wants it, and includes the current document text when it asks for `includeText`. `willSave` is also only sent when wanted, while `willSaveWaitUntil` is always sent since it is timed.

### Server to client requests

- Refresh requests (`workspace/semanticTokens/refresh`, `inlayHint/refresh`, `codeLens/refresh`, `inlineValue/refresh`, `diagnostic/refresh`) and `window/workDoneProgress/create` are acknowledged.
- `window/showMessageRequest` is dismissed with `null`, and `workspace/applyEdit` is declined with `applied: false`.
- `client/unregisterCapability` is now handled.

Previously these were rejected with a JSON-RPC `MethodNotFound` error, which some servers log noisily or handle poorly.

### Client capabilities

- Advertises capabilities for every new request, including `codeAction` `dataSupport` and `resolveSupport`, `inlayHint` and workspace symbol `resolveSupport`, semantic token requests (full, delta, range), and `linkSupport` for declaration.

### Behavior changes

- `saveDocument` now respects the server's save options, so it may send nothing, or send `didSave` with the full text, where it always sent a bare `didSave` before.
- `codeAction` and `inlayHint` `resolveSupport` and workspace symbol `resolveSupport` are now advertised, so some servers may return partial items and defer work to the matching resolve request. Benchmarks of those requests may get faster, with the cost moving to resolve.

### Fixes

- `stop()` never force killed a server that ignored `SIGTERM`, since it checked `process.killed` (which only reports that a signal was sent). It now checks for an actual exit and sends `SIGKILL` after 3 seconds.
- `edit` now applies each edit to the locally tracked document text, in order, following LSP incremental `didChange` semantics. Previously the tracked text never changed after `openDocument`.
- `codeAction` diagnostic code filtering now also matches `data.code`, so quick fixes from servers like Langium that store their issue code in `data` can be triggered.
- `addRegisteredLanguage` stored the extension mapping backwards (language id to extension instead of extension to language id). Extensions are now also lowercased to match `detectLanguageId`.
- `BenchContext.workspaceRoot` is documented as the absolute workspace path it actually holds, not a URI.

### Docs and tests

- README and `lsbench prime` list the full API grouped by area, describe save sync and server to client handling, and correct the stale CLI options and server configuration sections (a JSON server config file was documented but never supported, use `--init-options-file` instead).
- New integration suite against Langium's grammar language server (from devDependencies), covering formatting, code actions, semantic tokens, call and type hierarchy, and more. The minilogo suite now covers the additional methods it supports, and both suites list unsupported methods as skipped.
- `examples/typescript-actions.ts` showcases the new methods.

## v0.1.0

First release!
Updates a number of things from the original prototype, such as running action scripts via ts instead of js, and dropping some unused constructs.
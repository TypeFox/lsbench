# Client Behavior

lsbench acts as the LSP client. This page covers how it adapts to what a server advertises, and how it answers the server.

## Unsupported Requests

A timed request whose provider the server advertises neither statically nor through `client/registerCapability` isn't sent. It returns `null` without a round trip and records a timing with `result: "skipped"` and `duration_ms: 0`, so it shows in the report as skipped instead of as a fast failure.

- This covers the timed [context methods](api.md), including `willSaveWaitUntil`, and `request()` calls for the same LSP methods. Other `request()` methods are always sent.
- A pulled diagnostics wait on a server without `diagnosticProvider` is skipped the same way, and resolves with the cached diagnostics.
- `--no-skip-unsupported` (`skipUnsupported: false`) sends them anyway.
- Verbose mode prints which requests the server supports right after startup, and logs dynamic registrations as they arrive.

A server that registers a provider only after `initialized` gets it skipped until the registration arrives, so wait (for example with `waitForDiagnostics`) before the first request.

## Change Sync

`edit` follows the server's change sync kind, read from the static `textDocumentSync` capability (a bare `TextDocumentSyncKind` number or its `change` field) and from dynamic `textDocument/didChange` registrations (`syncKind`). A dynamic registration overrides the static value. With several registrations the most demanding kind wins (Full over Incremental over None).

| Kind | `didChange` |
| --- | --- |
| Incremental (2) | one ranged change per edit |
| Full (1) | one change holding the whole tracked text after the edits, without a `range` |
| None (0) | not sent, logged in verbose mode. The tracked text and version still update, so later saves and edits stay consistent, but diagnostics waits stay keyed to the `didOpen` |

A server that doesn't state a change kind gets incremental changes. The LSP default is None, but every server measured so far that omits it accepts incremental changes, so only an explicit `0` disables `didChange`.

## Save Sync

`saveDocument` and `willSave` follow the server's save options, read from the static `textDocumentSync` capability and from dynamic registrations of `textDocument/didSave`, `textDocument/willSave` and `textDocument/willSaveWaitUntil`.

- A bare `TextDocumentSyncKind` number implies `didSave` without text, matching `vscode-languageclient`.
- A notification the server doesn't ask for is skipped and logged in verbose mode.
- `willSaveWaitUntil` is a request, so it follows the [unsupported requests](#unsupported-requests) rule and is recorded as skipped.

## Server to Client Requests

lsbench answers requests from the server so it doesn't get stuck waiting on a client:

| Request | Answer |
| --- | --- |
| `workspace/workspaceFolders` | the single folder sent in `initialize`, the workspace root named by its basename |
| `workspace/configuration` | each item's section resolved against the [settings file](server-configuration.md#settings), or an empty object per item without one |
| `client/registerCapability`, `client/unregisterCapability` | accepted, and every registration is tracked (see `ctx.registrations`) |
| `workspace/*/refresh` (semantic tokens, inlay hints, code lenses, inline values, diagnostics) | acknowledged. A diagnostics refresh also makes pending auto waits [pull](diagnostics.md#refreshes) |
| `window/workDoneProgress/create` | acknowledged, and the token is tracked for [`waitForIdle`](readiness.md#waiting-for-idle) |
| `window/showMessageRequest` | dismissed with `null` |
| `workspace/applyEdit` | declined with `applied: false`, so the server never modifies the workspace |

lsbench advertises `workspace.didChangeWatchedFiles` with dynamic registration, as VS Code does, so servers leave file watching to the client. Their watcher registrations are tracked, but lsbench never sends file events.

Other server messages can be handled by an action script's [`setup`](action-scripts.md#custom-server-messages).

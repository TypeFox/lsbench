# CHANGELOG

## v0.3.0-next.2 (preview)

Cold starts on pull only servers no longer wait for a push in every iteration, and auto mode pull timings include the wait that preceded them.

### Pull diagnostics in waits

- With `--restart`, the diagnostics delivery a server was learned to use (push, or pull and whether that is tentative) is carried over to the next iteration's server. In next.1 each restarted server started unknown, so every auto wait on a pull only server such as ts7 first waited the full `pullAfterMs` grace (1000 ms by default) for a push, about 1000 ms of each S1 iteration. Warmup iterations now teach the delivery and timed ones pull at once. A carried tentative pull still flips to push when the restarted server pushes, so a server pulled empty while loading and pushing later (rust-analyzer) is not stuck on pulls. Verbose mode logs `Carrying diagnostics delivery from the previous server`.
- Auto mode pulls (`diagnostics/pull/*`) are timed like push waits: from the latest `didOpen` or `didChange` to the resolving response, or from the call of the wait for a document that is not open or already pulled since its latest sync. In next.1 they were timed from the pull request, so the grace before a fallback pull showed only in the iteration total (`diagnostics/pull/open` 3.9 ms in a 1066 ms iteration). The grace is now part of `duration_ms` and also recorded as the new timing field `grace_ms` (`graceMs` in the `waitForDiagnostics` result), and `MethodStats` adds `graced` and `grace_median_ms` when any timing has it. The printed summary notes such methods below the table. All new fields are optional, so the report change is additive. `mode: 'pull'` waits are still timed from the first pull request.
- Docs: for pull only servers, pass `mode: 'pull'` or a short `pullAfterMs` to avoid the grace altogether, and keep a warmup iteration with `--restart`.

## v0.3.0-next.1 (preview)

Fixes found re-testing next.0 against real servers: auto mode no longer locks pull only servers into push or measures placeholder pulls of servers still loading, reopen waits no longer resolve on a late close publish, known exit codes can be tolerated, and fully timed out methods no longer report 0 ms. Action scripts may also be JavaScript.

### Breaking changes

- `MethodStats` latency fields (`avg_ms`, `median_ms`, `p95_ms`, `p99_ms`, `min_ms`, `max_ms`, `stddev_ms`) are `number | null`. They are `null`, printed `n/a`, when no durations remain because every call timed out or was skipped, where next.0 reported 0, which read as instant. Code reading them needs a `null` check, as `examples/compare-servers.ts` now does.

### Pull diagnostics in waits

- Auto mode learns push only from a publish for a document the client opened (`current`, `closed` or `stale`). In next.0 any publish taught push for the rest of the session, so ts7, which clears `tsconfig.json` right after the first `didOpen`, was locked into push and every wait timed out. Publishes for unopened documents and close window candidates now teach nothing.
- A pull that resolves with no diagnostics learns pull only tentatively, since a server still loading may answer with an empty placeholder and push later. A pull returning diagnostics settles it, and a publish still flips the server to push. Pulls resolving while delivery is not settled are marked `tentative: true` in the timing and in the `waitForDiagnostics` result, and logged as tentative. This corrects next.0's claim that servers that push and advertise `diagnosticProvider` (rust-analyzer) are always measured by their pushes: a cold rust-analyzer was pulled, learned as pull only from an empty placeholder, and measured by those pulls until its first push.
- When the server is learned to push while an auto mode pull is in flight (request or backoff), the pull stops without recording a timing and the wait goes on waiting for pushes for the rest of its timeout, instead of pulling until it times out.

### Diagnostics waits

- Once a server is known to publish on close, a further empty, unversioned publish within the 1000 ms close window after a reopen is credited to the closed generation when the server versions its publishes for open documents, and held as a close candidate otherwise. rust-analyzer clears a closed document with two or three such publishes, and in next.0 a late one resolved the reopen wait in about 0.1 ms. Such a candidate accepted at the end of the window no longer teaches that the server is silent on close.
- A `diagnostics/open` wait that times out having seen only the publishes clearing the latest close logs a hint that the server may not republish clean files on reopen, suggesting `until` or a short timeout. `DocumentSyncState.closePublishes` counts those publishes.
- Publish URIs are matched to documents after decoding percent-encoding, and case-insensitively on darwin and win32, so a server lowercasing or encoding the URIs it publishes no longer makes waits time out. Elsewhere matching stays case-sensitive, and a publish for an unopened URI that matches an open document apart from case logs a hint once per URI.

### Server exits

- `--allow-exit-code <n>` (repeatable) and `ServerConfig.allowExitCodes` tolerate a known non zero exit code after a replied `shutdown`, such as TypeScript 7 exiting 1. Such exits are listed in the new report field `tolerated_exits` instead of `abnormal_exits` and do not make lsbench exit non zero. An exit without a shutdown reply stays abnormal whatever its code. The printed summary shows the abnormal and tolerated exit counts.
- A server exiting after initialize while a request is awaiting its reply no longer hangs the benchmark. vscode-jsonrpc rejects pending requests only when the connection is disposed, so in next.0 such a request never settled. Pending requests now fail with `server exited unexpectedly (...)`, recorded as an `error` timing, and later requests and notifications of the script fail at once, so the iteration ends and the exit is reported as an abnormal exit as before, with or without `--restart`.
- Under `--restart`, a server exiting while its iteration's server was stopped is recorded as during `teardown of iteration N` (or `teardown of warmup N`) instead of `iteration N`, which read as a crash during the iteration's work. A server that exited before the teardown keeps `iteration N`.

### Action scripts and API

- Action scripts may be `.js` or `.mjs` ES modules as well as `.ts`.
- `detectLanguageId(path)` is exported, returning the language id `openDocument` sends for a path.

### Verbose output

- Under `-v`, `Running iteration N...` ends with a newline, so the first ctx line no longer lands on it, and the iteration time follows as its own `Iteration N: Xms` line. Non verbose output is unchanged.
- The `lsbench results` banner of the printed summary is aligned again.

### Docs

- README: debounce numbers (VS Code servers about 500 ms, pyright about 250 ms), lua-language-server and the HTML server named as silent servers, zls named for intermediate publishes, a note on reopen waits for servers that do not republish clean files, the tentative pull behavior, idle waits listed as `lifecycle/idle` and `server/idle` in the report section, `during` labels of exits, and `detectLanguageId`.

## v0.3.0-next.0 (preview)

Makes diagnostics timings trustworthy (version aware, timed, push or pull, with explicit timeouts), adds a readiness signal for servers that load in the background, classifies every result, skips requests the server does not support, and keeps the report when a server crashes.

### Breaking changes

- `waitForDiagnostics` now resolves with `{ diagnostics, timedOut, publishes, source, pulls, ms }` instead of the diagnostics array. Scripts that used the array need `(await ctx.waitForDiagnostics(path)).diagnostics`. Its second argument may be an options object `{ timeout, until, settleMs, mode, pullAfterMs }`, and a bare timeout number still works.
- A timed out wait is now reported (`timedOut: true`, result `timeout`) instead of silently resolving with the cached diagnostics. The timeout comes from the timer itself, never from elapsed time.
- Verbose request timings are now prefixed `[lsbench:ctx]` instead of `  [ctx]`, so all of lsbench's own lines start with `[lsbench`. Server output is prefixed `[server]` (previously `[server stderr]`, `[server]` and `[server msg]`).

### Behavior changes

- Timed requests whose provider the server does not advertise are no longer sent, and are recorded as `skipped` (see below). This includes `willSaveWaitUntil`, which was always sent before. Pass `--no-skip-unsupported` (or `skipUnsupported: false`) for the old behavior.
- `success` is now `false` for `skipped` and `timeout` results as well as for errors.
- `waitForDiagnostics` ignores publishes for other document versions and for closed documents, so it no longer resolves on a stale publish.
- lsbench now advertises `workspace.didChangeWatchedFiles` with dynamic registration, `window.workDoneProgress` and rust-analyzer's `experimental.serverStatusNotification`. Servers may leave file watching to the client and report progress as a result.
- `.mts` and `.cts` open as `typescript`, `.mjs` and `.cjs` as `javascript`, and `.jsonc` as `jsonc`, where they used to fall back to `plaintext`.

### Diagnostics waits

- Waits are version aware. A publish counts when it carries the current document version, or carries no version and arrived after the latest `didOpen` or `didChange` of the current open generation. A matching publish that already arrived resolves the wait at once.
- Each wait records a timing, `diagnostics/open` or `diagnostics/edit` by the latest sync of the document (`diagnostics/wait` for a document that is not open), measured from that `didOpen` or `didChange` to the matching publish and carrying the diagnostic count in `diagnostics`.
- `until: (diagnostics) => boolean` resolves on the first current publish passing it (for example `(d) => d.length > 0` to skip the empty syntax pass of rust-analyzer or zls), and `settleMs` keeps waiting after the resolving publish until no current publish arrived for that long and resolves with the latest. `timeout` caps both. With `settleMs`, `ms` is the time to the latest publish, the quiet period is not included, and a timeout during the quiet period is not a timeout.
- `publishes` counts every current publish the wait saw, including those failing `until`. On timeout, `diagnostics` are those of the latest current publish when one arrived, otherwise the cached ones.
- An empty, unversioned publish after a quick reopen is no longer dropped outright as the clearing publish of the close. It is held for the rest of a 1000 ms window after the `didClose`, superseded by any later publish, and otherwise accepted with its own receipt time. lsbench learns per server whether it publishes on close and then decides at once, so servers that never clear closed documents (such as Langium) no longer time out on every reopen of a clean file.

### Pull diagnostics in waits

- `mode: 'push' | 'pull' | 'auto'` (default `auto`) and `pullAfterMs` (default 1000). In `auto` mode lsbench learns per server process whether a server advertising `diagnosticProvider` pushes: until it sent any publish, a wait pulls through `textDocument/diagnostic` after `pullAfterMs` without one (at half the timeout when that is not longer), and once such a pull resolved without a push the server counts as pull only and is pulled at once. Any publish makes auto waits wait for pushes for the rest of the session, so servers that push and also advertise `diagnosticProvider` (rust-analyzer) keep being measured by their pushes, while pull only servers such as ts7 no longer time out on every wait.
- Pulls repeat with a short backoff until `until` passes or the timeout, send `previousResultId`, and resolve `unchanged` reports to the previous diagnostics. Pulled waits are recorded as `diagnostics/pull/open`, `diagnostics/pull/edit` or `diagnostics/pull/wait`, timed from the first pull to the resolving response.
- `source` (`push` or `pull`) tells which one resolved the wait, and `pulls` counts the requests sent.
- `textDocument.diagnostic` stays unadvertised in the default client capabilities, since servers built on `vscode-languageserver` stop pushing when it is present.

### Readiness

- lsbench tracks work done progress tokens (`$/progress` begin and end, created or not) and rust-analyzer's `experimental/serverStatus`.
- New `ctx.waitForIdle(options?)` (`{ timeout, quietMs }` or a bare timeout, default 30000 ms and 100 ms) resolves with `{ idle, timedOut, ms }` once no token is active and the latest server status, if any, is quiescent, for at least `quietMs`. Recorded as `server/idle`.
- `--wait-idle [ms]` (default 30000) waits for idle after `initialized`, and after each restart, before the script runs. Recorded as `lifecycle/idle`, with a warning on timeout.

### Results and reporting

- Every timing has a `result`: `ok`, `empty`, `null`, `error`, `skipped` or `timeout`. `MethodStats` gains `null_rate`, `empty_rate`, `timeout_rate`, `skipped` and `skip_rate`, and the printed table adds Null%, Empty%, Tmout% and Skip% columns when any is nonzero. Timeouts and skips are left out of the duration stats and of `failure_rate`.
- `ctx.lastError` holds `{ method, message, code? }` when the last timed request failed, to tell a failure apart from a `null` result.
- Requests rejected with `ContentModified` are retried up to `--content-modified-retries` times (default 3) with a short backoff. The timing records `retries` and covers only the final attempt.
- Spawn, initialize and shutdown are timed as `lifecycle/spawn`, `lifecycle/initialize` and `lifecycle/shutdown`. With `--restart` they are part of each run, otherwise they go in a top level `lifecycle` list. Both appear in `summary`.

### Server capabilities and unsupported requests

- `ctx.capabilities` holds the server's `initialize` capabilities, `ctx.registrations` its dynamic registrations, and `ctx.supports(method)` checks both for the provider behind a request method.
- A timed request whose provider is not advertised returns `null` without a round trip and records `result: "skipped"` with `duration_ms: 0`. A pulled diagnostics wait on a server without `diagnosticProvider` is recorded as `skipped` too, and resolves with the cached diagnostics. `--no-skip-unsupported` (or `skipUnsupported: false`) sends them anyway. Verbose mode prints the supported requests after startup and logs dynamic registrations.

### Client configuration

- `--client-capabilities-file <path>` deep merges a JSON file over the default client capabilities (objects merge, arrays and scalars replace). `ServerConfig.clientCapabilities` does the same programmatically, and `defaultClientCapabilities()` and `mergeCapabilities()` are exported.
- `--settings-file <path>` gives the server client settings keyed by section, like VS Code's `settings.json`. Dotted keys are expanded, `workspace/configuration` items resolve their section as a dotted path into the settings, and the settings are sent once via `workspace/didChangeConfiguration` after `initialized` and after each restart. `ServerConfig.settings` does the same programmatically, and `expandSettings()` is exported.
- `openDocument(path, { languageId })` overrides the languageId detected from the extension for one document.

### Server crashes

- `stop()` always settles: the `shutdown` request is raced against the process exiting and `--shutdown-timeout` (default 5000 ms), then the server is killed if needed.
- The report is written before the final teardown, and with `--restart` a failed teardown keeps the collected runs. Abnormal exits are listed in the report's `abnormal_exits`, and lsbench then exits non zero.

### Verbose output

- `-v` logs each `textDocument/publishDiagnostics` as one line with the workspace relative path, version, count, tracker status (`current`, `stale`, `closed`, `close candidate`, `unopened`) and the first message.
- `--server-log <file>` appends server stderr, `window/logMessage`, `window/showMessage` and `$/logTrace` to a file, with a header line per server start, instead of the console.

### Docs

- README sections on waiting for diagnostics, pull diagnostics, waiting for idle, unsupported requests, comparing diagnostics timings across servers, and warmup and readiness. `lsbench prime` covers the same.

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
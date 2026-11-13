# lsbench

[![npm version](https://img.shields.io/npm/v/lsbench.svg)](https://www.npmjs.com/package/lsbench)

<img src="lsbench-icon.svg" alt="LSBench logo" width="178">

Benchmark arbitrary language servers with scripted LSP actions.

![lsbench example with langium-minilogo](demo/lsbench.gif)

```bash
# bench a ts language server over stdio, 50 iterations, report to results.json
lsbench "typescript-language-server --stdio" \
  --workspace ./my-project \
  --script ./bench-actions.ts \
  --iterations 50 \
  --output results.json
```

## Installation

lsbench is published on npm. You can install it globally to get the CLI:

```bash
npm install -g lsbench
```

Or, you can add it as a dependency to import the `BenchContext` API in your action
scripts directly:

```bash
npm install lsbench
```

## How it works

lsbench spawns a language server process, performs the LSP
initialize/initialized handshake, then runs your action script. That script is a
TypeScript or JavaScript file that drives a sequence of LSP requests
against a target workspace.

Each request is then timed. The script runs for N iterations, producing
a JSON report with per-method statistics and per-run breakdowns.

## Writing an action script

An action script is a `.ts`, `.js` or `.mjs` ES module that default-exports an async function
receiving a `BenchContext`. TypeScript scripts are loaded by Node's built-in type stripping (Node >= 24), so they must be erasable TypeScript: no `enum`, `namespace`, or parameter properties. A `.js` script is ESM unless the nearest `package.json` says otherwise, and `.mjs` always is. The [`examples/`](examples) directory has a few
starting points you can checkout:

- [`examples/typescript-actions.ts`](examples/typescript-actions.ts): a fuller driver exercising hover, completion (with resolve), navigation, formatting, document structure, semantic tokens, workspace symbols, call and type hierarchy, edits, and saves.
- [`examples/cold-start.ts`](examples/cold-start.ts): a minimal cold-start
  driver (i.e. a benchmark that restarts the LS on each run).
- [`examples/custom-language.ts`](examples/custom-language.ts): benchmarking a non-mainstream language server (a Langium DSL) via `addRegisteredLanguage`.
- [`examples/compare-servers.ts`](examples/compare-servers.ts): importing `runBenchmark` to compare two servers programmatically and diff the reports.

A typical script looks akin to this:

```typescript
import { BenchContext } from "lsbench";

export default async function (ctx: BenchContext) {
  await ctx.openDocument("src/index.ts");
  await ctx.waitForDiagnostics("src/index.ts");

  await ctx.hover("src/index.ts", 10, 5);
  await ctx.completion("src/index.ts", 15, 10);
  await ctx.definition("src/index.ts", 10, 5);
  await ctx.references("src/index.ts", 10, 5);
  await ctx.documentSymbol("src/index.ts");

  await ctx.closeDocument("src/index.ts");
}
```

### BenchContext API

The following paths should be considered relative to your workspace root, and their positions are zero based. Methods marked as `timed` record a timing entry and return the raw LSP result, or `null` on a failure. `ctx.workspaceRoot` holds the absolute workspace root path for reference.

Since a failure and a `null` result both return `null`, `ctx.lastError` holds `{ method, message, code? }` when the last timed request failed, and is `undefined` otherwise. It is cleared as each timed request starts.

```ts
const res = await ctx.definition("src/index.ts", 10, 5);
if (ctx.lastError) {
  console.error(`definition failed: ${ctx.lastError.message}`);
}
```

`ctx.capabilities` holds the `capabilities` of the server's `initialize` result, and `ctx.registrations` the dynamic registrations it currently holds (`{ id, method, registerOptions? }`). `ctx.supports(method)` checks both for the provider behind an LSP request method, including options such as `resolveProvider` or `semanticTokensProvider.full.delta`. Methods lsbench has no provider mapping for count as supported.

```ts
if (ctx.supports("textDocument/diagnostic")) {
  await ctx.documentDiagnostic("src/index.ts");
}
```

**Document lifecycle** (all but `openDocument` and `closeDocument` require an open document)

| Method | Description |
| --- | --- |
| `openDocument(path, options?)` | Send `textDocument/didOpen`. `options.languageId` overrides the languageId detected from the extension, for this document only |
| `closeDocument(path)` | Send `textDocument/didClose` |
| `edit(path, edits)` | Send `textDocument/didChange` and apply the edits to the tracked text, in order |
| `saveDocument(path)` | Send `textDocument/didSave` only if the server asks for it, with the tracked text when it wants `includeText` |
| `willSave(path, reason?)` | Send `textDocument/willSave` only if the server asks for it. `reason` defaults to 1 (Manual) |
| `willSaveWaitUntil(path, reason?)` | `textDocument/willSaveWaitUntil` (timed, skipped unless the server asks for it). `reason` defaults to 1 (Manual) |

**Navigation and editing** (timed)

| Method | Description |
| --- | --- |
| `hover(path, line, char)` | `textDocument/hover` |
| `completion(path, line, char)` | `textDocument/completion` |
| `signatureHelp(path, line, char)` | `textDocument/signatureHelp` |
| `definition(path, line, char)` | `textDocument/definition` |
| `declaration(path, line, char)` | `textDocument/declaration` |
| `typeDefinition(path, line, char)` | `textDocument/typeDefinition` |
| `implementation(path, line, char)` | `textDocument/implementation` |
| `references(path, line, char)` | `textDocument/references` (includes the declaration) |
| `documentHighlight(path, line, char)` | `textDocument/documentHighlight` |
| `prepareRename(path, line, char)` | `textDocument/prepareRename` |
| `rename(path, line, char, newName)` | `textDocument/rename` |
| `codeAction(path, range, codes?)` | `textDocument/codeAction`. `codes` selects cached diagnostics by `code`, falling back to `data.code` (as used by Langium) |
| `formatting(path)` | `textDocument/formatting` |
| `rangeFormatting(path, range)` | `textDocument/rangeFormatting` |
| `onTypeFormatting(path, line, char, ch)` | `textDocument/onTypeFormatting` |

**Document structure** (timed)

| Method | Description |
| --- | --- |
| `documentSymbol(path)` | `textDocument/documentSymbol` |
| `foldingRange(path)` | `textDocument/foldingRange` |
| `selectionRange(path, positions)` | `textDocument/selectionRange` |
| `documentLink(path)` | `textDocument/documentLink` |
| `codeLens(path)` | `textDocument/codeLens` |
| `inlayHint(path, range)` | `textDocument/inlayHint` |
| `semanticTokensFull(path)` | `textDocument/semanticTokens/full` |
| `semanticTokensRange(path, range)` | `textDocument/semanticTokens/range` |
| `semanticTokensDelta(path, previousResultId)` | `textDocument/semanticTokens/full/delta` |

**Workspace, hierarchies, and pull diagnostics** (timed)

| Method | Description |
| --- | --- |
| `workspaceSymbol(query)` | `workspace/symbol` |
| `prepareCallHierarchy(path, line, char)` | `textDocument/prepareCallHierarchy` |
| `callHierarchyIncomingCalls(item)` | `callHierarchy/incomingCalls` |
| `callHierarchyOutgoingCalls(item)` | `callHierarchy/outgoingCalls` |
| `prepareTypeHierarchy(path, line, char)` | `textDocument/prepareTypeHierarchy` |
| `typeHierarchySupertypes(item)` | `typeHierarchy/supertypes` |
| `typeHierarchySubtypes(item)` | `typeHierarchy/subtypes` |
| `documentDiagnostic(path, previousResultId?)` | `textDocument/diagnostic` |
| `workspaceDiagnostic(previousResultIds?)` | `workspace/diagnostic` |

**Resolve** (timed, the item is sent back as is)

| Method | Description |
| --- | --- |
| `completionItemResolve(item)` | `completionItem/resolve` |
| `codeActionResolve(action)` | `codeAction/resolve` |
| `codeLensResolve(codeLens)` | `codeLens/resolve` |
| `inlayHintResolve(hint)` | `inlayHint/resolve` |
| `documentLinkResolve(link)` | `documentLink/resolve` |
| `workspaceSymbolResolve(symbol)` | `workspaceSymbol/resolve` |

**Helpers**

| Method | Description |
| --- | --- |
| `waitForDiagnostics(path, options?)` | Wait for `publishDiagnostics` matching the current document version, or pull them, and time it (`options` is `{ timeout, until, settleMs, mode, pullAfterMs }` or a bare timeout, default 30000 ms). Resolves with `{ diagnostics, timedOut, publishes, source, pulls, ms }`, plus `tentative: true` for an auto mode pull of a server whose delivery is not settled and `graceMs` for an auto mode pull that first waited for a push, see [Waiting for diagnostics](#waiting-for-diagnostics) |
| `waitForIdle(options?)` | Wait until the server finished background work such as loading the workspace (`options` is `{ timeout, quietMs }` or a bare timeout, default 30000 ms). Resolves with `{ idle, timedOut, ms }`, see [Waiting for idle](#waiting-for-idle) |
| `sleep(ms)` | Pause execution |
| `request(method, params, label?)` | Arbitrary LSP request (timed) |
| `notify(method, params)` | Arbitrary LSP notification |

Call and type hierarchy requests expect an item returned by the matching prepare call:

```ts
const items = (await ctx.prepareCallHierarchy("src/index.ts", 10, 5)) as unknown[] | null;
if (items && items.length > 0) {
  await ctx.callHierarchyIncomingCalls(items[0]);
  await ctx.callHierarchyOutgoingCalls(items[0]);
}
```

Resolve requests take an item returned by the matching request. The server only answers when its provider advertises `resolveProvider: true`, otherwise lsbench skips them:

```ts
const list = (await ctx.completion("src/index.ts", 15, 10)) as { items: unknown[] } | unknown[] | null;
const items = Array.isArray(list) ? list : (list?.items ?? []);
if (items.length > 0) {
  await ctx.completionItemResolve(items[0]);
}
```

lsbench advertises `resolveSupport` for completion items, code actions, inlay hints, and workspace symbols, so some servers return partial items and defer that work to the resolve request.

`documentDiagnostic` and `workspaceDiagnostic` only work against servers that expose `diagnosticProvider`. lsbench does not advertise the `textDocument.diagnostic` client capability, since servers built on `vscode-languageserver` (such as the VS Code CSS, HTML and JSON servers, and ESLint) stop pushing diagnostics when it is present, which would silently turn push timings into pull timings. Servers that advertise `diagnosticProvider` regardless are pulled by `waitForDiagnostics` (see [pull diagnostics](#pull-diagnostics)). To advertise it anyway, set `textDocument.diagnostic` through `--client-capabilities-file`.

### Waiting for diagnostics

`waitForDiagnostics` resolves with the first publish that matches the current state of an open document, and resolves at once when such a publish already arrived, so awaiting other work between `openDocument` or `edit` and the wait does not miss it. Each `didOpen` starts a new open generation. A publish counts when it belongs to the current generation and:

- carries the current document version, or
- carries no version and arrived after the latest `didOpen` or `didChange`.

Publishes received while the document was closed, and publishes for other versions, are ignored. Servers often clear a closed document with an empty publish that can land after the next `didOpen`, while others never publish on close, so an empty publish after a quick reopen is ambiguous. The first empty, unversioned publish after a reopen within 1000 ms of the `didClose` is therefore held as a tentative candidate:

- if another publish for the document arrives before the window ends, it supersedes the candidate, which was the close publish
- otherwise the candidate is accepted when the window ends, and `ms` still counts to its own receipt

lsbench learns per server process which case applies. A publish for a closed document, or a superseded candidate, shows that the server publishes on close, and from then on such a publish is credited to the closed generation at once. A candidate accepted at the end of the window, or a close with no publish within it, shows that it does not, and the rule is turned off. A server that never publishes on close thus pays the window at most once. Some servers clear a closed document more than once (rust-analyzer sends two or three empty publishes), so once the server is known to publish on close, a further empty, unversioned publish within the window is credited to the close as well when the server sends versions with its publishes for open documents, and held as a candidate otherwise. Such a candidate accepted at the end of the window does not turn the rule off. Verbose mode logs candidates and what was learned. For a document that is not open, the wait resolves on the next publish.

The first matching publish is not always the final word. rust-analyzer and zls publish an empty syntax pass before the semantic diagnostics, and some servers publish in bursts. Two options shape what resolves the wait:

- `until: (diagnostics) => boolean`: resolve on the first matching publish whose diagnostics pass it. Matching publishes failing it are counted in `publishes` but do not resolve the wait
- `settleMs`: after the resolving publish, keep waiting until no further matching publish arrived for `settleMs`, then resolve with the latest one. With `until`, the quiet period starts once `until` is satisfied, and later publishes no longer need to pass it. Quiet time counts from the receipt of a publish, so a cached publish, or a close window candidate accepted at the end of its window, may already have been quiet long enough

`timeout` caps the whole wait, quiet period included. The wait resolves with `{ diagnostics, timedOut, publishes, source, pulls, ms }` (`source` and `pulls` are covered under [pull diagnostics](#pull-diagnostics)):

- `diagnostics`: the diagnostics of the resolving publish (the latest one with `settleMs`). On timeout, those of the latest matching publish when one arrived, otherwise the cached ones
- `timedOut`: `true` when the timeout fired before a matching publish (passing `until`, when given) arrived. A timeout during the quiet period does not count, the wait then resolves with the latest publish. This comes from the timer itself, never from comparing elapsed time against the timeout, since timers can fire slightly early
- `publishes`: how many matching publishes the wait saw, including a cached one and those failing `until`
- `ms`: time from the latest `didOpen` or `didChange` of the document to the resolving publish (or to the timeout), so time to diagnostics is measured even when other work ran before the wait. With `settleMs` this is the time to the latest publish, the quiet period after it is not included

```typescript
await ctx.openDocument("src/main.rs");
const { diagnostics, timedOut, ms } = await ctx.waitForDiagnostics("src/main.rs", {
  timeout: 10_000,
  until: (d) => d.length > 0, // skip the empty syntax pass
  settleMs: 200, // and pick up a follow up publish
});
```

Each wait also records a timing, so time to diagnostics shows up in the report like any method:

- `diagnostics/open`: the latest sync of the document was `didOpen`
- `diagnostics/edit`: the latest sync was `didChange`
- `diagnostics/wait`: the document is not open, timed from the call

The timing's `duration_ms` is `ms`, and `diagnostics` holds the diagnostic count. Its `result` is `ok` with diagnostics, `empty` without, and `timeout` when the wait timed out. Timeouts count toward `timeout_rate` and are left out of the duration stats, since their duration is just the timeout. Some servers never publish for clean files, so a `timeout_rate` near 1 means "no diagnostics", not necessarily a slow server.

#### Pull diagnostics

Some servers advertise `diagnosticProvider` and never push (ts7, for example), so a push wait would always run into its timeout. The `mode` option picks where diagnostics come from:

- `auto` (default): a server without `diagnosticProvider` (neither static nor dynamically registered) is only ever waited on for pushes. For one with it, lsbench learns per server process how it delivers diagnostics:
  - unknown, no push seen yet: wait for a push up to `pullAfterMs` (default 1000 ms), then pull. When `timeout` is not longer than `pullAfterMs`, pulling starts at half the timeout
  - push: once the server published for a document the client opened (a `current`, `closed` or `stale` publish, see [verbose output](#verbose-output)), auto waits only wait for pushes. Publishes for documents never opened, such as ts7 clearing `tsconfig.json`, close window candidates and placeholder publishes (see below) teach nothing
  - pull only: once an auto wait fell back to pulling and the pull resolved with no push in the meantime, later auto waits pull at once. A pull that returned no diagnostics learns this only tentatively, since a server still loading (a cold rust-analyzer, for example) may answer with an empty placeholder and push later. Until a pull returns diagnostics, pulled timings and results are marked `tentative: true`, and verbose mode adds `(tentative, the server may still push)`

  A push flips the server to push at any time. A pull in flight then stops, records no timing, and the wait goes on waiting for pushes for the rest of its timeout, so a server that both pushes and advertises `diagnosticProvider`, such as rust-analyzer, is measured by its pushes from its first publish on. Before that, it may be measured by tentative pulls: wait for idle first (see [warmup and readiness](#warmup-and-readiness)), or pass `mode: "push"`. Verbose mode logs what was learned

  With `--restart`, what one iteration's server was learned to use is carried over to the next iteration's server (verbose mode logs `Carrying diagnostics delivery from the previous server`), so warmup iterations teach it and timed iterations on a pull only server pull at once instead of paying the `pullAfterMs` grace on every cold start. A carried tentative pull stays tentative, so a restarted server that pushes still flips it to push

  Unless pull is settled, an empty pull answered while the server reports it is still loading is held as a placeholder instead of resolving the wait: the wait goes on waiting for a push, and pulls again once the server is no longer busy. Busy means `experimental/serverStatus` with `quiescent: false` once the server sent a status (rust-analyzer), and an open `$/progress` token for servers that never send one; rust-analyzer's flycheck progress after it turned quiescent does not count. The resolving timing then carries `held_pulls`, the summary entry adds `held`, how many timings held back a placeholder, and the printed summary notes them below the table (without the `mode: "pull"` hint, which would measure the placeholders). A wait that times out while the server stays busy records a pull timeout. A server that never reports being busy, such as ts7, is not affected

  Likewise, an empty publish for an opened document arriving while the server reports `experimental/serverStatus` with `quiescent: false` is a placeholder (rust-analyzer publishes one while loading). Only the server status counts here, not `$/progress`, so other push servers are not affected. A placeholder neither resolves an auto wait nor teaches push. Once the server is quiescent, the wait resolves with a newer publish if one arrived, else pulls when a held pull would (the server advertises `diagnosticProvider` and push was not learned), else with the placeholder, timed to the quiescence. A wait that times out first reports the placeholder. Non-empty publishes are never held. The timing carries `held_publishes`, the summary entry adds `held_publishes`, how many timings held back a placeholder publish, and the printed summary notes them below the table

  A `workspace/diagnostic/refresh` while an auto wait waits for a push (in the grace, after a held placeholder, or with push learned) makes it pull once, retrying `ContentModified` and `ServerCancelled`. A result passing `until` resolves the wait as a pull, the placeholder rule above still applying, otherwise the wait goes on waiting for a push. A refresh pull that returned diagnostics settles the server as pull only even after push was learned (rust-analyzer stops pushing for a document it was pulled for and only sends refreshes), while an empty one teaches nothing. A publish for an opened document still flips it back to push. Verbose mode logs each refresh
- `push`: only wait for pushes
- `pull`: send `textDocument/diagnostic` at once. A server without `diagnosticProvider` gets the wait recorded as `skipped`, like other unsupported requests

A pull resolves on the first report passing `until` (any report without it). Otherwise lsbench pulls again with a backoff from 25 ms doubling up to 250 ms, until `until` passes or the remaining `timeout` runs out. Each pull sends the `resultId` of the previous report for the document as `previousResultId`, and an `unchanged` report resolves to the diagnostics of that previous report. Closing the document forgets its `resultId`. A request rejected with ContentModified or ServerCancelled is pulled again, any other error ends the wait with `result: "error"`. `settleMs` does not apply, a report is the server's complete answer.

The result's `source` is `push` or `pull`, telling which one resolved the wait, and `pulls` counts the requests sent (0 for push, `publishes` is 0 for pull). A pull has no server debounce, so its timing is not comparable with time to a push. It is recorded under its own methods, `diagnostics/pull/open`, `diagnostics/pull/edit` and `diagnostics/pull/wait`, re-pulls and backoff included:

- `auto` mode: timed like a push wait, from the latest `didOpen` or `didChange` to the resolving response (from the call of the wait for a document that is not open, or that was already pulled since its latest sync). So the timing is open (or edit) to diagnostics as the script saw it, for push and pull alike. When the wait first waited for a push from a server whose delivery was unknown, that grace is part of `ms` and is also recorded as `grace_ms` in the timing and `graceMs` in the result. The summary entry then adds `graced`, how many timings include a grace, and `grace_median_ms`, and the printed summary notes them below the table. The first auto wait on a pull only server pays the grace once (under `--restart`, once per run unless a warmup taught the delivery, see above)
- `pull` mode: timed from the first pull request to the resolving response, the round trip the script asked to measure. No grace is involved

To avoid the grace on a server known to be pull only, such as ts7, pass `mode: "pull"`, or a short `pullAfterMs`. A `tentative` pull may have measured a placeholder rather than real diagnostics, so leave such timings out or wait for idle first. `codeAction` codes match against pulled diagnostics when the server never published for the document.

### Waiting for idle

Servers such as rust-analyzer load and index the workspace in the background after `initialized`. Requests sent meanwhile fail with `content modified` or answer from a partial model, so cold timings measure a placeholder. lsbench advertises `window.workDoneProgress` and tracks every work done progress token through `$/progress` begin and end, whether or not the server created it with `window/workDoneProgress/create`. It also advertises rust-analyzer's `experimental.serverStatusNotification` and tracks `experimental/serverStatus`. Verbose mode logs progress begin and end titles and status changes.

`waitForIdle` resolves once the server is idle: no progress token is active and, if the server ever sent a server status, the latest one is `quiescent: true`. The server must stay idle for `quietMs` (default 100), counted from the later of the call and the moment it last became idle, so the wait does not resolve between back to back progress tokens. A server that never reports progress resolves after the quiet period. The result is:

- `idle`: whether the server was idle when the wait resolved. On timeout it can be `true` when the quiet period was cut short
- `timedOut`: `true` when the timeout fired before the server stayed idle for `quietMs`
- `ms`: time from the call until the server last became idle, 0 when it already was. The quiet period is not included. On timeout, the time until the timeout

Each wait is recorded as `server/idle`, with `result` `ok` or `timeout`. A token that never ends keeps the server busy, so the wait times out.

```typescript
export default async function (ctx: BenchContext) {
  await ctx.waitForIdle(60_000); // let rust-analyzer load the workspace
  await ctx.openDocument("src/main.rs");
  await ctx.hover("src/main.rs", 10, 5);
}
```

Pass `--wait-idle [ms]` to wait for idle after `initialized`, and after each restart with `--restart`, before the script runs (default 30000 ms). The wait is recorded as `lifecycle/idle`, and a timeout prints `Warning: server not idle after Nms`.

### Unsupported requests

A timed request whose provider the server advertises neither statically nor through `client/registerCapability` is not sent. It returns `null` without a round trip and records a timing with `result: "skipped"` and `duration_ms: 0`, so it shows up in the report as skipped instead of as a fast failure. This covers the timed context methods above, including `willSaveWaitUntil`, and `request()` calls for the same LSP methods. A pulled diagnostics wait on a server without `diagnosticProvider` is skipped the same way, and resolves with the cached diagnostics. Other `request()` methods are always sent. Pass `--no-skip-unsupported` (or `skipUnsupported: false`) to send them anyway. Verbose mode prints which requests the server supports right after startup, and logs dynamic registrations as they arrive. A server that registers a provider only after `initialized` gets it skipped until the registration arrives, so wait (for example with `waitForDiagnostics`) before the first request.

### Save sync

`saveDocument` and `willSave` follow the server's save options, read from the static `textDocumentSync` capability and from dynamic registrations of `textDocument/didSave`, `textDocument/willSave`, and `textDocument/willSaveWaitUntil`. A bare `TextDocumentSyncKind` number implies `didSave` without text, matching `vscode-languageclient`. When the server does not ask for a notification it is skipped and logged in verbose mode. `willSaveWaitUntil` is a request, so it follows the [unsupported requests](#unsupported-requests) rule and is recorded as skipped.

### Server to client requests

lsbench answers requests from the server so it doesn't get stuck waiting on a client:

- `workspace/configuration` resolves each item's section against the [settings file](#server-configuration), or returns an empty object per item when no settings are given
- `client/registerCapability` and `client/unregisterCapability` are accepted, and every registration is tracked (see `ctx.registrations`). lsbench advertises `workspace.didChangeWatchedFiles` with dynamic registration, as VS Code does, so servers leave file watching to the client; their watcher registrations are tracked, but lsbench never sends file events
- `workspace/*/refresh` (semantic tokens, inlay hints, code lenses, inline values, diagnostics) are acknowledged. A diagnostics refresh also makes pending auto diagnostics waits pull, see [pull diagnostics](#pull-diagnostics)
- `window/workDoneProgress/create` is acknowledged, the token is tracked for [`waitForIdle`](#waiting-for-idle)
- `window/showMessageRequest` is dismissed with `null`
- `workspace/applyEdit` is declined with `applied: false`, lsbench avoids modifying the workspace using server-initiated requests

### Registering languages

In some cases you may also need to register a language ID for a given extension.
That's straightforward to do with `addRegisteredLanguage`, which will then impact all context related actions for documents with a matching extension.

```ts
import { addRegisteredLanguage } from 'lsbench';

// make sure mylanguage is recognized by its extension
addRegisteredLanguage('mylanguage', '.dsl');
```

This will ensure that opening a document with the extension `.dsl` will have an associated language ID of `mylanguage`, to invoke the correct language server.

`detectLanguageId(path)` returns the language ID `openDocument` sends for a path, matching the extension case-insensitively and falling back to `plaintext`:

```ts
import { detectLanguageId } from 'lsbench';

detectLanguageId('src/index.TS'); // 'typescript'
detectLanguageId('model.dsl'); // 'mylanguage' after the call above, 'plaintext' otherwise
```

To override the language ID of a single document instead, pass it when opening:

```ts
// a JSON file with comments, served as jsonc
await ctx.openDocument(".vscode/settings.json", { languageId: "jsonc" });
```

## CLI options

```
Usage: lsbench [run] [options] <server>

Arguments:
  server                      Server command, e.g. "typescript-language-server --stdio"

Options:
  -w, --workspace <path>      Workspace directory (required)
  -s, --script <path>         Action driver script, .ts, .js or .mjs (required)
  -n, --iterations <number>   Timed iterations (default: 10)
  --warmup <number>           Warmup iterations, not recorded (default: 2)
  -o, --output <path>         JSON report output file
  --init-options-file <path>  JSON file with LSP initializationOptions
  --client-capabilities-file <path>
                              JSON file deep merged over the default client capabilities
  --settings-file <path>      JSON file with client settings keyed by section
  --restart                   Restart the server between iterations
  --shutdown-timeout <ms>     Wait for a shutdown reply, then kill (default: 5000)
  --allow-exit-code <n>       Tolerate exit code n after a replied shutdown (repeatable)
  --content-modified-retries <n>
                              Retry requests rejected with ContentModified (default: 3)
  --no-skip-unsupported       Send requests even when the server does not advertise their provider
  --wait-idle [ms]            Wait up to ms for the server to become idle after initialized,
                              and after each restart (default: 30000)
  --server-log <file>         Append server stderr, window/logMessage, window/showMessage and
                              $/logTrace to file instead of the console, even without -v
  -v, --verbose               Verbose logging
  -V, --version               Show version
  -h, --help                  Show help

Commands:
  run                         Run a benchmark (default command)
  prime                       Print a primer on using lsbench
  baseline                    Write a baseline from a report (see [Regression checks](#regression-checks))
  check                       Check a report against a baseline
```

### Verbose output

With `-v`, lsbench's own lines start with `[lsbench]`, request timings with `[lsbench:ctx]`. The `Running iteration N...` progress line ends there, and the iteration time follows the iteration's log lines as `Iteration N: Xms`. Each `textDocument/publishDiagnostics` is logged as one line: the workspace relative path (the URI outside the workspace), the version or `-`, the diagnostic count, how the diagnostics tracker classified it, and the first message truncated to 100 characters:

```text
[lsbench] Publish src/config.yaml v=1 n=2 current: Incorrect type. Expected "string".
```

The status is `current` for the open document state, `stale` for an older version or a publish credited to a closed document, `closed` while the document is closed, `close candidate` when held as the possible clearing publish of a close (see [Waiting for diagnostics](#waiting-for-diagnostics)), and `unopened` for a document never opened. Publish URIs are matched to documents after decoding percent-encoding, and case-insensitively on macOS and Windows. On other platforms a publish whose URI matches an open document only apart from case stays `unopened`, and lsbench logs a hint once per URI.

Server stderr, `window/logMessage`, `window/showMessage` and `$/logTrace` are forwarded in verbose mode with each line prefixed `[server]`, so `grep -v '^\[server\]'` leaves lsbench's lines. `--server-log <file>` writes them to a file instead, with or without `-v`. The file is appended to, with a header line per server start holding the timestamp and command:

```text
===== 2026-11-11T10:15:02.123Z server start: yaml-language-server --stdio
```

When a server crashes, the tail of its stderr is still included in the error message either way.

### Prime

The CLI also supports a `prime` command that will print helpful information for working with `lsbench`.
This can be leveraged by humans as well as agents to use the tool in a self-documenting fashion.

## Server configuration

The server argument is a command string, split on whitespace. Anything after `--` is appended to the server's arguments:

```bash
lsbench "typescript-language-server --stdio" -w ./project -s ./actions.ts -- --log-level 4
```

Pass LSP `initializationOptions` as a JSON file:

```bash
lsbench "typescript-language-server --stdio" -w ./project -s ./actions.ts \
  --init-options-file ./init-options.json
```

See [`examples/init-options.json`](examples/init-options.json) for a sample.

Add or override client capabilities with a JSON file. It is deep merged over the defaults lsbench sends: objects merge recursively, arrays and scalars replace. For example, to turn off completion snippets:

```bash
lsbench "typescript-language-server --stdio" -w ./project -s ./actions.ts \
  --client-capabilities-file ./client-capabilities.json
```

```json
{ "textDocument": { "completion": { "completionItem": { "snippetSupport": false } } } }
```

Give the server client settings with a JSON file keyed by section, like VS Code's `settings.json`:

```bash
lsbench "vscode-html-language-server --stdio" -w ./project -s ./actions.ts \
  --settings-file ./settings.json
```

```json
{
  "js/ts": { "implicitProjectConfig": { "checkJs": true } },
  "html.format": { "enable": true }
}
```

Like VS Code, lsbench first expands dotted keys into nested objects, at every level, so the example above becomes `{ "js/ts": { ... }, "html": { "format": { "enable": true } } }`. Keys that meet at the same path deep merge, and on a conflict a key without dots wins over a dotted one. Each `workspace/configuration` item's `section` is then resolved as a dotted path into the expanded settings: `html` gets `{ "format": { "enable": true } }` and `html.format.enable` gets `true`. An unknown section gets `null`, and an item without a section gets the whole settings object. After `initialized`, the expanded settings are also sent once with `workspace/didChangeConfiguration` as `{ settings }`, and again after each restart. Without a settings file, every item gets `{}` and no `didChangeConfiguration` is sent.

For full control over `command`, `args`, `env`, `initializationOptions`, `clientCapabilities`, `settings` and `allowExitCodes`, drive `LspHarness` programmatically with a `ServerConfig`. `defaultClientCapabilities()` and `mergeCapabilities()` are exported for building on the defaults, and `expandSettings()` shows how settings are expanded.

## Output format

The JSON report contains:

- **summary**: Per-method aggregate stats (avg, median, p95, p99, min, max, stddev, failure rate, null rate, empty rate, timeout rate, skipped, and for auto mode pulls that waited for a push first `graced` and `grace_median_ms`, or that held back empty answers of a busy server `held`, and for diagnostics waits that held back placeholder publishes `held_publishes`), including the server lifecycle (see below), time to diagnostics (`diagnostics/*` and `diagnostics/pull/*`, see [waiting for diagnostics](#waiting-for-diagnostics)) and idle waits (`lifecycle/idle` for `--wait-idle`, `server/idle` for `ctx.waitForIdle`)
- **iteration_summary**: Per-iteration total time stats
- **runs**: Full per-iteration, per-request breakdown
- **lifecycle**: Keep alive mode only. Spawn, initialize, idle and final shutdown timings of the single server
- **abnormal_exits**: Servers that crashed or exited unexpectedly, only present when any did. The report is still written, and lsbench exits non zero. Each exit's `during` is `iteration N` or `warmup N` for a server that exited during an iteration, `teardown of iteration N` or `teardown of warmup N` for one that exited while being stopped under `--restart`, and `final teardown` for the single server without it
- **tolerated_exits**: Servers that replied to `shutdown` and then exited with a code allowed by `--allow-exit-code` (`ServerConfig.allowExitCodes`), only present when any did. They have the same shape as `abnormal_exits` but do not make lsbench exit non zero. Use this for servers known to exit non zero after `exit`, such as TypeScript 7 exiting 1. A server that exits without replying to `shutdown` stays in `abnormal_exits` whatever its code

Each request timing has a `result`:

- `ok`: a non empty result
- `empty`: an empty list, or a list wrapper with an empty list (a `CompletionList` or diagnostic report with no `items`, `SemanticTokens` with no `data`)
- `null`: a `null` result. A high `null_rate` usually means a position misses a symbol, so its fast timings mean little
- `error`: the request failed, with the message in `error`
- `skipped`: never sent, since the server does not advertise the provider (see [unsupported requests](#unsupported-requests))
- `timeout`: a diagnostics or idle wait ran out (see [waiting for diagnostics](#waiting-for-diagnostics) and [waiting for idle](#waiting-for-idle))

`success` is kept for compatibility and is `false` exactly for `error`, `skipped` and `timeout`. `summary` aggregates `failure_rate`, `null_rate`, `empty_rate` and `timeout_rate` per method, and the printed table adds Null% and Empty% columns when any method has a nonzero rate, and a Tmout% column when any wait timed out. Timeouts are not failures, so they only count toward `timeout_rate`. `count` includes skipped requests, `skipped` counts them and `skip_rate` is their share. The rates cover only the requests actually sent, and the duration stats additionally leave out timeouts, so a fully skipped or fully timed out method has no durations: its latency fields (`avg_ms` to `stddev_ms`) are `null`, printed as `n/a`, and a fully skipped one has a `failure_rate` of 0. The printed table adds a Skip% column when any request was skipped.

Requests rejected with `ContentModified` (-32801), as servers do while loading or when an edit races a request, are retried up to `--content-modified-retries` times (default 3) with a short backoff. The timing records the count in `retries` and covers only the final attempt.

Server lifecycle timings are recorded like methods, with a `result` of `ok` or `error` (`ok` or `timeout` for `lifecycle/idle`):

- `lifecycle/spawn`: spawning the process until the OS reports it started
- `lifecycle/initialize`: the `initialize` request until its response, which includes the server's own startup
- `lifecycle/idle`: with `--wait-idle` only, `initialized` until the server became idle (see [waiting for idle](#waiting-for-idle)), the quiet period not included
- `lifecycle/shutdown`: the `shutdown` request until its reply. It fails when the server exits first or does not reply within `--shutdown-timeout`

With `--restart` each run's `requests` start with spawn, initialize and idle and end with shutdown. Spawn, initialize and idle count toward `total_ms`, shutdown happens after the iteration ends and does not. Without `--restart` the single server's timings belong to no iteration, so they go in the top level `lifecycle` list instead, and each appears once in `summary`.

```json
{
  "server": "typescript-language-server --stdio",
  "iterations": 50,
  "warmup": 2,
  "summary": {
    "textDocument/hover": {
      "count": 50,
      "avg_ms": 12.4,
      "median_ms": 11.2,
      "p95_ms": 22.1,
      "p99_ms": 34.5,
      "min_ms": 8.1,
      "max_ms": 42.3,
      "stddev_ms": 5.2,
      "failure_rate": 0,
      "null_rate": 0,
      "empty_rate": 0,
      "timeout_rate": 0,
      "skipped": 0,
      "skip_rate": 0
    }
  },
  "runs": [
    {
      "iteration": 1,
      "requests": [
        { "method": "textDocument/hover", "duration_ms": 13.2, "success": true, "result": "ok" }
      ],
      "total_ms": 245.3
    }
  ]
}
```

## Regression checks

`lsbench baseline` reduces a report to a baseline, and `lsbench check` fails when a later report changed behavior or timings against it. Use them to gate a server or lsbench upgrade in CI.

```sh
# record today's behavior, then commit baseline.json
lsbench "typescript-language-server --stdio" -w ./ws -s ./actions.ts -o results.json
lsbench baseline results.json -o baseline.json

# later: run again and compare
lsbench "typescript-language-server --stdio" -w ./ws -s ./actions.ts -o results.json
lsbench check results.json -b baseline.json
```

The baseline keeps the run settings (`iterations`, `warmup`, `restart_between_iterations`), `summary` and `iteration_summary`, without the per iteration `runs`, so it stays small and diffs well. A baseline records behavior as it is, known timeouts included. Rewrite it with `lsbench baseline` when a change is intended, and review the diff.

`check` applies these rules, and fails on each one broken:

- **Run settings**: `iterations`, `warmup` and `restart_between_iterations` must match, since timings of different settings are not comparable.
- **Methods**: a method added to or missing from `summary` fails. This catches changed delivery too, such as `diagnostics/open` turning into `diagnostics/pull/open`.
- **Rates**: `timeout_rate`, `skip_rate`, `empty_rate`, `null_rate` and `failure_rate` fail when they differ by more than `--rate-tolerance` (default 0.1).
- **Median**: `median_ms` fails outside `[max(0, base / ratio - slack), base * ratio + slack]`, with `--median-ratio` (default 2) and `--slack-ms` (default 5). Faster fails too, since a placeholder answer looks like a speedup. The slack absorbs the noise of methods taking a few milliseconds.
- **Null median**: a `null` median (every call timed out or was skipped) must stay `null`, and a number must not become `null`.

```
Usage: lsbench baseline [options] <report>

Options:
  -o, --output <path>     Output file for the baseline (required)

Usage: lsbench check [options] <report>

Options:
  -b, --baseline <path>   Baseline written by `lsbench baseline` (required)
  --rate-tolerance <n>    Largest allowed absolute difference of a rate (default: 0.1)
  --median-ratio <n>      median_ms may grow by this factor or shrink by its inverse (default: 2)
  --slack-ms <n>          Milliseconds added on both sides of the median bounds (default: 5)
  --json                  Print a machine readable verdict
```

`check` exits 0 on pass, 1 on regressions, and 2 on usage errors such as a missing or invalid file or option. A failing check prints a table of the broken rules, `(run)` standing for a run setting:

```text
FAIL: 2 regressions against the baseline

method              field         baseline  actual  rule
------------------  ------------  --------  ------  -----------------
textDocument/hover  median_ms     100       300     outside [45, 205]
diagnostics/open    timeout_rate  0         0.5     |diff| > 0.1
```

With `--json`, it prints the verdict instead:

```json
{
  "pass": false,
  "failures": [
    { "method": "textDocument/hover", "field": "median_ms", "baseline": 100, "actual": 300, "rule": "outside [45, 205]" }
  ]
}
```

`field` is `method` for an added or missing method, with `baseline` and `actual` set to `present` or `missing`. `checkReport`, `createBaseline` and `formatCheckResult` are exported for use from code.

## Comparing diagnostics timings

Time to diagnostics measures when a server publishes, which is often not how long it took to check the file. Keep these in mind before comparing servers:

- **Debounce**: some servers wait on purpose before computing diagnostics. The VS Code servers (JSON, CSS, HTML and others from `vscode-langservers-extracted`) wait about 500 ms, pyright about 250 ms. Their timings then mostly measure that delay: a flat floor with a min that sits at the delay. Compare such servers against their debounce, not against servers without one.
- **Silent servers**: some servers never publish for a clean file, or skip some classes of errors. lua-language-server is silent on clean files, and the HTML server does not report markup errors. The wait then runs into its timeout, and `timeout_rate` means "no diagnostics", not "slow". Give such waits an explicit, short `timeout` so they cost little. When you do expect diagnostics, `until: (d) => d.length > 0` makes the wait ignore empty publishes, and `settleMs` picks up diagnostics that arrive in a later publish.
- **Reopens**: some servers do not republish a clean file when it is reopened, rust-analyzer for example. Its publishes on close are credited to the closed document, so a `diagnostics/open` wait after a reopen has nothing to resolve on and measures nothing but its timeout. Use `until` or a short `timeout` for such waits. Verbose mode logs a hint when a reopen wait times out having seen only the publishes clearing the close.
- **Push vs pull**: a push timing (`diagnostics/open`, `diagnostics/edit`) includes the server's debounce, a pull timing (`diagnostics/pull/*`) is a request without one, so the two are not comparable. In `auto` mode lsbench [learns per server](#pull-diagnostics) which one applies, so check which methods show up in the report, and whether pulled timings are `tentative`, or pass `mode: "push"` or `mode: "pull"` to compare like with like.
- **Intermediate publishes**: some servers publish in stages: rust-analyzer and zls send an empty syntax pass before the semantic diagnostics. Version aware waits already ignore publishes for older versions and closed documents, but such a pass belongs to the current state and resolves a plain wait early. Use `until` to skip it, and `settleMs` when a server publishes in bursts. `-v` logs every publish, which shows what a server sends.

## Warmup and readiness

Servers with a load phase, such as rust-analyzer, index the workspace after `initialized`. Requests sent meanwhile fail with `ContentModified` or answer from a partial model, which used to take several warmup iterations to wait out. Wait for the load to finish instead:

- `--wait-idle [ms]` waits after `initialized`, and after each restart with `--restart`, before the script runs. It is recorded as `lifecycle/idle`
- `ctx.waitForIdle()` waits inside the script, for example after an edit that triggers reindexing. It is recorded as `server/idle`

Both rely on work done progress or rust-analyzer's server status (see [waiting for idle](#waiting-for-idle)). A server that reports neither resolves after the short quiet period, so the wait tells nothing about it.

Warmup iterations are still useful for what idle does not cover: JIT compilation and caches that only warm up as requests run, per document state built on the first open, and servers that report no progress. Use `--warmup 3-5` for steady state numbers.

## Tips

- **Cold start**: Use `--restart` to measure initialization time, reported per iteration as `lifecycle/spawn` and `lifecycle/initialize`. Without it, the server stays alive across iterations (warm benchmarks). Keep at least one warmup iteration: the diagnostics delivery it learns carries over to the timed iterations, so a pull only server is not waited on for a push in each of them. With `--warmup 0`, the first run pays the `pullAfterMs` grace, visible as `grace_ms`; pass `mode: "pull"` or a short `pullAfterMs` to avoid it.
- **waitForDiagnostics**: Always call this after opening a document or making edits, before timing requests. Servers do background work that affects latency. The wait itself is reported as `diagnostics/open` or `diagnostics/edit` (`diagnostics/pull/open` or `diagnostics/pull/edit` when pulled); check `timeout_rate` before reading its durations.
- **Warmup**: see [warmup and readiness](#warmup-and-readiness).
- **Compare servers**: Run the same action script against different servers (e.g. `typescript-language-server` vs `vtsls`) on the same workspace, and read [comparing diagnostics timings](#comparing-diagnostics-timings) first.

## Development

lsbench requires Node `>=24` (see `.nvmrc` for the currently pinned version). To build from source:

```bash
git clone https://github.com/TypeFox/lsbench.git
cd lsbench
npm install
npm run build
```

Quality checks (all run in CI):

```bash
npm test          # unit tests (vitest)
npm run lint      # oxlint
npm run format    # biome format check
npm run knip      # unused dependency/export check
npm run test:integration  # minilogo + Langium grammar servers
```

Use `npm run dev` for a watch build while iterating.

### Build variants

- `npm run build` is the regular development build. This emits source maps and decl maps for debugging.
- `npm run build:prod` is the production build. It skips maps entirely.

Note that `prepublishOnly` cleans `dist/` and then runs `build:prod`.

## Testing

There are two test tiers:

- **Unit tests**: `npm test` runs the regular suite in `test/` via vitest.
- **Integration tests**: `npm run test:integration` builds lsbench, then drives two real language servers over stdio:
  - **minilogo**: clones, installs, and builds [langium-minilogo](https://github.com/TypeFox/langium-minilogo), then covers the methods it supports (symbols, definition, references, hover, highlight, prepareRename, folding, workspace symbols, save sync) plus a full `runBenchmark` report.
  - **Langium grammar**: starts Langium's own grammar language server from devDependencies against a small fixture (`test-integration/langium-grammar/shapes.langium`). It covers the broader provider set: completion, rename, formatting, code actions via `data.code`, semantic tokens, call and type hierarchy, edits, and save sync.

  Methods a server does not advertise are listed as skipped tests, and each suite asserts that those providers are indeed absent.

The minilogo server is cloned and built once on first use, so the first run can be slow (timeouts are 120s per test and 600s per hook, per `vitest.integration.config.ts`). CI runs both suites in a separate `integration` job.

## License

MIT

## Contributing

We're always open to new & helpful contributions to any parts of lsbench. Do be sure to check the READMEs & issues out in advance, and feel free to use your agent to help guide a potential contribution as well. New contributions should align with the core goals of lsbench, being:

- Agnostic of any one kind of LS implementation, this should be general purpose
- Keeping things simple. If a contribution is helpful but very specialized or complex (i.e. not relevant for most users), it probably won't fit in here (but is still appreciated from a discussion standpoint)
- Solving a clear problem & being well documented. New changes should be upfront in terms of what it is that they seek to improve, and how that change make the improvement, and _why_ it's useful (the why is important to really get your intent in mind).

None of these guarantee a contribution will be taken in, but it really helps us out in terms of review & it can greatly improve the likelihood that a contribution will be taken in.

### LLM-Generated Contributions

We welcome contributions from all sources, including those assisted or generated by large language model (LLM) driven agents. However, every contribution (whether a pull request, issue, or comment) must have a human accountable for it.

If you are using an LLM agent as part of your workflow, please be aware of the following requirements:

- **Human ownership is required.** A real person must review, understand, and take responsibility for any LLM-generated or LLM-assisted contribution before it is submitted. This includes pull requests, issues, comments, and review feedback.
- **Unattended contributions will not be merged.** Pull requests or issues that appear to have been created autonomously by an LLM agent — without meaningful human review — will be placed on hold until a human owner engages with the discussion.
- **Disclose LLM involvement.** If a contribution was substantially generated by an LLM, we ask that you note this in the PR, issue description, or via commit authorship. This is not to discourage the practice, but to help us calibrate our reviews accordingly. Again the more transparent this is, the better.
- **You are the author.** By submitting a contribution, you are affirming that you have reviewed the content, that it meets the project's standards to the best of your knowledge, and that you are prepared to respond to feedback and iterate on it.

We are not opposed to LLM-assisted contributions — they can be valuable. We simply need a human in the loop who can engage in the collaborative process that open source depends on. If you are an agent, please be sure to let your user know this so that we can engage with them. Thanks in advance!

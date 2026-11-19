# CHANGELOG

## Unreleased

### New features

- `--allow-exit-signal <name>` (repeatable) and `ServerConfig.allowExitSignals` tolerate a known signal after a replied `shutdown`, as `--allow-exit-code` does for exit codes. nixd, which often crashes with `SIGSEGV` after `exit` when its eval worker answers late, can now pass a run. Such exits are listed in `tolerated_exits` and logged `(allowed)`, and the summary reads e.g. `signal SIGSEGV after shutdown, allowed`. Names are case insensitive and the `SIG` prefix is optional, so `segv` means `SIGSEGV`. An unknown name is rejected. A signal before the shutdown reply, or one not listed, stays abnormal.
- `codeAction` accepts `overlappingDiagnostics: true` in its options object, sending the document's current diagnostics whose range overlaps the requested range, boundaries included, whatever their code. Servers that publish diagnostics without a code and build quick fixes from `context.diagnostics`, such as elixir-ls, can now be benchmarked for code actions. Combined with `diagnosticCodes`, a diagnostic must match both. Diagnostics without a well formed range are skipped, and the pulled diagnostics are used when the server never published for the document. Requests without the option are unchanged.
- `codeAction` accepts an options object `{ diagnosticCodes?, only? }` as its third argument, besides the array of codes. `only` lists the requested `CodeActionKind`s and is sent as `context.only`, so servers that offer source actions only on request, such as tsgo, can be benchmarked for code actions. `context.only` is left out when `only` is not given, and an empty `only: []` is sent as is. `CodeActionOptions` is exported.

### Fixes

- A publish is classified by the state of its document when it was read from the server, not when it is dispatched. vscode-jsonrpc queues incoming messages, so a script closing and reopening a document right away sent the `didOpen` before a publish already read was handled. A publish read before a `didOpen` no longer counts for that open, whatever its version: a close publish is `closed`, one read before the first open is `unopened`, and one read for an earlier open is `stale`. ruff clears a closed document with `version: 1`, which resolved every `navigation` reopen wait on that empty publish, so `broken.py` was measured clean in about 0.1 ms. Its reopen now resolves on the F401. `DiagnosticsTracker` adds `noteRead(params)`, and `receive()` without it classifies by the state at receipt as before.
- Settings keep the keys of top level language override sections such as `[yaml]` flat, as VS Code does, both in `didChangeConfiguration` and in `workspace/configuration` results. `{ "[yaml]": { "editor.tabSize": 2 } }` and `{ "[yaml].editor.tabSize": 2 }` both give section `[yaml]` the value `{ "editor.tabSize": 2 }`, where they used to give `{ "editor": { "tabSize": 2 } }`. yaml-language-server, which reads `editor.tabSize` from `[yaml]` for its indentation, no longer fails block string code actions. Other sections expand as before.
- `--shorten-silent-waits` pools silent and reopen streaks over the documents of a method. A method qualifies once the streaks of its documents sum to 3, and a document is then shortened after one silent timeout of its own, where each document used to need 3 of its own. A document waited on for the first time, or whose last wait resolved, still gets the full timeout, and a resolving wait still ends the streak of its own document only. terraform-ls `navigation` and `workspace` no longer run full timeouts into measured iterations. The silent wait hint reads `in 3 waits in a row across its documents` and fires once per method when the sum first reaches 3, and `silent_waits` lists a method from then on, also when no single document reached 3 (`longest_streak` stays the longest of any document).
- An empty publish clearing a closed document no longer teaches that the server pushes diagnostics, whether it arrives while the document is closed or unversioned within the close window after a reopen. ruby-lsp, which only answers pulls but clears documents on `didClose`, used to flip to push after the first close, so every later auto wait timed out waiting for pushes. Verbose mode logs `Empty publish clearing closed ... does not show the server pushes` once. A non empty or versioned publish, or one for an opened document outside a close window, still teaches push.
- `openDocument` warns once per extension, also without `--verbose`, when it opens a document as `plaintext` for lack of a registered language id, naming the extension and pointing at `addRegisteredLanguage()` and `options.languageId`. The report lists such extensions in `plaintext_fallbacks`, the printed summary notes them, and the silent wait and `until` hints add that the documents were opened as plaintext. The verbose open line reads `Opened main.tf (plaintext, fallback)`.
- `.nix` opens as `nix`, matching the Nix IDE VS Code extension, where it used to fall back to `plaintext`.
- `.ml` opens as `ocaml`, `.mli` as `ocaml.interface`, `.mll` as `ocaml.ocamllex`, `.mly` as `ocaml.menhir`, `.hs` as `haskell` and `.lhs` as `literate haskell`, matching the OCaml Platform and Haskell VS Code extensions, where they used to fall back to `plaintext`.
- `.tf` opens as `terraform`, `.tfvars` as `terraform-vars` and `.hcl` as `hcl`, where they used to fall back to `plaintext`. `.txt` maps to `plaintext` and does not warn.
- `SilenceTracker` adds `recordPlaintextFallback(extension)` and `plaintextFallbacks()`.
- `--shorten-silent-waits` keeps the reopen streak per document instead of per method, so a document whose reopen resolves no longer resets the streak of other documents. rust-analyzer `navigation` and `workspace` reopen waits are now shortened. `reopen_waits` keeps its shape: `waits` and `shortened` are summed over documents, `longest_streak` is the longest of any document.
- `edit` follows the server's change sync kind, read from `textDocumentSync` (a bare number or `change`) and from dynamic `textDocument/didChange` registrations (`syncKind`). Full sync servers such as taplo now get the whole tracked text without a `range` instead of ranged changes they took as the entire document, and None (0) skips `didChange`. Servers stating no kind still get incremental changes. `LspHarness.changeSyncKind()` exposes the resolved kind.
- `SilenceTracker.recordReopen` takes the document uri (`recordReopen(method, uri, reopenOnly)`), and `shortens` and `recordShortened` take it for the `reopen` kind.
- `--shorten-silent-waits` keeps the silent streak per document instead of per method, so a document whose wait resolves no longer resets the streak of other documents. marksman `open-diagnostics`, `navigation` and `workspace` waits for clean documents are now shortened. `silent_waits` keeps its shape: `waits` and `shortened` are summed over documents, `longest_streak` is the longest of any document. The silent wait hint is still logged once per method.
- `SilenceTracker.record` takes the document uri (`record(method, uri, silent)`), and `shortens` and `recordShortened` take it for the `silent` kind.

## v0.3.0

Changes since 0.2.0. Diagnostics timings are now trustworthy: waits are version aware, timed, delivered by push or pull, ignore placeholders of servers still loading, and report timeouts explicitly. lsbench also adds a readiness signal, classifies every result, skips unsupported requests, keeps the report when a server crashes, and can check a report against a baseline. The details since next.6 close this section, and the preview sections below have the rest.

Checked for compatibility against rust-analyzer, zls, Langium, lua-language-server, bash-language-server, pyright, vscode-json-language-server and TypeScript 7.

### Breaking changes

- `waitForDiagnostics` resolves with an object (`{ diagnostics, timedOut, publishes, source, pulls, ms, ... }`) instead of an array, and accepts an options object `{ timeout, until, settleMs, mode, pullAfterMs }` as well as a bare timeout.
- Timed out waits are reported as `timeout` instead of resolving with cached diagnostics.
- `MethodStats` latencies are `number | null`, `null` when every call timed out or was skipped.
- `success` is `false` for `skipped` and `timeout` results.
- Requests the server does not advertise are skipped, `willSaveWaitUntil` included. Use `--no-skip-unsupported` for the old behavior.
- lsbench exits non zero when a server exits abnormally. Without `--restart`, a crash ends the run but the report is still written.
- Log prefixes are now `[lsbench...]` for lsbench and `[server]` for server output.

### Behavior changes that move numbers

- More client capabilities are advertised (watched files, work done progress, server status, diagnostic refresh), which can change server timings. Rerun 0.2.0 baselines.
- `.mts`, `.cts`, `.mjs`, `.cjs` and `.jsonc` get proper language ids.
- `ContentModified` rejections are retried (`--content-modified-retries`, default 3), timing only the final attempt.
- Timeouts and skips are left out of duration stats and `failure_rate`.
- Pending requests fail when the server exits instead of hanging, and `stop()` always settles within `--shutdown-timeout`.

### Diagnostics

- Each wait records a timing (`diagnostics/open`, `diagnostics/edit` or `diagnostics/wait`) from the latest sync to the matching publish.
- Only publishes for the current document version count. URIs are matched after decoding, and case insensitively on darwin and win32.
- `until` resolves on the first publish passing a predicate, and `settleMs` waits for publishes to go quiet.
- Empty publishes shortly after a close and reopen are handled per server, so servers that do or do not clear closed documents both time correctly.
- `mode: 'push' | 'pull' | 'auto'` selects delivery. `auto` learns per server whether it pushes or pulls, carrying that across `--restart`. Pulled waits are recorded as `diagnostics/pull/...`.
- Empty results from a server reporting itself busy are held until it is quiescent.
- Verbose mode and the report flag waits that repeatedly time out with no publish (`silent_waits`) or with publishes that all fail `until` (`until_rejected`).
- `--shorten-silent-waits [ms]` ends waits of a kind known to time out early. They still count as timeouts.
- Servers that clear each close with one publish have the empty publish after a reopen accepted at once instead of held for the close window, so iteration totals drop.

### New features

- `lsbench baseline` and `lsbench check` record a baseline and fail on regressions in run settings, methods, rates or medians, with configurable tolerances.
- `--trace <file>` records every LSP message as JSON lines.
- `--shorten-silent-waits`, `--advertise-pull`, `--allow-exit-code`, `--wait-idle`, `--client-capabilities-file`, `--settings-file` and `--server-log`.
- `ctx.waitForIdle`, `ctx.capabilities`, `ctx.registrations`, `ctx.supports`, `ctx.lastError`, and a `languageId` option for `openDocument`.
- Action scripts may be `.js` or `.mjs` as well as `.ts`.
- New exports for baselines, capabilities, settings, tracing and silence tracking.

### Report format

New fields are optional, so 0.2.0 readers keep working apart from nullable latencies and the stricter `success`.

- Timings add `result` (`ok`, `empty`, `null`, `error`, `skipped`, `timeout`), retries and diagnostics details.
- `MethodStats` adds null, empty, timeout and skip rates, plus grace, hold and close window figures when present.
- Top level adds `lifecycle`, `abnormal_exits`, `tolerated_exits`, `silent_waits`, `until_rejected` and `reopen_waits`.
- New `diagnostics/*`, `lifecycle/*` and `server/idle` methods.
- The printed table adds rate columns and notes below it.

### Timings not comparable with 0.2.0

- 0.2.0 did not time diagnostics waits and could resolve on stale publishes.
- Cold start diagnostics now wait for the real result rather than a loading placeholder, so they may be much slower.
- Iteration totals and request timings may shift with the new capabilities, skipped requests and excluded timeouts.

### Details since next.6

#### Shortening diagnostics waits known to time out

- `--shorten-silent-waits [ms]` (`shortenSilentWaits` in `BenchOptions`, `shortenSilentWaitsMs` in `BenchContextOptions`, default 500 ms for a bare flag, off without it) ends diagnostics push waits of a kind known to time out early, once 3 waits of that kind and method timed out in a row, warmups and restarts included. Silent waits (no publish, lua-language-server on clean files) and reopen waits that saw only the publishes clearing the close (rust-analyzer) end `ms` after their `didOpen` or `didChange`. Waits whose method kept timing out after publishes all failing `until` (bash-language-server `edit-diagnostics` without shellcheck) end `ms` after their latest rejected publish. A wait of a kind that resolves restores the full timeout for later waits of that kind. No wait is shortened while a placeholder is held or while the close window is open. In the second next.6 full run, such timeouts took 2207 s of 3679 s.
- Shortened waits stay timeouts, so `timeout_rate` and the medians are unchanged unless a server publishes after `ms`. The timing adds `shortened: true` (also in the `waitForDiagnostics` result), `MethodStats` adds `shortened`, `silent_waits` and `until_rejected` add a `shortened` count, and the new optional report field `reopen_waits` (`ReopenWaits`) lists methods with a shortened reopen wait. The printed summary notes them below the table, and verbose mode logs `timeout (shortened)`. All new fields are optional, and without the flag the report is unchanged.
- `SilenceTracker` adds `recordReopen`, `recordUntilResolved`, `reopenWaits`, `shortens` and `recordShortened`, `DiagnosticsTracker` and `LspHarness` add `closeWindowEndsAt`, and `ShortenedKind` and `ReopenWaits` are exported.

#### Skipping the close window hold for servers clearing each close once

- Once a server publishing on close without versions cleared 3 closes in a row with exactly one publish each, and the empty publish held after it was accepted at the end of the close window each time, the empty, unversioned publish after the reopen is accepted at once instead of held until 1000 ms after the `didClose`. Durations do not change, `close_window_ms` disappears from those waits and iteration totals drop. In the second next.6 full run, such holds took 311 s, mostly for zls, yaml-language-server, typescript-language-server and the vscode css, html and json servers.
- A close cleared by two or more publishes, a candidate superseded after a clearing publish, or a second empty publish after one accepted at once turns this off for the rest of the server process. Publishes for a closed document following a sync of another document (revalidation) do not count. rust-analyzer and servers learned not to publish on close (Langium) are unaffected.
- Verbose mode logs `Server clears each close once (...)` when it is learned and `accepted at once` for each such publish. `DiagnosticsTracker` adds `closeClears`, and `CloseClears` is exported. The close window of a document whose reopen publish was accepted at once no longer postpones `--shorten-silent-waits`.

## v0.3.0-next.6 (preview)

Langium open waits no longer time out after a reopen because lsbench mistook its revalidation publishes for close publishes.

### Close window rule

- Only an empty publish for a closed document within the close window, the first since its `didClose` and with no `didOpen`, `didChange` or `didClose` of another document in between, teaches that the server publishes on close. In next.5 any publish for a closed document taught it, so Langium, which publishes for closed documents when a document importing them is opened, had the empty publish after a later reopen credited to the close, and one `diagnostics/open` in three of the langium `open-diagnostics`, `navigation` and `workspace` checks ran into its 15 s timeout. Verbose mode logs a publish for a closed document that follows another sync as possible revalidation.
- A publish for a closed document no longer turns a learned `silent` into `publishes`.
- A push wait that held an empty publish after a reopen until the close window ended records the hold, from the publish's receipt (or the call of the wait, when later) to the end of the window, as the new timing field `close_window_ms` (`closeWindowMs` in the `waitForDiagnostics` result). It is not included in `duration_ms`, which still runs to the publish's receipt. In next.5 the hold showed only in the iteration total: zls `open-diagnostics` iterations took about 1000 ms while their three `diagnostics/open` timings added up to about 230 ms. `MethodStats` adds `close_windowed` and `close_window_median_ms` when any timing has it, the printed summary notes such methods below the table, and verbose mode adds the hold to the `diagnostics/...` line. All new fields are optional, so the report change is additive. `DiagnosticsPublish` adds `acceptedAt`.
- The reopen timeout hint no longer claims the server did not republish when every publish it saw arrived after the reopen and was credited to the close by the learned rule. `DocumentSyncState` adds `closePublishesAfterReopen`.

### Explicit diagnostics modes

- `waitForDiagnostics` with `mode: 'push'` or `mode: 'pull'` holds placeholders like auto mode. An empty publish for the open document (push) or an empty pull report (pull) while the server reports `experimental/serverStatus` with `quiescent: false` no longer resolves the wait: push resolves at quiescence with a newer publish or the placeholder, timed to the quiescence, and pull pulls again once the server is quiescent. The timings carry `held_publishes` and `held_pulls`. In next.5 explicit modes timed rust-analyzer's placeholders, so its cold start took about 1.5 s with `mode: 'push'` and about 2 ms with `mode: 'pull'`, against about 2.6 to 3.0 s in auto mode. Explicit mode timings of servers that report `experimental/serverStatus` may therefore grow, rerun their baselines. Servers that never send it are not affected, and an open `$/progress` token does not hold an explicit pull.

### Client capabilities

- lsbench advertises `workspace.diagnostics.refreshSupport`, as it has handled `workspace/diagnostic/refresh` since next.3. Per the LSP spec a server may only send the refresh when the client advertises it, so servers that check the flag may now send refreshes, which make pending auto diagnostics waits pull. Diagnostics delivery and timings may change for such servers, rerun their baselines. rust-analyzer sent the refresh without it.
- `--advertise-pull` (`advertisePullDiagnostics` on `ServerConfig` and `BenchOptions`) advertises the `textDocument.diagnostic` client capability with `dynamicRegistration` and `relatedDocumentSupport` off. It stays off by default: servers built on `vscode-languageserver` (the VS Code CSS, HTML and JSON servers, ESLint) stop pushing when it is present, so their `diagnostics/open` turns into `diagnostics/pull/open` and `lsbench check` fails against a baseline recorded without it. A `--client-capabilities-file` is merged over it. The run header prints `Pull diag:` when it is set, and `pullDiagnosticClientCapabilities` is exported.

### Server exits

- Without `--restart`, a server that exits during an iteration ends the run. The exit in `abnormal_exits` is labeled with that iteration (`iteration N` or `warmup N`) instead of `final teardown`, and no further iterations run. In next.5 the remaining iterations ran against the dead server, each request failing at once, so the report had a run of error iterations and did not say when the server died. The report is still written with the runs completed so far, including the crashed one, and lsbench exits non zero.

### Silent servers

- lsbench notices servers that never publish for a clean document. After 3 push waits of one kind (`diagnostics/open`, `diagnostics/edit` or `diagnostics/wait`) in a row time out without any publish, counted across warmups and restarts, verbose mode logs that the server may never publish for a clean document, so those timeouts mean no diagnostics, not slow ones. The report records such methods in the new optional field `silent_waits` (`waits` and `longest_streak` per method), and the printed summary notes them below the table. A wait that resolves, or times out after publishes failing `until`, ends the streak, and a reopen wait that saw only close publishes keeps its own hint and does not count. In next.5 lua-language-server `open-diagnostics` ran every wait into its timeout with nothing but `timeout_rate` 1 to show for it. `SilenceTracker`, `SILENT_WAIT_STREAK` and the `silence` option of `BenchContextOptions` are exported. Waits are not shortened.

### Wire trace

- `--trace <file>` (`trace` on `BenchOptions`) writes every LSP message lsbench sends (`"dir":"out"`) and receives (`"dir":"in"`) to a file as JSON lines `{"t","dir","msg"}`, with a `{"t","spawn":true,...}` line per server start and a `{"t","iteration","warmup"}` marker per iteration. `t` is milliseconds since the run start on the clock of the report timings. The file is overwritten per run, and the run header prints `Trace:`. It is off by default, and without it the connection is unchanged. In next.5 tracing took a proxy spawned in place of the server. `WireTrace` and `WireDirection` are exported.

### Settings

- The README, `--help` and the primer note that `--settings-file` sends only the listed keys, unlike VS Code, which sends every setting with its default, so a server may read a missing key as `false`. With only `"json.format.enable": true`, vscode-json-language-server turned schema validation off and every `edit-diagnostics` wait timed out. Verbose mode logs the expanded settings sent with `workspace/didChangeConfiguration`.

## v0.3.0-next.5 (preview)

`lsbench check` no longer fails on the median of a single sample, such as the lifecycle methods of a run without `--restart`.

### Regression checks

- `check --min-count <n>` (default 3) skips the median rule for a method whose `count` is below `n` in the baseline or the report. In next.4 `lifecycle/spawn`, `lifecycle/initialize` and `lifecycle/shutdown`, measured once per run without `--restart`, failed on noise like a shutdown going from 0.84 ms to 7.2 ms. The method set, the rates, the `null` median rule and the run settings are still checked for every method. `--min-count 1` restores the next.4 behavior, and a value that is not a positive integer exits 2.
- `validateCheckedRun` requires a numeric `count` per method, and `CheckOptions` and `DEFAULT_CHECK_OPTIONS` add `minCount`.

## v0.3.0-next.4 (preview)

Reports can be checked against a committed baseline, failing on changed behavior or timings, to gate server and lsbench upgrades.

### Regression checks

- `lsbench baseline <report> -o <file>` writes a baseline: the run settings (`iterations`, `warmup`, `restart_between_iterations`), `summary` and `iteration_summary`, without the per iteration `runs`, so it stays small and diffs well. The file carries `lsbench_baseline: 1` as its format version.
- `lsbench check <report> -b <file>` fails on mismatched run settings, an added or missing method (which also catches a change of delivery, such as `diagnostics/open` turning into `diagnostics/pull/open`), a rate (`timeout_rate`, `skip_rate`, `empty_rate`, `null_rate`, `failure_rate`) differing by more than `--rate-tolerance` (default 0.1), a `median_ms` outside `[max(0, base / ratio - slack), base * ratio + slack]` with `--median-ratio` (default 2) and `--slack-ms` (default 5), and a `null` median turning into a number or back. Faster medians fail too, since placeholder answers looked like speedups.
- `check` exits 0 on pass, 1 on regressions and 2 on usage errors. It prints a table of the broken rules, or with `--json` the verdict `{ pass, failures: [{ method, field, baseline, actual, rule }] }`. Run setting failures use the method `(run)`.
- `createBaseline`, `checkReport`, `formatCheckResult`, `validateCheckedRun`, `DEFAULT_CHECK_OPTIONS` and the related constants and types are exported for use from code.

## v0.3.0-next.3 (preview)

Cold rust-analyzer runs no longer measure empty placeholders answered or published while loading, and no longer time out after it switches to refreshes.

### Pull diagnostics in waits

- Unless pull is settled, an empty auto mode pull answered while the server is busy is held as a placeholder instead of resolving the wait. The wait goes on waiting for a push and pulls again once the server is no longer busy. Busy is `experimental/serverStatus` with `quiescent: false` once the server sent a status, which takes precedence over `$/progress`, so rust-analyzer's flycheck after quiescence does not count; servers without a status use open `$/progress` tokens. In next.2 a carried tentative pull made each cold rust-analyzer S1 iteration resolve on such a placeholder in about 1.6 ms. Timings carry the new field `held_pulls`, on every outcome (pull, push or timeout), `MethodStats` adds `held`, the printed summary notes such methods and then drops the `mode: 'pull'` hint, and a wait timing out while busy records a pull timeout. Servers that never report being busy, such as ts7, are unaffected.
- An empty publish for an opened document arriving while the server reports `experimental/serverStatus` with `quiescent: false` is held as a placeholder too. Only the server status counts here, not `$/progress`, so other push servers are unaffected. A placeholder publish neither resolves an auto wait nor teaches push. Once the server is quiescent, the wait resolves with a newer publish if one arrived, else pulls when a held pull would, else with the placeholder, timed to the quiescence. Timing out reports the placeholder. Non-empty publishes are never held. Timings carry the new field `held_publishes`, and `MethodStats` adds `held_publishes`, noted in the printed summary like `held`.
- A `workspace/diagnostic/refresh` while an auto wait waits for a push (in the grace, after a held placeholder, or with push learned) makes it pull once, retrying `ContentModified` and `ServerCancelled`. In next.2 the refresh was only acknowledged, so a cold rust-analyzer S4 run timed out both edit waits (about 31 s for iteration 1): it stops pushing for a document it was pulled for and only sends refreshes.
- A refresh pull returning diagnostics settles the server as pull only, even after push was learned. An empty one teaches nothing, and a publish for an opened document that is not a placeholder still flips it back to push. Verbose mode logs each refresh.

### Note on rust-analyzer cold numbers

- Cold rust-analyzer S1 now ends when the server turns quiescent (at about 3 s in the S4 verification trace), on a pull after the held placeholders, so it is recorded as `diagnostics/pull/open`. It is not comparable with next.2 (about 1.6 ms, an empty placeholder pull) or with 0.2.0 (1194 ms), which both timed a placeholder. The S4 iteration 1 open wait likewise ends at quiescence instead of the placeholder publish at about 1.45 s.

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
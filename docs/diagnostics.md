# Waiting for Diagnostics

`ctx.waitForDiagnostics(path, options?)` waits for the diagnostics of the current state of a document and times how long they took. Before comparing servers by these timings, read [comparing diagnostics timings](diagnostics-timings.md).

```typescript
await ctx.openDocument("src/main.rs");
const { diagnostics, timedOut, ms } = await ctx.waitForDiagnostics("src/main.rs", {
  timeout: 10_000,
  until: (d) => d.length > 0, // skip the empty syntax pass
  settleMs: 200, // and pick up a follow up publish
});
```

## Options

`options` is an object, or a bare number as the timeout.

| Option | Default | Meaning |
| --- | --- | --- |
| `timeout` | 30000 | caps the whole wait in ms, quiet period included |
| `until` | none | `(diagnostics) => boolean`, resolve on the first matching publish that passes it |
| `settleMs` | none | after the resolving publish, wait until no further matching publish arrived for this long, then resolve with the latest |
| `mode` | `auto` | `auto`, `push` or `pull`, see [pull diagnostics](#pull-diagnostics) |
| `pullAfterMs` | 1000 | in `auto` mode, how long to wait for a push before pulling from a server whose delivery is unknown |

The first matching publish isn't always the final word. rust-analyzer and zls publish an empty syntax pass before the semantic diagnostics, and some servers publish in bursts. `until` and `settleMs` handle both:

- Publishes failing `until` are counted in `publishes` but don't resolve the wait.
- With `until`, the `settleMs` quiet period starts once `until` is satisfied, and later publishes no longer need to pass it.
- Quiet time counts from the receipt of a publish, so a cached publish, or a close window candidate accepted at the end of its window, may already have been quiet long enough.

## Result

| Field | Meaning |
| --- | --- |
| `diagnostics` | diagnostics of the resolving publish (the latest one with `settleMs`). On timeout, those of the latest matching publish, otherwise the cached ones |
| `timedOut` | `true` when the timeout fired before a matching publish (passing `until`) arrived. A timeout during the quiet period doesn't count. This comes from the timer itself, never from comparing elapsed time, since timers can fire slightly early |
| `publishes` | matching publishes the wait saw, including a cached one and those failing `until` (0 for pull). Counted over the whole wait, also when a refresh or the grace ended a push wait that then went on, a cached publish seen again counting once |
| `source` | `push` or `pull`, whichever resolved the wait |
| `pulls` | pull requests sent (0 for push) |
| `ms` | time from the latest `didOpen` or `didChange` of the document to the resolving publish, or to the timeout. With `settleMs`, to the latest publish, without the quiet period |
| `tentative` | `true` for an auto pull from a server whose delivery isn't settled |
| `graceMs` | for an auto pull that first waited for a push |
| `closeWindowMs` | for a push wait that held an empty publish in the [close window](#reopens-and-the-close-window) |
| `shortened` | for a wait ended early by `--shorten-silent-waits` |

Because `ms` counts from the document's sync, time to diagnostics is measured even when other work ran before the wait.

## Timings

Each wait records a timing, so time to diagnostics shows up in the report like any method:

| Method | When |
| --- | --- |
| `diagnostics/open` | the latest sync of the document was `didOpen` |
| `diagnostics/edit` | the latest sync was `didChange` |
| `diagnostics/wait` | the document isn't open, timed from the call |
| `diagnostics/pull/open`, `/edit`, `/wait` | the same, resolved by a pull |

- `duration_ms` is `ms`, and `diagnostics` holds the diagnostic count.
- `result` is `ok` with diagnostics, `empty` without, and `timeout` when the wait timed out.
- Timeouts count toward `timeout_rate` and are left out of the duration stats, since their duration is just the timeout.

Some servers never publish for clean files, so a `timeout_rate` near 1 means "no diagnostics", not necessarily a slow server.

## Which Publishes Count

The wait resolves with the first publish that matches the current state of an open document. It resolves at once when such a publish already arrived, so awaiting other work between `openDocument` or `edit` and the wait doesn't miss it.

Each `didOpen` starts a new open generation. A publish counts when it belongs to the current generation and either:

- carries the current document version, or
- carries no version and arrived after the latest `didOpen` or `didChange`.

Publishes for other versions are ignored, and so are publishes read from the server while the document was closed, even when they are handled after the next `didOpen`. For a document that isn't open, the wait resolves on the next publish.

A publish without a `diagnostics` array is taken as empty. lsbench warns about it once per run.

## Reopens and the Close Window

Servers often clear a closed document with an empty publish that can land after the next `didOpen`, while others never publish on close. An empty publish right after a quick reopen is therefore ambiguous.

The first empty, unversioned publish after a reopen within 1000 ms of the `didClose` is held as a candidate:

- **Superseded**: another publish for the document arrives before the window ends. The candidate was the close publish.
- **Accepted**: no other publish arrives, so the candidate resolves the wait when the window ends. `ms` still counts to the candidate's receipt.

The time the wait held a candidate, from its receipt (or the call of the wait, when later) to the end of the window, isn't part of `ms` but shows in the iteration total. It's recorded as:

- `close_window_ms` in the timing and `closeWindowMs` in the result
- `close_windowed` (how many timings held one) and `close_window_median_ms` in the summary entry
- a note below the printed summary table

### Learning the Server's Close Behavior

lsbench learns per server process whether the server publishes on close, so a server that never does pays the window at most once. Verbose mode logs candidates and what was learned.

| Evidence | Learned | Effect |
| --- | --- | --- |
| an empty publish for a closed document within the window, the first since its `didClose` with no other document opened, changed or closed in between, or a superseded candidate | publishes on close | such a publish is credited to the closed generation at once |
| a candidate accepted at the end of the window, or a close with no publish within it | doesn't publish on close | the rule is turned off, and stays off |

Some servers clear a closed document more than once (rust-analyzer sends two or three empty publishes). Once the server is known to publish on close, a further empty, unversioned publish within the window is:

- credited to the close, when the server sends versions with its publishes for open documents
- held as a candidate otherwise. Accepting such a candidate at the end of the window doesn't turn the rule off.

**Clears once**: after 3 closes in a row were each cleared by exactly one publish and their candidate was accepted at the end of the window, lsbench learns that the server clears each close once. It then accepts such a further empty publish at once, without holding it and without `close_window_ms`. A clearing publish is an empty one for the closed document right after its `didClose`, or one credited to the close after the reopen.

**Back to holding**: any of these shows the server may clear a close more than once, and candidates are held again:

- a close cleared by two or more publishes
- a candidate superseded after a clearing publish
- a second empty publish after one accepted at once

Publishes that teach nothing:

- publishes for a closed document following a sync of another document don't count as clears
- other publishes for a closed document, since servers revalidating dependent documents (such as Langium on opening a document that imports it) publish for closed documents without clearing them on close

## Pull Diagnostics

Some servers advertise `diagnosticProvider` and never push (ts7, for example), so a push wait would always time out. The `mode` option picks where diagnostics come from.

| Mode | Behavior |
| --- | --- |
| `auto` | push for servers without `diagnosticProvider` (static or dynamically registered). For servers with it, lsbench [learns the delivery](#learning-the-delivery) |
| `push` | only wait for pushes. A [placeholder publish](#placeholders) is held like in auto mode, and the wait resolves at quiescence with a newer publish or the placeholder, never by pulling |
| `pull` | send `textDocument/diagnostic` at once. A server without `diagnosticProvider` gets the wait recorded as `skipped`, resolving with the cached diagnostics |

Explicit modes only choose the delivery, so a server still loading is measured to its quiescence, not to its placeholders.

### Learning the Delivery

In `auto` mode, lsbench learns per server process how a server with `diagnosticProvider` delivers diagnostics:

| State | Auto waits |
| --- | --- |
| unknown, no push seen yet | wait for a push up to `pullAfterMs`, then pull. When `timeout` isn't longer than `pullAfterMs`, pulling starts at half the timeout |
| push | only wait for pushes |
| pull only | pull at once |

**Learning push**: the server published for a document the client opened (a `current`, `closed` or `stale` publish, see [verbose output](cli.md#verbose-output)). These teach nothing:

- publishes for documents never opened, such as ts7 clearing `tsconfig.json`
- close window candidates and placeholder publishes
- an empty publish clearing a closed document, whether it arrives while the document is closed or unversioned within the close window. Pull only servers such as ruby-lsp clear closed documents too. Verbose mode logs `Empty publish clearing closed ... does not show the server pushes` once.

A push flips the server to push at any time. A pull in flight then stops, records no timing, and the wait keeps waiting for pushes for the rest of its timeout. So a server that both pushes and advertises `diagnosticProvider`, such as rust-analyzer, is measured by its pushes from its first publish on. Before that, it may be measured by tentative pulls: [wait for idle](readiness.md) first, or pass `mode: "push"`.

**Learning pull only**: an auto wait fell back to pulling, and the pull resolved with no push in the meantime. A pull that returned no diagnostics learns this only tentatively, since a server still loading (a cold rust-analyzer, for example) may answer with an empty placeholder and push later. Until a pull returns diagnostics, pulled timings and results are marked `tentative: true`, and verbose mode adds `(tentative, the server may still push)`.

**Restarts**: with `--restart`, the delivery learned by one iteration's server carries over to the next (verbose mode logs `Carrying diagnostics delivery from the previous server`). Warmup iterations then teach it, and timed iterations on a pull only server pull at once instead of paying the `pullAfterMs` grace on every cold start. A carried tentative pull stays tentative, so a restarted server that pushes still flips it to push.

Verbose mode logs what was learned.

### Placeholders

A loading server may answer with an empty placeholder. lsbench holds placeholders back instead of resolving on them. Non empty publishes are never held.

| Placeholder | Held when | Then |
| --- | --- | --- |
| empty pull, in `auto` mode | pull isn't settled and the server reports it's busy | keep waiting for a push, and pull again once the server is no longer busy. A timeout while busy without any publish records a pull timeout, counted as a [silent wait](diagnostics-timings.md) of the push method |
| empty pull, in `pull` mode | the server sent `experimental/serverStatus` with `quiescent: false` | pull again once quiescent, or time out with the placeholder |
| empty publish for an opened document | the server sent `experimental/serverStatus` with `quiescent: false` (rust-analyzer publishes one while loading) | at quiescence, resolve with a newer publish if one arrived, else pull when a held pull would (the server advertises `diagnosticProvider` and push wasn't learned), else resolve with the placeholder, timed to the quiescence. A timeout first reports the placeholder |

Busy means `experimental/serverStatus` with `quiescent: false` once the server sent a status (rust-analyzer), and an open `$/progress` token for servers that never send one. rust-analyzer's flycheck progress after it turned quiescent doesn't count. Only the empty pull in `auto` mode counts `$/progress`, the other rows need a server status. A server that never reports being busy, such as ts7, isn't affected.

A placeholder neither resolves an auto wait nor teaches push. Held placeholders are recorded as:

- `held_pulls` in the timing, and `held` (how many timings held back a pull) in the summary entry
- `held_publishes` in the timing and in the summary entry
- a note below the printed summary table, without the `mode: "pull"` hint for held pulls, since such a server may still push

### Refreshes

A `workspace/diagnostic/refresh` while an auto wait waits for a push (in the grace, after a held placeholder, or with push learned) makes it pull once, retrying `ContentModified` and `ServerCancelled`.

- A result passing `until` resolves the wait as a pull, the placeholder rules still applying. Otherwise the wait keeps waiting for a push.
- A refresh pull that returned diagnostics settles the server as pull only, even after push was learned, since rust-analyzer stops pushing for a document it was pulled for and only sends refreshes. An empty one teaches nothing.
- A publish for an opened document still flips it back to push.
- For a document that isn't open, the wait keeps taking any publish since its call, one received during the refresh pull included.

Verbose mode logs each refresh. After a refresh pull, an auto wait of unknown delivery waits only the grace left, and `No publish from the server within Nms` logs that time.

### Pulling

- A pull resolves on the first report passing `until` (any report without it). Otherwise lsbench pulls again with a backoff from 25 ms doubling up to 250 ms, until `until` passes or the `timeout` runs out.
- Each pull sends the `resultId` of the document's previous report as `previousResultId`, and an `unchanged` report resolves to that previous report's diagnostics. Closing the document forgets its `resultId`.
- A request rejected with `ContentModified` or `ServerCancelled` is pulled again. Any other error ends the wait with `result: "error"`.
- `settleMs` doesn't apply, since a report is the server's complete answer.
- A pull still pending when the `timeout` runs out, or when an `auto` wait learns the server pushes, is cancelled with `$/cancelRequest`. A late reply to it is ignored, so the next pull sends no `resultId` from it.

### Pull Timings

A pull has no server debounce, so its timing isn't comparable with time to a push. Pulls are recorded under `diagnostics/pull/open`, `diagnostics/pull/edit` and `diagnostics/pull/wait`, re-pulls and backoff included.

- **`auto` mode**: timed like a push wait, from the latest `didOpen` or `didChange` to the resolving response (from the call, for a document that isn't open or was already pulled since its latest sync). When the wait first waited for a push from a server of unknown delivery, that grace is part of `ms` and is also recorded as `grace_ms` in the timing and `graceMs` in the result. The summary entry adds `graced` and `grace_median_ms`, and the printed summary notes them. The first auto wait on a pull only server pays the grace once (under `--restart`, once per run unless a warmup taught the delivery).
- **`pull` mode**: timed from the first pull request to the resolving response. No grace is involved, but the wait for a held placeholder is.

To avoid the grace on a server known to be pull only, such as ts7, pass `mode: "pull"` or a short `pullAfterMs`. A `tentative` pull may have measured a placeholder, so leave such timings out or wait for idle first.

### Advertising Pull Support

lsbench doesn't advertise the `textDocument.diagnostic` client capability by default. Servers built on `vscode-languageserver` (such as the VS Code CSS, HTML and JSON servers, and ESLint) stop pushing when it's present, which would silently turn push timings into pull timings. Servers that advertise `diagnosticProvider` regardless are still pulled as described above.

- `--advertise-pull` (`advertisePullDiagnostics: true` in code) advertises `{ "dynamicRegistration": false, "relatedDocumentSupport": false }`. Expect such servers to switch from `diagnostics/open` to `diagnostics/pull/open`.
- A `--client-capabilities-file` still overrides it.
- `workspace.diagnostics.refreshSupport` is always advertised, since lsbench handles `workspace/diagnostic/refresh`.

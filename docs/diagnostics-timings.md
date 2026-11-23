# Comparing Diagnostics Timings

Time to diagnostics measures when a server publishes, which is often not how long it took to check the file. Keep these in mind before comparing servers.

## Debounce

Some servers wait on purpose before computing diagnostics. The VS Code servers (JSON, CSS, HTML and others from `vscode-langservers-extracted`) wait about 500 ms, pyright about 250 ms. Their timings mostly measure that delay: a flat floor with a min at the delay. Compare such servers against their debounce, not against servers without one.

## Push vs Pull

A push timing (`diagnostics/open`, `diagnostics/edit`) includes the server's debounce. A pull timing (`diagnostics/pull/*`) is a request without one, so the two aren't comparable. In `auto` mode lsbench [learns per server](diagnostics.md#learning-the-delivery) which applies. Check which methods show up in the report and whether pulled timings are `tentative`, or pass `mode: "push"` or `mode: "pull"` to compare like with like.

## Intermediate Publishes

Some servers publish in stages: rust-analyzer and zls send an empty syntax pass before the semantic diagnostics. Waits already ignore publishes for older versions and closed documents, but such a pass belongs to the current state and resolves a plain wait early. Use `until` to skip it, and `settleMs` when a server publishes in bursts. `-v` logs every publish, which shows what a server sends.

## Silent Servers

Some servers never publish for a clean file, or skip some classes of errors. lua-language-server is silent on clean files, and the HTML server doesn't report markup errors. The wait then times out, and `timeout_rate` means "no diagnostics", not "slow".

- Give such waits an explicit, short `timeout` so they cost little.
- When you do expect diagnostics, `until: (d) => d.length > 0` ignores empty publishes, and `settleMs` picks up diagnostics that arrive in a later publish.

lsbench detects silent servers. After 3 push waits of one kind (`diagnostics/open`, `diagnostics/edit` or `diagnostics/wait`) time out in a row without any publish, warmups and restarts included:

- verbose mode logs that the server may never publish for a clean document
- the report records the method in `silent_waits`, with `waits` summed over documents and `longest_streak` the longest of any document
- the printed summary notes it below the table

Streaks are counted over documents, without a resolving wait of the same document in between. Whether a server publishes depends on the document (clean or not), so a wait that resolves, or sees publishes failing `until`, ends the streak of its own document only. The method still counts the streaks of its other documents.

## Publishes Failing `until`

A server may publish, but never with what `until` expects. bash-language-server without shellcheck, for example, publishes no diagnostics for a line meant to cause one, so every such wait times out.

- When a push wait times out after publishes that all failed `until`, verbose mode adds `all failing until (last: N diagnostics)` to its `diagnostics/...` line.
- After 3 such waits of one kind in a row, warmups and restarts included, verbose mode logs once per method that the server may never report what `until` expects.
- A wait that resolves after a publish failing `until` ends the streak. Other resolving waits don't.
- The report records such a method in `until_rejected` with all its waits that timed out this way, and the printed summary notes it below the table.

## Reopens

Some servers don't republish a clean file when it's reopened, rust-analyzer for example. Its publishes on close are credited to the closed document, so a `diagnostics/open` wait after a reopen has nothing to resolve on and measures only its timeout. Use `until` or a short `timeout` for such waits.

Verbose mode logs a hint when a reopen wait times out having seen only the publishes clearing the close. It says so when all of them arrived after the reopen and were credited to the close by the [learned rule](diagnostics.md#learning-the-servers-close-behavior), since one of them may have been the reopen's own publish.

## Shortening Known Timeouts

Silent servers, publishes failing `until` and reopens each cost a full timeout per wait, which can dominate a run. `--shorten-silent-waits [ms]` (`shortenSilentWaits` in `BenchOptions`) ends such waits early. It's off without the flag, and a bare flag uses 500 ms.

**When it kicks in**: once 3 waits of a kind and method timed out in a row, warmups and restarts included.

| Kind | Counted | Shortened wait ends | Full timeout restored by |
| --- | --- | --- | --- |
| silent (no publish) | over documents, without a resolving wait of the same document in between | `ms` after its `didOpen` or `didChange` | a resolving wait of the same document |
| reopen (only publishes clearing the close) | like silent, but tracked apart from it | `ms` after its `didOpen` or `didChange` | a resolving reopen of the same document |
| `until` (publishes all failing it) | per method. Resolving waits in between don't count against it, since bash-language-server's `edit-diagnostics` alternates them | `ms` after its latest rejected publish | a wait that resolves after a publish failing `until` |

- For silent and reopen waits, a document is shortened after one such timeout of its own once the method qualifies. Its first wait, and a wait after its last one resolved, get the full timeout.
- A further publish arriving before the shortened end keeps the wait going.
- No wait is shortened while a placeholder publish or pull answer is held, or while a close window is open and a close candidate could still be accepted, so a reopen wait runs at least until that window ends.
- Servers that publish for every wait are never shortened.

**Reporting**: shortened waits stay timeouts.

- the timing has `shortened: true`, and the `waitForDiagnostics` result `shortened`
- the summary entry adds `shortened`, how many timings were, and the printed summary notes them
- `silent_waits` and `until_rejected` add a `shortened` count
- the report adds `reopen_waits` for methods with a shortened reopen wait (`waits` and `shortened` summed over documents, `longest_streak` the longest of any document)
- verbose mode logs such a wait as `500.3ms timeout (shortened)`

Timeouts are left out of the durations, so medians don't change, but wall time drops. A server that publishes very late, after `ms`, has those publishes cut off, so its `timeout_rate` can rise. Compare runs with and without the flag before relying on it.

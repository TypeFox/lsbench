# Report Format

`--output` writes a JSON report:

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

## Top Level Fields

| Field | Content |
| --- | --- |
| `summary` | per method aggregate stats, see [summary](#summary) |
| `iteration_summary` | per iteration total time stats |
| `runs` | the full per iteration, per request breakdown |
| `lifecycle` | without `--restart` only: spawn, initialize, idle and final shutdown timings of the single server |
| `abnormal_exits` | servers that crashed or exited unexpectedly, see [server exits](#server-exits) |
| `tolerated_exits` | servers whose exit was allowed, see [server exits](#server-exits) |
| `plaintext_fallbacks` | extensions opened as `plaintext`, see [language IDs](action-scripts.md#language-ids) |
| `silent_waits`, `until_rejected`, `reopen_waits` | diagnostics waits known to time out, see [comparing diagnostics timings](diagnostics-timings.md) |

## Request Results

Each request timing has a `result`:

| Result | Meaning |
| --- | --- |
| `ok` | a non empty result |
| `empty` | an empty list, or a wrapper with an empty list (a `CompletionList` or diagnostic report with no `items`, `SemanticTokens` with no `data`) |
| `null` | a `null` result. A high `null_rate` usually means a position misses a symbol, so its fast timings mean little |
| `error` | the request failed, with the message in `error` |
| `skipped` | never sent, since the server doesn't advertise the provider (see [unsupported requests](client-behavior.md#unsupported-requests)) |
| `timeout` | a [diagnostics](diagnostics.md) or [idle](readiness.md#waiting-for-idle) wait ran out |

`success` is kept for compatibility and is `false` exactly for `error`, `skipped` and `timeout`.

## Summary

Each method in `summary` has:

- **Durations**: `avg_ms`, `median_ms`, `p95_ms`, `p99_ms`, `min_ms`, `max_ms`, `stddev_ms`
- **Rates**: `failure_rate`, `null_rate`, `empty_rate`, `timeout_rate`
- **Counts**: `count` (skipped requests included), `skipped`, and `skip_rate`, their share

How they're computed:

- The rates cover only the requests actually sent.
- Timeouts aren't failures, so they only count toward `timeout_rate`.
- The durations also leave out timeouts. A fully skipped or fully timed out method has no durations: its latency fields are `null`, printed as `n/a`. A fully skipped one has a `failure_rate` of 0.

Diagnostics waits add fields when they apply. Their durations don't include the time these describe:

| Fields | Waits |
| --- | --- |
| `graced`, `grace_median_ms` | auto pulls that first waited for a push, see [pull timings](diagnostics.md#pull-timings) |
| `held` | auto pulls that held back empty answers of a busy server, see [placeholders](diagnostics.md#placeholders) |
| `held_publishes` | waits that held back placeholder publishes |
| `close_windowed`, `close_window_median_ms` | push waits that held an empty publish in the [close window](diagnostics.md#reopens-and-the-close-window) |
| `shortened` | push waits ended early by [`--shorten-silent-waits`](diagnostics-timings.md#shortening-known-timeouts) |

The printed table adds Null% and Empty% columns when any method has a nonzero rate, a Tmout% column when any wait timed out, and a Skip% column when any request was skipped. Notes on the fields above appear below the table.

## Lifecycle Timings

Server lifecycle timings are recorded like methods:

| Method | Measures | Results |
| --- | --- | --- |
| `lifecycle/spawn` | spawning the process until the OS reports it started | `ok`, `error` |
| `lifecycle/initialize` | the `initialize` request until its response, including the server's own startup | `ok`, `error` |
| `lifecycle/idle` | with `--wait-idle` only, `initialized` until the server became [idle](readiness.md), without the quiet period | `ok`, `timeout` |
| `lifecycle/shutdown` | the `shutdown` request until its reply. Fails when the server exits first or doesn't reply within `--shutdown-timeout` | `ok`, `error` |

- **With `--restart`**: each run's `requests` start with spawn, initialize and idle and end with shutdown. Spawn, initialize and idle count toward `total_ms`. Shutdown happens after the iteration ends and doesn't.
- **Without `--restart`**: the single server's timings belong to no iteration, so they go in the top level `lifecycle` list, and each appears once in `summary`.

Time to diagnostics (`diagnostics/*`, `diagnostics/pull/*`) and idle waits (`server/idle`) appear in `summary` like any method.

## Retries

Requests rejected with `ContentModified` (-32801), as servers do while loading or when an edit races a request, are retried up to `--content-modified-retries` times (default 3) with a short backoff. The timing records the count in `retries` and covers only the final attempt.

## Server Exits

`abnormal_exits` lists servers that crashed or exited unexpectedly, only when any did. The report is still written, and lsbench exits non zero. Each exit's `during` says when:

| `during` | The server exited |
| --- | --- |
| `iteration N`, `warmup N` | during an iteration |
| `teardown of iteration N`, `teardown of warmup N` | while being stopped under `--restart` |
| `final teardown` | the single server without `--restart`, while being stopped after the last iteration |

Without `--restart`, a server that exits during an iteration ends the run. The exit is labeled with that iteration, no further iterations run, and the report keeps the runs completed so far, including the crashed one.

A server whose start fails is stopped before the error is reported, so no process is left behind:

- After an `initialize` error reply or a `setup` export that throws, the server gets `SIGTERM`, then `SIGKILL` after 3 seconds. No `shutdown` is sent. `LspHarness.start()` does this itself before rejecting, and `harness.exit` reads `killed by lsbench (...)` unless the server already exited on its own.
- After a failing `--wait-idle`, the server is stopped as usual, with `shutdown` and `exit`.
- Under `--restart`, a failed start after collected runs is listed as `failed to start: <error>`, with `code` and `signal` only when the server exited on its own.

`tolerated_exits` has the same shape, only when any exit was tolerated, and doesn't make lsbench exit non zero:

| Option | `ServerConfig` | Tolerates | Example |
| --- | --- | --- | --- |
| `--allow-exit-code <n>` | `allowExitCodes` | exit code `n` after a replied `shutdown` | TypeScript 7 exiting 1 |
| `--allow-exit-signal <name>` | `allowExitSignals` | a signal after a replied `shutdown` | nixd crashing with `SIGSEGV` |
| `--allow-unreplied-shutdown` | `allowUnrepliedShutdown` | an exit with code 0, an allowed code or an allowed signal after `shutdown` was sent but before its reply | neocmakelsp, which exits on `shutdown` without waiting for `exit` |

An unreplied shutdown exit is listed with a reason such as `exited after unreplied shutdown with code 0 (allowed)`, and `lifecycle/shutdown` is timed up to the exit. Without `--allow-unreplied-shutdown`, a server that exits without replying to `shutdown` stays in `abnormal_exits` whatever its code or signal. An exit before `shutdown` was sent always stays abnormal.

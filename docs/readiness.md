# Warmup and Readiness

Servers with a load phase, such as rust-analyzer, index the workspace after `initialized`. Requests sent meanwhile fail with `ContentModified` or answer from a partial model, so cold timings measure a placeholder. Wait for the load to finish instead of adding warmup iterations:

| Wait | Where | Recorded as |
| --- | --- | --- |
| `--wait-idle [ms]` | after `initialized`, and after each restart with `--restart`, before the script runs | `lifecycle/idle` |
| `ctx.waitForIdle()` | inside the script, for example after an edit that triggers reindexing | `server/idle` |

## Waiting for Idle

lsbench tracks two busy signals:

- **Work done progress**: lsbench advertises `window.workDoneProgress` and tracks every token through `$/progress` begin and end, whether or not the server created it with `window/workDoneProgress/create`.
- **Server status**: lsbench advertises rust-analyzer's `experimental.serverStatusNotification` and tracks `experimental/serverStatus`.

The server is idle when no progress token is active and, if it ever sent a server status, the latest one is `quiescent: true`. Verbose mode logs progress begin and end titles and status changes.

`waitForIdle(options?)` takes `{ timeout, quietMs }` or a bare timeout (default 30000 ms). It resolves once the server stayed idle for `quietMs` (default 100), counted from the later of the call and the moment it last became idle, so the wait doesn't resolve between back to back progress tokens.

```typescript
export default async function (ctx: BenchContext) {
  await ctx.waitForIdle(60_000); // let rust-analyzer load the workspace
  await ctx.openDocument("src/main.rs");
  await ctx.hover("src/main.rs", 10, 5);
}
```

| Result | Meaning |
| --- | --- |
| `idle` | whether the server was idle when the wait resolved. On timeout it can be `true` when the quiet period was cut short |
| `timedOut` | `true` when the timeout fired before the server stayed idle for `quietMs` |
| `ms` | time from the call until the server last became idle, 0 when it already was, without the quiet period. On timeout, the time until the timeout |

- Each wait is recorded as `server/idle`, with `result` `ok` or `timeout`.
- A token that never ends keeps the server busy, so the wait times out.
- A server that reports neither progress nor status resolves after the quiet period, so the wait tells nothing about it.

`--wait-idle [ms]` (default 30000 ms) is recorded as `lifecycle/idle`, and a timeout prints `Warning: server not idle after Nms`.

## Warmup Iterations

Warmup iterations still cover what idle doesn't:

- JIT compilation and caches that only warm up as requests run
- per document state built on the first open
- servers that report no progress

Use `--warmup 3-5` for steady state numbers.

## Cold Start

`--restart` restarts the server between iterations, so each run reports `lifecycle/spawn` and `lifecycle/initialize`. Without it, the server stays alive across iterations (warm benchmarks).

Keep at least one warmup iteration: the [diagnostics delivery](diagnostics.md#learning-the-delivery) it learns carries over to the timed iterations, so a pull only server isn't waited on for a push in each of them. With `--warmup 0`, the first run pays the `pullAfterMs` grace, visible as `grace_ms`. Pass `mode: "pull"` or a short `pullAfterMs` to avoid it.

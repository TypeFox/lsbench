# CLI

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
  --advertise-pull            Advertise textDocument.diagnostic, servers may switch from push to pull
  --settings-file <path>      JSON file with client settings keyed by section. Only the listed keys are sent,
                              and servers may read a missing key as false (e.g. json.validate.enable)
  --restart                   Restart the server between iterations
  --shutdown-timeout <ms>     Wait for a shutdown reply, then kill (default: 5000)
  --allow-exit-code <n>       Tolerate exit code n after a replied shutdown (repeatable)
  --allow-exit-signal <name>  Tolerate a signal such as SIGSEGV after a replied shutdown (repeatable)
  --allow-unreplied-shutdown  Tolerate an exit with code 0, or an allowed code or signal, after shutdown
                              was sent but before the server replied
  --content-modified-retries <n>
                              Retry requests rejected with ContentModified (default: 3)
  --no-skip-unsupported       Send requests even when the server does not advertise their provider
  --wait-idle [ms]            Wait up to ms for the server to become idle after initialized,
                              and after each restart (default: 30000)
  --shorten-silent-waits [ms] Once 3 diagnostics waits of a kind known to time out did so in a row,
                              end later ones of that kind after ms (default: 500, off without the flag)
  --server-log <file>         Append server stderr, window/logMessage, window/showMessage and
                              $/logTrace to file instead of the console, even without -v
  --trace <file>              Write every LSP message in both directions to file as JSON lines,
                              with server starts and iteration markers (off by default)
  -v, --verbose               Verbose logging
  -V, --version               Show version
  -h, --help                  Show help

Commands:
  run                         Run a benchmark (default command)
  prime                       Print a primer on using lsbench
  baseline                    Write a baseline from a report
  check                       Check a report against a baseline
```

Where to read more:

| Options | Page |
| --- | --- |
| `--init-options-file`, `--client-capabilities-file`, `--settings-file`, arguments after `--` | [server configuration](server-configuration.md) |
| `--advertise-pull` | [pull diagnostics](diagnostics.md#advertising-pull-support) |
| `--restart`, `--warmup`, `--wait-idle` | [warmup and readiness](readiness.md) |
| `--shorten-silent-waits` | [shortening known timeouts](diagnostics-timings.md#shortening-known-timeouts) |
| `--allow-exit-code`, `--allow-exit-signal`, `--allow-unreplied-shutdown` | [server exits](report-format.md#server-exits) |
| `--content-modified-retries` | [retries](report-format.md#retries) |
| `--no-skip-unsupported` | [unsupported requests](client-behavior.md#unsupported-requests) |
| `baseline`, `check` | [regression checks](regression-checks.md) |

## Verbose Output

With `-v`, lsbench's own lines start with `[lsbench]`, and request timings with `[lsbench:ctx]`. The `Running iteration N...` progress line ends there, and the iteration time follows the iteration's log lines as `Iteration N: Xms`.

### Publishes

Each `textDocument/publishDiagnostics` is logged as one line: the workspace relative path (the URI outside the workspace), the version or `-`, the diagnostic count, its status, and the first message truncated to 100 characters:

```text
[lsbench] Publish src/config.yaml v=1 n=2 current: Incorrect type. Expected "string".
```

A publish is classified by the state of its document when it was read from the server, not when it's handled, since a quick close and reopen can be sent between the two.

| Status | Publish |
| --- | --- |
| `current` | for the open document state. A publish read while the document was open but handled after its `didClose` stays `current` for that open |
| `stale` | for an older version, credited to a closed document, or read for an earlier open of the document |
| `closed` | read while the document was closed, also when handled after the reopen |
| `close candidate` | held as the possible clearing publish of a close, see [the close window](diagnostics.md#reopens-and-the-close-window) |
| `unopened` | read before the document's first `didOpen` |

Publish URIs are matched to documents after decoding percent encoding, and case-insensitively on macOS and Windows. On other platforms a publish whose URI matches an open document only apart from case stays `unopened`, and lsbench logs a hint once per URI.

### Server Output

Server stderr, `window/logMessage`, `window/showMessage` and `$/logTrace` are forwarded in verbose mode with each line prefixed `[server]`, so `grep -v '^\[server\]'` leaves lsbench's lines.

`--server-log <file>` appends them to a file instead, with or without `-v`, with a header line per server start:

```text
===== 2026-11-11T10:15:02.123Z server start: yaml-language-server --stdio
```

When a server crashes, the tail of its stderr is included in the error message either way.

With `--settings-file`, the expanded settings are logged as `Sending workspace/didChangeConfiguration: {...}` each time they're sent.

## Wire Trace

`--trace <file>` records every JSON-RPC message lsbench exchanges with the server, one JSON line per message:

```text
{"t":1014.5,"dir":"out","msg":{"jsonrpc":"2.0","method":"textDocument/didChange","params":{...}}}
{"t":1440.1,"dir":"in","msg":{"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{...}}}
```

- `dir` is `out` for messages lsbench sends and `in` for messages it receives.
- `t` is milliseconds since the run started, on the same `process.hrtime` clock as the report timings.
- Each server start adds `{"t":...,"spawn":true,"iso":"2026-11-17T10:15:02.123Z","command":"...","args":[...]}`.
- Each iteration starts with `{"t":...,"iteration":3,"warmup":false}`, numbered like the progress lines (warmups count from 1 with `"warmup":true`).

With `--restart`, the iteration marker comes before the server is spawned, so its spawn and initialize belong to the iteration. Without it, the server starts before the first marker, and documents are reset at the end of each iteration. Report timings are durations, so line a trace up with them through the iteration markers.

The file is overwritten on each run. Outgoing messages are logged as lsbench writes them, incoming ones as they're read, before lsbench handles them. Tracing serializes every message, which adds overhead to the timings, so it's off by default and the connection isn't wrapped at all without it.

## Prime

`lsbench prime` prints a primer on using lsbench, for humans and agents alike.

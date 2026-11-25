# Transports

lsbench speaks LSP over the server's stdin and stdout by default. Two TCP socket modes reach servers that offer sockets, or only sockets.

| Option | Who listens | Server command | Typical servers |
| --- | --- | --- | --- |
| none (stdio) | nobody | required | most servers |
| `--connect <[host:]port>` | the server | optional, spawned first when given | Godot's GDScript server, `gopls -listen=:port`, Erlang LS in TCP mode |
| `--socket <port>` | lsbench, on `127.0.0.1` | required, must connect back | servers built on `vscode-languageserver` (`--socket=<port>`), Eclipse JDT LS (`CLIENT_PORT`) |

Both modes build the JSON-RPC connection on the socket. Timings, tracing and diagnostics work as with stdio. `TCP_NODELAY` is set, so Nagle's algorithm does not delay small messages.

## Options

- `--connect` takes a port, `host:port` or `[ipv6]:port`. The host defaults to `127.0.0.1`.
- `--socket 0` picks a free port for each server start.
- `{port}` in the server command or its arguments is replaced by the socket port, in both modes.
- `--connect-timeout <ms>` (default 10000) bounds the wait for the connection. `--connect` retries every 100 ms until then.
- `--connect` and `--socket` cannot be combined.

```sh
lsbench "node ./out/server.js --socket={port}" --socket 0 -w ./workspace -s ./actions.ts
lsbench --connect 6005 -w ./project -s ./actions.ts
lsbench "gopls -listen=127.0.0.1:{port}" --connect 37374 -w ./module -s ./actions.ts
```

A failed connection ends the start with an error such as `cannot connect to 127.0.0.1:6005 within 10000ms (ECONNREFUSED)` or `the server did not connect to 127.0.0.1:41011 within 10000ms`. A spawned server that exits first fails the start with its exit code and stderr instead.

## Spawned Servers

When lsbench spawns the server in a socket mode:

- Its stdout no longer carries LSP. It goes to the console in verbose mode or to `--server-log`, like stderr.
- Its stdin stays open, since some servers exit when it closes.
- Its exit is classified as with stdio, including `--allow-exit-code` and `--allow-exit-signal`.
- A connection the server closes before `shutdown` counts as a crash, even when the process keeps running. lsbench waits 200 ms for an exit first, so a crashing process is reported with its exit code.

## Servers Without a Command

With `--connect` and no server command, lsbench owns no process:

- `shutdown` and `exit` are sent as usual, then lsbench closes its side. No signal is sent.
- The closed connection ends the server. `harness.exit` has `code` and `signal` `null`.
- `--allow-exit-code` and `--allow-exit-signal` are rejected, and stderr is unavailable.
- The report's `server` field reads e.g. `connect 127.0.0.1:6005`.

| The server | Reason | Listed in |
| --- | --- | --- |
| closes the connection after replying to `shutdown` | `closed the connection after shutdown` | neither |
| ignores `exit` or `shutdown`, lsbench closes the connection | `disconnected by lsbench` | neither |
| closes it after an error reply to `shutdown` | `closed the connection after failed shutdown` | neither |
| closes it after `shutdown` was sent, before replying, with `--allow-unreplied-shutdown` | `closed the connection after unreplied shutdown (allowed)` | `tolerated_exits` |
| closes it at any other time | `closed the connection unexpectedly` | `abnormal_exits` |

`--restart` reconnects for each iteration. That suits daemons such as gopls, but a server inside an editor may not accept a second `initialize`.

`initialize` sends lsbench's own `processId`. A server on another machine cannot watch it.

## From Code

`ServerConfig.transport` (`ServerTransport`) selects the mode:

| Value | CLI |
| --- | --- |
| `{ kind: 'stdio' }` or none | default |
| `{ kind: 'connect', host, port, timeoutMs? }` | `--connect` |
| `{ kind: 'socket', port, timeoutMs? }` | `--socket` |

`ServerConfig.command` may be left out only with `connect`. `LspHarness.start()` rejects otherwise, and `resolveServerConfig(undefined, { transport })` throws.

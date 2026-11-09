# lsbench

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

lsbench is published to npm. Install it globally for the CLI:

```bash
npm install -g lsbench
```

Or add it as a dependency to import the `BenchContext` API in your action
scripts:

```bash
npm install lsbench
```

## How it works

lsbench spawns a language server process, performs the LSP
initialize/initialized handshake, then runs your action script, which is a
TypeScript file that drives a sequence of LSP requests
against a target workspace.

Each request is then timed. The script runs for N iterations, producing
a JSON report with per-method statistics and per-run breakdowns.

## Writing an action script

An action script is a file that default-exports an async function
receiving a `BenchContext`. The [`examples/`](examples) directory has a few
starting points:

- [`examples/typescript-actions.ts`](examples/typescript-actions.ts): a fuller driver exercising hover, completion (with resolve), navigation, formatting, document structure, semantic tokens, workspace symbols, call and type hierarchy, edits, and saves.
- [`examples/cold-start.ts`](examples/cold-start.ts): a minimal cold-start
  driver (i.e. a benchmark that restarts the LS on each run).
- [`examples/custom-language.ts`](examples/custom-language.ts): benchmarking a non-mainstream language server (a Langium DSL) via `addRegisteredLanguage`.
- [`examples/compare-servers.ts`](examples/compare-servers.ts): importing `runBenchmark` to compare two servers programmatically and diff the reports.

A typical script looks like:

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

Paths are relative to the workspace root, positions are zero based. Methods marked (timed) record a timing entry and return the raw LSP result, or `null` on failure. `ctx.workspaceRoot` holds the absolute workspace root path.

**Document lifecycle** (all but `openDocument` and `closeDocument` require an open document)

| Method | Description |
| --- | --- |
| `openDocument(path)` | Send `textDocument/didOpen` |
| `closeDocument(path)` | Send `textDocument/didClose` |
| `edit(path, edits)` | Send `textDocument/didChange` and apply the edits to the tracked text, in order |
| `saveDocument(path)` | Send `textDocument/didSave` only if the server asks for it, with the tracked text when it wants `includeText` |
| `willSave(path, reason?)` | Send `textDocument/willSave` only if the server asks for it. `reason` defaults to 1 (Manual) |
| `willSaveWaitUntil(path, reason?)` | `textDocument/willSaveWaitUntil` (timed, always sent). `reason` defaults to 1 (Manual) |

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
| `waitForDiagnostics(path, timeout?)` | Wait for `publishDiagnostics` (default 30000 ms) |
| `sleep(ms)` | Pause execution |
| `request(method, params, label?)` | Arbitrary LSP request (timed) |
| `notify(method, params)` | Arbitrary LSP notification |

Call and type hierarchy requests take an item returned by the matching prepare call:

```ts
const items = (await ctx.prepareCallHierarchy("src/index.ts", 10, 5)) as unknown[] | null;
if (items && items.length > 0) {
  await ctx.callHierarchyIncomingCalls(items[0]);
  await ctx.callHierarchyOutgoingCalls(items[0]);
}
```

Resolve requests take an item returned by the matching request. The server only answers them when its provider advertises `resolveProvider: true`:

```ts
const list = (await ctx.completion("src/index.ts", 15, 10)) as { items: unknown[] } | unknown[] | null;
const items = Array.isArray(list) ? list : (list?.items ?? []);
if (items.length > 0) {
  await ctx.completionItemResolve(items[0]);
}
```

lsbench advertises `resolveSupport` for completion items, code actions, inlay hints, and workspace symbols, so some servers return partial items and defer that work to the resolve request.

`documentDiagnostic` and `workspaceDiagnostic` only work against servers that expose `diagnosticProvider`. lsbench does not advertise the `textDocument.diagnostic` client capability, since some servers would then stop pushing diagnostics and break `waitForDiagnostics`.

### Save sync

`saveDocument` and `willSave` follow the server's save options, read from the static `textDocumentSync` capability and from dynamic registrations of `textDocument/didSave`, `textDocument/willSave`, and `textDocument/willSaveWaitUntil`. A bare `TextDocumentSyncKind` number implies `didSave` without text, matching `vscode-languageclient`. When the server does not ask for a notification it is skipped and logged in verbose mode. `willSaveWaitUntil` is always sent so it can be timed.

### Server to client requests

lsbench answers requests from the server so it never stalls waiting on a client:

- `workspace/configuration` returns an empty object per item
- `client/registerCapability` and `client/unregisterCapability` are accepted (save related registrations are tracked)
- `workspace/*/refresh` (semantic tokens, inlay hints, code lenses, inline values, diagnostics) and `window/workDoneProgress/create` are acknowledged
- `window/showMessageRequest` is dismissed with `null`
- `workspace/applyEdit` is declined with `applied: false`, lsbench never modifies the workspace

### Registering languages

In some cases you may also need to register a language ID for a given extension.
That's straightforward to do with `addRegisteredLanguage`, which will then impact all context related actions for documents with a matching extension.

```ts
import { addRegisteredLanguage } from 'lsbench';

// make sure mylanguage is recognized by its extension
addRegisteredLanguage('mylanguage', '.dsl');
```

This will ensure that opening a document with the extension `.dsl` will have an associated language ID of `mylanguage`, to invoke the correct language server.

## CLI options

```
Usage: lsbench [run] [options] <server>

Arguments:
  server                      Server command, e.g. "typescript-language-server --stdio"

Options:
  -w, --workspace <path>      Workspace directory (required)
  -s, --script <path>         Action driver script, .ts (required)
  -n, --iterations <number>   Timed iterations (default: 10)
  --warmup <number>           Warmup iterations, not recorded (default: 2)
  -o, --output <path>         JSON report output file
  --init-options-file <path>  JSON file with LSP initializationOptions
  --restart                   Restart the server between iterations
  -v, --verbose               Verbose logging
  -V, --version               Show version
  -h, --help                  Show help

Commands:
  run                         Run a benchmark (default command)
  prime                       Print a primer on using lsbench
```

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

See [`examples/init-options.json`](examples/init-options.json) for a sample. For full control over `command`, `args`, `env`, and `initializationOptions`, drive `LspHarness` programmatically with a `ServerConfig`.

## Output format

The JSON report contains:

- **summary**: Per-method aggregate stats (avg, median, p95, p99, min, max, stddev, failure rate)
- **iteration_summary**: Per-iteration total time stats
- **runs**: Full per-iteration, per-request breakdown

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
      "failure_rate": 0
    }
  },
  "runs": [
    {
      "iteration": 1,
      "requests": [
        { "method": "textDocument/hover", "duration_ms": 13.2, "success": true }
      ],
      "total_ms": 245.3
    }
  ]
}
```

## Prime

The CLI also supports a `prime` command that will print helpful information for working with `lsbench`.
This can be leveraged by humans as well as agents to use the tool in a self-documenting fashion.

## Tips

- **Warmup matters**: JIT compilation, caches, etc. need a few runs to stabilize (unless you want cold-start times). Use `--warmup 3-5` for reliable numbers once the server is warmed up.
- **Cold start**: Use `--restart` to measure initialization time. Without it, the server stays alive across iterations (warm benchmarks).
- **waitForDiagnostics**: Always call this after opening a document or making edits, before timing requests. Servers do background work that affects latency.
- **Large workspaces**: The first iteration may be much slower due to indexing. Use enough warmup to account for this.
- **Compare servers**: Run the same action script against different servers (e.g. `typescript-language-server` vs `vtsls`) on the same workspace.

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

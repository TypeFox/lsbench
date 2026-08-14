# lsbench

Benchmark arbitrary language servers with scripted LSP actions.

![lsbench example with langium-minilogo](demo/lsbench.gif)

```bash
# bench a ts language server over stdio
lsbench "typescript-language-server --stdio" \
  --workspace ./my-project \    # point to your workspace
  --script ./bench-actions.ts \ # set the benchmark script
  --iterations 50 \             # set iteration count
  --output results.json         # configure output
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

- [`examples/typescript-actions.ts`](examples/typescript-actions.ts): a fuller driver exercising hover, completion, definition, references, edits, and more.
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

| Method | Description |
| --- | --- |
| `openDocument(path)` | Send `textDocument/didOpen` |
| `closeDocument(path)` | Send `textDocument/didClose` |
| `hover(path, line, char)` | `textDocument/hover` (timed) |
| `completion(path, line, char)` | `textDocument/completion` (timed) |
| `definition(path, line, char)` | `textDocument/definition` (timed) |
| `references(path, line, char)` | `textDocument/references` (timed) |
| `typeDefinition(path, line, char)` | `textDocument/typeDefinition` (timed) |
| `implementation(path, line, char)` | `textDocument/implementation` (timed) |
| `documentSymbol(path)` | `textDocument/documentSymbol` (timed) |
| `formatting(path)` | `textDocument/formatting` (timed) |
| `rename(path, line, char, newName)` | `textDocument/rename` (timed) |
| `codeAction(path, range, codes?)` | `textDocument/codeAction` (timed) |
| `signatureHelp(path, line, char)` | `textDocument/signatureHelp` (timed) |
| `edit(path, edits)` | Send `textDocument/didChange` |
| `waitForDiagnostics(path, timeout?)` | Wait for `publishDiagnostics` |
| `sleep(ms)` | Pause execution |
| `request(method, params, label?)` | Arbitrary timed LSP request |
| `notify(method, params)` | Send any LSP notification |

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
Usage: lsbench [options] <server>

Arguments:
  server                Server command or path to config file

Options:
  -w, --workspace <path>    Workspace directory (required)
  -s, --script <path>       Action driver script (required)
  -n, --iterations <n>      Timed iterations (default: 10)
  --warmup <n>              Warmup iterations (default: 2)
  -o, --output <path>       JSON report output file
  --restart                 Restart server between iterations
  -v, --verbose             Verbose logging
  -V, --version             Show version
  -h, --help                Show help
```

## Server configuration

You can pass a simple command string:

```bash
lsbench "typescript-language-server --stdio"
```

Or a JSON config file for a bit more control:

```json
{
  "command": "typescript-language-server",
  "args": ["--stdio", "--log-level", "warn"],
  "env": { "TSS_LOG": "-level verbose" },
  "initializationOptions": {
    "preferences": { "includeInlayParameterNameHints": "none" }
  }
}
```

```bash
lsbench ./server-config.json -w ./project -s ./actions.ts
```

See [`examples/init-options.json`](examples/init-options.json) for a sample
config file.

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
```

Use `npm run dev` for a watch build while iterating.

## Testing

There are two test tiers:

- **Unit tests**: `npm test` runs the regular suite in `test/` via vitest.
- **Integration tests**: `npm run test:integration` builds lsbench, then
  clones, installs, and builds a Langium ([minilogo](https://github.com/TypeFox/langium-minilogo))
  language server and interacts with it via stdio. The suite runs over some of the following benchmark checks: go-to-definition, references, document symbols, hover, and a full `runBenchmark` report.

The integration run clones down & builds the minilogo server once on first use, so it's possible that it might be slow (timeouts are 120s per test / 600s per hook, per `vitest.integration.config.ts`). To account for this, the CI runs it as a separate `integration` job.

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

# Writing an Action Script

An action script is a `.ts`, `.js` or `.mjs` ES module that default-exports an async function receiving a `BenchContext`. lsbench runs it once per iteration and times each request it sends.

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

## Module Formats

- **TypeScript** is loaded by Node's built-in type stripping (Node >= 24), so it must be erasable: no `enum`, `namespace`, or parameter properties.
- **`.js`** is ESM unless the nearest `package.json` says otherwise.
- **`.mjs`** is always ESM.

## Examples

The [`examples/`](../examples) directory has starting points:

| Example | Shows |
| --- | --- |
| [`typescript-actions.ts`](../examples/typescript-actions.ts) | hover, completion with resolve, navigation, formatting, document structure, semantic tokens, workspace symbols, call and type hierarchy, edits and saves |
| [`cold-start.ts`](../examples/cold-start.ts) | a minimal cold start driver, restarting the server on each run |
| [`custom-language.ts`](../examples/custom-language.ts) | a Langium DSL server, registered with `addRegisteredLanguage` |
| [`compare-servers.ts`](../examples/compare-servers.ts) | `runBenchmark` from code, comparing two servers and diffing the reports |

## Context Basics

Paths are relative to the workspace root, and positions are zero based. `ctx.workspaceRoot` holds the absolute workspace root.

Timed methods record a timing and return the raw LSP result, or `null` on a failure. Since a `null` result looks the same, check `ctx.lastError`. It holds `{ method, message, code? }` when the last timed request failed, is `undefined` otherwise, and is cleared as each timed request starts. A request without a reply within [`--request-timeout`](report-format.md#request-timeouts) also returns `null` and sets `ctx.lastError`.

```ts
const res = await ctx.definition("src/index.ts", 10, 5);
if (ctx.lastError) {
  console.error(`definition failed: ${ctx.lastError.message}`);
}
```

To check what the server supports:

- `ctx.capabilities`: the `capabilities` of the server's `initialize` result
- `ctx.registrations`: the dynamic registrations it holds, as `{ id, method, registerOptions? }`
- `ctx.supports(method)`: whether either provides the provider behind an LSP request method, including options such as `resolveProvider` or `semanticTokensProvider.full.delta`. Methods lsbench has no provider mapping for count as supported.

```ts
if (ctx.supports("textDocument/diagnostic")) {
  await ctx.documentDiagnostic("src/index.ts");
}
```

Unsupported requests are skipped rather than sent, see [client behavior](client-behavior.md#unsupported-requests). The full method list is in the [BenchContext API](api.md).

## Language IDs

`openDocument` sends a language ID detected from the file. `detectLanguageId(path)` returns it: known file names such as `CMakeLists.txt` match first, then the extension, both case-insensitively, falling back to `plaintext`.

```ts
import { detectLanguageId } from 'lsbench';

detectLanguageId('src/index.TS'); // 'typescript'
detectLanguageId('model.dsl'); // 'mylanguage' after addRegisteredLanguage below, 'plaintext' otherwise
```

Register a language for an extension with `addRegisteredLanguage`. It applies to every document with that extension:

```ts
import { addRegisteredLanguage } from 'lsbench';

addRegisteredLanguage('mylanguage', '.dsl');
```

Override the language ID of a single document when opening it:

```ts
// a JSON file with comments, served as jsonc
await ctx.openDocument(".vscode/settings.json", { languageId: "jsonc" });
```

Built in mappings beyond the common languages:

| Extensions or file names | Language ID |
| --- | --- |
| `.tf`, `.tfvars`, `.hcl` | `terraform`, `terraform-vars`, `hcl` |
| `.ml`, `.mli`, `.mll`, `.mly` | `ocaml`, `ocaml.interface`, `ocaml.ocamllex`, `ocaml.menhir` |
| `.hs`, `.lhs` | `haskell`, `literate haskell` |
| `.nix` | `nix` |
| `.tex`, `.sty`, `.cls` | `latex` |
| `.bib` | `bibtex` |
| `.typ` | `typst` |
| `.pl`, `.pm`, `.t` | `perl` |
| `.cmake`, `CMakeLists.txt` | `cmake` |
| other `.txt` | `plaintext`, on purpose |

When `openDocument` falls back to `plaintext` for an unmapped extension:

- it warns once per extension, also without `--verbose`
- the report lists the extension in `plaintext_fallbacks`, and the printed summary notes it
- the silent wait and `until` hints add that the server may not serve that language ID, since many servers (terraform-ls among them) reject or ignore documents of a language they don't know

## Custom Server Messages

Some servers send custom notifications or requests and wait for the client to answer. Export a `setup` function next to the default export to handle them:

```ts
import type { BenchContext, ClientHooks } from 'lsbench';

// vue-language-server waits for a tsserver/response to each tsserver/request,
// answering null makes it fall back to an inferred project
export function setup(client: ClientHooks) {
  client.onNotification('tsserver/request', (params) => {
    const [[id]] = params as [[number, string, unknown]];
    client.notify('tsserver/response', [id, null]);
  });
}

export default async function (ctx: BenchContext) {
  await ctx.openDocument('src/App.vue');
  await ctx.documentSymbol('src/App.vue');
}
```

lsbench calls `setup` on every server spawn, after the process starts and before `initialize`, so handlers apply from the first message on, including each `--restart` spawn. `setup` may be async. `initialize` waits for it, and its time is not part of `lifecycle/spawn` or `lifecycle/initialize`.

| Hook | Behavior |
| --- | --- |
| `client.onNotification(method, handler)` | handles a server notification. The handler may answer right away or after an async call. A throwing or rejecting handler is logged in verbose mode and the run goes on |
| `client.onRequest(method, handler)` | answers a server request with the handler's result or resolved value. A throwing or rejecting handler answers with an error |
| `client.notify(method, params)` | sends an untimed notification to the server |

- Params reach handlers exactly as on the wire. A server sending one array with vscode-jsonrpc, like vue-language-server, sends it wrapped as `[[id, name, args]]`, and `client.notify(method, [id, null])` sends it the same way.
- Registering a method again replaces its handler.
- Methods lsbench answers itself can't be taken over, and registering one throws. These are the [server to client requests](client-behavior.md#server-to-client-requests), plus `textDocument/publishDiagnostics`, `window/logMessage`, `window/showMessage`, `$/logTrace`, `$/progress` and `experimental/serverStatus`.
- Without a handler, notifications are dropped and requests get `MethodNotFound`. Verbose mode logs each such method once, e.g. `Unhandled notification tsserver/request from the server, a script's setup can handle it`, so a hanging server points at its cause.

From code, `loadSetupScript(path)` loads a script's `setup` (undefined when it has none), and `LspHarnessOptions.setup` passes it to a harness.

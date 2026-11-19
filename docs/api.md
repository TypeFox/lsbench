# BenchContext API

Paths are relative to the workspace root, and positions are zero based. Methods marked timed record a timing and return the raw LSP result, or `null` on a failure (see [context basics](action-scripts.md#context-basics)).

## Document Lifecycle

All but `openDocument` and `closeDocument` require an open document.

| Method | Description |
| --- | --- |
| `openDocument(path, options?)` | Send `textDocument/didOpen`. `options.languageId` overrides the detected language ID for this document only |
| `closeDocument(path)` | Send `textDocument/didClose` |
| `edit(path, edits)` | Send `textDocument/didChange` and apply the edits to the tracked text, in order. Follows the server's [change sync kind](client-behavior.md#change-sync) |
| `saveDocument(path)` | Send `textDocument/didSave` only if the server asks for it, with the tracked text when it wants `includeText` |
| `willSave(path, reason?)` | Send `textDocument/willSave` only if the server asks for it. `reason` defaults to 1 (Manual) |
| `willSaveWaitUntil(path, reason?)` | `textDocument/willSaveWaitUntil` (timed, skipped unless the server asks for it). `reason` defaults to 1 (Manual) |

## Navigation and Editing

All timed.

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
| `codeAction(path, range, codes? \| options?)` | `textDocument/codeAction`, see [code actions](#code-actions) |
| `formatting(path)` | `textDocument/formatting` |
| `rangeFormatting(path, range)` | `textDocument/rangeFormatting` |
| `onTypeFormatting(path, line, char, ch)` | `textDocument/onTypeFormatting` |

### Code Actions

The third argument is an array of diagnostic codes, or an options object `{ diagnosticCodes?, only?, overlappingDiagnostics? }`. It picks which cached diagnostics are sent as `context.diagnostics`:

- `codes` or `diagnosticCodes`: diagnostics whose `code` matches, falling back to `data.code` (as Langium uses)
- `overlappingDiagnostics: true`: diagnostics whose range overlaps `range`, boundaries included, whatever their code, as editors do. Servers that publish diagnostics without a code and build quick fixes from `context.diagnostics`, such as elixir-ls, need it
- both: a diagnostic must match both
- neither: no diagnostics are sent

`only` lists the requested `CodeActionKind`s, sent as `context.only` and left out when not given. Some servers offer source actions only on request, e.g. tsgo needs `only: ['source.organizeImports']`.

Codes and overlaps match against pulled diagnostics when the server never published for the document.

## Document Structure

All timed.

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

## Workspace, Hierarchies and Pull Diagnostics

All timed.

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

Hierarchy requests expect an item returned by the matching prepare call:

```ts
const items = (await ctx.prepareCallHierarchy("src/index.ts", 10, 5)) as unknown[] | null;
if (items && items.length > 0) {
  await ctx.callHierarchyIncomingCalls(items[0]);
  await ctx.callHierarchyOutgoingCalls(items[0]);
}
```

`documentDiagnostic` and `workspaceDiagnostic` only work against servers that expose `diagnosticProvider`. lsbench doesn't advertise the pull client capability by default, see [pull diagnostics](diagnostics.md#pull-diagnostics).

## Resolve

All timed. The item is sent back as is.

| Method | Description |
| --- | --- |
| `completionItemResolve(item)` | `completionItem/resolve` |
| `codeActionResolve(action)` | `codeAction/resolve` |
| `codeLensResolve(codeLens)` | `codeLens/resolve` |
| `inlayHintResolve(hint)` | `inlayHint/resolve` |
| `documentLinkResolve(link)` | `documentLink/resolve` |
| `workspaceSymbolResolve(symbol)` | `workspaceSymbol/resolve` |

Resolve requests take an item returned by the matching request. The server only answers when its provider advertises `resolveProvider: true`, otherwise lsbench skips them:

```ts
const list = (await ctx.completion("src/index.ts", 15, 10)) as { items: unknown[] } | unknown[] | null;
const items = Array.isArray(list) ? list : (list?.items ?? []);
if (items.length > 0) {
  await ctx.completionItemResolve(items[0]);
}
```

lsbench advertises `resolveSupport` for completion items, code actions, inlay hints and workspace symbols, so some servers return partial items and defer that work to the resolve request.

## Helpers

| Method | Description |
| --- | --- |
| `waitForDiagnostics(path, options?)` | Wait for diagnostics of the current document state and time it, see [waiting for diagnostics](diagnostics.md) |
| `waitForIdle(options?)` | Wait until the server finished background work such as loading the workspace, see [waiting for idle](readiness.md#waiting-for-idle) |
| `sleep(ms)` | Pause execution |
| `request(method, params, label?)` | Arbitrary LSP request (timed) |
| `notify(method, params)` | Arbitrary LSP notification |

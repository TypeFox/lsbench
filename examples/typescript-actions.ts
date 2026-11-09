/**
 * Example action driver for benchmarking typescript-language-server.
 *
 * Usage:
 *   lsbench "typescript-language-server --stdio" \
 *     --workspace ./my-ts-project \
 *     --script ./examples/typescript-actions.ts \
 *     --iterations 20
 *
 * This script opens a file, waits for the server to finish loading,
 * then fires a series of LSP requests that exercise typical editor
 * interactions: hover, completions, go-to-definition, references,
 * formatting, document structure, semantic tokens, hierarchies, edits
 * and saves.
 *
 * Requests a server doesn't support still get timed (usually as a fast error
 * or empty result), so trim the sections your server doesn't implement.
 *
 * Adapt the file paths and positions to your own workspace.
 */
import type { BenchContext, Range } from 'lsbench';

const FILE = 'src/index.ts';

// a symbol to target in FILE, adjust to a real function or class in your code
const SYMBOL = { line: 10, character: 5 };

// a range covering the top of FILE, used by range based requests
const TOP_RANGE: Range = {
    start: { line: 0, character: 0 },
    end: { line: 40, character: 0 },
};

export default async function (ctx: BenchContext) {
    // ── 1. Open the main file and wait for diagnostics ────────────────
    //    (This ensures tsserver has finished loading the project.)
    await ctx.openDocument(FILE);
    await ctx.waitForDiagnostics(FILE, 30_000);

    // ── 2. Core requests ──────────────────────────────────────────────
    await coreRequests(ctx);

    // ── 3. Navigation ─────────────────────────────────────────────────
    await navigation(ctx);

    // ── 4. Formatting ─────────────────────────────────────────────────
    //    Formatting returns edits without applying them, so this is safe to repeat.
    await ctx.formatting(FILE);
    await ctx.rangeFormatting(FILE, TOP_RANGE);

    // ── 5. Document structure ─────────────────────────────────────────
    await documentStructure(ctx);

    // ── 6. Semantic tokens ────────────────────────────────────────────
    await semanticTokens(ctx);

    // ── 7. Workspace symbols ──────────────────────────────────────────
    //    Query a prefix of a symbol name that exists in your project.
    await ctx.workspaceSymbol('create');

    // ── 8. Call and type hierarchy ────────────────────────────────────
    await callHierarchy(ctx);
    await typeHierarchy(ctx);

    // ── 9. Edit, save, then undo the edit ─────────────────────────────
    await editAndSave(ctx);

    // ── 10. Close the document ────────────────────────────────────────
    await ctx.closeDocument(FILE);
}

/** hover, completion (plus resolve), definition, references and symbols */
async function coreRequests(ctx: BenchContext) {
    // hover over a symbol
    await ctx.hover(FILE, SYMBOL.line, SYMBOL.character);

    // trigger completion after a dot (e.g. `object.`), then resolve the first
    // item to fetch its documentation and detail lazily, as editors do on selection
    const completions = await ctx.completion(FILE, 15, 10);
    const firstCompletion = firstOf(completionItems(completions));
    if (firstCompletion) {
        await ctx.completionItemResolve(firstCompletion);
    }

    await ctx.definition(FILE, SYMBOL.line, SYMBOL.character);
    await ctx.references(FILE, SYMBOL.line, SYMBOL.character);
    await ctx.documentSymbol(FILE);
}

/** declaration and document highlight, as triggered by cursor movement */
async function navigation(ctx: BenchContext) {
    await ctx.declaration(FILE, SYMBOL.line, SYMBOL.character);
    await ctx.documentHighlight(FILE, SYMBOL.line, SYMBOL.character);
}

/** requests an editor sends after opening a file to render its structure */
async function documentStructure(ctx: BenchContext) {
    await ctx.foldingRange(FILE);
    await ctx.selectionRange(FILE, [{ line: SYMBOL.line, character: SYMBOL.character }]);
    await ctx.documentLink(FILE);
    await ctx.codeLens(FILE);
    await ctx.inlayHint(FILE, TOP_RANGE);
}

/** full semantic tokens, then a delta against the returned resultId */
async function semanticTokens(ctx: BenchContext) {
    const full = await ctx.semanticTokensFull(FILE);
    const resultId = (full as { resultId?: string } | null)?.resultId;

    // only servers that support deltas return a resultId
    if (resultId) {
        await ctx.semanticTokensDelta(FILE, resultId);
    }
}

/** prepare a call hierarchy item, then expand its incoming and outgoing calls */
async function callHierarchy(ctx: BenchContext) {
    const items = await ctx.prepareCallHierarchy(FILE, SYMBOL.line, SYMBOL.character);
    const item = firstOf(items);
    if (!item) {
        return;
    }
    await ctx.callHierarchyIncomingCalls(item);
    await ctx.callHierarchyOutgoingCalls(item);
}

/** prepare a type hierarchy item, then expand its supertypes and subtypes */
async function typeHierarchy(ctx: BenchContext) {
    // target a class or interface for meaningful results
    const items = await ctx.prepareTypeHierarchy(FILE, SYMBOL.line, SYMBOL.character);
    const item = firstOf(items);
    if (!item) {
        return;
    }
    await ctx.typeHierarchySupertypes(item);
    await ctx.typeHierarchySubtypes(item);
}

/** insert a line, re-check it, save, then remove the line again */
async function editAndSave(ctx: BenchContext) {
    await ctx.edit(FILE, {
        range: {
            start: { line: 20, character: 0 },
            end: { line: 20, character: 0 },
        },
        text: 'const __benchTemp = 42;\n',
    });

    // wait for the server to process the change, then hover the new variable
    await ctx.waitForDiagnostics(FILE, 10_000);
    await ctx.hover(FILE, 20, 10);

    // save like an editor would: willSaveWaitUntil is timed and may return
    // edits (e.g. organize imports), saveDocument only sends didSave when the
    // server asked for it. Neither writes to disk.
    await ctx.willSaveWaitUntil(FILE);
    await ctx.saveDocument(FILE);

    // undo the inserted line so each iteration starts from the same text
    await ctx.edit(FILE, {
        range: {
            start: { line: 20, character: 0 },
            end: { line: 21, character: 0 },
        },
        text: '',
    });
}

/** completion results are either an item array or a CompletionList */
function completionItems(result: unknown): unknown {
    if (Array.isArray(result)) {
        return result;
    }
    return (result as { items?: unknown[] } | null)?.items ?? null;
}

/** the first element of an array result, or undefined for null or empty results */
function firstOf(result: unknown): unknown {
    if (Array.isArray(result) && result.length > 0) {
        return result[0];
    }
    return undefined;
}

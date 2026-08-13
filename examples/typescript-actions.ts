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
 * interactions: hover, completions, go-to-definition, references, etc.
 *
 * Adapt the file paths and positions to your own workspace.
 */
import type { BenchContext } from 'lsbench';

export default async function (ctx: BenchContext) {
    // ── 1. Open the main file and wait for diagnostics ────────────────
    //    (This ensures tsserver has finished loading the project.)
    await ctx.openDocument('src/index.ts');
    await ctx.waitForDiagnostics('src/index.ts', 30_000);

    // ── 2. Hover over a symbol ────────────────────────────────────────
    //    Hover at line 10, column 5 — adjust to a real symbol in your code.
    await ctx.hover('src/index.ts', 10, 5);

    // ── 3. Request completions ────────────────────────────────────────
    //    Trigger completion at a position after a dot (e.g. `object.`)
    await ctx.completion('src/index.ts', 15, 10);

    // ── 4. Go to definition ───────────────────────────────────────────
    await ctx.definition('src/index.ts', 10, 5);

    // ── 5. Find all references ────────────────────────────────────────
    await ctx.references('src/index.ts', 10, 5);

    // ── 6. Document symbols ───────────────────────────────────────────
    await ctx.documentSymbol('src/index.ts');

    // ── 7. Simulate an edit, then re-check ────────────────────────────
    //    Insert a line, then request diagnostics and hover again.
    await ctx.edit('src/index.ts', {
        range: {
            start: { line: 20, character: 0 },
            end: { line: 20, character: 0 },
        },
        text: 'const __benchTemp = 42;\n',
    });

    // Wait for the server to process the change
    await ctx.waitForDiagnostics('src/index.ts', 10_000);

    // Hover the newly inserted variable
    await ctx.hover('src/index.ts', 20, 10);

    // ── 8. Clean up the edit (undo the inserted line) ─────────────────
    await ctx.edit('src/index.ts', {
        range: {
            start: { line: 20, character: 0 },
            end: { line: 21, character: 0 },
        },
        text: '',
    });

    // ── 9. Close the document ─────────────────────────────────────────
    await ctx.closeDocument('src/index.ts');
}

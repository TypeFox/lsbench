import type { BenchContext } from 'lsbench';

// Drives the minilogo language server through an editor session over
// gallery.logo (~1.5k LoC): a MiniLogo program with parameterized
// definitions, nested macro calls, parameter references, arithmetic, colors,
// and for-loops. Every position below points at a symbol in the document.
export default async function (ctx: BenchContext) {
    const program = 'gallery.logo';

    // open the document, and let the builder resolve cross-references
    await ctx.openDocument(program);
    await ctx.waitForDiagnostics(program, 30_000);

    // await outline
    await ctx.documentSymbol(program);

    // code completion partway through a tile body, where a macro call is expected
    await ctx.completion(program, 99, 4);

    // hover the `square` definition name and a param ref in its body
    await ctx.hover(program, 29, 4);
    await ctx.hover(program, 31, 9);

    // go-to-definition from two different call sites back to their `def`
    await ctx.definition(program, 67, 12); // square(...) call inside grid
    await ctx.definition(program, 1447, 0); // gallery(...) top-level call

    // find every reference to a the `grid` helper
    await ctx.references(program, 64, 4);

    // rename the same helper
    await ctx.rename(program, 64, 4, 'cluster');

    // ask for code actions and formatting across the document
    await ctx.codeAction(program, {
        start: { line: 29, character: 0 },
        end: { line: 40, character: 0 },
    });
    await ctx.formatting(program);

    // simulate an edit, append a top-level call, then re-measure after the
    // server updates diagnostics
    await ctx.edit(program, {
        range: {
            start: { line: 1474, character: 0 },
            end: { line: 1474, character: 0 },
        },
        text: 'tile0(0, 0)\n',
    });
    await ctx.waitForDiagnostics(program, 10_000);
    await ctx.documentSymbol(program);
    await ctx.definition(program, 67, 12);

    await ctx.closeDocument(program);
}

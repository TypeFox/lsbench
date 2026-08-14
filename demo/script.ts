import type { BenchContext } from 'lsbench';

// Drives the minilogo language server through a realistic editor session over
// gallery.logo (~1.5k LoC): a feature-rich MiniLogo program with parameterized
// definitions, nested macro calls, parameter references, arithmetic, colors,
// and for-loops. Every position below points at a real, resolvable symbol so
// the requests return meaningful results — not just non-null round-trips.
//
// gallery.logo landmarks (0-indexed):
//    29: def square(x, y, size)        <- a parameterized definition
//    31:     move(x, y)                <- parameter reference `x` in the body
//    64: def grid(ox, oy, cell, count) <- called once per tile (~190 call sites)
//    67:         square(ox + i * cell, oy + j * cell, cell)  <- call to `square`
//    99:     grid(x, y, 10, 2)         <- a call inside tile0
//  1447: gallery(6, 6, 120)            <- top-level call to `gallery`
export default async function (ctx: BenchContext) {
    const program = 'gallery.logo';

    // open the document and let the builder resolve cross-references before we query
    await ctx.openDocument(program);
    await ctx.waitForDiagnostics(program, 30_000);

    // outline the whole document (~200 symbols)
    await ctx.documentSymbol(program);

    // code completion partway through a tile body, where a macro call is expected
    await ctx.completion(program, 99, 4);

    // hover the `square` definition name and a parameter reference in its body
    await ctx.hover(program, 29, 4);
    await ctx.hover(program, 31, 9);

    // go-to-definition from two different call sites back to their `def`
    await ctx.definition(program, 67, 12); // square(...) call inside grid
    await ctx.definition(program, 1447, 0); // gallery(...) top-level call

    // find every reference to a heavily-called helper (`grid`)
    await ctx.references(program, 64, 4);

    // rename that same helper — a workspace edit touching all ~190 call sites
    await ctx.rename(program, 64, 4, 'cluster');

    // ask for code actions and formatting across the document
    await ctx.codeAction(program, {
        start: { line: 29, character: 0 },
        end: { line: 40, character: 0 },
    });
    await ctx.formatting(program);

    // simulate an edit — append a top-level call — then re-measure after the
    // server republishes diagnostics
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

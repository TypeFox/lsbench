/**
 * Example: benchmarking a custom / non-mainstream language server.
 *
 * lsbench is server-agnostic, so it'll work with any compliant LSP server.
 * The only extra step for a language whose file extension
 * lsbench doesn't already recognize is to register all extension -> languageId
 * mappings, so opened documents carry the languageId the server expects.
 *
 * This script targets a Langium-based DSL, minilogo, whose files use the
 * `.logo` extension and a `minilogo` languageId.
 * You can point it at the minilogo examples workspace after building the language server:
 *
 *   git clone https://github.com/TypeFox/langium-minilogo
 *   cd langium-minilogo && npm install && npm run build
 *
 *   lsbench "node ./out/language-server/main.js --stdio" \
 *     --workspace ./examples \
 *     --script /path/to/lsbench/examples/custom-language.ts \
 *     --iterations 20
 *
 * Adapt the extension, languageId, file path, and positions to your own DSL.
 */
import { addRegisteredLanguage, type BenchContext } from 'lsbench';

// Teach lsbench that `.logo` files should be opened as the `minilogo` language.
// Without this, the document's languageId defaults to 'plaintext' and the
// server may refuse to handle it. Call this once, before opening any document.
addRegisteredLanguage('minilogo', '.logo');

export default async function (ctx: BenchContext) {
    // open the document and let the Langium builder resolve cross-references
    await ctx.openDocument('test.logo');
    await ctx.waitForDiagnostics('test.logo', 30_000);

    // exercise the requests a DSL server typically supports (each is timed).
    // positions below match `def square(...)` in the minilogo test.logo sample:
    //   line 9 — the `square` definition name
    //   line 24 — a `square(...)` call site
    await ctx.documentSymbol('test.logo');
    await ctx.definition('test.logo', 24, 0);
    await ctx.references('test.logo', 9, 8);
    await ctx.hover('test.logo', 9, 8);

    await ctx.closeDocument('test.logo');
}

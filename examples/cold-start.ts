/**
 * Example: Minimal action for cold-start benchmarking.
 *
 * Use with --restart to measure how long it takes the server to
 * initialize and become responsive for each fresh start.
 *
 * Usage:
 *   lsbench "typescript-language-server --stdio" \
 *     --workspace ./my-ts-project \
 *     --script ./examples/cold-start.ts \
 *     --iterations 10 \
 *     --restart
 */
import { BenchContext } from "lsbench";

export default async function (ctx: BenchContext) {
  // Open a file — this triggers project loading
  await ctx.openDocument("src/index.ts");

  // Wait for the server to fully load (diagnostics are a good "ready" signal)
  await ctx.waitForDiagnostics("src/index.ts", 60_000);

  // Fire one request to confirm the server is responsive
  await ctx.hover("src/index.ts", 0, 0);
}

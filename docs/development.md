# Development

lsbench requires Node `>=24` (see `.nvmrc` for the pinned version). To build from source:

```bash
git clone https://github.com/TypeFox/lsbench.git
cd lsbench
npm install
npm run build
```

Use `npm run dev` for a watch build while iterating.

## Quality Checks

All run in CI:

```bash
npm test                  # unit tests (vitest)
npm run lint              # oxlint
npm run format            # biome format check
npm run knip              # unused dependency/export check
npm run test:integration  # minilogo + Langium grammar servers
```

## Build Variants

| Script | Build |
| --- | --- |
| `npm run build` | development build, with source maps and declaration maps |
| `npm run build:prod` | production build, without maps |

`prepublishOnly` cleans `dist/` and then runs `build:prod`.

## Testing

| Tier | Command | Covers |
| --- | --- | --- |
| Unit | `npm test` | the suite in `test/` |
| Integration | `npm run test:integration` | builds lsbench, then drives two real language servers over stdio |

The integration servers:

- **minilogo**: clones, installs and builds [langium-minilogo](https://github.com/TypeFox/langium-minilogo), then covers the methods it supports (symbols, definition, references, hover, highlight, prepareRename, folding, workspace symbols, save sync) plus a full `runBenchmark` report.
- **Langium grammar**: starts Langium's own grammar language server from devDependencies against a small fixture (`test-integration/langium-grammar/shapes.langium`). It covers the broader provider set: completion, rename, formatting, code actions via `data.code`, semantic tokens, call and type hierarchy, edits and save sync.

Methods a server doesn't advertise are listed as skipped tests, and each suite asserts that those providers are indeed absent.

The minilogo server is cloned and built once on first use, so the first run can be slow (timeouts are 120s per test and 600s per hook, per `vitest.integration.config.ts`). CI runs both suites in a separate `integration` job.

`test/primer.test.ts` checks that the CLI reference in `lsbench prime` (`src/primer.ts`) lists every option of `run`, `baseline` and `check` with its default. Add a new option there too, or the unit tests fail.

## Documentation

`README.md` is the entry point: what lsbench is, how to install it, a quick start, links into `docs/`, and the contribution guidelines. Details live in `docs/`, one page per topic, listed in [`docs/index.md`](index.md).

- Add new detail to the page for its topic, or a new page linked from `docs/index.md` when no page fits.
- Prefer short sentences, lists and tables over long paragraphs.
- Link related sections across pages instead of repeating them.
- `CHANGELOG.md` records each user facing change.

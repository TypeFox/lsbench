# lsbench Documentation

Start with the [README](../README.md) for installation and a quick start.

## Writing Benchmarks

| Page | Covers |
| --- | --- |
| [Action scripts](action-scripts.md) | script formats, examples, context basics, language IDs, custom server messages |
| [BenchContext API](api.md) | every context method, grouped by purpose |
| [Waiting for diagnostics](diagnostics.md) | options, results and timings of `waitForDiagnostics`, reopens, pull diagnostics |
| [Warmup and readiness](readiness.md) | `waitForIdle`, `--wait-idle`, warmup iterations, cold starts |

## Running Benchmarks

| Page | Covers |
| --- | --- |
| [CLI](cli.md) | options, quiet and verbose output, run status, wire trace, `prime` |
| [Server configuration](server-configuration.md) | server arguments, initialization options, client capabilities, settings |
| [Transports](transports.md) | stdio, `--connect` and `--socket`, servers lsbench does not spawn |
| [Client behavior](client-behavior.md) | unsupported requests, change and save sync, answers to server requests |

## Reading Results

| Page | Covers |
| --- | --- |
| [Report format](report-format.md) | report fields, request results, summary stats, lifecycle timings, server exits |
| [Comparing diagnostics timings](diagnostics-timings.md) | debounce, push vs pull, silent servers, shortening known timeouts |
| [Regression checks](regression-checks.md) | `lsbench baseline` and `lsbench check` |

## Project

| Page | Covers |
| --- | --- |
| [Development](development.md) | building, quality checks, testing, documentation conventions |
| [Changelog](../CHANGELOG.md) | changes per release |

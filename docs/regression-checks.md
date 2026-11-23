# Regression Checks

`lsbench baseline` reduces a report to a baseline, and `lsbench check` fails when a later report changed behavior or timings against it. Use them to gate a server or lsbench upgrade in CI.

```sh
# record today's behavior, then commit baseline.json
lsbench "typescript-language-server --stdio" -w ./ws -s ./actions.ts -o results.json
lsbench baseline results.json -o baseline.json

# later: run again and compare
lsbench "typescript-language-server --stdio" -w ./ws -s ./actions.ts -o results.json
lsbench check results.json -b baseline.json
```

The baseline keeps the run settings (`iterations`, `warmup`, `restart_between_iterations`), `summary` and `iteration_summary`, without the per iteration `runs`, so it stays small and diffs well. It records behavior as it is, known timeouts included. Rewrite it with `lsbench baseline` when a change is intended, and review the diff.

The baseline records its format version in `lsbench_baseline`. `check` exits 2 on a baseline of a format it does not support, such as `unsupported baseline format 2 (supported: 1)`. Regenerate it with `lsbench baseline`.

## Rules

`check` fails on each rule broken:

| Rule | Fails when |
| --- | --- |
| Run settings | `iterations`, `warmup` or `restart_between_iterations` differ, since timings of different settings aren't comparable |
| Methods | a method was added to or is missing from `summary`. This catches changed delivery too, such as `diagnostics/open` turning into `diagnostics/pull/open` |
| Rates | `timeout_rate`, `skip_rate`, `empty_rate`, `null_rate` or `failure_rate` differ by more than `--rate-tolerance` |
| Median | `median_ms` falls outside `[max(0, base / ratio - slack), base * ratio + slack]`, with `--median-ratio` and `--slack-ms` |
| Null median | a `null` median (every call timed out or was skipped) isn't `null` anymore, or a number became `null` |

About the median rule:

- Faster fails too, since a placeholder answer looks like a speedup.
- The slack absorbs the noise of methods taking a few milliseconds.
- It's skipped for a method whose `count` is below `--min-count` in the baseline or the report, since the median of one or two samples is noise. `--min-count 1` compares every median.
- Without `--restart`, `lifecycle/spawn`, `lifecycle/initialize` and `lifecycle/shutdown` run once, so their medians aren't compared, while their method and rates still are.

## Options

```
Usage: lsbench baseline [options] <report>

Options:
  -o, --output <path>     Output file for the baseline (required)

Usage: lsbench check [options] <report>

Options:
  -b, --baseline <path>   Baseline written by `lsbench baseline` (required)
  --rate-tolerance <n>    Largest allowed absolute difference of a rate (default: 0.1)
  --median-ratio <n>      median_ms may grow by this factor or shrink by its inverse (default: 2)
  --slack-ms <n>          Milliseconds added on both sides of the median bounds (default: 5)
  --min-count <n>         Skip the median rule for methods with a count below this in the baseline or report (default: 3)
  --json                  Print a machine readable verdict
```

## Output

`check` exits 0 on pass, 1 on regressions, and 2 on usage errors such as a missing or invalid file or option. A failing check prints a table of the broken rules, `(run)` standing for a run setting:

```text
FAIL: 2 regressions against the baseline

method              field         baseline  actual  rule
------------------  ------------  --------  ------  -----------------
textDocument/hover  median_ms     100       300     outside [45, 205]
diagnostics/open    timeout_rate  0         0.5     |diff| > 0.1
```

With `--json`, it prints the verdict instead:

```json
{
  "pass": false,
  "failures": [
    { "method": "textDocument/hover", "field": "median_ms", "baseline": 100, "actual": 300, "rule": "outside [45, 205]" }
  ]
}
```

`field` is `method` for an added or missing method, with `baseline` and `actual` set to `present` or `missing`.

`checkReport`, `createBaseline` and `formatCheckResult` are exported for use from code.

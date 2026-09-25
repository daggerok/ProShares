# Standard updater output

Every normal update prints its effective configuration, a filter/candidate count,
and one final result line for each attempted ETF:

```text
[ config ] Brand updater:
            MAX_FETCHES=0
            REQUEST_SLEEP=1.5
            CONCURRENCY=15
            ...all other supported effective configuration values...
[ filter ] 81 of 81 funds pass filters
[  8/81  ] BIV   updated   port=0925 history=761 (official=539 yahoo=234) holdings=2352 divs=233 netAssets=$29.0B total=$52.1B div=4.75454727 sec=5.19 wp=true
```

- Column order is **progress, ticker, status, details**. Fields are always in the
  same order; unavailable values are `null`, not invented zeroes. Numbers in the
  example are illustrative; each provider retains its own sources.
- Configuration shows canonical environment-variable names and effective parsed
  values, including unset ranges (`:`). Aliases resolve to their canonical name.
  Providers only list settings they actually support (Vanguard does not implement
  `CONCURRENCY` or `MAX_FETCHES`). No new fetching options are introduced.
- If filtering depends on fetched data, the filter line says **selected for
  evaluation (data-dependent filters applied per fund)** rather than claiming
  all candidates passed. The denominator on result lines is the attempted batch,
  respecting the existing cursor/MAX_FETCHES selection. Deferred exclusions use
  `skipped`; failures use `failed`, with a single-line `reason` when available.
- `updated` / `unchanged` compare semantic published fund JSON before/after,
  including page-only changes and removed pages; serialization ordering and
  `generatedAt` / `catalogReadAt` alone do not count. This comparison is **read-only** and does not
  affect existing writes, summary counters, cursors, fetching, or failure policy.
- Amplify publishes one aggregate file, so successful fund results print after
  its existing normalization/write step. Other providers report completions as
  workers finish. A fatal error still stops an updater that previously stopped.
- `official` and `yahoo` are input-history row counts when the updater exposes
  those counts (Vanguard); otherwise `null`. Overlapping source windows mean
  these counts need not sum to the merged history count. `wp` is Vanguard's
  workplace-source flag, `null` for providers without an equivalent.
- Warnings, catalog discovery, cursor notices, and run summaries remain separate
  diagnostics. There is one **result** line per attempted fund, not one line for
  every underlying network request. Existing summary counters retain their
  provider-specific semantics.

Run the output contract tests without network requests:

```sh
bun test scripts/update-output.test.ts
```

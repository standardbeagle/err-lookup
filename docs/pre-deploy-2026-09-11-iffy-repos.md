# Pre-deploy validation — seven small, badly-analyzed repos (2026-09-11)

Question: does the deployable state actually repair the repos the August quota
storms left broken, and does it break anything on languages the changes were not
developed against?

Set chosen from the production corpus by quality, not by traffic: 12–70 records,
30–500 source files, >80% thin, one repo per language. Small enough to run
cheaply, bad enough that a failure to improve them would be obvious.

Config: `configs/tune-glm-control.kdl` — glm-5.3-flash at production's model,
effort, batch size and directive. The deployable state, not an experimental one.
Run live alongside a production drain, which the system is designed for.

## Result

| repo | lang | was rec/thin | now rec/thin | disc/rej | doc | sols | tags |
|---|---|---|---|---|---|---|---|
| typecho/typecho | PHP | 43 / 42 | 43 / **0** | 89/46 | 296 | 4.0 | 3.4 |
| filp/whoops | PHP | 16 / 16 | 16 / **0** | 17/1 | 299 | 3.1 | 3.5 |
| exo-explore/exo | Python | 62 / 62 | **84** / **0** | 106/22 | 314 | 3.7 | 3.5 |
| clap-rs/clap | Rust | 28 / 27 | 22 / **0** | 40/18 | 376 | 3.6 | 4.7 |
| rouge-ruby/rouge | Ruby | 25 / 25 | 21 / **0** | 22/1 | 345 | 3.1 | 2.5 |
| xyflow/xyflow | TypeScript | 12 / 11 | **15** / **0** | 16/1 | 323 | 3.7 | 3.9 |
| serilog/serilog | C# | 31 / 31 | 28 / **0** | 33/5 | 306 | 3.2 | 4.0 |
| **total** | | **217 / 214** | **229 / 0** | 323/94 | | | |

`scan done: 7 ok, 0 unchanged, 0 failed`. Verify reported "no gaps — provider
calls skipped" on all seven, so nothing needed a second pass to clear the bar.
serilog is worth noting separately: its production row still carries
`discovery: operation timed out after 600`, and it completed here without
incident.

**214 thin records to 0.** That is the deploy signal — the current pipeline
fully repairs what the August storms produced.

## Record counts move in both directions

exo gained (62 → 84) and xyflow gained (12 → 15), but clap fell 28 → 22, rouge
25 → 21 and serilog 31 → 28. In every case the replaced records were ~100%
thin, so 21 healthy pages beat 25 stubs — but **deploying will reduce published
page count on some repos while improving their quality**, and the recrawl is
about to touch these repos systematically. Expect it rather than discover it.

## Reject rate is repo-shaped, and was invisible

Rejects — discovered sites that never became records, after the providers were
already paid — ran from 1-in-17 (whoops) to 46-of-89 (typecho, 52%) and 18-of-40
(clap, 45%). The two outliers are repos where one error recurs across many call
sites: typecho's numeric codes, clap's macros. That points at duplicate-discovery
rather than validation failure, but it is a hypothesis, not a measurement.

It was a hypothesis because the scan path logged the count and threw the reasons
away — `analyze` printed them, `scan` (what production runs) did not. Fixed in
100685c; the next run over these repos will name the reason instead of leaving
it to inference.

## Two defects this run found in already-committed work

Neither was visible from fastapi alone, and both would have shipped looking
correct.

1. **Numeric slugs** (fixed, 91bbeb0). The slug work removed typecho's 19
   generic `error*` slugs — the file-stem fallback worked — and replaced a third
   of them with `16`, `403`, `404-68ab46`, `32001`. `deriveSlug` prefers
   `errorCode`, and a numeric code kebabs to a *non-empty* string, so the
   empty-kebab guard never fired. One contentless-URL pathology traded for
   another.
2. **Recrawl eligibility** (fixed, df1d6ad). Found while picking this set:
   clap-rs/clap is stamped `analyzed_at = 2026-09-06` over records last written
   2026-08-18, because an incremental rescan refreshes the repo stamp without
   touching records. 86 of 1,628 repos, holding 51,945 records, carry that drift
   — and every one would have been permanently ineligible for the recrawl.

## What this run does NOT validate

**The slug numbers below are from the pre-91bbeb0 derivation.** The run launched
before that fix and tsx loads its modules at start, so the numeric-slug repair is
covered by unit tests only, not by this run:

    quality: 44/229 flagged (19.2%), 31 noindexed — duplicate=31 opaque-slug=18
    generic(error*): 3    numeric: 8    opaque(-hex): 18    of 229

Re-running these seven on current HEAD would close that gap and is cheap.

Also unvalidated here: the `counts` directive (this used the production one), and
any repo larger than 500 source files.

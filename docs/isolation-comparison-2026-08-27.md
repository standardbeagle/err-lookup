# Isolation comparison — minimal-MCP ACP extraction vs current production records (2026-08-27)

Question: do the ACP isolation changes (d9833e3→2e71516 — extraction agents run
with an emptied `XDG_CONFIG_HOME` and an `OPENCODE_CONFIG_CONTENT` carrying only
the lci MCP and the write/read tool pair, default ON) change extraction results
against the records currently in production?

Method: three medium repos already published, all analyzed before isolation
reached production, extracted from the prod DB on beagle-ab into
`data/baseline-isolation-cmp.db`. Rerun locally at HEAD 2e71516 with
`configs/compare-isolation.kdl` — same model routing as the blitz config
(glm-5.2 bulk, verify k3→glm-5.3 fallback since k3's cycle is spent),
concurrency capped at 3 to leave the live production drain its z.ai slots.
Isolation ON into `data/compare-isolation.db`; one control (fastapi, isolation
OFF) into `data/compare-isolation-off.db`. Report:
`tsx scripts/compare-report.ts baseline=... isolated=... --repo <r>`.

| repo | baseline records (analyzed) | isolated run | slug overlap | new slugs |
|---|---|---|---|---|
| fastapi/fastapi | 50 (2026-08-14) | **3** | 0 | 3 |
| nestjs/nest | 100 (2026-08-21) | 82 | 70 | 12 |
| tokio-rs/tokio | 74 (2026-08-21) | 47 | 30 | 17 |

## Verdict: isolation is exonerated; a silent-empty-batch defect is the story

**1. The minimal-MCP isolation does not degrade results.** The fastapi control
(isolation OFF, same machine/models/hour) discovered the identical 26 sites and
did *worse* downstream: 0/26 enriched, 0 final records vs the isolated run's
6/26 and 3. nest and tokio ran healthy under isolation. Nothing in the run
points at the isolated config.

**2. Per-record quality is up sharply vs the current production records.**
nest, isolated vs baseline: avg documentation 353 vs 216 chars, short docs 0%
vs 41%, avg solutions 3.2 vs 1.1, records with no solutions 0% vs **73%**,
example fix 98% vs 27%, defense strategy 100% vs 27%. tokio is at parity on
quality. The verify overhaul (05259af/bba53a3) patching every named gap is
visible: today's pipeline ships far more complete records than the 08-21-era
production rows it replaces.

**3. Coverage is down, and the mechanism is a defect, not a judgment.**
Enrichment batches that return a parseable-but-empty payload are counted as
successes: `analysis.ts` maps `parsed.enriched ?? []` and only a thrown call
increments `failedBatches`. Observed:

- fastapi isolated: 2 batches "0 failed", yet enrichment covered only
  errorIndex 20–25 — batch 1 (0–19) contributed nothing, silently. 26
  discovered → 3 records.
- tokio: 7 batches "0 failed", 70/137 enriched — roughly three batches empty.
- fastapi control: 0/26 enriched, "0 failed", 0 records.
- nest is the counterexample that proves the path: its degraded batches **timed
  out loudly** (600s wall clock), split-retried as halves, and finished at
  102/113 (90%) — the loud failure path recovers; the silent one loses data.

Unenriched records then die in verify/assembly (no documentation → patch
attempts → reject), so one quick-empty LLM response discards up to 20 records
with no log line. This violates the fail-fast rule and explains the entire
coverage gap. The likely provider trigger: glm-5.2 answering quickly with an
empty/stub output while the account is throttled (the production drain was
holding the z.ai 10-concurrent gate during this run — every full-size nest
batch hit the 600s ceiling).

**Fix before trusting any rescan counts:** treat an empty `enriched` payload
for a non-empty batch as a failed batch (log + split-retry like a timeout).
That is a size-independent failure, so route it like rate-limit/parse failures
(no split), or split once and then fail loudly — but never count it a success.

## Caveats

- Baseline rows predate the 08-24 verify overhaul and the 08-26 quota-fallback
  work, so this measures "updated pipeline as a whole" vs "current production
  records", not isolation as a single factor. The fastapi ON/OFF control is the
  only pure isolation A/B, and it favors ON.
- Verify model differs: baselines verified via k3; these runs used the glm-5.3
  fallback (k3's monthly cycle spent).
- Timings are not comparable: the local run shared the z.ai account with a live
  production drain. Baseline phase times (74.9m nest discovery) also include
  production queue effects.
- fastapi's 3 surviving records are all deprecation warnings with 0 slug
  overlap against its 50 baseline rows — that repo's funnel was effectively
  destroyed by the empty batches and tells us nothing about steady-state
  quality.
- Production is protected from count regressions on rescans (75a1d83, d63e036:
  published records a rescan fails to rediscover are kept), so this defect
  costs new-repo coverage and freshness, not published pages.

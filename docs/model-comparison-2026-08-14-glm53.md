# Model comparison — glm-5.3 challenger (2026-08-14)

Question: `zai-coding-plan/glm-5.3` appeared on the plan; does it beat the
glm-5.2 blitz primary? Method: same repo as the July baseline
(`sindresorhus/is`), single-provider config
`configs/compare-opencode-glm53.kdl`, isolated DB `compare-glm53.db` (on
beagle-ab), run entirely off-peak. The 5.2 column is the production DB's
current records for the same repo (analyzed 2026-07-31, same pipeline
generation) — fairer than the July table, whose phase times predate the
candidates-lci discovery rework and are not comparable.

The run was clean — zero rate limits, timeouts, retries, or failed batches —
so the gaps below are the model's output, not infrastructure.

| metric | glm-5.3 | glm-5.2 (production) |
|---|---|---|
| records | 93 (3 rejects) | 100 |
| with errorCode | 0% | 0% |
| avg doc chars | 276 | 300 |
| short docs (<100ch) | 0% | 0% |
| avg solutions | 3.4 | 3.5 |
| no solutions | 0% | 0% |
| example fix | 100% | 100% |
| source extracted | 100% | 100% |
| defense strategy | **82%** | **100%** |
| avg prevention tips | 2.4 | 3.2 |
| avg tags | 3.4 | 4.0 |

Verdict: **keep glm-5.2**. Enrichment and defense each covered only 76/96
discovered errors; defense-strategy coverage (the site's core value) fell to
82% vs 100%, and no metric improved. Day-one releases are often untuned —
rerun this benchmark after a 5.3 point release:

    ERRLOOKUP_CONFIG=$REPO/configs/compare-opencode-glm53.kdl \
    ERRLOOKUP_DB=$REPO/packages/pipeline/data/compare-glm53.db \
    pnpm --filter @errlookup/pipeline dev scan <corpus-file-with-sindresorhus/is>

Timing for the record (not comparable to July's columns): discovery 14.0m,
analysis 16.7m, verify 2 rounds.

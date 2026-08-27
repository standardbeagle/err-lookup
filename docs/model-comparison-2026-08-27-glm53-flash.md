# Model comparison — glm-5.3-flash for every task (2026-08-27)

Question: can `zai-coding-plan/glm-5.3-flash` take over all pipeline phases —
scope, discovery, analysis, verify, review? Same three-repo set and baseline
as `docs/isolation-comparison-2026-08-27.md` (production records +
same-day glm-5.2 reruns at HEAD a20f679, isolation-only, empty-batch guard
live), plus the 9-record traffic-subset review dry-run of
`docs/model-comparison-2026-08-16-review-phase.md`. Configs:
`configs/compare-glm53flash.kdl` (all phases → flash),
`configs/review-glm53flash.kdl`. Both runs shared the z.ai account with a
live production drain, so stall/timeout rates are worst-case-ish — but the
glm-5.2 comparison runs ran under the same contention.

## Bulk phases (scope / discovery / analysis / verify)

| | fastapi | nest | tokio |
|---|---|---|---|
| baseline records | 50 | 100 | 74 |
| glm-5.2 records (today) | 18 | 82 | 47 |
| **flash records** | **22** | **58** | **62** |
| flash discovery (glm-5.2's) | 38 (25) | 79 (113) | 113 (137) |
| flash enrichment coverage | 38/38 | 69/79 | 76/113 |
| flash rejects | 16 | 3 | 17 |
| baseline slugs rediscovered (glm-5.2's) | 12/50 (13/50) | 41/100 (70/100) | 36/74 (30/74) |

Per-record quality is at parity: docs 263–281 chars (glm-5.2 278–353),
solutions 3–3.6, example fix 97–100%, defense 100%; tags run thinner
(3.6–3.8 vs 4.7). Wall time similar; discovery classify is fast (fastapi 1.1m
vs 4.7m).

**Reliability is the gap.** Across the three repos flash logged 4 dead
batches with three distinct failure modes glm-5.2's same-day runs did not
show at this rate:

- **ACP idle stalls** — two halves killed by the 180s idle watchdog.
- **Output-protocol miss** — one batch streamed its full JSON as chat text
  instead of writing the requested output file ("agent did not write
  .errlookup.out…json; last text: …preventionTips…"). The answer existed and
  was lost to protocol non-compliance. Hardening candidate: fall back to
  parsing streamed text when the file is missing — the parser for text-mode
  responses already exists.
- **Empty stub answers** — same disease as glm-5.2's; the new empty-batch
  guard (7e633dc) caught them live ("returned empty — retrying as halves",
  then one still-empty half failed loudly). First real-world firing of that
  guard, and it worked.

Discovery variance is also wider: flash found 152% of glm-5.2's sites on
fastapi and 70% on nest — its classify judgment is less stable across repo
shapes, and nest's shortfall (79 vs 113 sites) is most of its record gap
there.

## Review phase (9-record traffic subset, dry-run)

| metric | glm-5.3 (08-16) | terra low | **flash** |
|---|---|---|---|
| completed | 9/9 | 9/9 | 9/9 |
| good | 4 | 0 | **7** |
| improved | 5 | 8 | 1 |
| defective | 0 | 1 | **1** |
| fields patched | 9 | 38 | 2 |
| avg secs/record | 67 | 29 | **27** |

Flash's calibration is the best seen on this subset. It called the grpc-go
record **defective** — the message/source-mismatch stance the 08-16 doc named
the safer default, which glm-5.3 got wrong (it rewrote the record instead).
Its one "improved" is the cargo record, where it found the same real defect
glm-5.3 found (the wrong `cargo clean -p` claim) plus an incomplete jq
pipeline, patched two fields, and left everything verified alone. It is 2.5x
faster than glm-5.3 per record. The risk is under-patching: glm-5.3 patched
5/9 with targeted fixes and some of those (an invented exit code, an
ungrounded example) flash waved through as good — worth a spot-check pass
before switching, but its errors are omissions, never invention.

## Verdict

- **Review: switch to flash** (`phase-providers { review "flash" }`).
  Best-calibrated verdicts, the safe stance on unfixable records, targeted
  patches only, 2.5x faster. Watch the first live batches for under-patching.
- **Verify: viable fallback** (`phase-fallbacks { verify "flash" }` alongside
  glm53). Its verify pass patched effectively (tokio: 67 patches → 62 valid).
- **Bulk analysis/discovery: not yet.** Record quality is fine but the ACP
  stalls, the output-file miss, and unstable discovery counts make it a net
  coverage loss vs glm-5.2 (58 vs 82 on nest). Re-evaluate if the
  streamed-text fallback lands or if flash's per-credit price makes 2x calls
  cheaper than 1x glm-5.2 — cost per record was not measured here.

Caveats: one run per repo; shared-quota contention inflated stalls for both
models; verify comparability differs (glm-5.2 runs verified via glm-5.3
fallback, flash verified itself).

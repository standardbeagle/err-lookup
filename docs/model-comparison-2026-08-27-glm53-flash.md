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

## Parity ladder (2026-08-28): effort + tuning close the gap

Step 1 above unknowingly ran at opencode variant=low (thinking:{disabled} maps
to an effort model's minimum; flash exposes low/high/max, pinned via
model-options `reasoningEffort`, visible as model.variant in opencode's log).
Two more rungs, after the streamed-JSON salvage (3195571) and the HOME
isolation fix (53ab2aa):

- **Step 2 — effort high** (`configs/compare-flash-high.kdl`): tokio went
  131/131 enriched, 0 failed, **114 records** (baseline 74, glm-5.2 47) with
  verify needing ONE patch. fastapi still sank (11) on an empty half and a
  mid-string JSON truncation.
- **Step 3 — tuned** (`configs/compare-flash-tuned.kdl`): effort high +
  `analysis-batch-size 10` (half-size outputs cannot hit the truncation
  ceiling) + a flash `prompt-directive` replacing the stock minimal-thinking
  opener (complete coverage of every index, brief factual fields, write-tool
  delivery).

| records | baseline | glm-5.2 (08-27) | flash low | flash tuned |
|---|---|---|---|---|
| fastapi | 50 | 18 | 22 | **22** (4 rejects, 26/26 enriched, 0 failed) |
| nest | 100 | 82 | 58 | **107** (8 rejects, 115/115 enriched, 0 failed) |
| tokio | 74 | 47 | 62 | **88** (16 rejects; 3 batches lost to account rate-limit contention with the live drain — the uncontended step-2 run hit 114) |

Tuned quality metrics sit at or above glm-5.2's: nest avg docs 326 chars /
solutions 3.7 / prevention tips 3.7; tokio avg docs 313 / example fix 100%.
Tags run thinner (3.4–3.8 vs 4.7). fastapi's shortfall vs its 2026-08-14
baseline is discovery-config-driven (halved window, scope excludes, pattern
guard) and hits every current model equally.

Review at effort high (same subset): 6 good / 2 improved / 1 defective at
~33s/record — same calibration as low, one extra mild-enhancement patch;
grpc-go correctly defective at both efforts. Low stays the review pick.

**Revised verdict: with effort=high, batch 10, and the flash prompt
directive, flash is at parity or better on the bulk phases too** — it beat
glm-5.2 on all three repos and the production baseline on two. Remaining
caveats: single tuned run per repo; empty stubs still occur (~2 per 12
batches, all recovered by the split guard); account-level request rate is
shared with the drain's glm-5.2 traffic, so co-running eats into flash's 5x
headroom. Adopting it for production bulk means porting the step-3 knobs into
the blitz config and watching the first drain's funnel lines.

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

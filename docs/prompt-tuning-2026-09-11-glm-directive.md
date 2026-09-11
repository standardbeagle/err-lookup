# Prompt tuning — the glm-5.3-flash directive (2026-09-11)

Question: the incumbent trails both opencode Go candidates on every list-shaped
field (`docs/model-comparison-2026-09-10-opencode-go.md`). Those models are out
on cost, so can the gap be closed on glm with the prompt instead?

Two hypotheses, both about the directive rather than the model:

1. The `tags` spec carries no target count, and its example shows two entries —
   roughly where production lands (3.4).
2. Production's directive says *"Keep each field brief and factual; never pad."*
   It was added for completeness and truncation, but it argues against exactly
   the counts we are short on.

Four cells, differing ONLY in `prompt-directive` (`configs/tune-glm-*.kdl`):
**control** (production's directive verbatim), **counts** (adds list-coverage
guidance), **nopad** (drops the brevity clause, keeps the completeness half),
**both**. One repo (fastapi 50113da), one run per cell, sequential.

The control was re-run rather than reusing published numbers: commit 150a171
moved fastapi's in-scope candidate pool from 43 to 59, so the pre-fix figures
are not comparable.

Runs shared the z.ai gate with a live production drain (by design — the system
takes live updates during a drain). Field metrics are unaffected by contention;
wall-times are not reported for that reason.

## Results

| cell | records | **indexable** | rejects | doc chars | solutions | tags | tips |
|---|---|---|---|---|---|---|---|
| tuned flash, pre-fix | 22 | 22 | — | 303 | 3.2 | 3.4 | 3.4 |
| control | 33 | 29 | 23 | 338 | 3.36 | 4.06 | 3.36 |
| **counts** | **44** | **40** | **13** | 315 | 3.57 | **5.89** | 3.57 |
| nopad | 29 | 26 | 24 | 380 | 3.83 | 4.21 | 3.79 |
| **both** | 36 | 33 | 21 | **385** | **4.08** | 5.58 | **3.97** |

Reference points from the models we cannot afford: Qwen3.8 Flash produced doc
399 / sols 4.2 / tags 5.0 / tips 4.0; DeepSeek V4.1 Flash doc 286 / sols 4.1 /
tags 3.9 / tips 4.0. The production baseline is doc 399 / sols 3.8 / tags 4.7.

## What each lever does

**The candidate fix, not the prompt, did the largest single piece of work.**
Control against the pre-fix tuned run is 22 → 29 indexable pages (+32%) with an
identical directive. Discovery went 38 → 56 errors because the pool went 43 →
59. Every prompt result below sits on top of that.

**`counts` buys breadth.** Most records and most indexable pages, with rejects
nearly halved (23 → 13) at unchanged discovery (56 vs 57). The extra records are
outputs passing validation, not sites newly found — worth a follow-up on its
own, because fewer rejects is a reliability gain independent of field richness.

**`nopad` buys depth.** Richest per-record content of the two single-lever cells
(doc 380, solutions 3.83, tips 3.79) with no reject improvement and slightly
fewer records. So the brevity clause *was* suppressing field richness, as
hypothesized — but it was not suppressing record count.

**`both` is the quality pick and does not simply add the two.** It takes the
highest documentation (385), solutions (4.08) and tips (3.97) of any cell, and
tags close behind `counts` — i.e. **it closes the entire field-richness gap to
Qwen3.8 Flash while running on the incumbent model**, which is the practical
answer to the cost constraint. But its rejects sit at 21 against `counts`' 13,
and its record count lands between the two. Plausible mechanism, untested:
longer outputs are likelier to hit the truncation ceiling that `analysis-batch
-size 10` exists to avoid.

## The tag-hygiene cost

More tags is not automatically better. `tags` has no controlled vocabulary —
`backgroundTag` gets a families block precisely to force reuse, and the plain
field gets nothing.

| cell | tag uses | distinct | singletons | singleton rate |
|---|---|---|---|---|
| control | 134 | 49 | 26 | 53% |
| counts | 259 | 93 | 53 | 57% |
| nopad | 122 | 50 | 29 | 58% |
| both | 201 | 89 | 62 | **70%** |

`counts` roughly holds the control's reuse rate while nearly doubling the
vocabulary. `both` does not: 70% of its tags are used exactly once, the worst of
the four. Against a corpus already carrying 55,568 distinct tags, two thirds of
them used once, that is the wrong direction.

Spelling variants (`staticfiles` beside `static-files`) appear in the control
too — pre-existing, not introduced by any directive. Fixing that needs a tag
vocabulary, not a directive change.

## Recommendation

Adopt **`counts`** for production bulk, not `both`, and not yet.

`counts` delivers the larger indexable corpus (40 vs 33), the big reliability
win (rejects 23 → 13), and the tag gap closed (5.89 against a 4.7 baseline)
while holding the control's tag reuse rate. `both` wins per-record richness but
pays for it with a 70% singleton tag rate and 8 more rejects, and per-record
richness is the metric we are least short on after the candidate fix.

Blocking items before any routing change:

1. **One run per cell.** Discovery varied 53–57 on an identical corpus and pool,
   so the small deltas (solutions 3.36 → 3.57) are inside noise. The reject drop
   and the tag move are large enough to believe; nothing else is.
2. **A tag vocabulary guard should land first.** Asking for more tags without
   one trades thin tags for fragmented ones. The `backgroundTag` families block
   is the pattern to copy.
3. **fastapi only.** nest and tokio are the repos where the August evaluation
   found flash's coverage weakest; a directive that helps a 59-candidate Python
   repo may not help a 1,000-candidate TypeScript one.

## Addendum — a reachability clause for the review directive (2026-09-11)

A live record, `Automattic/harper/expected-a-dom-element`, named an
environment in which its error cannot fire. The throw is
`if (!(el instanceof Element)) throw new TypeError(...)` with no existence
check on `Element`, so in a bare Node/SSR context that line raises
`ReferenceError: Element is not defined` and the TypeError is unreachable —
yet `triggerScenarios` led with "Running outside a real DOM (SSR/node...)".
The wrong premise had propagated into `commonSituations` and the first
solution. Corrected in production via `updateErrorFields` (contentChangedAt
moved, so the sitemap lastmod follows).

Can the directive catch this class? Tested on the pre-fix record, incumbent
model and effort (glm-5.3-flash, low):

| directive | verdict | caught it? |
|---|---|---|
| stock | good | no |
| "confirm the error is reachable there" | good | **no — misapplied** |
| value-guard vs capability-guard, named explicitly | **improved** | **yes** |

The middle row is the useful failure. glm reasoned "the throw is the
function's own guard (instanceof Element check...), so it is reachable",
conflating a guard that rejects a bad VALUE with one that tests for a MISSING
capability. Naming that distinction is what worked; the vaguer instruction
actively produced the wrong answer. With it, glm reached the correct analysis
on its own: "a bare Node SSR environment without any DOM globals cannot reach
this throw (the `Element` identifier would be undefined, causing a
ReferenceError at the guard), so only jsdom-style incomplete DOM setups
genuinely trigger it."

**False-positive check matters more than the catch**, because ~180 corpus
records name a non-browser environment *correctly* — their code guards for the
missing capability and throws deliberately. Three controls, all held:

| record | verdict | why it held |
|---|---|---|
| jquery/jquery-requires-a-window-with-a-document | good | `typeof window === "undefined" \|\| !window.document` is a capability guard |
| webpack/automatic-publicpath-is-not-supported-in-this-brow | good | tests for absent document/importScripts |
| dotnet/aspnetcore/cannot-resolve-url | good | deliberate non-browser throw |

1 true positive, 0 false positives on 3 controls. Config:
`configs/review-flash-reachability.kdl`.

**Recommendation: scope it to the review directive only, not the bulk one.**
The bulk directive rides every phase of every repo, and the matrix above shows
directive text has effects well beyond its subject — the `counts` clause moved
reject rates and tag counts. Review is single-record and low-volume, so the
clause is cheap there and its blast radius is one phase.

Be clear about the size of the win: a narrow detector (unguarded browser-global
dereference plus a non-browser trigger claim) finds 4 candidates corpus-wide,
of which harper is the confirmed defect. This buys correctness on a rare class,
not volume. A broader detector matches 184 records, but a sample of 8 from that
set were all correct by design — errors whose own guard tests for the missing
thing — so the broad number is not a defect count.

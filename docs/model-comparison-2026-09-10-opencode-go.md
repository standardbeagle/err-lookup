# Model comparison — DeepSeek V4.1 Flash and Qwen3.8 Flash (opencode Go, 2026-09-10)

Question: can either opencode Go model take over generation (scope, discovery,
analysis, verify) or review from the incumbent `zai-coding-plan/glm-5.3-flash`?

Candidates, both via `opencode acp --pure`:

- `opencode-go/deepseek-v4.1-flash`
- `opencode-go/qwen3.8-flash`

Configs: `configs/compare-{deepseek-v41-flash,qwen38-flash}.kdl` (bulk),
`configs/review-{deepseek-v41-flash,qwen38-flash}.kdl` (review).

**Method note that decides how much these numbers are worth.** The incumbent's
published bulk numbers were measured *tuned* — `analysis-batch-size 10` plus the
flash prompt directive (`docs/model-comparison-2026-08-27-glm53-flash.md`, step
3). Both candidate configs carry the same batch size and the same directive, so
this measures the models rather than the tuning. Neither candidate pins
`reasoningEffort`: that is a z.ai-shaped `model-options` key and these are
opencode Go models, so a guessed value risks being silently ignored — the
incumbent's review pick is explicitly effort-pinned and the candidates are not,
which is a real and unclosed difference.

**Budget did NOT constrain this, and an earlier draft of this doc said it did.**
opencode Go is a $10/mo subscription with per-model monthly dollar caps and a
5-hour window at 20% of the monthly allowance
(<https://opencode.ai/docs/go/#usage-limits>) — DeepSeek V4.1 Flash in the
$15/mo tier (~$3 per window), Qwen3.8 Flash in the $30 tier (~$6). Reasoning
from those caps, this evaluation was scoped to one repo on the assumption that a
three-repo sweep would exhaust the window. **Measured actual spend for both
models across both the review subset and the fastapi bulk run: $0.36.** The cap
was never close to binding; a three-repo sweep costs roughly a dollar. The
one-repo scope is a limitation of this evaluation, not a constraint of the
plan — nest and tokio should simply be run.

## Review phase (9-record traffic subset, dry-run)

Same subset and method as `docs/model-comparison-2026-08-16-review-phase.md` and
the 08-27 flash comparison. All runs `review --dry-run`; the subset DBs were
byte-identical afterwards (checked), so nothing was written.

| metric | glm-5.3 (08-16) | **glm-5.3-flash** (incumbent, low) | **DeepSeek V4.1 Flash** | **Qwen3.8 Flash** |
|---|---|---|---|---|
| completed | 9/9 | 9/9 | **9/9** | 9/9 (one run died at 7; the last 2 re-ran) |
| good | 4 | **7** | 2 | 1 |
| improved | 5 | 1 | 6 | 8 |
| defective | 0 | **1** | **1** | **0** |
| fields patched | 9 | **2** | 11 | 21 |
| avg secs/record | 67 | 27 | **24** | 54 |

### The grpc-go record is the whole test

`grpc/grpc-go/grpc-the-connection-is-closing` carries user-facing content for an
entirely different error: every narrative field describes an xDS/RBAC
audit-logger TypeURL failure while the record's message and source region are
grpc-go's internal `errConnClosing` sentinel in `clientconn.go`. The 08-16
comparison settled what the right answer is: call it **defective** and refuse to
patch, because there is no repair that is not invention. The Codex three and the
incumbent all do this; glm-5.3 did not, and rewrote the record.

- **DeepSeek: defective, zero fields patched.** "The record is mismatched at its
  core and cannot be repaired without fabricating unrelated details."
- **Qwen: improved, five fields rewritten** — documentation, triggerScenarios,
  commonSituations, solutions, exampleFix. It diagnosed the mismatch correctly
  and then rewrote the page anyway.

Qwen's diagnosis is not the failure; the action is. Review patches land on live
pages, so a reviewer that rewrites a record it has just identified as
fundamentally mismatched is the one failure mode this phase cannot carry.

### Where DeepSeek actually helps

Its non-trivial findings are real and source-checked, not stylistic:

- **next.js** (`the-requested-resource-isn-t-a-valid-image`): the record framed
  the failure around the upstream `Content-Type` header; the source calls
  `detectContentType(upstreamBuffer)`, which inspects the fetched bytes'
  magic number. It also caught a fabricated "error 255" where the thrown status
  is 400. Five fields patched — its largest patch, and the record deserved it.
  Qwen independently found the same byte-vs-header defect, which is a good sign
  for both.
- **cargo**: the same wrong `cargo clean -p` claim glm-5.3 caught in August,
  replaced with `cargo metadata` / `cargo tree`.
- Two records it left alone entirely, with a stated reason ("no patch can be
  grounded as clearly better without inventing API details outside the provided
  region").

### The open risk on DeepSeek

It patches **11 fields to the incumbent's 2**. The incumbent was picked partly
*for* restraint, with a standing watch item that it under-patches subtle
single-field defects. DeepSeek sits at the other end: closer to glm-5.3's
interventionism (9 fields) but with flash's calibration on the record that
matters and 2.5x its speed. Every DeepSeek patch reviewed here was justified,
but nine records is not enough evidence to conclude that holds at corpus scale.

## Bulk phases (fastapi only)

| | baseline (08-14 prod) | glm-5.2 (08-27) | glm-5.3-flash untuned (08-27) | **DeepSeek V4.1 Flash** | **Qwen3.8 Flash** |
|---|---|---|---|---|---|
| records | 50 | 18 | 22 | 19 | **23** |
| discovery sites | — | 25 | 38 | 23 | **31** |
| rejects | — | 16 | 16 | **4** | 8 |
| failed batches | — | — | several | **0** | **0** |
| avg doc chars | 399 | — | 263 | 286 | **399** |
| avg solutions | 3.8 | — | 3.0 | 4.1 | **4.2** |
| example fix | 100% | — | 100% | 100% | 100% |
| defense | — | — | 100% | 100% | 100% |
| avg tags | 4.7 | — | 3.8 | 3.9 | **5.0** |
| avg prevention tips | — | — | — | 4.0 | 4.0 |
| verify gaps | — | — | — | **none** | **none** |
| flagged by `errlookup quality` | — | — | — | 1/19 (5.3%) | **1/23 (4.3%)** |
| provider wall time | — | — | — | **2.9 min** | 9.8 min |

### The record counts are not a shortfall — read them by area

Every current model produces under half of fastapi's 50-record August baseline,
which reads as a broad regression until you ask where those 50 records lived:

| area | baseline records |
|---|---|
| `docs_src/` (tutorial snippets) | 19 |
| `scripts/` (build tooling) | 16 |
| `fastapi/` (the library) | **15** |

**70% of the baseline was not the library.** The scope phase now excludes
`docs_src/` and `scripts/` — 156 and 52 candidate locations, dropped identically
by both candidates — and both of today's runs are 100% library code. Like for
like:

| run | library-only records |
|---|---|
| baseline (08-14) | 15 |
| glm-5.3-flash (08-27) | 22 |
| DeepSeek V4.1 Flash | 19 |
| Qwen3.8 Flash | **23** |

Every current model *beats* the baseline on real library errors, by 27–53%. The
missing 35 pages documented tutorial snippets and build scripts — thin,
near-duplicate, and exactly the shape of page that fed the 2026-08-18 crawl
withdrawal. Losing them is the intended effect of the scope excludes, not
collateral damage.

Nor is the drop universal: the 08-27 tuned runs put nest at 107 against a
100-record baseline and tokio at 88 against 74. fastapi is the only repo whose
raw count fell, and the table above is why. Compare models on the library-only
row, never on the raw baseline delta.

**Both candidates were clean in the way the August flash run was not.** The
08-27 evaluation rejected flash for bulk on reliability, not quality: ACP idle
stalls, an output-protocol miss where a batch streamed its JSON as chat text
instead of writing the output file, and empty stub answers. Neither candidate
logged any of those here. Every analysis batch completed first try — DeepSeek
3/3, Qwen 4/4, zero failed, zero split-retries, zero empty stubs.

Both also cleared verify outright:

    phase verify: verify: no gaps — provider calls skipped

Every record met the verify bar (documentation ≥200 chars, solutions present) on
the first pass, so verify made no provider calls at all. Against a corpus whose
SEO problem *is* thin records, that is the line that matters, and the quality
stream confirms it independently: one cosmetic `opaque-slug` flag each, nothing
noindexed, on either side.

**Qwen produces the richer corpus.** 23 records to DeepSeek's 19, from 31
discovery sites to 23, at 399 average doc chars — exactly the production
baseline — and 5.0 tags, the highest of any model measured on this repo,
baseline included. Tag thinness was the one quality gap the 08-27 flash
evaluation could not close (3.4–3.8 vs 4.7); Qwen closes it.

**DeepSeek is 3.4x faster** — 2.9 minutes of provider time against 9.8 — and
that gap held across every phase (discovery 58s vs 193s, analysis 99s vs 375s)
and across the review phase too (24s vs 54s per record). It is a consistent
property of the model, not a scheduling artifact.

## Verdict

**Review: DeepSeek V4.1 Flash is a credible replacement; Qwen3.8 Flash is
disqualified.** Qwen rewrote five fields of a record it had itself diagnosed as
describing an entirely different error. Review patches land on live pages, so
that is the one failure this phase cannot carry, and it is the same failure that
kept glm-5.3 out of the seat in August. DeepSeek matches the incumbent's
calibration on that record, is marginally faster (24s vs 27s), and its patches
were justified on inspection.

**Closed 2026-09-11: not adopting DeepSeek for review. No A/B was run.** The
incumbent stays in the seat. glm-5.3-flash's review calibration is adequate, the
account is already paid for, and adding a second vendor to the review path buys
a marginal verdict improvement in exchange for another provider to keep
authenticated, rate-limited and monitored. The open question below is recorded
for anyone who reopens this, not as pending work.

Recorded for that reader: DeepSeek patched 11 fields to the incumbent's 2 on the
traffic subset. That was read here as an over-patching risk, and it may instead
be the incumbent under-patching — but the evidence never got past anecdote, and
the decision does not turn on it.

**Bulk: Qwen3.8 Flash is the first candidate to beat the incumbent on quality
without a reliability penalty** — more records, more sites, baseline-parity
documentation, and the best tag coverage measured. The cost is 3.4x the wall
time, which at a $30/mo tier (~$6 per 5-hour window) is the real constraint, not
the quality. Worth a three-repo run (nest, tokio) before any routing change; one
repo is a screen, not a decision.

**DeepSeek for bulk: viable, thinner.** It is the fast, cheap, clean option —
fewest rejects of any model measured — but 19 records to Qwen's 23 from a
smaller discovery set. If throughput per credit is the binding constraint it is
the better pick; if corpus richness is, Qwen is.

Neither result argues for touching production today. The immediate value is that
both models clear the reliability bar that disqualified flash for bulk, which
means the bulk seat is genuinely contestable for the first time since August.


## Caveats

- One bulk run, one repo, per model. Total measured spend for everything here
  was $0.36, so extending to nest and tokio is cheap and should be done before
  any routing change.
- Neither candidate has a reasoning-effort pin; the incumbent review provider
  does (low). An effort sweep was not run.
- Qwen's first review run exited after 7 of 9 records with no error line. The
  two remaining records were re-run and completed, but an unexplained silent
  exit is itself a reliability data point.
- Review verdict counts come from a 9-record subset chosen for traffic, not for
  defect coverage.

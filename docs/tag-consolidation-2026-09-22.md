# Background-family consolidation, 2026-09-22

## What was wrong

`backgroundTag` was free text. The enrichment prompt asked the model to coin a
name for the cross-library family an error belongs to, and `tags.ts` folded the
spelling afterwards. Nothing bounded how many names could exist.

Measured against the production DB on 2026-09-22:

| | |
|---|---|
| records | 496,100 |
| distinct families | 56,960 |
| families used exactly once | 37,280 (65%) |
| share of records in the top 250 families | 63% |
| background articles | 184 (84 keyed to a family, 96 to an error class, 4 to a code) |

The spelling fold had stopped paying: re-running it over the whole corpus
merged 56,960 names into 56,876. What remains is semantic.
`unsupported-operation`, `operation-not-supported`, `method-not-implemented`
and `feature-not-implemented` are four names for one article, and no rule over
their characters says so.

## What replaced it

A declared taxonomy plus a typed classifier.

- `@errlookup/schema`'s `tag-taxonomy.ts` lists the 112 families a record may
  be published under, each with the one-line rubric the classifier decides on.
  The list is capped at 254 entries because the whole taxonomy is offered as
  the options of a single Choice question.
- `errors.background_tag` now holds a declared family or nothing.
  `errors.background_tag_raw` holds what the model proposed, which is the only
  link from a record back to the name that produced it.
- `tag_decisions` holds one row per distinct proposal: the family it maps to,
  or null. Decisions are per proposal, never per record — 496,100 records carry
  56,960 names, so this is the difference between half a million
  classifications and fifty thousand, and one name cannot resolve two ways in
  one corpus.
- The write path publishes a family only when the spelling fold or an existing
  decision produces one. Everything else waits for `errlookup tags classify`.
- A proposal that fits nothing is parked, not dropped. `errlookup tags
  candidates` ranks the parked proposals by how many records ride on them, and
  that list is the only way the taxonomy grows.

## The classifier

TypeSafe's Jev (`jev-1.13.0`), pinned. It returns a typed choice from the
option set the request declares plus a probability distribution over it, so the
answer cannot be a family the taxonomy does not have.

Confidence is `(N·peak − 1)/(N − 1)` over N options, which at N = 113 is within
a percentage point of the top option's probability. The gate is 0.55: below it
the proposal is parked rather than guessed at, because a wrong fold files a
record under an article that does not describe it and nothing downstream asks
again.

Cost and speed, measured: 292 calls, 1.64M input tokens, $0.07, 8 seconds at
concurrency 8. Roughly 5,600 tokens per call, of which the 112 rubrics are the
bulk; the error samples are about 4%. Extrapolated to the 50,000-odd proposals
the whole corpus carries: about $12 and 45 minutes, bounded by the 1,200
requests/minute rate limit rather than by anything local.

## The measured run

The test set is the head of the corpus: the 400 largest proposals plus every
proposal with an article, 408 in all, carrying 215,168 records (43% of the
corpus). Evidence per proposal is up to 8 real error messages, each from a
different repository, plus the article's title and summary where one exists.

- 116 proposals folded by spelling, free.
- 252 classified: 176 at 0.9 or above, 40 between 0.75 and 0.9, 36 between 0.55
  and 0.75.
- 40 parked below the gate.
- 408 families became 112. **97.6% of the head's records land in a declared
  family**; the remaining 2.4% sit under parked proposals.

### Against a human

The 26 hand-written entries in `TAG_ALIASES` are merges a person made by name.
Eight of them have records in the sample, so they are the one labelled set
available. Jev matched the human on 3, parked 1, and disagreed on 4 — and on
all four the messages say the classifier is right:

| proposal | human said | Jev said | the messages |
|---|---|---|---|
| `config-validation-failed` | `invalid-config-value` | `value-out-of-range` | "must be positive", "must be between 1 and 32" |
| `invalid-configuration-value` | `invalid-config-value` | `value-out-of-range` | "thread limits must be positive" |
| `invalid-option-value` | `invalid-enum-value` | `value-out-of-range` | "expected an integer from 1 to 5" |
| `invalid-argument-type` | `invalid-argument-value` | `type-mismatch` | "only accepts a string index name or JSON document" |

The human merged names; the classifier read errors. Two aliases
(`invalid-argument-type`, `wrong-argument-type`) were removed as a result, so
those proposals now reach a judgment instead of being routed into the
wrong-value family before anyone looks. An alias pre-empts the classifier,
which is now a cost rather than the whole mechanism.

Two rubric defects surfaced the same way and were fixed: `invalid-config-value`
claimed contradictory settings, which belong to `mutually-exclusive-options`,
and `unsupported-operation` said "not available on this type", which pulled in
every wrong-argument-type and HTTP 405 proposal. Both showed up as split
probability rather than as confident mistakes — overlapping options are what
low confidence usually means here.

## Effect on the articles

32 of the 84 family-keyed articles follow their family:

- 6 move cleanly: `missing-api-key` → `missing-credentials`,
  `tensor-shape-mismatch` → `shape-mismatch`, `unexpected-api-response-shape` →
  `unexpected-response-shape`, `mutually-exclusive-flags` and
  `conflicting-config-options` → `mutually-exclusive-options`,
  `mkdir-permission-denied` and `file-write-permission-denied` →
  `file-permission-denied`.
- 26 land on a family that already has an article. The backfill refuses to pick
  a winner and reports the pair; `missing-required-argument` alone collects
  five (`missing-required-parameter`, `missing-required-field`,
  `required-field-missing`, `missing-required-option`,
  `missing-required-flag` via `missing-cli-argument`).

Retiring the loser of each pair needs a redirect path under `/info/`, which the
site does not have — retired-slug 301s cover error pages only. Until it exists
the losers keep their cluster key, keep rendering and stay in the sitemap: the
duplicate thin pages the crawl gating exists to avoid. That is the open work
this consolidation surfaces.

`content_hash` is deliberately not recomputed when a record changes family. The
error's own explanation, solutions and source are untouched; only the article it
links to changes. Moving lastmod on thousands of pages for that, while the
host's crawl budget is still suppressed, is the churn that cost trust in the
first place.

## Running it

```
errlookup tags                    # what applying the decisions would do
errlookup tags classify           # decide the pending proposals (needs TYPESAFE_API_KEY)
errlookup tags candidates         # proposals no declared family covers, by weight
errlookup tags --apply            # rewrite the records and re-key the articles
```

`classify` is resumable: each decision is its own row, so a run that dies
continues where it stopped. `--apply` is idempotent and is the only writer of
`errors.background_tag`.

Production has not been touched. The numbers above come from a local database
holding the head of the corpus — real messages, real articles, one row per
sample — so the classification is real and the record counts behind it are the
sample's, not production's.

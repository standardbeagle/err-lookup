# Background-family consolidation, 2026-09-22

## The problem

`backgroundTag` was free text. The enrichment prompt asked the model to coin a
name for the cross-library family an error belongs to, and `tags.ts` folded the
spelling afterwards. Nothing bounded how many names could exist.

Measured against the production DB on 2026-09-22:

| | |
|---|---|
| records | 498,785 |
| records with a proposed family name | 331,237 |
| distinct names | 56,960 |
| names used exactly once | 37,280 (65%) |
| background articles | 184 (84 keyed to a family) |

The spelling fold had stopped paying: over the whole corpus it merged 56,960
names into 56,876. What remains is semantic. `unsupported-operation`,
`operation-not-supported` and `method-not-implemented` are one article under
three names.

## What replaced it

- **A declared taxonomy.** `packages/schema/src/tag-taxonomy.json` lists the
  112 families a page may be published under, each with a domain and a
  one-line rubric. It is capped at 254 entries because the classifier takes
  the whole list as the options of one question.
- **One decision per page.** `page_tag_decisions` holds Jev's top choice and
  its confidence for each record, against a hash of the taxonomy. A proposed
  name is no unit of classification: one name covers unrelated errors, and a
  third of the corpus has none.
- **Publication at plan time.** `errlookup tags` plans the backfill from the
  decisions at a confidence gate; `--gate` re-reads them at another value
  without classifying anything again. `--apply` rewrites the records and moves
  each family-keyed article to the family most of its pages land in, holding
  articles whose pages split.
- **A write path that never invents a family.** A new page is published under a
  family only by a precise content rule; everything else waits for
  `errlookup tags classify`. A re-analysed page keeps its decision.
- **A way to grow.** `errlookup tags candidates` lists pages that publish no
  family, grouped by the name their model proposed. `errlookup tags propose`
  derives candidate families from the corpus and has them checked.
  `errlookup tags audit` measures published families against a reference
  labeller on a random sample.

## Proposing families: procedure, then model

`tags propose` starts without a model. Proposed names are regular: a small set
of failure modes (`invalid`, `missing`, `not-found`, `unsupported`,
`mismatch`, ...) around an object (argument, config, file, json, http, ...).
Parsed that way, 81% of proposed records land in about 230
failure-mode × object cells (`phase/tag-shape.ts`, `phase/tag-cells.ts`);
179 cells carry at least 100 records.

glm-5.3-flash then checks each cell against a page from each of up to 12
libraries: one family, several, or partly none? One call under the `curate`
provider role, routed to glm-5.3 in production, reads the pooled list for
merges, overlapping rubrics and drops. Every answer passes deterministic
checks, and a new family must carry 100 records.

Two runs of this were measured:

- **v1 grew the list to 143 families** until the record floor cut it to 119.
  It also rewrote 108 existing rubrics at twice their length, which cost
  accuracy (below).
- **v2 keeps every reused family's rubric** and lets a model write rubrics only
  for new families and targeted boundary fixes, capped at 300 characters. It
  proposes 115 families: the current 112, plus `corrupt-file-content` (327
  records), `parse-failed` (150) and `invalid-dependency` (144), with three
  rubrics rewritten.

The two runs did not agree on which new families to add. v1 also proposed
`type-not-found` (988 records) and `invalid-query-parameter` (533). The curate
call is not deterministic, so a proposal is a list to review, not a verdict.

## What classification needs

400 random pages, drawn by a seeded hash so every arm sees the same pages,
labelled by glm-5.3 reading the whole page. The sample is random on purpose:
pages chosen because their signals agree would make the message alone look
sufficient. Scores are against pages the labeller rated clear or likely,
against the current 112-family list, at a gate of 0.55:

| Jev reads | accuracy | precision | tokens/page |
|---|---|---|---|
| message | 50.4% | 72.3% | 5,137 |
| + exception class, code, status | 51.3% | 72.7% | 5,146 |
| **+ explanation** | **70.6%** | **88.4%** | 5,226 |
| + triggered-when | 70.3% | 88.1% | 5,284 |
| + situations | 70.9% | 89.1% | 5,330 |
| + proposed name | 68.3% | 80.3% | 5,340 |
| proposed name only | 32.6% | 54.9% | 5,127 |
| two-stage: domain, then family | 57.3% | 80.9% | 1,989 |
| rule: name folded by spelling, no model | 19.6% | 60.2% | 0 |
| rule: exception class / errno / status | 3.5% | 75.0% | 0 |

- **The explanation is the section classification needs.** It takes accuracy
  from 51% to 71%, and to 95.1% on clearly labelled pages. The other sections
  add nothing measurable.
- **The proposed name hurts.** It costs eight points of precision. As a
  spelling rule it is right on 60% of the pages it places, so it is not used
  as one.
- **Two-stage classification** costs a third as much and loses 13 points, so
  classification stays flat.
- **Sections barely move the cost.** Every page's question carries every
  rubric, and the rubrics are the bill. Packing pages into one request saves
  requests against the rate limit, not tokens.

The same arms against proposal v1:

| | current (112) | proposal v1 (119) |
|---|---|---|
| accuracy, message + class + explanation | 70.6% | 66.8% |
| precision | 88.4% | 83.3% |
| accuracy on clear labels | 95.1% | 88.6% |
| tokens per page | 5,226 | 9,309 |

v1's rewritten rubrics were longer and classified worse. That is why v2 leaves
existing rubrics alone. v2 has not been measured yet.

### The gate

Jev's confidence is calibrated on this taxonomy:

| confidence | accuracy |
|---|---|
| 0.9 and above | 98.5% |
| 0.75–0.9 | 92.3% |
| 0.55–0.75 | 65.6% |
| 0.35–0.55 | 55.4% |

The gate is 0.75. Published families are then about 96% precise on about 61%
of pages; at 0.55 they would be 89% precise on 80%. A wrong family files a page
under an article that does not describe it, and nothing downstream checks it
again. A missing family only withholds a link.

### Pages that cannot be classified automatically

Of the 400 pages, 124 are placed by nothing, and in 53 of those the labeller
itself could not decide. They do not differ from placed pages in any section:
they are as likely to have a proposed name (31% against 31%), a generic
exception class (59% against 54%) or a short message (27% against 26%), and
every one has an explanation. The labeller answered "no family fits" on 15
pages, and marked every one of those unclear: it never said so with
confidence. The unplaced pages sit on the boundaries between broad families such as
`invalid-argument-value`, `resource-not-found` and `invalid-config-value`,
where the classifier's vote splits. Sharper boundary rubrics are the lever,
and the gate keeps them from publishing wrongly in the meantime.

## Cost

With the current rubrics and the explanation in the state, Jev reads about
5.2k tokens per page. The whole corpus comes to about $105 and three hours,
bounded by the token rate rather than by anything local. Content rules settle
about 5% of pages for free.

## Running it

```
errlookup tags propose [--max-cells N]   # candidate families; writes a file, adopts nothing
errlookup tags classify [--max-pages N]  # decide pending pages (needs TYPESAFE_API_KEY)
errlookup tags [--gate 0.75]             # what applying the decisions would do
errlookup tags --apply                   # rewrite records, move articles
errlookup tags candidates                # pages that publish no family, by proposed name
errlookup tags audit                     # published families against a reference labeller
```

`classify` and `propose` resume from their checkpoints. Production has not been
touched: every number above comes from a read-only copy of the corpus.

## Open

- **Duplicate articles.** 26 of the 84 family-keyed articles land on a family
  that already has one, and retiring the loser needs a redirect path under
  `/info/` that the site does not have. Until it exists the losers keep
  rendering and stay in the sitemap.
- **Proposal v2 is unmeasured.** Its three new families and three rubric
  rewrites need an ablation run before adoption.
- **Provider throttling.** On the day of this work the production z.ai proxy
  showed 17% of requests rate-limited since 2026-09-20, against 0.4% measured
  at the same gate on 2026-09-07.

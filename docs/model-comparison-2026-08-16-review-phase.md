# Model comparison — review-phase candidates (2026-08-16)

Question: which model should run the popularity-driven quality review (phase
"review")? Candidates: GPT-5.6 Terra (low effort), GPT-5.6 Luna (high effort),
GPT-5.6 Sol (low effort) via the OpenAI Codex plan in opencode, and GLM 5.3
(Z.AI plan). Reasoning efforts are pinned per-model in
`~/.config/opencode/opencode.json` — OPENCODE_CONFIG_CONTENT only injects
`{model}` and merges over the file config, so the per-model option survives the
pipeline's ACP invocation.

Method: identical 9-record set = the top pages by real 7-day traffic
(`scripts/report-top-pages.sh`), extracted from the production DB into an
isolated snapshot (`/tmp/review-subset.db` on beagle-ab; needs the
`__drizzle_migrations` rows or openDb re-runs migration 0 into existing
tables). All runs `review --dry-run` — verdicts and patch fields only, nothing
written. Configs: `configs/review-codex-{terra,luna,sol}.kdl`,
`configs/review-glm53.kdl`. Codex runs on beagle-ab (OAuth lives there),
glm-5.3 run locally.

One intended target was dropped: `rust-lang/cargo/cannot-produce-for-as-the-target`
is in the traffic top-10 but no longer in the DB (re-slugged by a rescan) — its
page traffic is hitting a stale URL; separate issue.

| metric | glm-5.3 | terra low | luna high | sol low |
|---|---|---|---|---|
| completed | 9/9 | 9/9 | **8/9** (1 output-handoff failure) | 9/9 |
| good | 4 | 0 | 0 | 0 |
| improved | 5 | 8 | 7 | 8 |
| defective | 0 | 1 | 1 | 1 |
| fields patched (total) | 9 | 38 | 32 | 40 |
| avg secs/record | 67 (two >150s outliers) | 29 | 35 | 31 |

All four agreed the grpc-go record (`grpc-the-connection-is-closing`) is wrong
at its core — the stored documentation describes an unrelated xDS audit-logger
error while the source is the `errConnClosing` sentinel. The split is what to
do about it: the Codex models called it **defective** (message/source mismatch,
refuse to patch, rescan or remove); glm-5.3 called it **improved** and rewrote
every narrative field from the source, on the grounds that the message/file
pairing itself is valid. The Codex stance is the safer default for automated
patching.

The deeper difference is calibration. All three Codex variants apply a strict
"provable from the stored source region or delete it" rule and patched
effectively every record — including ones glm-5.3 (and spot-reading) judged
accurate, e.g. the DnsServer DNSSEC and vllm records. Analysis-phase content is
legitimately derived from whole-repo context the reviewer no longer sees, so
region-only verification systematically strips correct enrichment. At 8/9
"improved", a Codex-driven review pass would rewrite nearly the whole corpus'
most-visited pages. glm-5.3 patched 5/9 with mostly single-field, targeted
fixes (an invented exit code, a wrong `cargo clean -p` claim, an ungrounded
example) and left verified records alone.

Failure note: Luna's one failure ("no JSON found in output") is the ACP
output-file handoff truncating, not a model-quality signal, but it was the only
failure in 35 calls. Luna's notes were the most nuanced of the Codex three; at
high effort it was still ~2x faster than glm-5.3's worst records.

Verdict: **glm-5.3 for the review phase** (`phase-providers { review "glm53" }`
or run with `configs/review-glm53.kdl`). Its verdict distribution is the only
calibrated one — "good" exists — and its patches target real defects instead of
re-deriving pages from the review's narrower evidence. If a second opinion is
ever wanted on defective-suspects, **sol low** is the best Codex value: same
strictness as terra with more precise notes, 31s/record, low effort.

Caveat: verdict notes were compared, not the full patched field contents. Before
promoting any model to non-dry-run reviews at scale, diff a few actual patches
(`job_history` rows persist them on real runs).

Rerun commands (targets = top-9 list in `/tmp/run-codex-reviews.sh` on beagle-ab):

    ERRLOOKUP_CONFIG=$REPO/configs/review-glm53.kdl \
    ERRLOOKUP_DB=/tmp/review-subset.db \
    npx tsx src/cli/main.ts review --dry-run <targets...>

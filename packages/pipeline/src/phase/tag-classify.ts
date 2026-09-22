import { sql } from "drizzle-orm";
import { CANONICAL_FAMILIES, CANONICAL_TAGS, normalizeTag, tagKey } from "@errlookup/schema";
import type { Db } from "../db/client.js";
import { tagDecisions } from "../db/schema.js";
import { TypeSafeClient, type ChoiceQuestion } from "../provider/typesafe.js";

/**
 * Map every proposed background-family name onto the canonical taxonomy.
 *
 * The enrichment model still coins a name — it is reading the errors and has
 * an opinion worth keeping — but the name is a proposal, not a family. This
 * is where a proposal becomes one of the declared families or nothing at all.
 *
 * Two mechanisms, in order:
 *
 *   1. The spelling fold from `tags.ts`, free and exact. A proposal whose key
 *      matches a canonical family's key IS that family, whatever the word
 *      order or abbreviation.
 *   2. A typed classification for everything else. The model is given the
 *      whole taxonomy as the option set plus a no-match option, so its answer
 *      is a family name by construction, and the probability it carries is
 *      what decides whether the answer is applied or parked.
 *
 * Decisions are per distinct proposal, never per record: 496,100 records carry
 * 56,960 distinct names, so this is the difference between half a million
 * classifications and fifty thousand, and it makes the mapping consistent by
 * construction — one name cannot resolve two ways in one corpus.
 *
 * The constants below are the reviewable surface of this file. The question
 * text, the no-match option and the confidence gate decide what the corpus
 * looks like; everything else is plumbing.
 */

/**
 * The option offered when no declared family fits. Without it the model must
 * pick a family for every proposal, and the ones that genuinely name a family
 * the taxonomy lacks — the only signal that the taxonomy should grow — would
 * be buried in a confident-looking wrong answer.
 */
export const NO_FAMILY = "none-of-these";

/**
 * Minimum confidence to store a family. Below it the proposal is parked as a
 * candidate rather than guessed at: a wrong fold is worse than no fold,
 * because it puts a record under an article that does not describe it and
 * nothing downstream ever questions it again.
 *
 * Calibrated against jev-1.13.0 on the 84 families that already have an
 * article (see docs/tag-consolidation-2026-09-22.md). Re-measure when the
 * pinned model moves.
 */
export const CONFIDENCE_THRESHOLD = 0.55;

/**
 * Error messages shown per proposal, each from a different repository.
 *
 * The name alone is often ambiguous, and a proposal can span hundreds of
 * repos, so the sample is the whole basis for the judgment. Raising it from
 * four costs about 4% more tokens — the 112 rubrics dominate every request —
 * and it is the only defence against a family being judged on an unlucky
 * handful of messages.
 */
export const SAMPLES_PER_PROPOSAL = 8;

/** Concurrent classifications. Jev allows 1,200 requests/minute. */
export const CLASSIFY_CONCURRENCY = 8;

const INSTRUCTIONS =
  "Software errors from open-source libraries are grouped below. `proposed_family_name` is the name an earlier model coined for the group — a hint, not an answer, and frequently a near-synonym of a listed family. Pick the one family whose criteria describe what actually went wrong in `example_errors`. Judge the fault itself, not the wording of the message or the library it came from. Choose " +
  NO_FAMILY +
  " only when the errors describe a distinct kind of fault that no listed family covers.";

const NO_FAMILY_CRITERIA =
  "No family above describes these errors. They share a real fault that the taxonomy has no name for yet. Do not choose this because several families fit; choose the closest one instead.";

/** How a decision was reached. */
export type DecisionMethod = "rule" | "model" | "manual";

export interface TagDecision {
  proposal: string;
  /** Canonical family, or null when nothing in the taxonomy fits. */
  canonical: string | null;
  method: DecisionMethod;
  confidence: number | null;
  runnerUp: string | null;
  model: string | null;
}

/** A distinct proposal and the evidence for deciding where it belongs. */
export interface ProposalCluster {
  proposal: string;
  errorCount: number;
  repoCount: number;
  samples: { message: string; repo: string }[];
  /** Title and summary of the background article written for this proposal, when one exists. */
  article?: { slug: string; title: string; summary: string };
}

/**
 * Canonical family per spelling key. Built from the taxonomy rather than from
 * the corpus: the old index took whichever coined name had the most records,
 * which let the biggest accident name the family.
 */
const CANONICAL_BY_KEY: Map<string, string> = new Map(
  CANONICAL_FAMILIES.map((f) => [tagKey(f.tag), f.tag])
);

/**
 * The family a proposal folds onto by spelling alone, or null when the fold
 * lands outside the taxonomy and a judgment is needed.
 */
export function ruleFold(proposal: string): string | null {
  const tag = normalizeTag(proposal);
  if (!tag) return null;
  if (CANONICAL_TAGS.has(tag)) return tag;
  const key = tagKey(tag);
  if (!key) return null;
  return CANONICAL_BY_KEY.get(key) ?? null;
}

/** The whole taxonomy as one question, plus the way out of it. */
export function familyQuestion(): ChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const f of CANONICAL_FAMILIES) criteria[f.tag] = f.criteria;
  criteria[NO_FAMILY] = NO_FAMILY_CRITERIA;
  return { type: "choice", instructions: INSTRUCTIONS, criteria };
}

/** The evidence the classifier reads. Kept small — it is billed per token. */
export function clusterState(cluster: ProposalCluster): Record<string, unknown> {
  const state: Record<string, unknown> = {
    proposed_family_name: cluster.proposal,
    example_errors: cluster.samples.map((s) => `${s.repo}: ${s.message}`),
  };
  if (cluster.article) {
    // An article was written about this group by a model that read far more of
    // it than four messages. Where one exists it is the better evidence.
    state.existing_article = { title: cluster.article.title, summary: cluster.article.summary };
  }
  return state;
}

/** Classify one proposal. Throws on a transport or API failure — never guesses. */
export async function classifyCluster(
  client: TypeSafeClient,
  cluster: ProposalCluster
): Promise<TagDecision> {
  const res = await client.evaluate(clusterState(cluster), { family: familyQuestion() });
  const answer = res.answers.family;
  if (!answer) throw new Error(`no answer for proposal "${cluster.proposal}"`);

  // Only a contender counts as a runner-up. Every option carries a
  // probability, so the second entry of a distribution that put everything on
  // one family is an arbitrary zero — recording it would make a certain
  // answer look like a close call in every report that reads this column.
  const ranked = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
  const runnerUp = (ranked[1]?.[1] ?? 0) > 0 ? ranked[1]![0] : null;
  const accepted =
    answer.choice !== NO_FAMILY &&
    answer.confidence >= CONFIDENCE_THRESHOLD &&
    CANONICAL_TAGS.has(answer.choice);

  return {
    proposal: cluster.proposal,
    canonical: accepted ? answer.choice : null,
    method: "model",
    confidence: answer.confidence,
    runnerUp,
    model: res.model,
  };
}

interface ProposalRow {
  proposal: string;
  n: number;
  r: number;
}

/**
 * Proposals the corpus carries that have no decision yet, largest first.
 *
 * Reads `background_tag_raw`, which holds what the model proposed. Records
 * written before the column existed were seeded from `background_tag` by
 * migration 0012, so the whole corpus is visible here.
 */
export function pendingProposals(
  db: Db,
  opts: { minErrors?: number; limit?: number } = {}
): ProposalCluster[] {
  const minErrors = opts.minErrors ?? 1;
  const limit = opts.limit ?? 1_000_000;
  const rows = db.all<ProposalRow>(sql`
    SELECT e.background_tag_raw AS proposal,
           count(*) AS n,
           count(DISTINCT e.repo) AS r
    FROM errors e
    LEFT JOIN tag_decisions d ON d.proposal = e.background_tag_raw
    WHERE e.background_tag_raw IS NOT NULL
      AND e.background_tag_raw != ''
      AND d.proposal IS NULL
    GROUP BY e.background_tag_raw
    HAVING n >= ${minErrors}
    ORDER BY n DESC, proposal ASC
    LIMIT ${limit}
  `);
  return rows.map((row) => withEvidence(db, row));
}

/** One proposal by name, with its evidence, whether or not it has a decision. */
export function proposalCluster(db: Db, proposal: string): ProposalCluster | null {
  const row = db.all<ProposalRow>(sql`
    SELECT background_tag_raw AS proposal, count(*) AS n, count(DISTINCT repo) AS r
    FROM errors WHERE background_tag_raw = ${proposal}
  `)[0];
  if (!row || row.n === 0) return null;
  return withEvidence(db, row);
}

function withEvidence(db: Db, row: ProposalRow): ProposalCluster {
  // One repo per sample where possible: four messages from one library
  // describe that library, not the family.
  const samples = db.all<{ message: string; repo: string }>(sql`
    SELECT error_message AS message, repo FROM errors
    WHERE background_tag_raw = ${row.proposal}
    GROUP BY repo
    ORDER BY length(error_message) DESC
    LIMIT ${SAMPLES_PER_PROPOSAL}
  `);
  const article = db.all<{ slug: string; title: string; summary: string }>(sql`
    SELECT slug, title, summary FROM info_pages WHERE cluster_key = ${`tag:${row.proposal}`}
  `)[0];
  return {
    proposal: row.proposal,
    errorCount: row.n,
    repoCount: row.r,
    samples: samples.map((s) => ({ message: s.message.slice(0, 300), repo: s.repo })),
    ...(article
      ? { article: { slug: article.slug, title: article.title, summary: article.summary.slice(0, 800) } }
      : {}),
  };
}

export function storeDecision(db: Db, decision: TagDecision): void {
  db.insert(tagDecisions)
    .values({
      proposal: decision.proposal,
      canonical: decision.canonical,
      method: decision.method,
      confidence: decision.confidence,
      runnerUp: decision.runnerUp,
      model: decision.model,
      decidedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: tagDecisions.proposal,
      set: {
        canonical: decision.canonical,
        method: decision.method,
        confidence: decision.confidence,
        runnerUp: decision.runnerUp,
        model: decision.model,
        decidedAt: new Date().toISOString(),
      },
    })
    .run();
}

export interface ClassifyProgress {
  decided: number;
  pending: number;
  proposal: string;
  canonical: string | null;
}

export interface ClassifyResult {
  byRule: number;
  byModel: number;
  unmatched: number;
  recordsDecided: number;
  calls: number;
  inputTokens: number;
}

/**
 * Decide every pending proposal, rule first and model for the rest.
 *
 * A classification failure stops the run rather than being swallowed: the
 * decisions already written are durable (each is its own row), so a stopped
 * run resumes where it died on the next invocation, and a run that quietly
 * skipped its failures would look complete while leaving records untagged.
 */
export async function classifyPending(
  db: Db,
  client: TypeSafeClient,
  opts: { minErrors?: number; limit?: number; onProgress?: (p: ClassifyProgress) => void } = {}
): Promise<ClassifyResult> {
  const clusters = pendingProposals(db, opts);
  const result: ClassifyResult = {
    byRule: 0,
    byModel: 0,
    unmatched: 0,
    recordsDecided: 0,
    calls: 0,
    inputTokens: 0,
  };

  const needModel: ProposalCluster[] = [];
  for (const cluster of clusters) {
    const folded = ruleFold(cluster.proposal);
    if (folded) {
      storeDecision(db, {
        proposal: cluster.proposal,
        canonical: folded,
        method: "rule",
        confidence: null,
        runnerUp: null,
        model: null,
      });
      result.byRule++;
      result.recordsDecided += cluster.errorCount;
      continue;
    }
    needModel.push(cluster);
  }

  let next = 0;
  let decided = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const cluster = needModel[i];
      if (!cluster) return;
      const decision = await classifyCluster(client, cluster);
      storeDecision(db, decision);
      decided++;
      if (decision.canonical) {
        result.byModel++;
        result.recordsDecided += cluster.errorCount;
      } else {
        result.unmatched++;
      }
      opts.onProgress?.({
        decided,
        pending: needModel.length,
        proposal: cluster.proposal,
        canonical: decision.canonical,
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CLASSIFY_CONCURRENCY, needModel.length) }, worker)
  );

  result.calls = client.calls;
  result.inputTokens = client.inputTokens;
  return result;
}

export interface CandidateProposal {
  proposal: string;
  errorCount: number;
  repoCount: number;
  confidence: number | null;
  runnerUp: string | null;
}

/**
 * Proposals the classifier could not place, by weight. This is the taxonomy's
 * growth queue: a name that keeps arriving with thousands of records behind it
 * is the evidence for adding a family, and the confidence and runner-up columns
 * say whether it was a genuine miss or a gate set too high.
 */
export function candidateProposals(db: Db, limit = 40): CandidateProposal[] {
  return db.all<CandidateProposal>(sql`
    SELECT d.proposal AS proposal,
           count(e.id) AS errorCount,
           count(DISTINCT e.repo) AS repoCount,
           d.confidence AS confidence,
           d.runner_up AS runnerUp
    FROM tag_decisions d
    JOIN errors e ON e.background_tag_raw = d.proposal
    WHERE d.canonical IS NULL
    GROUP BY d.proposal
    ORDER BY errorCount DESC, d.proposal ASC
    LIMIT ${limit}
  `);
}

/** Every decision, for reporting and for the write path's resolution map. */
export function decisionMap(db: Db): Map<string, string | null> {
  const rows = db.all<{ proposal: string; canonical: string | null }>(sql`
    SELECT proposal, canonical FROM tag_decisions
  `);
  return new Map(rows.map((r) => [r.proposal, r.canonical]));
}

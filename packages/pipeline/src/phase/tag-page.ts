import { sql } from "drizzle-orm";
import { CANONICAL_FAMILIES, type CanonicalFamily } from "@errlookup/schema";
import type { Db } from "../db/client.js";
import type { TypeSafeClient, ChoiceQuestion } from "../provider/typesafe.js";

/**
 * Classify a page — one error record — against a family taxonomy.
 *
 * A page is classified on its own content, not on the name its enrichment
 * model proposed. One proposal can cover unrelated errors (the 649 records
 * named "upstream-api-error" range from a Signal Flow program failure to a
 * scraper finding no network id), and a third of the corpus carries no
 * proposal at all, so per-proposal decisions both misfile and miss pages.
 *
 * What the classifier reads is chosen by `StateField`s, so the same code
 * serves the production pass and the ablation that decides which sections of
 * a page are needed at all.
 */

/** The parts of a page a classification can be shown. */
export type StateField =
  /** The error message itself. */
  | "message"
  /** Exception class, error code, HTTP status. */
  | "signals"
  /** The page's explanation of the error. */
  | "documentation"
  /** The conditions that trigger it. */
  | "triggers"
  /** Real-world situations developers hit it in. */
  | "situations"
  /** The family name the enrichment model proposed. */
  | "proposal";

export const ALL_STATE_FIELDS: readonly StateField[] = [
  "message",
  "signals",
  "documentation",
  "triggers",
  "situations",
  "proposal",
];

/** A page as the classifier needs it. */
export interface Page {
  id: string;
  repo: string;
  errorMessage: string;
  errorClass: string | null;
  errorCode: string | null;
  httpStatus: number | null;
  errorType: string;
  documentation: string | null;
  triggerScenarios: string | null;
  commonSituations: string | null;
  proposal: string | null;
}

/** Longest text a section contributes. Enough for its point; keeps the bill flat. */
const SECTION_CHARS = 600;

const trim = (s: string | null): string | undefined => (s ? s.slice(0, SECTION_CHARS) : undefined);

/**
 * The state for one page, holding only the requested sections. Absent
 * sections are left out rather than sent empty, so the model is never told a
 * page has no documentation when it was simply not shown any.
 */
export function pageState(page: Page, fields: readonly StateField[]): Record<string, unknown> {
  const want = new Set(fields);
  const state: Record<string, unknown> = {};
  if (want.has("message")) state.error_message = page.errorMessage.slice(0, SECTION_CHARS);
  if (want.has("signals")) {
    if (page.errorClass) state.exception_class = page.errorClass;
    if (page.errorCode) state.error_code = page.errorCode;
    if (page.httpStatus != null) state.http_status = page.httpStatus;
  }
  if (want.has("documentation") && page.documentation) state.explanation = trim(page.documentation);
  if (want.has("triggers") && page.triggerScenarios) state.triggered_when = trim(page.triggerScenarios);
  if (want.has("situations") && page.commonSituations) state.common_situations = trim(page.commonSituations);
  if (want.has("proposal") && page.proposal) state.proposed_family_name = page.proposal;
  return state;
}

/** The option a page takes when no family in the taxonomy describes it. */
export const NO_FAMILY = "none-of-these";

const NO_FAMILY_CRITERIA =
  "No family above describes this error. Do not choose this because several families fit; choose the closest one instead.";

/** Pick-one-family question over a taxonomy, pointed at a place in the state. */
export function pageQuestion(families: readonly CanonicalFamily[], statePath: string): ChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const f of families) criteria[f.tag] = f.criteria;
  criteria[NO_FAMILY] = NO_FAMILY_CRITERIA;
  return {
    type: "choice",
    instructions: `Which family does the software error in \`${statePath}\` belong to? Judge what actually went wrong, not the wording or the library it came from.`,
    criteria,
  };
}

/** Pick-one-domain question: the first, cheap half of a two-stage classification. */
export function domainQuestion(families: readonly CanonicalFamily[], statePath: string): ChoiceQuestion {
  const byDomain = new Map<string, string[]>();
  for (const f of families) byDomain.set(f.domain, [...(byDomain.get(f.domain) ?? []), f.tag]);
  const criteria: Record<string, string> = {};
  for (const [domain, tags] of byDomain) criteria[domain] = `Errors such as: ${tags.join(", ")}.`;
  criteria[NO_FAMILY] = NO_FAMILY_CRITERIA;
  return {
    type: "choice",
    instructions: `Which area does the software error in \`${statePath}\` belong to?`,
    criteria,
  };
}

/** One page's classification. */
export interface PageDecision {
  id: string;
  /** The top choice, whatever its confidence; null when it was "none of these". */
  choice: string | null;
  confidence: number;
  runnerUp: string | null;
  model: string;
}

function decode(id: string, answer: { choice: string; confidence: number; probabilities: Record<string, number> }, model: string): PageDecision {
  const ranked = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
  // Only a contender is a runner-up; the second entry of a certain answer is
  // an arbitrary zero.
  const runnerUp = (ranked[1]?.[1] ?? 0) > 0 ? ranked[1]![0] : null;
  return {
    id,
    choice: answer.choice === NO_FAMILY ? null : answer.choice,
    confidence: answer.confidence,
    runnerUp,
    model,
  };
}

/**
 * Pages per request. Packing is billed linearly — every question carries the
 * whole rubric set, measured at ~5.3k tokens per page packed or not — so it
 * saves requests against the 1,200/minute limit, not money. Eight keeps a
 * request well inside the 64k budget.
 */
export const PAGES_PER_REQUEST = 8;

/** Classify pages in one request against the whole taxonomy. */
export async function classifyPagesFlat(
  client: TypeSafeClient,
  pages: readonly Page[],
  fields: readonly StateField[],
  families: readonly CanonicalFamily[] = CANONICAL_FAMILIES
): Promise<PageDecision[]> {
  const state = { pages: pages.map((p) => pageState(p, fields)) };
  const questions = Object.fromEntries(pages.map((_, i) => [`p${i}`, pageQuestion(families, `pages[${i}]`)]));
  const res = await client.evaluate(state, questions);
  return pages.map((p, i) => {
    const a = res.answers[`p${i}`];
    if (!a) throw new Error(`no answer for page ${p.id}`);
    return decode(p.id, a, res.model);
  });
}

/**
 * Classify pages in two steps: domain, then family within the domain. The
 * second request only carries the rubrics of the domain each page landed in,
 * which is what makes it cheaper. A wrong domain makes a wrong family, and
 * the ablation measures what that costs.
 */
export async function classifyPagesTwoStage(
  client: TypeSafeClient,
  pages: readonly Page[],
  fields: readonly StateField[],
  families: readonly CanonicalFamily[] = CANONICAL_FAMILIES
): Promise<PageDecision[]> {
  const states = pages.map((p) => pageState(p, fields));
  const first = await client.evaluate(
    { pages: states },
    Object.fromEntries(pages.map((_, i) => [`p${i}`, domainQuestion(families, `pages[${i}]`)]))
  );
  const out: PageDecision[] = [];
  for (const [i, p] of pages.entries()) {
    const d = first.answers[`p${i}`];
    if (!d) throw new Error(`no domain answer for page ${p.id}`);
    if (d.choice === NO_FAMILY) {
      out.push({ id: p.id, choice: null, confidence: d.confidence, runnerUp: null, model: first.model });
      continue;
    }
    const inDomain = families.filter((f) => f.domain === d.choice);
    const second = await client.evaluate({ page: states[i] }, { family: pageQuestion(inDomain, "page") });
    const f = second.answers.family;
    if (!f) throw new Error(`no family answer for page ${p.id}`);
    const decision = decode(p.id, f, second.model);
    // A two-stage answer is only as sure as its less sure step.
    decision.confidence = Math.min(decision.confidence, d.confidence);
    out.push(decision);
  }
  return out;
}

interface PageRow {
  id: string;
  repo: string;
  error_message: string;
  error_class: string | null;
  error_code: string | null;
  http_status: number | null;
  error_type: string;
  documentation: string | null;
  trigger_scenarios: string | null;
  common_situations: string | null;
  background_tag_raw: string | null;
}

export function rowToPage(r: PageRow): Page {
  return {
    id: r.id,
    repo: r.repo,
    errorMessage: r.error_message,
    errorClass: r.error_class,
    errorCode: r.error_code,
    httpStatus: r.http_status,
    errorType: r.error_type,
    documentation: r.documentation,
    triggerScenarios: r.trigger_scenarios,
    commonSituations: r.common_situations,
    proposal: r.background_tag_raw,
  };
}

/** FNV-1a over the seed and the id: a stable, well-spread order key. */
function sampleKey(seed: number, id: string): number {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A reproducible random sample of pages: the same seed draws the same pages
 * from the same corpus, so an ablation can be rerun against a changed
 * taxonomy on identical evidence. Ordering by a hash of the id rather than
 * SQLite's random() is what makes the draw repeatable.
 */
export function samplePages(db: Db, n: number, seed: number): Page[] {
  const ids = db.all<{ id: string }>(sql`SELECT id FROM errors`).map((r) => r.id);
  const chosen = ids
    .map((id) => ({ id, k: sampleKey(seed, id) }))
    .sort((a, b) => a.k - b.k || a.id.localeCompare(b.id))
    .slice(0, n)
    .map((x) => x.id);
  const rows = db.all<PageRow>(sql`
    SELECT id, repo, error_message, error_class, error_code, http_status, error_type,
           documentation, trigger_scenarios, common_situations, background_tag_raw
    FROM errors WHERE id IN (${sql.join(chosen.map((id) => sql`${id}`), sql`, `)})
  `);
  const order = new Map(chosen.map((id, i) => [id, i]));
  return rows.map(rowToPage).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

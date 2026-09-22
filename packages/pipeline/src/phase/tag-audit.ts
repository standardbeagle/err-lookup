import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalFamily } from "@errlookup/schema";
import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider } from "../provider/types.js";
import { runProvider, watchdogBudgetMs } from "../provider/run.js";
import { withTimeout } from "../util/watchdog.js";
import type { Page } from "./tag-page.js";

/**
 * Reference labels: a reasoning model reads whole pages and says which
 * family each belongs to, and how sure it is.
 *
 * They are the yardstick the typed classifier is measured against, so they
 * are taken on a random sample of pages, never on pages picked because their
 * signals agree — a set chosen for informative messages would make the
 * message alone look like enough. And they are taken with every section of
 * the page in view, because the question the ablation asks is how much of
 * that the cheaper classifier can do without.
 *
 * "unclear" is an answer, not a failure. A page a reasoning model with the
 * whole text cannot place is the clearest evidence there is that no
 * classifier will place it either, and those pages are reported, not guessed.
 */

export type Certainty = "clear" | "likely" | "unclear";

export interface Label {
  id: string;
  /** Family, or null when the model says none fits. */
  family: string | null;
  certainty: Certainty;
}

/** A validated labelling answer for one batch. */
interface LabelAnswer {
  labels: { page: number; family: string | null; certainty: Certainty }[];
}

/** Pages judged per call: enough to amortize the taxonomy, few enough to read closely. */
export const PAGES_PER_LABEL_CALL = 10;

export function labelPrompt(families: readonly CanonicalFamily[], pages: readonly Page[], issues: readonly string[] = []): string {
  const taxonomy = families.map((f) => `- ${f.tag}: ${f.criteria}`).join("\n");
  const body = pages
    .map(
      (p, i) =>
        `[${i}] ${p.repo}\n  message: ${p.errorMessage.slice(0, 400)}` +
        (p.errorClass ? `\n  class: ${p.errorClass}` : "") +
        (p.errorCode ? `\n  code: ${p.errorCode}` : "") +
        (p.httpStatus != null ? `\n  http status: ${p.httpStatus}` : "") +
        (p.documentation ? `\n  explanation: ${p.documentation.slice(0, 600)}` : "") +
        (p.triggerScenarios ? `\n  triggered when: ${p.triggerScenarios.slice(0, 400)}` : "") +
        (p.commonSituations ? `\n  situations: ${p.commonSituations.slice(0, 300)}` : "")
    )
    .join("\n");
  const fixups = issues.length
    ? `\n\nA previous answer was REJECTED. Fix exactly these problems:\n${issues.map((i) => `- ${i}`).join("\n")}\n`
    : "";
  return `You are labelling error pages from ErrLookup, a knowledge base of errors thrown by open-source
libraries, against a fixed list of error families. Your labels are the reference a cheaper
classifier will be graded on, so be careful rather than quick, and say when you are unsure.

FAMILIES (tag: what belongs):
${taxonomy}

${pages.length} PAGES:
${body}${fixups}

For every page, pick the ONE family whose description fits what actually went wrong — judge
the fault, not the wording or the library. Use null only when no family fits at all.
Rate your certainty:
- "clear": one family plainly fits and no other is close.
- "likely": one family fits best, but another is a reasonable reading.
- "unclear": the page does not say enough to tell, or it fits several equally.

Write JSON: {"labels": [{"page": 0, "family": "tag-or-null", "certainty": "clear"}]}
with exactly one entry per page, pages 0 to ${pages.length - 1}.`;
}

export function validateLabels(answer: unknown, count: number, tags: ReadonlySet<string>): string[] {
  if (!answer || typeof answer !== "object" || !Array.isArray((answer as { labels?: unknown }).labels)) {
    return ['answer must be {"labels": [...]}'];
  }
  const issues: string[] = [];
  const seen = new Set<number>();
  for (const l of (answer as { labels: { page?: unknown; family?: unknown; certainty?: unknown }[] }).labels) {
    if (typeof l.page !== "number" || l.page < 0 || l.page >= count) {
      issues.push(`page ${String(l.page)} is not one of 0-${count - 1}`);
      continue;
    }
    if (seen.has(l.page)) issues.push(`page ${l.page} is labelled twice`);
    seen.add(l.page);
    if (l.family !== null && (typeof l.family !== "string" || !tags.has(l.family))) {
      issues.push(`page ${l.page}: "${String(l.family)}" is not a family in the list`);
    }
    if (l.certainty !== "clear" && l.certainty !== "likely" && l.certainty !== "unclear") {
      issues.push(`page ${l.page}: certainty must be clear, likely or unclear`);
    }
  }
  for (let i = 0; i < count; i++) if (!seen.has(i)) issues.push(`page ${i} has no label`);
  return issues;
}

/** Label pages, checkpointing each batch so a stopped run resumes. */
export async function labelPages(
  providers: Record<string, LlmProvider>,
  cfg: ErrlookupConfig,
  pages: readonly Page[],
  families: readonly CanonicalFamily[],
  opts: { checkpointFile: string; onLog?: (m: string) => void }
): Promise<Map<string, Label>> {
  const labels = new Map<string, Label>(
    existsSync(opts.checkpointFile)
      ? (JSON.parse(readFileSync(opts.checkpointFile, "utf8")) as Label[]).map((l) => [l.id, l])
      : []
  );
  const tags = new Set(families.map((f) => f.tag));
  const todo = pages.filter((p) => !labels.has(p.id));
  const cwd = mkdtempSync(join(tmpdir(), "errlookup-label-"));
  try {
    for (let start = 0; start < todo.length; start += PAGES_PER_LABEL_CALL) {
      const batch = todo.slice(start, start + PAGES_PER_LABEL_CALL);
      let issues: string[] = [];
      let answer: LabelAnswer | null = null;
      for (let round = 0; round < 2 && !answer; round++) {
        const res = await withTimeout(
          runProvider(labelPrompt(families, batch, issues), { cwd }, providers, cfg, "curate"),
          watchdogBudgetMs(cfg, "curate")
        );
        issues = validateLabels(res.parsed, batch.length, tags);
        if (issues.length === 0) answer = res.parsed as LabelAnswer;
        else opts.onLog?.(`label: batch at ${start} round ${round + 1} rejected — ${issues.slice(0, 3).join("; ")}`);
      }
      // A batch that cannot be labelled stops the run: a reference set with
      // holes in it grades the classifier on whatever was easy to label.
      if (!answer) throw new Error(`labels for pages ${start}-${start + batch.length - 1} still invalid: ${issues.slice(0, 3).join("; ")}`);
      for (const l of answer.labels) {
        const p = batch[l.page]!;
        labels.set(p.id, { id: p.id, family: l.family, certainty: l.certainty });
      }
      const tmp = `${opts.checkpointFile}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify([...labels.values()]));
      renameSync(tmp, opts.checkpointFile);
      opts.onLog?.(`label: ${labels.size}/${pages.length}`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  return labels;
}

export interface AuditDisagreement {
  id: string;
  repo: string;
  message: string;
  published: string | null;
  labelled: string | null;
  certainty: Certainty;
}

export interface AuditReport {
  pages: number;
  /** Pages the labeller could place with confidence (clear or likely). */
  judged: number;
  agree: number;
  /** Agreement over judged pages: the published families' measured accuracy. */
  agreement: number;
  /** Pages the labeller itself called unclear — not scored either way. */
  unclear: number;
  /** Judged pages with no decision at the current taxonomy yet. */
  undecided: number;
  disagreements: AuditDisagreement[];
}

/**
 * Check published families against the reference labeller on a random
 * sample. This is the standing version of the ablation: run after a classify
 * pass or a taxonomy change, it says how often a page's family is the one a
 * careful reader would give it, and lists the pages where they differ.
 */
export function compareToLabels(
  pages: readonly Page[],
  labels: Map<string, Label>,
  published: Map<string, string | null>
): AuditReport {
  let judged = 0;
  let agree = 0;
  let unclear = 0;
  let undecided = 0;
  const disagreements: AuditDisagreement[] = [];
  for (const p of pages) {
    const l = labels.get(p.id);
    if (!l || l.certainty === "unclear") {
      unclear++;
      continue;
    }
    if (!published.has(p.id)) {
      undecided++;
      continue;
    }
    judged++;
    const fam = published.get(p.id) ?? null;
    if (fam === l.family) agree++;
    else disagreements.push({ id: p.id, repo: p.repo, message: p.errorMessage.slice(0, 160), published: fam, labelled: l.family, certainty: l.certainty });
  }
  return { pages: pages.length, judged, agree, agreement: agree / Math.max(judged, 1), unclear, undecided, disagreements };
}

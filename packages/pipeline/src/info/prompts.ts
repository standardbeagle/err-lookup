import type { GuideDef } from "@errlookup/schema";
import type { ClusterCandidate } from "./collector.js";

/** One error record compacted for the info-page prompt. */
export interface ClusterSample {
  id: string;
  repo: string;
  message: string;
  code: string | null;
  errorClass: string | null;
  documentation: string;
  triggerScenarios: string;
  solutions: string[];
  preventionTips: string[];
}

/** Counted facts about a family, so the article states them instead of guessing. */
export interface ClusterEvidence {
  repos: { repo: string; errorCount: number }[];
  codes: { value: string; errorCount: number }[];
  classes: { value: string; errorCount: number }[];
  handlingStrategies: { value: string; errorCount: number }[];
  severities: { value: string; errorCount: number }[];
  /** Records in the family that carry no solutions — the corpus's own blind spot. */
  undocumentedCount: number;
}

function counts(rows: { value: string; errorCount: number }[]): string {
  return rows.length ? rows.map((r) => `${r.value} (${r.errorCount})`).join(", ") : "none recorded";
}

function evidenceBlock(evidence: ClusterEvidence): string {
  return `COUNTED FACTS about the family (from the whole corpus, not just the sample below).
Use these for any claim about spread, naming or handling; do not estimate them yourself.
- libraries raising it: ${evidence.repos.map((r) => `${r.repo} (${r.errorCount})`).join(", ")}
- error codes used: ${counts(evidence.codes)}
- error classes used: ${counts(evidence.classes)}
- handling strategies recorded: ${counts(evidence.handlingStrategies)}
- severities recorded: ${counts(evidence.severities)}
- records with no solutions recorded yet: ${evidence.undocumentedCount}`;
}

/** What the model returns; draftToEntry() normalizes and validates it. */
export interface InfoPageDraft {
  title?: string;
  summary?: string;
  background?: string;
  commonCauses?: { cause?: string; detail?: string }[];
  fixes?: string[];
  guideSlugs?: string[];
}

export function infoPagePrompt(
  cluster: ClusterCandidate,
  samples: ClusterSample[],
  guides: GuideDef[],
  evidence: ClusterEvidence,
  /** Issues from a failed validation or review round, to fix in this attempt. */
  issues: readonly string[] = []
): string {
  const family =
    cluster.kind === "code"
      ? `error code "${cluster.value}"`
      : cluster.kind === "class"
        ? `error class "${cluster.value}"`
        : `error family "${cluster.value}"`;
  const records = samples
    .map(
      (s, i) =>
        `[${i}] ${s.repo}: "${s.message}"` +
        (s.code ? `\n  code: ${s.code}` : "") +
        (s.errorClass ? `\n  class: ${s.errorClass}` : "") +
        (s.documentation ? `\n  documentation: ${s.documentation}` : "") +
        (s.triggerScenarios ? `\n  triggers: ${s.triggerScenarios}` : "") +
        (s.solutions.length ? `\n  solutions: ${s.solutions.join(" | ")}` : "") +
        (s.preventionTips.length ? `\n  prevention: ${s.preventionTips.join(" | ")}` : "")
    )
    .join("\n");
  const guideList = guides.map((g) => `- ${g.slug}: ${g.description}`).join("\n");

  const fixups = issues.length
    ? `\n\nA previous attempt was REJECTED. Fix exactly these problems and change nothing else:\n${issues.map((i) => `- ${i}`).join("\n")}\n`
    : "";

  return `You are writing a background article for ErrLookup, a knowledge base of open-source
library errors. The article covers one error FAMILY across many libraries — the depth a
single error page cannot give.

FAMILY: ${family} — ${cluster.errorCount} documented records across ${cluster.repoCount} repositories.

${evidenceBlock(evidence)}

The ${samples.length} best-documented records of the family, spread across its libraries:
${records}${fixups}

Available deep-dive guides (link only those genuinely relevant):
${guideList}

Write JSON with exactly these fields:
- title: article headline naming the family in the words a developer would type into a
  search engine — lead with the error's own vocabulary (code, message phrase), then the
  plain-words meaning. No clickbait.
- summary: one paragraph — what this error family is and when a developer meets it. Open
  with the searched-for phrase; this paragraph is the meta description search engines show.
- background: 2-4 paragraphs of mechanism — what layer produces it, why it exists,
  what it looks like from the caller's side, how the family varies across libraries.
  Draw on the records; do not invent libraries or behaviors not in evidence.
  Separate paragraphs with a blank line. Plain text, no markdown headings.
- commonCauses: 3-8 items, each {"cause": short name, "detail": 1-3 sentences},
  ordered most common first, distilled from the records' documentation and triggers.
- fixes: 2-6 remediation themes that hold across the family (record-specific fixes
  stay on the record pages).
- guideSlugs: slugs from the list above that a reader should go deeper with ([] if none).

Ground every claim in the records and the counted facts. Where the records disagree, say
the behavior is library-specific instead of picking a side. Name only libraries that
appear above. Write no URLs — the site renders its own links.`;
}

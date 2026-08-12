import type { GuideDef } from "@errlookup/schema";
import type { ClusterCandidate } from "./collector.js";

/** One error record compacted for the info-page prompt. */
export interface ClusterSample {
  id: string;
  repo: string;
  message: string;
  documentation: string;
  triggerScenarios: string;
  solutions: string[];
  preventionTips: string[];
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
  guides: GuideDef[]
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
        (s.documentation ? `\n  documentation: ${s.documentation}` : "") +
        (s.triggerScenarios ? `\n  triggers: ${s.triggerScenarios}` : "") +
        (s.solutions.length ? `\n  solutions: ${s.solutions.join(" | ")}` : "") +
        (s.preventionTips.length ? `\n  prevention: ${s.preventionTips.join(" | ")}` : "")
    )
    .join("\n");
  const guideList = guides.map((g) => `- ${g.slug}: ${g.description}`).join("\n");

  return `You are writing a background article for ErrLookup, a knowledge base of open-source
library errors. The article covers one error FAMILY across many libraries — the depth a
single error page cannot give.

FAMILY: ${family} — ${cluster.errorCount} documented records across ${cluster.repoCount} repositories.

The ${samples.length} best-documented records of the family:
${records}

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

Ground every claim in the records. Where the records disagree, say the behavior is
library-specific instead of picking a side.`;
}

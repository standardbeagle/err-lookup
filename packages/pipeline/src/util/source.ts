import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Extract a throwing source-code region around a line, capped at ≤40 lines (§3.1).
 * Returns the code text plus 1-indexed start/end line numbers, or null if the
 * file can't be read. Window defaults to ±18 lines (total ≤37).
 */
export function extractSourceRegion(
  repoPath: string,
  filePath: string,
  lineNumber: number | null,
  contextLines = 18
): { sourceCode: string; start: number; end: number } | null {
  if (lineNumber == null) return null;
  const abs = resolve(repoPath, filePath);
  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const lines = content.split("\n");
  const maxEnd = lines.length;
  let start = Math.max(1, lineNumber - contextLines);
  let end = Math.min(maxEnd, lineNumber + contextLines);
  // Hard cap at 40 lines total (§3.1).
  if (end - start + 1 > 40) {
    end = start + 39;
    if (end > maxEnd) {
      end = maxEnd;
      start = Math.max(1, end - 39);
    }
  }
  const slice = lines.slice(start - 1, end).join("\n");
  return { sourceCode: slice, start, end };
}

/**
 * Build a GitHub permalink pinned to the analyzed SHA (§3.1 — never branch-relative).
 * Uses a line range when start/end differ, else a single line anchor.
 */
export function githubPermalink(
  repo: string,
  sha: string,
  filePath: string,
  start: number | null,
  end: number | null
): string {
  const base = `https://github.com/${repo}/blob/${sha}/${filePath}`;
  if (start != null && end != null && end !== start) return `${base}#L${start}-L${end}`;
  if (start != null) return `${base}#L${start}`;
  return base;
}

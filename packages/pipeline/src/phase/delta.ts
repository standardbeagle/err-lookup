/**
 * Incremental rescan — what a HEAD move actually changed.
 *
 * A published repo whose HEAD moved used to be re-analyzed from scratch: every
 * candidate re-classified, every error re-enriched, 1-3h of provider time to
 * learn that a README edit changed nothing. This module turns the git diff
 * between the published SHA and HEAD into a plan:
 *
 *   - files untouched by the diff: their published records carry over verbatim;
 *   - files deleted: their records are dropped;
 *   - files added/modified: only the changed hunks (± a pad) are reviewed —
 *     candidates inside them go to discovery, published records inside them
 *     are re-derived from that review (same identity → enrichment reused,
 *     new identity → full enrichment), published records outside them are
 *     kept with their line re-anchored past the hunks.
 *
 * Everything here is pure and deterministic so the plan is testable without
 * a clone or a provider.
 */
import type { ErrorRow } from "../db/schema.js";

export interface Hunk {
  oldStart: number;
  oldLen: number;
  newStart: number;
  newLen: number;
}

export interface FileDiff {
  /** Repo-relative path (the new path for A/M, the old path for D). */
  path: string;
  status: "A" | "M" | "D";
  hunks: Hunk[];
}

/** Lines either side of a hunk that count as touched: a throw's message often
 *  sits on the line after the keyword, and a candidate's context should see
 *  an edit right next to it. */
export const HUNK_PAD = 3;

const DIFF_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse `git diff -U0 --no-renames` output. Renames are disabled upstream so a
 * move shows as D + A — the old location's records go, the new location is
 * reviewed as new code, which is exactly what a moved throw site needs.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  for (const line of text.split("\n")) {
    const h = DIFF_HEADER.exec(line);
    if (h) {
      cur = { path: h[2]!, status: "M", hunks: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("--- /dev/null")) cur.status = "A";
    else if (line.startsWith("+++ /dev/null")) {
      cur.status = "D";
      cur.path = cur.path; // header already names the (old) path
    } else {
      const k = HUNK_HEADER.exec(line);
      if (k) {
        cur.hunks.push({
          oldStart: Number(k[1]),
          oldLen: k[2] == null ? 1 : Number(k[2]),
          newStart: Number(k[3]),
          newLen: k[4] == null ? 1 : Number(k[4]),
        });
      }
    }
  }
  return files;
}

/** Inclusive old-side line range a hunk touches. A pure insertion (oldLen 0)
 *  sits between oldStart and oldStart+1, so both neighbours count. */
function oldRange(h: Hunk): [number, number] {
  return h.oldLen === 0 ? [h.oldStart, h.oldStart + 1] : [h.oldStart, h.oldStart + h.oldLen - 1];
}

/** Inclusive new-side line range a hunk touches (pure deletion: the seam). */
function newRange(h: Hunk): [number, number] {
  return h.newLen === 0 ? [h.newStart, h.newStart + 1] : [h.newStart, h.newStart + h.newLen - 1];
}

/** Was this line of the OLD file edited (or is it within the pad of an edit)? */
export function oldLineTouched(hunks: Hunk[], line: number, pad = HUNK_PAD): boolean {
  return hunks.some((h) => {
    const [a, b] = oldRange(h);
    return line >= a - pad && line <= b + pad;
  });
}

/** Is this line of the NEW file inside (or within the pad of) an edit? */
export function newLineTouched(hunks: Hunk[], line: number, pad = HUNK_PAD): boolean {
  return hunks.some((h) => {
    const [a, b] = newRange(h);
    return line >= a - pad && line <= b + pad;
  });
}

/**
 * Where an untouched OLD line lives in the NEW file: shifted by the net size
 * of every hunk that ends above it. Only meaningful for lines
 * `oldLineTouched` rejects — a touched line has no single new home.
 */
export function remapOldLine(hunks: Hunk[], line: number): number {
  let shift = 0;
  for (const h of hunks) {
    const [, oldEnd] = oldRange(h);
    const above = h.oldLen === 0 ? h.oldStart < line : oldEnd < line;
    if (above) shift += h.newLen - h.oldLen;
  }
  return line + shift;
}

export interface RescanPlan {
  /** Published records in files the diff never touched — reused as-is. */
  carryOver: ErrorRow[];
  /** Published records in modified files but outside every hunk — kept, with
   *  the line they now sit on. Source region and permalink are re-derived by
   *  the caller from the HEAD checkout. */
  remapped: { row: ErrorRow; newLine: number }[];
  /** Published records whose file was deleted or whose site was edited. Their
   *  identity stays available for reuse if discovery finds the same error in
   *  the reviewed code. */
  dropped: ErrorRow[];
  /** Added/modified files whose changed hunks discovery must review. */
  reviewFiles: Map<string, FileDiff>;
}

/**
 * Split a repo's published records by what the diff did to them, and name the
 * files discovery has to look at. `relevant` is the caller's source-file
 * filter (extension + static exclusions): a touched README is not a reason to
 * review anything.
 */
export function planRescan(
  published: ErrorRow[],
  diff: FileDiff[],
  relevant: (path: string) => boolean,
  pad = HUNK_PAD
): RescanPlan {
  const byPath = new Map<string, FileDiff>();
  for (const f of diff) if (relevant(f.path)) byPath.set(f.path, f);

  const plan: RescanPlan = { carryOver: [], remapped: [], dropped: [], reviewFiles: new Map() };
  for (const f of byPath.values()) if (f.status !== "D") plan.reviewFiles.set(f.path, f);

  for (const row of published) {
    const f = byPath.get(row.filePath);
    if (!f) {
      plan.carryOver.push(row);
      continue;
    }
    if (f.status === "D" || row.lineNumber == null || oldLineTouched(f.hunks, row.lineNumber, pad)) {
      plan.dropped.push(row);
      continue;
    }
    plan.remapped.push({ row, newLine: remapOldLine(f.hunks, row.lineNumber) });
  }
  return plan;
}

/** Candidate predicate for discovery under a plan: every line of an added
 *  file, only the edited hunks (± pad) of a modified one. */
export function candidateInReview(reviewFiles: Map<string, FileDiff>, pad = HUNK_PAD) {
  return {
    files: new Set(reviewFiles.keys()),
    line: (file: string, line: number): boolean => {
      const f = reviewFiles.get(file);
      if (!f) return false;
      return f.status === "A" || newLineTouched(f.hunks, line, pad);
    },
  };
}

/**
 * When the delta is a large share of the scoped source, reviewing hunks costs
 * about what a full analysis does and the carry-over is mostly noise — do the
 * full analysis instead. A small delta is always cheap to review whatever the
 * repo size, so an absolute floor applies before the share does. Defaults:
 * 25% of source files (ERRLOOKUP_INCREMENTAL_MAX_SHARE) above a floor of 20
 * files (ERRLOOKUP_INCREMENTAL_MIN_FILES).
 */
export function deltaTooLarge(changedSourceFiles: number, totalSourceFiles: number): boolean {
  const share = Number(process.env.ERRLOOKUP_INCREMENTAL_MAX_SHARE ?? 0.25);
  const max = Number.isFinite(share) && share > 0 ? share : 0.25;
  const floor = Number(process.env.ERRLOOKUP_INCREMENTAL_MIN_FILES ?? 20);
  const minFiles = Number.isFinite(floor) && floor >= 0 ? floor : 20;
  return totalSourceFiles > 0 && changedSourceFiles > Math.max(minFiles, max * totalSourceFiles);
}

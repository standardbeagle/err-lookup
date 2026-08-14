/**
 * Phase 0 — Scope (§4.2.0): LLM-generated per-repo scan scope.
 *
 * One light provider call per repo per commit reads a bounded directory tree
 * (depth- and count-limited) and returns include-roots + exclude-dirs. The
 * static SKIP_DIRS floor in candidates.ts always applies underneath: the model
 * can only tighten scope, never re-include floor-excluded dirs. Invalid model
 * output fails the phase loudly — a hallucinated include-root would silently
 * scan nothing.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider } from "../provider/types.js";
import { runProvider, watchdogBudgetMs } from "../provider/run.js";
import { withTimeout } from "../util/watchdog.js";
import { scopePrompt } from "./prompts.js";
import { isFloorSkippedDir, isSourceFile, type ScanScope } from "./candidates.js";

export interface TreeDir {
  path: string; // repo-relative, no trailing slash
  depth: number; // 1 = top-level
  sourceFiles: number; // recursive, capped at countCap
  capped: boolean;
}

export interface TreeOptions {
  /** Directory depth listed for the model. Deeper dirs still count into their
   *  ancestors but are not shown. */
  maxDepth?: number;
  /** Total directories listed — a runaway tree must not blow up the prompt. */
  maxDirs?: number;
  /** Per-subtree source-file count ceiling. Counting stops here, so an
   *  accidentally committed dependency tree (an assets/node_modules-style
   *  mistake under a name the floor does not know) costs bounded walk time
   *  and shows up as "N+" instead of stalling the scan. */
  countCap?: number;
  /** At or above this count a listed dir gets a SUSPECT annotation. */
  suspectFileCount?: number;
}

const DEFAULTS: Required<TreeOptions> = {
  maxDepth: 3,
  maxDirs: 400,
  countCap: 5000,
  suspectFileCount: 3000,
};

/** Walk the repo top levels, floor exclusions applied, counts capped. */
export function collectRepoTree(repoPath: string, opts: TreeOptions = {}): TreeDir[] {
  const o = { ...DEFAULTS, ...opts };
  const dirs: TreeDir[] = [];

  const visit = (abs: string, rel: string, depth: number): { count: number; capped: boolean } => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return { count: 0, capped: false };
    }
    const node =
      depth > 0 && depth <= o.maxDepth && dirs.length < o.maxDirs
        ? dirs[dirs.push({ path: rel, depth, sourceFiles: 0, capped: false }) - 1]!
        : null;
    let count = 0;
    let capped = false;
    for (const e of entries) {
      if (count >= o.countCap) {
        capped = true;
        break;
      }
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        if (isFloorSkippedDir(e.name)) continue;
        const sub = visit(join(abs, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
        count += sub.count;
        capped ||= sub.capped;
      } else if (e.isFile() && isSourceFile(e.name)) {
        count++;
      }
    }
    if (count > o.countCap) {
      count = o.countCap;
      capped = true;
    }
    if (node) {
      node.sourceFiles = count;
      node.capped = capped;
    }
    return { count, capped };
  };

  visit(repoPath, "", 0);
  return dirs;
}

/** Render the tree as indented lines with counts and SUSPECT annotations. */
export function renderTree(dirs: TreeDir[], suspectFileCount = DEFAULTS.suspectFileCount): string {
  return dirs
    .map((d) => {
      const n = d.capped ? `${d.sourceFiles}+` : String(d.sourceFiles);
      const suspect =
        d.sourceFiles >= suspectFileCount ? " [SUSPECT: unusually large — vendored or generated code?]" : "";
      return `${"  ".repeat(d.depth - 1)}${d.path}/ (${n} source files)${suspect}`;
    })
    .join("\n");
}

/**
 * Validate the model's scope answer against the tree it was shown. Any entry
 * that is not a directory we listed fails the phase — no silent repair.
 */
export function parseScope(parsed: unknown, dirs: TreeDir[]): ScanScope {
  const known = new Set(dirs.map((d) => d.path));
  const p = parsed as { includeRoots?: unknown; excludeDirs?: unknown } | null;
  const clean = (v: unknown, field: string): string[] => {
    if (v == null) return [];
    if (!Array.isArray(v)) throw new Error(`scope: ${field} is not an array`);
    return v.map((x) => {
      if (typeof x !== "string") throw new Error(`scope: ${field} entry is not a string`);
      const s = x.replace(/\/+$/, "").replace(/^\.\//, "");
      if (s === "" || s.startsWith("/") || s.split("/").includes("..")) {
        throw new Error(`scope: invalid path ${JSON.stringify(x)} in ${field}`);
      }
      if (!known.has(s)) {
        throw new Error(`scope: ${field} entry "${s}" does not match any directory in the tree`);
      }
      return s;
    });
  };
  return { includeRoots: clean(p?.includeRoots, "includeRoots"), excludeDirs: clean(p?.excludeDirs, "excludeDirs") };
}

export interface ScopeResult {
  scope: ScanScope;
  /** "llm" ran the provider; "skipped-small" — too few dirs to be worth a call. */
  mode: "llm" | "skipped-small";
  providerUsed: string;
  durationMs: number;
}

/** Below this many listed dirs the whole-repo default is obviously right and a
 *  provider call would only confirm it. */
const MIN_DIRS_FOR_SCOPE = 3;

export async function runScope(
  repoPath: string,
  repo: string,
  providers: Record<string, LlmProvider>,
  cfg: ErrlookupConfig,
  onLog?: (msg: string) => void
): Promise<ScopeResult> {
  const started = Date.now();
  const dirs = collectRepoTree(repoPath);
  if (dirs.length < MIN_DIRS_FOR_SCOPE) {
    return {
      scope: { includeRoots: [], excludeDirs: [] },
      mode: "skipped-small",
      providerUsed: "none",
      durationMs: Date.now() - started,
    };
  }
  const result = await withTimeout(
    runProvider(scopePrompt(repo, renderTree(dirs)), { cwd: repoPath }, providers, cfg, "scope"),
    watchdogBudgetMs(cfg, "scope")
  );
  const scope = parseScope(result.parsed, dirs);
  onLog?.(
    `includeRoots=[${scope.includeRoots.join(", ")}] excludeDirs=[${scope.excludeDirs.join(", ")}] via ${result.providerUsed}`
  );
  return { scope, mode: "llm", providerUsed: result.providerUsed, durationMs: Date.now() - started };
}

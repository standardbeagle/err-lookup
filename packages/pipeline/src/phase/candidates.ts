/**
 * Deterministic candidate extraction — zero-token pre-pass over a cloned repo.
 *
 * Greps source files for error-raising sites (throw/raise/panic/errors.New/
 * HTTP error statuses/error-code constants) and returns compact candidate
 * records. Discovery then feeds these to the LLM as one dense classification
 * payload per batch instead of letting an agent wander the repo — lighter
 * models produce far better results judging concrete sites than searching,
 * and the tokens-per-message ratio improves by an order of magnitude.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";

export interface CandidateSite {
  file: string; // repo-relative
  line: number; // 1-based
  kind: string; // which pattern family matched
  snippet: string; // the matched line, trimmed
  literal: string | null; // first quoted string on the line, if any
  /** Surrounding source lines, extracted procedurally. Carried into the
   *  discovery prompt so the model classifies in place instead of spending an
   *  agent tool round trip re-reading the file per candidate. */
  context: string | null;
}

const CONTEXT_LINES = 8; // each side of the match
const CONTEXT_MAX_CHARS = 1200;
const CONTEXT_MAX_LINE = 200;

function clipContext(lines: string[]): string | null {
  if (lines.length === 0) return null;
  const joined = lines.map((l) => (l.length > CONTEXT_MAX_LINE ? l.slice(0, CONTEXT_MAX_LINE) : l)).join("\n");
  const trimmed = joined.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > CONTEXT_MAX_CHARS ? trimmed.slice(0, CONTEXT_MAX_CHARS) : trimmed;
}

export interface ExtractOptions {
  maxCandidates?: number;
  maxPerFile?: number;
  maxFileBytes?: number;
}

const SKIP_DIRS = new Set([
  ".git", "node_modules", "vendor", "dist", "build", "out", "target",
  "third_party", "testdata", "__tests__", "__mocks__", "fixtures", "mocks",
  ".github", "docs", "examples", "example", "benchmark", "benchmarks",
]);

const TEST_FILE = /(\.test\.|\.spec\.|_test\.(go|py|rb|c|cc|cpp)$|^test_|Test\.(java|kt|cs)$)/;

/** Same exclusions the built-in walk applies during traversal, as a path
 *  predicate — the lci backend gets repo-wide hits and must filter after the
 *  fact, or demo/example scripts (e.g. prisma's examples/…/scripts/seed.ts)
 *  leak into candidates as if they were library error sites. */
export function isExcludedPath(rel: string): boolean {
  const segs = rel.split("/");
  for (const d of segs.slice(0, -1)) {
    if (SKIP_DIRS.has(d) || /^tests?$|^spec$/.test(d)) return true;
  }
  return TEST_FILE.test(rel);
}

interface Pattern {
  kind: string;
  re: RegExp;
}

/** Pattern families per extension group. Line-anchored, conservative. */
const PATTERNS: Record<string, Pattern[]> = {
  js: [
    { kind: "throw", re: /\bthrow\s+new\s+[A-Z][A-Za-z0-9_.]*\s*\(/ },
    { kind: "throw", re: /\bthrow\s+new\s+Error\s*\(/ },
    { kind: "error_code", re: /\bcode:\s*['"][A-Z][A-Z0-9_]{3,}['"]/ },
    { kind: "http", re: /\b(?:status|sendStatus|writeHead)\s*\(\s*[45]\d\d\b/ },
  ],
  py: [
    { kind: "throw", re: /\braise\s+[A-Z][A-Za-z0-9_.]*\s*\(/ },
    { kind: "http", re: /\babort\s*\(\s*[45]\d\d\b/ },
  ],
  go: [
    { kind: "error_new", re: /\berrors\.New\s*\(/ },
    { kind: "error_new", re: /\bfmt\.Errorf\s*\(/ },
    { kind: "panic", re: /\bpanic\s*\(/ },
    { kind: "http", re: /\bhttp\.Error\s*\(/ },
  ],
  rs: [
    { kind: "panic", re: /\b(?:panic|unreachable|todo|unimplemented)!\s*\(/ },
    { kind: "error_new", re: /\b(?:bail|anyhow|ensure)!\s*\(/ },
    { kind: "error_attr", re: /#\[error\s*\(/ }, // thiserror display messages
    { kind: "error_new", re: /\bError::new\s*\(/ },
    { kind: "panic", re: /\.expect\s*\(\s*"/ },
  ],
  jvm: [{ kind: "throw", re: /\bthrow\s+new\s+[A-Z][A-Za-z0-9_.]*(?:Exception|Error)\s*\(/ }],
  cs: [{ kind: "throw", re: /\bthrow\s+new\s+[A-Z][A-Za-z0-9_.]*Exception\s*\(/ }],
  rb: [{ kind: "throw", re: /\braise\s+[A-Z][A-Za-z0-9_:]*[,(\s]/ }],
  php: [{ kind: "throw", re: /\bthrow\s+new\s+[A-Z\\][A-Za-z0-9_\\]*\s*\(/ }],
  c: [
    { kind: "error_print", re: /\b(?:errx?|warnx?)\s*\(/ },
    { kind: "error_print", re: /\bfprintf\s*\(\s*stderr\b/ },
  ],
};

const EXT_TO_FAMILY: Record<string, string> = {
  ".js": "js", ".jsx": "js", ".ts": "js", ".tsx": "js", ".mjs": "js", ".cjs": "js",
  ".py": "py",
  ".go": "go",
  ".rs": "rs",
  ".java": "jvm", ".kt": "jvm", ".scala": "jvm",
  ".cs": "cs",
  ".rb": "rb",
  ".php": "php",
  ".c": "c", ".cc": "c", ".cpp": "c", ".h": "c", ".hpp": "c",
};

const STRING_LITERAL = /["'`]((?:[^"'`\\]|\\.){4,200})["'`]/;

function* walk(dir: string, root: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || /^tests?$|^spec$/.test(e.name)) continue;
      yield* walk(full, root);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

/**
 * Count the source files candidate extraction would consider: recognized
 * source extensions, minus skip dirs and test files. This is the repo-size
 * signal published with each repo — it must mirror the extraction rules, or
 * the count describes a different corpus than the one scanned.
 */
export function countSourceFiles(repoPath: string): number {
  let count = 0;
  for (const file of walk(repoPath, repoPath)) {
    if (!EXT_TO_FAMILY[extname(file)]) continue;
    if (TEST_FILE.test(relative(repoPath, file))) continue;
    count++;
  }
  return count;
}

/** All pattern families flattened to (kind, RE2-compatible source) pairs for lci. */
const LCI_PATTERNS: { kind: string; source: string }[] = Object.values(PATTERNS)
  .flat()
  .map((p) => ({ kind: p.kind, source: p.re.source }));

export interface LciGrepResult {
  results?: { path?: string; line?: number; context?: { lines?: string[]; matched_lines?: number[]; start_line?: number } }[];
}

/** Map one `lci grep --json` payload to candidate sites (exported for tests). */
export function candidatesFromLciJson(kind: string, repoPath: string, payload: LciGrepResult, seen: Set<string>): CandidateSite[] {
  const out: CandidateSite[] = [];
  for (const r of payload.results ?? []) {
    if (!r.path || !r.line) continue;
    const rel = isAbsolute(r.path) ? relative(repoPath, r.path) : r.path;
    if (rel.startsWith("..")) continue;
    if (isExcludedPath(rel)) continue;
    const key = `${rel}:${r.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const matchedIdx = r.context?.matched_lines?.[0];
    const start = r.context?.start_line;
    const lineText =
      matchedIdx != null && start != null ? r.context?.lines?.[matchedIdx - start] ?? "" : r.context?.lines?.[0] ?? "";
    const lit = lineText.match(STRING_LITERAL);
    out.push({
      file: rel,
      line: r.line,
      kind,
      snippet: lineText.trim().slice(0, 300),
      literal: lit ? lit[1]!.slice(0, 200) : null,
      context: clipContext(r.context?.lines ?? []),
    });
  }
  return out;
}

/**
 * lci-backed extraction: structural-grade grep (RE2, test/comment exclusion,
 * ignore handling) from the lci code-intelligence binary. Throws if lci is
 * unusable — callers pick the backend explicitly via extractCandidatesAuto.
 */
/** Build the lci invocation. `-r/--root` is a GLOBAL flag: it must precede the subcommand. */
/**
 * Candidate ceiling. Unlimited by default: a hard cap on candidate sites is a
 * hard cap on a repo's error count — golang/go and elasticsearch both hit the
 * old silent 2000 exactly. Operators bound cost explicitly via
 * ERRLOOKUP_MAX_CANDIDATES; per-call opts (tests) still override.
 */
function defaultMaxCandidates(): number {
  const n = Number(process.env.ERRLOOKUP_MAX_CANDIDATES ?? 0);
  return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY;
}

export function lciGrepArgs(repoPath: string, patternSource: string, maxResults: number): string[] {
  // -C: context lines ride along in the same JSON payload — free relative to
  // the LLM re-reading each file during discovery.
  return ["-r", repoPath, "grep", "-E", "-j", "-C", String(CONTEXT_LINES), "--exclude-tests", "--exclude-comments", "-n", String(maxResults), patternSource];
}

export function extractCandidatesLci(repoPath: string, opts: ExtractOptions = {}): CandidateSite[] {
  const maxCandidates = opts.maxCandidates ?? defaultMaxCandidates();
  const seen = new Set<string>();
  const out: CandidateSite[] = [];
  for (const { kind, source } of LCI_PATTERNS) {
    if (out.length >= maxCandidates) break;
    const stdout = execFileSync("lci", lciGrepArgs(repoPath, source, Number.isFinite(maxCandidates) ? maxCandidates : 1_000_000), {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    out.push(...candidatesFromLciJson(kind, repoPath, JSON.parse(stdout) as LciGrepResult, seen));
  }
  return Number.isFinite(maxCandidates) ? out.slice(0, maxCandidates) : out;
}

/** Pick the best available backend: lci when installed, else the built-in walk. */
export function extractCandidatesAuto(repoPath: string, opts: ExtractOptions = {}): { candidates: CandidateSite[]; backend: "lci" | "builtin" } {
  if (process.env.ERRLOOKUP_EXTRACTOR !== "builtin") {
    try {
      return { candidates: extractCandidatesLci(repoPath, opts), backend: "lci" };
    } catch {
      // lci missing or errored — the built-in walk is the portable baseline
    }
  }
  return { candidates: extractCandidates(repoPath, opts), backend: "builtin" };
}

export function extractCandidates(repoPath: string, opts: ExtractOptions = {}): CandidateSite[] {
  const maxCandidates = opts.maxCandidates ?? defaultMaxCandidates();
  // Error-dense files are legitimate (validation libraries put 100+ throws in
  // one module) — the per-file cap only guards against generated/minified junk.
  const maxPerFile = opts.maxPerFile ?? 500;
  const maxFileBytes = opts.maxFileBytes ?? 400_000;
  const out: CandidateSite[] = [];

  for (const file of walk(repoPath, repoPath)) {
    if (out.length >= maxCandidates) break;
    const family = EXT_TO_FAMILY[extname(file)];
    if (!family) continue;
    const rel = relative(repoPath, file);
    if (TEST_FILE.test(rel) || TEST_FILE.test(file)) continue;
    try {
      if (statSync(file).size > maxFileBytes) continue;
    } catch {
      continue;
    }
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const patterns = PATTERNS[family]!;
    const lines = src.split("\n");
    let fromFile = 0;
    for (let i = 0; i < lines.length && fromFile < maxPerFile && out.length < maxCandidates; i++) {
      const line = lines[i]!;
      if (line.length > 500) continue; // minified
      for (const p of patterns) {
        if (!p.re.test(line)) continue;
        // literal may sit on the next line for multi-line constructors
        const lit = line.match(STRING_LITERAL) ?? lines[i + 1]?.match(STRING_LITERAL) ?? null;
        out.push({
          file: rel,
          line: i + 1,
          kind: p.kind,
          snippet: line.trim().slice(0, 300),
          literal: lit ? lit[1]!.slice(0, 200) : null,
          context: clipContext(lines.slice(Math.max(0, i - CONTEXT_LINES), i + CONTEXT_LINES + 1)),
        });
        fromFile++;
        break; // one candidate per line
      }
    }
  }
  return out;
}

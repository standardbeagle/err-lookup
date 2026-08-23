/**
 * Call facts for an error site — the enclosing function and who calls it —
 * read from lci's symbol index. Zero provider tokens.
 *
 * The analysis prompt asks for `triggerScenarios`: the specific API calls that
 * produce an error. A source window cannot answer that, because the callers
 * live in other files; the model either guesses or spends a tool round trip
 * exploring. lci already knows, so the facts ride along in the prompt at about
 * a fifth of what one source window costs.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";

export interface CallFacts {
  /** The enclosing function, or the error value declared at this line. */
  symbol: string;
  exported: boolean;
  /**
   * How the symbol relates to the site. A package-level `ErrFoo =
   * errors.New(...)` has no enclosing function, and asking who calls it is the
   * wrong question — what matters is which functions return it.
   */
  role: "raised-in" | "declared-as";
  /** Functions that reach the site. Capped — a long list is noise. */
  reachedBy: string[];
}

interface LciSymbol {
  name: string;
  type: string;
  line: number;
  end_line?: number;
  is_exported?: boolean;
  callers?: string[];
}

const ENCLOSING_KINDS = new Set(["function", "method", "class", "struct"]);
const DECLARATION_KINDS = new Set(["variable", "constant", "field"]);
const MAX_REACHED_BY = 6;
/** References followed back to their enclosing function per declared error. */
const MAX_REFS = 12;

/**
 * Consecutive lci failures after which the repo gives up on facts entirely.
 * matomo asked for 215 files while the index server was still indexing; each
 * ask burned its own 20s timeout, so a nice-to-have cost over an hour of a
 * phase that had already decided it was getting nothing.
 */
const MAX_FAILURES = 3;

/**
 * Name being assigned at the start of a line: `ErrX = errors.New(...)`,
 * `var ErrX = ...`, `const ERR_X = ...`. Only consulted at module scope, where
 * an assignment is a declaration — inside a function this would misread a
 * local. lci's own symbol table is preferred and this covers what it misses:
 * Go's grouped `var (...)` members carry no symbol, and they are exactly where
 * a library keeps its error values.
 */
const DECLARED_NAME = /^\s*(?:(?:export|public|static|final|var|const|let|val)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::=|=)[^=]/;

function lciJson(repoPath: string, args: string[]): unknown {
  const out = execFileSync("lci", ["-r", repoPath, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  // The index server prints readiness lines to stdout on a cold start.
  const brace = out.indexOf("{");
  return brace >= 0 ? JSON.parse(out.slice(brace)) : null;
}

/**
 * Resolve call facts for `sites` (repo-relative file + line). Files are browsed
 * once and symbols cached, so cost is one lci call per distinct file plus one
 * per distinct enclosing symbol.
 *
 * A site whose enclosing symbol cannot be resolved is simply absent from the
 * result: the prompt then carries source alone, exactly as it did before. lci
 * being unavailable is reported through `onLog` rather than swallowed — a
 * silent degradation here would look like a model that stopped naming callers.
 */
export function collectCallFacts(
  repoPath: string,
  sites: { file: string; line: number }[],
  onLog?: (msg: string) => void
): Map<string, CallFacts> {
  const facts = new Map<string, CallFacts>();
  if (sites.length === 0) return facts;

  const root = resolve(repoPath);
  const symbolsByFile = new Map<string, LciSymbol[]>();
  const linesByFile = new Map<string, string[]>();
  const reachedBySymbol = new Map<string, string[]>();
  let failures = 0;

  const symbolsIn = (file: string): LciSymbol[] => {
    let symbols = symbolsByFile.get(file);
    if (symbols) return symbols;
    if (failures >= MAX_FAILURES) return [];
    try {
      const parsed = lciJson(repoPath, ["browse", file, "--json"]) as { symbols?: LciSymbol[] };
      symbols = parsed?.symbols ?? [];
      // A run of failures means the index is missing or still building, not
      // that this one file is odd; a success proves otherwise, so reset.
      failures = 0;
    } catch (e) {
      failures++;
      if (failures === 1) onLog?.(`call facts unavailable (${(e as Error).message.split("\n")[0]})`);
      symbols = [];
    }
    symbolsByFile.set(file, symbols);
    return symbols;
  };

  const lineText = (file: string, line: number): string => {
    let lines = linesByFile.get(file);
    if (!lines) {
      try {
        lines = readFileSync(join(repoPath, file), "utf8").split("\n");
      } catch {
        lines = [];
      }
      linesByFile.set(file, lines);
    }
    return lines[line - 1] ?? "";
  };

  /** The function containing `line` in `file`, if lci resolved one. */
  const functionAt = (file: string, line: number): LciSymbol | undefined =>
    symbolsIn(file)
      .filter((s) => ENCLOSING_KINDS.has(s.type) && s.end_line && s.line <= line && s.end_line >= line)
      // Smallest wins: a method and its class both contain the line, and the
      // method is the entry point a caller actually reaches.
      .sort((a, b) => a.end_line! - a.line - (b.end_line! - b.line))[0];

  /** Functions that mention `name` — where a declared error value is returned. */
  const returnedBy = (name: string, declaredIn: string, declaredAt: number): string[] => {
    let out: string[] = [];
    try {
      const stdout = execFileSync("lci", ["-r", repoPath, "refs", name, "--terse"], {
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      const refs = stdout
        .split("\n")
        .map((l) => l.trim().match(/^(.*):(\d+)$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => ({ file: relative(root, resolve(m[1]!)), line: Number(m[2]) }))
        .filter((r) => !r.file.startsWith("..") && !(r.file === declaredIn && r.line === declaredAt))
        .slice(0, MAX_REFS);
      const names = new Set<string>();
      for (const ref of refs) {
        const fn = functionAt(ref.file, ref.line);
        if (fn) names.add(fn.name);
      }
      out = [...names].slice(0, MAX_REACHED_BY);
    } catch {
      /* the symbol is not in the index — the site keeps its source alone */
    }
    return out;
  };

  for (const site of sites) {
    const enclosing = functionAt(site.file, site.line);
    if (enclosing) {
      const key = `${site.file}:${enclosing.name}`;
      let callers = reachedBySymbol.get(key);
      if (!callers) {
        try {
          const parsed = lciJson(repoPath, ["inspect", enclosing.name, "--json"]) as { symbols?: LciSymbol[] };
          const match = (parsed?.symbols ?? []).find((s) => s.line === enclosing.line) ?? parsed?.symbols?.[0];
          callers = [...new Set(match?.callers ?? [])].slice(0, MAX_REACHED_BY);
        } catch {
          callers = [];
        }
        reachedBySymbol.set(key, callers);
      }
      facts.set(`${site.file}:${site.line}`, {
        symbol: enclosing.name,
        exported: enclosing.is_exported === true,
        role: "raised-in",
        reachedBy: callers,
      });
      continue;
    }

    // No enclosing function: the site is most often a package-level error
    // value (`var ErrX = errors.New(...)`), which is exactly where the good
    // message strings live. Its references are the trigger chain.
    const declared = symbolsIn(site.file).find((s) => s.line === site.line && DECLARATION_KINDS.has(s.type));
    const name = declared?.name ?? DECLARED_NAME.exec(lineText(site.file, site.line))?.[1];
    if (!name) continue;
    const key = `${site.file}:${name}`;
    let refs = reachedBySymbol.get(key);
    if (!refs) {
      refs = returnedBy(name, site.file, site.line);
      reachedBySymbol.set(key, refs);
    }
    facts.set(`${site.file}:${site.line}`, {
      symbol: name,
      // Go and Java say it with a capital, JS/Python by not being underscored.
      exported: declared?.is_exported ?? /^[A-Z]/.test(name),
      role: "declared-as",
      reachedBy: refs,
    });
  }

  if (failures >= MAX_FAILURES) {
    onLog?.(
      `call facts: lci failed ${MAX_FAILURES} times in a row — skipped the rest of this repo ` +
        `(${sites.length - facts.size} site(s) carry source only)`
    );
  }
  return facts;
}

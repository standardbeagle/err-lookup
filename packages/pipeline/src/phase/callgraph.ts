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

export interface CallFacts {
  /** Enclosing function/method/class name. */
  fn: string;
  exported: boolean;
  /** Distinct callers, nearest first, capped — a long list is noise. */
  callers: string[];
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
const MAX_CALLERS = 6;

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

  const symbolsByFile = new Map<string, LciSymbol[]>();
  const callersBySymbol = new Map<string, string[]>();
  let failures = 0;

  for (const site of sites) {
    let symbols = symbolsByFile.get(site.file);
    if (!symbols) {
      try {
        const parsed = lciJson(repoPath, ["browse", site.file, "--json"]) as { symbols?: LciSymbol[] };
        symbols = (parsed?.symbols ?? []).filter((s) => ENCLOSING_KINDS.has(s.type) && s.end_line);
      } catch (e) {
        if (failures === 0) onLog?.(`call facts unavailable (${(e as Error).message.split("\n")[0]})`);
        failures++;
        symbols = [];
      }
      symbolsByFile.set(site.file, symbols);
    }

    // Smallest enclosing symbol: nested functions and methods on a class both
    // contain the line, and the inner one is the caller's real entry point.
    const enclosing = symbols
      .filter((s) => s.line <= site.line && s.end_line! >= site.line)
      .sort((a, b) => a.end_line! - a.line - (b.end_line! - b.line))[0];
    if (!enclosing) continue;

    const key = `${site.file}:${enclosing.name}`;
    let callers = callersBySymbol.get(key);
    if (!callers) {
      try {
        const parsed = lciJson(repoPath, ["inspect", enclosing.name, "--json"]) as { symbols?: LciSymbol[] };
        const match = (parsed?.symbols ?? []).find((s) => s.line === enclosing.line) ?? parsed?.symbols?.[0];
        callers = [...new Set(match?.callers ?? [])].slice(0, MAX_CALLERS);
      } catch {
        callers = [];
      }
      callersBySymbol.set(key, callers);
    }

    facts.set(`${site.file}:${site.line}`, {
      fn: enclosing.name,
      exported: enclosing.is_exported === true,
      callers,
    });
  }

  if (failures > 1) onLog?.(`call facts unavailable for ${failures} file(s)`);
  return facts;
}

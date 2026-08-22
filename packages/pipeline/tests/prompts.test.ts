import { describe, it, expect } from "vitest";
import { analysisPrompt, candidateDiscoveryPrompt, type CandidatePrompt } from "../src/phase/prompts.js";

function site(file: string, line: number, start: number, lines: string[], snippet = "throw"): CandidatePrompt {
  return { file, line, kind: "throw", snippet, literal: null, context: { start, lines } };
}

/** Every "--- path:a-b" header the prompt emitted. */
function headers(prompt: string): string[] {
  return [...prompt.matchAll(/^--- (\S+)$/gm)].map((m) => m[1]!);
}

describe("candidateDiscoveryPrompt source regions", () => {
  it("ships overlapping windows of one file as a single region", () => {
    const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`);
    const prompt = candidateDiscoveryPrompt([
      site("src/a.js", 9, 1, lines(1, 17)),
      site("src/a.js", 12, 4, lines(4, 20)),
    ]);

    expect(headers(prompt)).toEqual(["src/a.js:1-20"]);
    // Each source line appears once — the overlap 4-17 used to ride along twice.
    expect([...prompt.matchAll(/^line 12$/gm)]).toHaveLength(1);
    expect(prompt).toContain("line 1\n");
    expect(prompt).toContain("line 20");
    // The candidate list still names every site, without repeating source.
    expect(prompt).toContain('"line":9');
    expect(prompt).toContain('"line":12');
    expect(prompt).not.toContain('"context"');
  });

  it("keeps separate files and separate stretches of one file apart", () => {
    const prompt = candidateDiscoveryPrompt([
      site("src/a.js", 5, 1, ["a1", "a2", "a3"]),
      site("src/a.js", 90, 88, ["a88", "a89", "a90"]),
      site("src/b.js", 2, 1, ["b1", "b2"]),
    ]);

    expect(headers(prompt)).toEqual(["src/a.js:1-3", "src/a.js:88-90", "src/b.js:1-2"]);
  });

  it("merges windows that abut without overlapping", () => {
    const prompt = candidateDiscoveryPrompt([
      site("src/a.js", 2, 1, ["a1", "a2", "a3"]),
      site("src/a.js", 5, 4, ["a4", "a5"]),
    ]);

    expect(headers(prompt)).toEqual(["src/a.js:1-5"]);
    expect(prompt).toContain("a1\na2\na3\na4\na5");
  });

  it("still lists a candidate whose context could not be read", () => {
    const withoutContext: CandidatePrompt = {
      file: "src/c.js",
      line: 7,
      kind: "throw",
      snippet: "throw new Error('x')",
      literal: "x",
      context: null,
    };
    const prompt = candidateDiscoveryPrompt([site("src/a.js", 2, 1, ["a1", "a2"]), withoutContext]);

    expect(headers(prompt)).toEqual(["src/a.js:1-2"]);
    expect(prompt).toContain('"file":"src/c.js"');
    // The instructions must tell the model what to do about a missing region.
    expect(prompt).toContain("has no region");
  });
});

describe("analysisPrompt call facts", () => {
  const errors = [
    { message: "config missing", type: "exception", file: "src/a.go", line: 12 },
    { message: "bad port", type: "exception", file: "src/b.go", line: 30 },
  ];
  const need = { enrichment: true, defense: true };

  it("names the enclosing function and its callers for each error", () => {
    const prompt = analysisPrompt(errors, 0, need, ["src line", "src line"], [
      { fn: "LoadConfig", exported: true, callers: ["New", "main"] },
      { fn: "parsePort", exported: false, callers: [] },
    ]);

    // triggerScenarios asks which API calls reach the error — the callers are
    // the answer, and no source window can carry them.
    expect(prompt).toContain("RAISED IN: LoadConfig (public) — called by: New, main");
    // Unexported and uncalled: still worth saying which function raises it.
    expect(prompt).toContain("RAISED IN: parsePort");
    expect(prompt).not.toContain("parsePort (public)");
  });

  it("says nothing when the facts are missing, rather than an empty label", () => {
    const prompt = analysisPrompt(errors, 0, need, ["src line", "src line"], [null, null]);
    expect(prompt).not.toContain("RAISED IN");
    expect(prompt).toContain("SOURCE:");
  });
});

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo, disposeRepo } from "./tmp-repo.js";
import { collectRepoTree, renderTree, parseScope, runScope, type TreeDir } from "../src/phase/scope.js";
import { isOutOfScope, extractCandidates, candidatesFromLciJson } from "../src/phase/candidates.js";
import { mapConfig } from "../src/config/index.js";
import { parseKdl } from "../src/config/kdl.js";
import type { LlmProvider, InvokeOptions, ProviderResult } from "../src/provider/types.js";

function write(dir: string, rel: string, content = "export {};\n"): void {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

function monorepoFixture(): string {
  const dir = tmpRepo("scope-");
  write(dir, "src/core/index.ts", `throw new Error('lib error');\n`);
  write(dir, "src/core/util.ts");
  write(dir, "src/net/http.ts", `throw new Error('net error');\n`);
  write(dir, "website/app.ts", `throw new Error('site error');\n`);
  write(dir, "tools/release/publish.ts", `throw new Error('tool error');\n`);
  write(dir, "src/core/deep/very/nested/leaf.ts"); // beyond depth 3 — counted, not listed
  return dir;
}

describe("collectRepoTree", () => {
  it("lists dirs to the depth limit while counting deeper files into ancestors", () => {
    const dir = monorepoFixture();
    const tree = collectRepoTree(dir);
    const paths = tree.map((d) => d.path);
    expect(paths).toContain("src");
    expect(paths).toContain("src/core");
    expect(paths).toContain("src/core/deep");
    expect(paths).not.toContain("src/core/deep/very"); // depth 4
    // the depth-4+ leaf still counts into every ancestor
    expect(tree.find((d) => d.path === "src")!.sourceFiles).toBe(4);
    expect(tree.find((d) => d.path === "src/core/deep")!.sourceFiles).toBe(1);
    disposeRepo(dir);
  });

  it("skips floor dirs entirely — an assets/node_modules mistake never inflates the tree", () => {
    const dir = tmpRepo("scope-floor-");
    write(dir, "src/a.ts");
    mkdirSync(join(dir, "assets", "node_modules", "dep"), { recursive: true });
    for (let i = 0; i < 20; i++) write(dir, `assets/node_modules/dep/f${i}.js`);
    const tree = collectRepoTree(dir);
    expect(tree.map((d) => d.path).sort()).toEqual(["assets", "src"]);
    expect(tree.find((d) => d.path === "assets")!.sourceFiles).toBe(0);
    expect(tree.some((d) => d.path.includes("node_modules"))).toBe(false);
    disposeRepo(dir);
  });

  it("caps per-subtree file counts so a vendored monster costs bounded walk time", () => {
    const dir = tmpRepo("scope-cap-");
    for (let i = 0; i < 30; i++) write(dir, `vendored-junk/f${i}.js`);
    write(dir, "src/a.ts");
    const tree = collectRepoTree(dir, { countCap: 10 });
    const junk = tree.find((d) => d.path === "vendored-junk")!;
    expect(junk.sourceFiles).toBe(10);
    expect(junk.capped).toBe(true);
    disposeRepo(dir);
  });

  it("caps total listed dirs", () => {
    const dir = tmpRepo("scope-dirs-");
    for (let i = 0; i < 30; i++) write(dir, `pkg${String(i).padStart(2, "0")}/index.ts`);
    expect(collectRepoTree(dir, { maxDirs: 5 })).toHaveLength(5);
    disposeRepo(dir);
  });
});

describe("renderTree", () => {
  it("annotates oversized dirs as SUSPECT and capped counts with +", () => {
    const dirs: TreeDir[] = [
      { path: "src", depth: 1, sourceFiles: 12, capped: false },
      { path: "assets/vendor", depth: 2, sourceFiles: 5000, capped: true },
    ];
    const text = renderTree(dirs, 3000);
    expect(text).toContain("src/ (12 source files)");
    expect(text).toContain("assets/vendor/ (5000+ source files) [SUSPECT");
  });
});

describe("parseScope", () => {
  const dirs: TreeDir[] = [
    { path: "src", depth: 1, sourceFiles: 10, capped: false },
    { path: "samples", depth: 1, sourceFiles: 5, capped: false },
  ];

  it("accepts valid answers and normalizes trailing slashes", () => {
    const s = parseScope({ includeRoots: ["src/"], excludeDirs: ["./samples"] }, dirs);
    expect(s).toEqual({ includeRoots: ["src"], excludeDirs: ["samples"] });
  });

  it("treats missing fields as empty (whole repo)", () => {
    expect(parseScope({}, dirs)).toEqual({ includeRoots: [], excludeDirs: [] });
  });

  it("fails loudly on hallucinated dirs — a wrong includeRoot would scan nothing", () => {
    expect(() => parseScope({ includeRoots: ["lib"] }, dirs)).toThrow(/does not match/);
    expect(() => parseScope({ excludeDirs: ["../etc"] }, dirs)).toThrow(/invalid path/);
    expect(() => parseScope({ includeRoots: "src" }, dirs)).toThrow(/not an array/);
  });
});

describe("isOutOfScope + extraction", () => {
  const scope = { includeRoots: ["src"], excludeDirs: ["src/generated"] };

  it("include-roots gate and exclude-dirs tighten within them", () => {
    expect(isOutOfScope("src/core/a.ts", scope)).toBe(false);
    expect(isOutOfScope("website/app.ts", scope)).toBe(true);
    expect(isOutOfScope("src/generated/x.ts", scope)).toBe(true);
    expect(isOutOfScope("srcfoo/a.ts", scope)).toBe(true); // prefix must be a path segment
    expect(isOutOfScope("anything", undefined)).toBe(false);
  });

  it("builtin extractor drops out-of-scope files and tallies them by top dir", () => {
    const dir = monorepoFixture();
    const counts = new Map<string, number>();
    const c = extractCandidates(dir, { scope: { includeRoots: ["src"], excludeDirs: [] }, excludedByScope: counts });
    expect([...new Set(c.map((s) => s.file))].sort()).toEqual(["src/core/index.ts", "src/net/http.ts"]);
    expect(counts.get("website")).toBe(1);
    expect(counts.get("tools")).toBe(1);
    disposeRepo(dir);
  });

  it("lci mapping applies the same scope filter", () => {
    const payload = {
      results: [
        { path: "/repo/src/a.ts", line: 1, context: { lines: ["throw new Error('x')"], matched_lines: [1], start_line: 1 } },
        { path: "/repo/website/demo.ts", line: 2, context: { lines: ["throw new Error('y')"], matched_lines: [2], start_line: 2 } },
      ],
    };
    const counts = new Map<string, number>();
    const c = candidatesFromLciJson("throw", "/repo", payload, new Set(), { includeRoots: [], excludeDirs: ["website"] }, counts);
    expect(c.map((s) => s.file)).toEqual(["src/a.ts"]);
    expect(counts.get("website")).toBe(1);
  });
});

describe("runScope", () => {
  function cfg() {
    return mapConfig(parseKdl(['provider "p" { command "p" }', "defaults {", '  primary "p"', "}"].join("\n")));
  }

  class ScopeProvider implements LlmProvider {
    calls = 0;
    constructor(readonly name: string, private readonly answer: unknown) {}
    async invoke(_prompt: string, _o: InvokeOptions): Promise<ProviderResult> {
      this.calls++;
      return { ok: true, parsed: this.answer, raw: JSON.stringify(this.answer) };
    }
  }

  it("skips the provider call on a tiny repo — whole-repo default is obviously right", async () => {
    const dir = tmpRepo("scope-tiny-");
    write(dir, "index.ts", `throw new Error('x');\n`);
    const p = new ScopeProvider("p", {});
    const r = await runScope(dir, "o/tiny", { p }, cfg());
    expect(r.mode).toBe("skipped-small");
    expect(p.calls).toBe(0);
    expect(r.scope).toEqual({ includeRoots: [], excludeDirs: [] });
    disposeRepo(dir);
  });

  it("returns the validated model scope on a structured repo", async () => {
    const dir = monorepoFixture();
    const p = new ScopeProvider("p", { includeRoots: ["src"], excludeDirs: ["website"], notes: "site is not the lib" });
    const r = await runScope(dir, "o/mono", { p }, cfg());
    expect(r.mode).toBe("llm");
    expect(r.scope).toEqual({ includeRoots: ["src"], excludeDirs: ["website"] });
    disposeRepo(dir);
  });

  it("fails the phase when the model invents a directory", async () => {
    const dir = monorepoFixture();
    const p = new ScopeProvider("p", { includeRoots: ["lib"] });
    await expect(runScope(dir, "o/mono", { p }, cfg())).rejects.toThrow(/does not match/);
    disposeRepo(dir);
  });
});

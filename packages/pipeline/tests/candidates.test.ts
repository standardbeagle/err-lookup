import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo, disposeRepo } from "./tmp-repo.js";
import { extractCandidates, candidatesFromLciJson, lciGrepArgs, extractCandidatesLci, countSourceFiles } from "../src/phase/candidates.js";
import { mapConfig } from "../src/config/index.js";
import { parseKdl } from "../src/config/kdl.js";

function fixtureRepo(): string {
  const dir = tmpRepo("cand-");
  writeFileSync(join(dir, "index.js"), `function f(x) {\n  if (!x) throw new TypeError('Expected a function');\n}\n`);
  writeFileSync(join(dir, "api.py"), `def g():\n    raise ValueError("bad input: %s" % x)\n`);
  writeFileSync(join(dir, "main.go"), `func h() error {\n\treturn fmt.Errorf("connect failed: %w", err)\n}\n`);
  writeFileSync(
    join(dir, "lib.rs"),
    `fn i() {\n    panic!("unreachable state {}", s);\n}\n#[error("connection reset by {peer}")]\nstruct E;\nfn j() {\n    let f = std::fs::File::open(p).expect("config file must exist");\n    Err(io::Error::new(ErrorKind::Other, "socket closed"))\n}\n`
  );
  // must be skipped:
  writeFileSync(join(dir, "index.test.js"), `throw new Error('in test');\n`);
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "x", "dep.js"), `throw new Error('in dep');\n`);
  return dir;
}

describe("builtin candidate extractor", () => {
  it("finds error sites across languages with literals, skipping tests and deps", () => {
    const dir = fixtureRepo();
    const c = extractCandidates(dir);
    const files = [...new Set(c.map((s) => s.file))].sort();
    expect(files).toEqual(["api.py", "index.js", "lib.rs", "main.go"]);
    // rust idioms: thiserror attr, .expect(), Error::new all captured
    const rs = c.filter((s) => s.file === "lib.rs");
    expect(rs.map((s) => s.kind).sort()).toEqual(["error_attr", "error_new", "panic", "panic"]);
    expect(rs.some((s) => s.literal === "connection reset by {peer}")).toBe(true);
    const js = c.find((s) => s.file === "index.js")!;
    expect(js.line).toBe(2);
    expect(js.kind).toBe("throw");
    expect(js.literal).toBe("Expected a function");
    // builtin walk slices its own context window around the match
    expect(js.context).toContain("function f(x)");
    expect(js.context).toContain("Expected a function");
    const go = c.find((s) => s.file === "main.go")!;
    expect(go.literal).toContain("connect failed");
    disposeRepo(dir);
  });

  it("counts source files under the same exclusion rules as extraction", () => {
    const dir = fixtureRepo();
    // index.js, api.py, main.go, lib.rs — index.test.js and node_modules excluded
    expect(countSourceFiles(dir)).toBe(4);
    disposeRepo(dir);
  });

  it("has no default candidate ceiling — caps only when explicitly configured", () => {
    // The old silent default of 2000 capped a repo's error count; golang/go
    // and elasticsearch both hit it exactly.
    const dir = tmpRepo("cand-nocap-");
    const lines = Array.from({ length: 2600 }, (_, i) => `throw new Error('e${i}');`).join("\n");
    writeFileSync(join(dir, "many.js"), lines);
    expect(extractCandidates(dir, { maxPerFile: 5000 }).length).toBe(2600);
    process.env.ERRLOOKUP_MAX_CANDIDATES = "100";
    try {
      expect(extractCandidates(dir, { maxPerFile: 5000 })).toHaveLength(100);
    } finally {
      delete process.env.ERRLOOKUP_MAX_CANDIDATES;
    }
    disposeRepo(dir);
  });

  it("honors caps", () => {
    const dir = tmpRepo("cand-cap-");
    const lines = Array.from({ length: 100 }, (_, i) => `throw new Error('e${i}');`).join("\n");
    writeFileSync(join(dir, "many.js"), lines);
    expect(extractCandidates(dir, { maxPerFile: 10 })).toHaveLength(10);
    expect(extractCandidates(dir, { maxCandidates: 5 })).toHaveLength(5);
    disposeRepo(dir);
  });
});

describe("lci invocation", () => {
  it("puts the global -r flag before the grep subcommand", () => {
    const args = lciGrepArgs("/repo", "throw", 100);
    expect(args.indexOf("-r")).toBeLessThan(args.indexOf("grep"));
    expect(args[args.length - 1]).toBe("throw");
  });

  it("requests context lines so discovery ships them instead of re-reading files", () => {
    const args = lciGrepArgs("/repo", "throw", 100);
    const c = args.indexOf("-C");
    expect(c).toBeGreaterThan(args.indexOf("grep"));
    expect(Number(args[c + 1])).toBeGreaterThan(0);
  });

  it("extracts real candidates end-to-end when the lci binary is available", () => {
    const dir = fixtureRepo();
    try {
      const c = extractCandidatesLci(dir);
      // lci must at least find the JS throw; other langs depend on its grammars
      expect(c.some((s) => s.file === "index.js" && s.line === 2)).toBe(true);
    } catch (e) {
      // acceptable only when the binary is genuinely absent on this host
      expect((e as NodeJS.ErrnoException).code).toBe("ENOENT");
    } finally {
      disposeRepo(dir);
    }
  });
});

describe("lci grep contract", () => {
  /**
   * Regression + repro. lci's grep JSON carries three line-ish fields —
   * `line`, `context.start_line`, `context.matched_lines` — and with the -C 8
   * we ask for, the context windows of adjacent matches overlap, so all three
   * neighbours ship the same `lines` array. `line` is the only per-result
   * identity; everything else is window bookkeeping.
   *
   * A stale lci build (30850272 bytes, pre-2026-08-16) emitted start_line-like
   * values in `line`, which collapsed consecutive throws to 1,1,2 and made the
   * file:line dedup drop two of three. That build is not what production runs,
   * but the failure was invisible until someone diffed two binaries that both
   * self-report "lci version 0.8.0" — so pin the contract here instead.
   */
  it("gives each match on consecutive lines its own line number and message", () => {
    const dir = tmpRepo("lci-contract-");
    try {
      writeFileSync(
        join(dir, "index.js"),
        "const a = 1;\nthrow new Error('first failed');\nthrow new Error('second failed');\nthrow new Error('third failed');\nconst b = 2;\n"
      );
      // Assert outside the try: an expect() failure must not be swallowed by
      // the binary-absent catch and reported as "lci missing".
      let candidates: ReturnType<typeof extractCandidatesLci> | null = null;
      try {
        candidates = extractCandidatesLci(dir).filter((s) => s.file === "index.js");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // only a genuinely absent binary excuses a skip
      }
      if (candidates) {
        expect(candidates.map((s) => [s.line, s.literal])).toEqual([
          [2, "first failed"],
          [3, "second failed"],
          [4, "third failed"],
        ]);
      }
    } finally {
      disposeRepo(dir);
    }
  });
});

describe("lci JSON mapping", () => {
  it("indexes each result's snippet from its own line, not the window's first match", () => {
    // Three matches whose -C windows overlap: identical `lines`, distinct `line`.
    const lines = ["const a = 1;", "throw new Error('first failed');", "throw new Error('second failed');", "throw new Error('third failed');"];
    const payload = {
      results: [2, 3, 4].map((line) => ({ path: "/repo/index.js", line, context: { lines, matched_lines: [line], start_line: 1 } })),
    };
    const c = candidatesFromLciJson("throw", "/repo", payload, new Set<string>());
    expect(c.map((s) => [s.line, s.literal])).toEqual([
      [2, "first failed"],
      [3, "second failed"],
      [4, "third failed"],
    ]);
  });


  it("maps lci grep payloads to candidate sites and dedupes by file:line", () => {
    const payload = {
      results: [
        {
          path: "/repo/src/a.ts",
          line: 113,
          context: {
            lines: ["    const res = await fetch(url);", "    if (!res.ok) throw new Error(`GET failed`);"],
            matched_lines: [113],
            start_line: 112,
          },
        },
        { path: "/repo/src/a.ts", line: 113 }, // duplicate
        { path: "/outside/other.ts", line: 5 }, // outside repo root
        { path: "/repo/examples/prisma-8-demo-sqlite/scripts/seed.ts", line: 119 }, // demo script, not library code
        { path: "/repo/dotnet/samples/Concepts/ChatCompletion/OpenAI_ChatCompletion.cs", line: 31 }, // samples dir (semantic-kernel shape)
        { path: "/repo/python/samples/getting_started/step1.py", line: 12 }, // nested samples dir
        { path: "/repo/demo/app.ts", line: 3 }, // demo dir
        { path: "/repo/notebooks/intro.py", line: 8 }, // notebooks dir
        { path: "/repo/docs/guide.ts", line: 7 }, // docs snippet
        { path: "/repo/src/util.test.ts", line: 9 }, // test file
      ],
    };
    const seen = new Set<string>();
    const c = candidatesFromLciJson("throw", "/repo", payload, seen);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ file: "src/a.ts", line: 113, kind: "throw", literal: "GET failed" });
    // context.lines ride along verbatim — discovery classifies without re-reads
    expect(c[0]!.context).toContain("await fetch(url)");
    expect(c[0]!.context).toContain("GET failed");
  });
});

describe("phase-providers config", () => {
  it("parses per-phase routing and leaves unset phases on the primary", () => {
    const cfg = mapConfig(
      parseKdl(
        [
          'provider "deepseek" {',
          '  command "opencode"',
          "}",
          'provider "k3" {',
          '  command "opencode"',
          "}",
          "defaults {",
          '  primary "deepseek"',
          "}",
          "phase-providers {",
          '  verify "k3"',
          "}",
        ].join("\n")
      )
    );
    expect(cfg.phaseProviders).toEqual({ verify: "k3" });
    expect(cfg.defaults.primary).toBe("deepseek");
  });
});

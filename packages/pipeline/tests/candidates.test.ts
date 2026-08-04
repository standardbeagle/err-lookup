import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractCandidates, candidatesFromLciJson, lciGrepArgs, extractCandidatesLci, countSourceFiles } from "../src/phase/candidates.js";
import { mapConfig } from "../src/config/index.js";
import { parseKdl } from "../src/config/kdl.js";

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cand-"));
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
    const go = c.find((s) => s.file === "main.go")!;
    expect(go.literal).toContain("connect failed");
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts source files under the same exclusion rules as extraction", () => {
    const dir = fixtureRepo();
    // index.js, api.py, main.go, lib.rs — index.test.js and node_modules excluded
    expect(countSourceFiles(dir)).toBe(4);
    rmSync(dir, { recursive: true, force: true });
  });

  it("honors caps", () => {
    const dir = mkdtempSync(join(tmpdir(), "cand-cap-"));
    const lines = Array.from({ length: 100 }, (_, i) => `throw new Error('e${i}');`).join("\n");
    writeFileSync(join(dir, "many.js"), lines);
    expect(extractCandidates(dir, { maxPerFile: 10 })).toHaveLength(10);
    expect(extractCandidates(dir, { maxCandidates: 5 })).toHaveLength(5);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("lci invocation", () => {
  it("puts the global -r flag before the grep subcommand", () => {
    const args = lciGrepArgs("/repo", "throw", 100);
    expect(args.indexOf("-r")).toBeLessThan(args.indexOf("grep"));
    expect(args[args.length - 1]).toBe("throw");
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
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lci JSON mapping", () => {
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
        { path: "/repo/docs/guide.ts", line: 7 }, // docs snippet
        { path: "/repo/src/util.test.ts", line: 9 }, // test file
      ],
    };
    const seen = new Set<string>();
    const c = candidatesFromLciJson("throw", "/repo", payload, seen);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ file: "src/a.ts", line: 113, kind: "throw", literal: "GET failed" });
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

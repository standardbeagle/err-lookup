import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo, disposeRepo } from "./tmp-repo.js";
import { collectCallFacts } from "../src/phase/callgraph.js";

describe("collectCallFacts", () => {
  it("names the function an error is raised in, and who calls it", () => {
    const dir = tmpRepo("callfacts-");
    writeFileSync(
      join(dir, "config.go"),
      [
        "package config",
        "",
        "func LoadConfig(path string) error {",
        '\tif path == "" {',
        '\t\treturn errors.New("config path is empty")',
        "\t}",
        "\treturn nil",
        "}",
        "",
        "func New() error {",
        '\treturn LoadConfig("app.toml")',
        "}",
        "",
      ].join("\n")
    );

    const logs: string[] = [];
    const facts = collectCallFacts(dir, [{ file: "config.go", line: 5 }], (m) => logs.push(m));
    const site = facts.get("config.go:5");

    // Skip only when the binary is genuinely absent — a resolution that
    // silently returns nothing is the failure this test exists to catch.
    if (!logs.some((l) => l.includes("call facts unavailable"))) {
      expect(site?.symbol).toBe("LoadConfig");
      expect(site?.role).toBe("raised-in");
      expect(site?.exported).toBe(true);
      expect(site?.reachedBy).toContain("New");
    }
    disposeRepo(dir);
  });

  it("resolves a package-level error value through its references", () => {
    const dir = tmpRepo("callfacts-declared-");
    writeFileSync(
      join(dir, "errs.go"),
      [
        "package errs",
        "",
        "var (",
        "\t// ErrNoPath is returned when the path is empty.",
        '\tErrNoPath = errors.New("config path is empty")',
        ")",
        "",
        "func LoadConfig(path string) error {",
        '\tif path == "" {',
        "\t\treturn ErrNoPath",
        "\t}",
        "\treturn nil",
        "}",
        "",
      ].join("\n")
    );
    const logs: string[] = [];

    // Go's grouped `var (...)` members carry no lci symbol, and they are where
    // libraries keep their error values — the name comes from the line itself.
    const facts = collectCallFacts(dir, [{ file: "errs.go", line: 5 }], (m) => logs.push(m));
    const site = facts.get("errs.go:5");

    if (!logs.some((l) => l.includes("call facts unavailable"))) {
      expect(site?.symbol).toBe("ErrNoPath");
      expect(site?.role).toBe("declared-as");
      expect(site?.reachedBy).toContain("LoadConfig");
    }
    disposeRepo(dir);
  });

  it("returns no facts, and does not throw, when a site has no enclosing symbol", () => {
    const dir = tmpRepo("callfacts-empty-");
    writeFileSync(join(dir, "notes.go"), "package notes\n\n// nothing declared here\n");
    const logs: string[] = [];

    const facts = collectCallFacts(dir, [{ file: "notes.go", line: 3 }], (m) => logs.push(m));

    expect(facts.size).toBe(0);
    // A missing binary is reported, never swallowed — silently losing the
    // facts would look like a model that stopped naming callers.
    if (logs.length > 0) expect(logs[0]).toContain("call facts unavailable");
    disposeRepo(dir);
  });
});

describe("collectCallFacts when lci is not answering", () => {
  it("gives up after three consecutive failures instead of timing out per file", () => {
    // A repo path lci cannot index: every call fails the way a still-indexing
    // server does. matomo asked 215 times at 20s each before this existed.
    const sites = Array.from({ length: 25 }, (_, i) => ({ file: `pkg/f${i}.go`, line: 3 }));
    const logs: string[] = [];

    const started = Date.now();
    const facts = collectCallFacts("/nonexistent-repo-for-callfacts", sites, (m) => logs.push(m));
    const elapsed = Date.now() - started;

    expect(facts.size).toBe(0);
    // Three attempts, not twenty-five: the give-up must be visible and counted.
    expect(logs.some((l) => l.includes("failed 3 times in a row"))).toBe(true);
    expect(logs.some((l) => l.includes("25 site(s) carry source only"))).toBe(true);
    // Three failing spawns cannot take the 25-file path's time even on a slow box.
    expect(elapsed).toBeLessThan(60_000);
  });
});

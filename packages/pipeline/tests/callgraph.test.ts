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
      expect(site?.fn).toBe("LoadConfig");
      expect(site?.exported).toBe(true);
      expect(site?.callers).toContain("New");
    }
    disposeRepo(dir);
  });

  it("returns no facts, and does not throw, when a site has no enclosing symbol", () => {
    const dir = tmpRepo("callfacts-empty-");
    writeFileSync(join(dir, "notes.go"), "package notes\n\nvar x = 1\n");
    const logs: string[] = [];

    const facts = collectCallFacts(dir, [{ file: "notes.go", line: 3 }], (m) => logs.push(m));

    expect(facts.size).toBe(0);
    // A missing binary is reported, never swallowed — silently losing the
    // facts would look like a model that stopped naming callers.
    if (logs.length > 0) expect(logs[0]).toContain("call facts unavailable");
    disposeRepo(dir);
  });
});

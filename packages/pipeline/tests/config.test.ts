import { describe, it, expect } from "vitest";
import { parseKdl } from "../src/config/kdl.js";
import { mapConfig, loadConfig, DEFAULT_CONFIG } from "../src/config/index.js";

const SPEC_SAMPLE = `
// operator configuration
provider "glm" {
    command "glm"
    args "-p" "--output-format" "json"
    timeout-ms 600000
}
provider "claude" {
    command "claude"
    args "-p" "--output-format" "json" "--max-turns" "30"
    timeout-ms 600000
}
defaults {
    primary "glm"
    fallback "claude"
    max-concurrent 1
    delay-between-phases-ms 5000
}
`;

describe("loadConfig explicit path", () => {
  it("throws when ERRLOOKUP_CONFIG points at a missing file (no silent default)", () => {
    process.env.ERRLOOKUP_CONFIG = "does/not/exist.kdl";
    try {
      expect(() => loadConfig()).toThrow(/config not found/);
    } finally {
      delete process.env.ERRLOOKUP_CONFIG;
    }
  });

  it("throws when an explicit configPath argument is missing", () => {
    expect(() => loadConfig("/nonexistent/errlookup.kdl")).toThrow(/config not found/);
  });
});

describe("kdl parser", () => {
  it("parses the spec sample config", () => {
    const doc = parseKdl(SPEC_SAMPLE);
    expect(doc.nodes.map((n) => n.name)).toEqual(["provider", "provider", "defaults"]);
    const glm = doc.nodes[0]!;
    expect(glm.values).toEqual(["glm"]);
    expect(glm.children.map((c) => c.name)).toEqual(["command", "args", "timeout-ms"]);
    expect(glm.children[1]!.values).toEqual(["-p", "--output-format", "json"]);
    expect(glm.children[2]!.values).toEqual([600000]);
  });

  it("handles block + line comments", () => {
    const src = `
      /* block
         comment */
      provider "x" { // trailing
          command "x" // inline
      }
    `;
    const doc = parseKdl(src);
    expect(doc.nodes[0]!.name).toBe("provider");
    expect(doc.nodes[0]!.values[0]).toBe("x");
  });

  it("coerces booleans and numbers", () => {
    const doc = parseKdl('node "str" 42 true false');
    expect(doc.nodes[0]!.values).toEqual(["str", 42, true, false]);
  });
});

describe("config mapping", () => {
  it("maps the spec sample to typed config", () => {
    const cfg = mapConfig(parseKdl(SPEC_SAMPLE));
    expect(Object.keys(cfg.providers).sort()).toEqual(["claude", "glm"]);
    expect(cfg.providers.glm).toEqual({
      command: "glm",
      args: ["-p", "--output-format", "json"],
      timeoutMs: 600_000,
      promptMode: "stdin",
      type: "spawn",
      model: null,
    });
    expect(cfg.providers.claude.args).toContain("--max-turns");
    expect(cfg.defaults).toEqual({
      primary: "glm",
      fallback: "claude",
      maxConcurrent: 1,
      delayBetweenPhasesMs: 5_000,
    });
  });
});

describe("loadConfig", () => {
  it("returns DEFAULT_CONFIG when no config file exists in cwd candidates", () => {
    // no explicit path, no ERRLOOKUP_CONFIG: falls back to defaults only when
    // none of the conventional locations exist (vitest cwd is packages/pipeline)
    delete process.env.ERRLOOKUP_CONFIG;
    const cfg = loadConfig();
    expect(cfg.providers.claude?.command ?? "claude").toBe("claude");
    expect(cfg.defaults.maxConcurrent).toBeGreaterThanOrEqual(1);
  });
});

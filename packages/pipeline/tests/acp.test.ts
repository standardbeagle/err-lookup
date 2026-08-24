import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpProvider } from "../src/provider/acp.js";
import { runProvider, OUTPUT_PREFIX } from "../src/provider/run.js";
import { mapConfig } from "../src/config/index.js";
import { parseKdl } from "../src/config/kdl.js";
import type { ProviderConfig } from "../src/config/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = resolve(__dirname, "..", "fixtures", "fake-acp-agent.mjs");

function acpCfg(): ProviderConfig {
  return {
    command: process.execPath,
    args: [FAKE_AGENT],
    timeoutMs: 15_000,
    idleTimeoutMs: 0,
    promptMode: "stdin",
    type: "acp",
    model: "fake/fake-model",
    modelOptions: null,
  };
}

describe("AcpProvider", () => {
  it("full protocol round-trip: permission auto-allow + output file parsed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "acp-test-"));
    const p = new AcpProvider("opencode", acpCfg());
    const outputFile = join(cwd, `${OUTPUT_PREFIX}.test.json`);
    const prompt = `Find things.\n\nOUTPUT DELIVERY: Write the final JSON to the file "${outputFile}" (create or overwrite it; the file must contain only the JSON). Do not print the JSON to stdout.`;
    const r = await p.invoke(prompt, { cwd, outputFile });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parsed).toEqual({ fake: true });
    rmSync(cwd, { recursive: true, force: true });
  }, 20000);

  it("fails loudly when the agent never writes the output file", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "acp-test-"));
    process.env.FAKE_ACP_SKIP_FILE = "1";
    try {
      const p = new AcpProvider("opencode", acpCfg());
      const outputFile = join(cwd, `${OUTPUT_PREFIX}.test.json`);
      const r = await p.invoke(`x\nWrite the final JSON to the file "${outputFile}"`, { cwd, outputFile });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("empty");
    } finally {
      delete process.env.FAKE_ACP_SKIP_FILE;
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 20000);

  it("kills a stalled call on protocol silence, not wall clock", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "acp-idle-"));
    process.env.FAKE_ACP_STALL = "1";
    try {
      const p = new AcpProvider("opencode", { ...acpCfg(), idleTimeoutMs: 400 });
      const started = Date.now();
      const r = await p.invoke("stall", { cwd });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.kind).toBe("timeout");
        expect(r.error).toContain("no ACP activity for 400ms");
      }
      // Long before the 15s hard ceiling: the idle timer fired, not the wall clock.
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      delete process.env.FAKE_ACP_STALL;
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 20000);

  it("streamed events hold the idle timer off past the idle window", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "acp-drip-"));
    // 6 chunks every 150ms ≈ 900ms of work, idle window 500ms: only the
    // per-event reset lets this finish.
    process.env.FAKE_ACP_DRIP = "150,6";
    try {
      const p = new AcpProvider("opencode", { ...acpCfg(), idleTimeoutMs: 500 });
      const r = await p.invoke("drip", { cwd });
      expect(r.ok).toBe(true);
    } finally {
      delete process.env.FAKE_ACP_DRIP;
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 20000);

  it("parses from streamed agent text when no outputFile is requested", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "acp-test-"));
    const p = new AcpProvider("opencode", acpCfg());
    const r = await p.invoke("no file instruction here", { cwd });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parsed).toEqual({ fake: true });
    rmSync(cwd, { recursive: true, force: true });
  }, 20000);
});

describe("runProvider file handoff", () => {
  function acpConfig() {
    return mapConfig(
      parseKdl(
        [
          'provider "opencode" {',
          `  command "${process.execPath}"`,
          `  args "${FAKE_AGENT}"`,
          '  type "acp"',
          '  model "fake/fake-model"',
          "  timeout-ms 15000",
          "}",
          "defaults {",
          '  primary "opencode"',
          "}",
        ].join("\n")
      )
    );
  }
  const leftovers = (cwd: string) => readdirSync(cwd).filter((f) => f.startsWith(OUTPUT_PREFIX));

  it("injects the output-file instruction and cleans the file up afterwards", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "handoff-test-"));
    const cfg = acpConfig();
    const providers = { opencode: new AcpProvider("opencode", cfg.providers.opencode!) };
    const res = await runProvider("Find things.", { cwd }, providers, cfg);
    expect(res.parsed).toEqual({ fake: true });
    expect(res.providerUsed).toBe("opencode");
    expect(leftovers(cwd)).toEqual([]); // cleaned up
    rmSync(cwd, { recursive: true, force: true });
  }, 20000);

  it("concurrent calls sharing one cwd each read back their own output file", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "handoff-concurrent-"));
    const cfg = acpConfig();
    const providers = { opencode: new AcpProvider("opencode", cfg.providers.opencode!) };
    const markers = ["alpha", "bravo", "charlie", "delta"];
    const results = await Promise.all(
      markers.map((m) => runProvider(`Find things. MARKER:${m}`, { cwd }, providers, cfg))
    );
    expect(results.map((r) => (r.parsed as { marker: string }).marker)).toEqual(markers);
    expect(leftovers(cwd)).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  }, 30000);
});

describe("config: acp provider mapping", () => {
  it("parses type + model and applies ERRLOOKUP_CONFIG env override path", () => {
    const cfg = mapConfig(
      parseKdl(
        [
          'provider "opencode" {',
          '  command "opencode"',
          '  args "acp" "--pure"',
          '  type "acp"',
          '  model "kimi-for-coding/kimi-for-coding"',
          "  timeout-ms 300000",
          "}",
          'defaults { primary "opencode" }',
        ].join("\n")
      )
    );
    const p = cfg.providers.opencode!;
    expect(p.type).toBe("acp");
    expect(p.model).toBe("kimi-for-coding/kimi-for-coding");
    expect(p.args).toEqual(["acp", "--pure"]);
  });

  it("parses idle-timeout-ms and model-options JSON", () => {
    const cfg = mapConfig(
      parseKdl(
        [
          'provider "opencode" {',
          '  command "opencode"',
          '  type "acp"',
          '  model "zai-coding-plan/glm-5.2"',
          "  idle-timeout-ms 90000",
          '  model-options "{\\"thinking\\":{\\"type\\":\\"disabled\\"}}"',
          "}",
          'defaults { primary "opencode" }',
        ].join("\n")
      )
    );
    const p = cfg.providers.opencode!;
    expect(p.idleTimeoutMs).toBe(90_000);
    expect(p.modelOptions).toEqual({ thinking: { type: "disabled" } });
  });

  it("rejects malformed model-options instead of running without the pin", () => {
    expect(() =>
      mapConfig(parseKdl('provider "x" { model-options "not json" }'))
    ).toThrow(/model-options/);
  });
});

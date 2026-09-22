import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalFamily } from "@errlookup/schema";
import { mapConfig } from "../src/config/index.js";
import { parseKdl } from "../src/config/kdl.js";
import type { LlmProvider, InvokeOptions, ProviderResult } from "../src/provider/types.js";
import type { Page } from "../src/phase/tag-page.js";
import { validateLabels, labelPages } from "../src/phase/tag-audit.js";

const page = (id: string): Page => ({
  id,
  repo: "org/lib",
  errorMessage: "FOO is required",
  errorClass: "ValueError",
  errorCode: null,
  httpStatus: null,
  errorType: "validation",
  documentation: "Raised when FOO is unset.",
  triggerScenarios: null,
  commonSituations: null,
  proposal: "missing-env-var",
});

const FAMILIES: CanonicalFamily[] = [
  { tag: "missing-env-var", domain: "configuration", criteria: "A required environment variable is unset." },
  { tag: "file-not-found", domain: "filesystem", criteria: "A file does not exist at the path given." },
];

describe("reference labels", () => {
  const tags = new Set(FAMILIES.map((f) => f.tag));

  it("holds a label answer to one valid entry per page", () => {
    expect(
      validateLabels({ labels: [{ page: 0, family: "missing-env-var", certainty: "clear" }, { page: 1, family: null, certainty: "unclear" }] }, 2, tags)
    ).toEqual([]);
    const issues = validateLabels({ labels: [{ page: 0, family: "made-up", certainty: "sure" }] }, 2, tags).join("\n");
    expect(issues).toContain('"made-up" is not a family');
    expect(issues).toContain("certainty must be clear, likely or unclear");
    expect(issues).toContain("page 1 has no label");
  });

  it("checkpoints labels and does not ask again for pages it has", async () => {
    let calls = 0;
    const provider: LlmProvider = {
      name: "bulk",
      async invoke(prompt: string, _o: InvokeOptions): Promise<ProviderResult> {
        calls++;
        const n = (prompt.match(/^\[\d+\] /gm) ?? []).length;
        const answer = { labels: Array.from({ length: n }, (_, i) => ({ page: i, family: "missing-env-var", certainty: "clear" })) };
        return { ok: true, parsed: answer, raw: JSON.stringify(answer) };
      },
    };
    const cfg = mapConfig(parseKdl(['provider "bulk" { command "bulk" }', "defaults {", '  primary "bulk"', "}"].join("\n")));
    const checkpointFile = join(mkdtempSync(join(tmpdir(), "labels-")), "labels.json");
    const pages = Array.from({ length: 12 }, (_, i) => page(`p${i}`));

    const first = await labelPages({ bulk: provider }, cfg, pages, FAMILIES, { checkpointFile });
    expect(first.size).toBe(12);
    expect(calls).toBe(2);
    expect(existsSync(checkpointFile)).toBe(true);
    expect(JSON.parse(readFileSync(checkpointFile, "utf8"))).toHaveLength(12);

    await labelPages({ bulk: provider }, cfg, pages, FAMILIES, { checkpointFile });
    expect(calls).toBe(2);
  });
});

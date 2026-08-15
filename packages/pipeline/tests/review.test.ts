import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReviewOne, parseReviewTarget } from "../src/phase/review.js";
import { mapConfig } from "../src/config/index.js";
import { parseKdl } from "../src/config/kdl.js";
import type { LlmProvider, InvokeOptions, ProviderResult } from "../src/provider/types.js";
import type { ErrorEntry } from "@errlookup/schema";

function cfg() {
  return mapConfig(parseKdl(['provider "p" { command "p" }', "defaults {", '  primary "p"', "}"].join("\n")));
}

class FixtureProvider implements LlmProvider {
  constructor(readonly name: string, private readonly answer: unknown) {}
  async invoke(_prompt: string, _o: InvokeOptions): Promise<ProviderResult> {
    return { ok: true, parsed: this.answer, raw: JSON.stringify(this.answer) };
  }
}

const ENTRY: ErrorEntry = {
  id: "abcdef0123456789",
  repo: "docker/cli",
  slug: "cannot-attach-stdin-bec",
  errorCode: null,
  errorMessage: "cannot attach stdin to a tty-enabled container",
  messagePattern: "cannot attach stdin",
  errorType: "exception",
  errorClass: null,
  httpStatus: null,
  severity: "error",
  filePath: "cli/command/container/attach.go",
  lineNumber: 42,
  sourceCode: 'return errors.New("cannot attach stdin to a tty-enabled container")',
  sourceCodeStart: 40,
  sourceCodeEnd: 44,
  githubUrl: "https://github.com/docker/cli/blob/abc/cli/command/container/attach.go#L42",
  documentation: "old docs",
  triggerScenarios: "old",
  commonSituations: "old",
  solutions: ["old step"],
  exampleFix: null,
  handlingStrategy: null,
  validationCode: null,
  typeGuard: null,
  tryCatchPattern: null,
  preventionTips: [],
  tags: ["docker"],
  backgroundTag: null,
  analyzedSha: "a".repeat(40),
  analyzedAt: "2026-08-01T00:00:00.000Z",
  schemaVersion: 2,
};

describe("parseReviewTarget", () => {
  it("accepts page URLs and bare owner/repo/slug", () => {
    expect(
      parseReviewTarget("https://errors.standardbeagle.com/docker/cli/cannot-attach-stdin-to-a-tty-enabled-container-bec/")
    ).toEqual({ repo: "docker/cli", slug: "cannot-attach-stdin-to-a-tty-enabled-container-bec" });
    expect(parseReviewTarget("docker/cli/some-slug")).toEqual({ repo: "docker/cli", slug: "some-slug" });
  });

  it("rejects anything that does not name exactly one record", () => {
    expect(parseReviewTarget("docker/cli")).toBeNull();
    expect(parseReviewTarget("https://errors.standardbeagle.com/about/")).toBeNull();
    expect(parseReviewTarget("a/b/c/d")).toBeNull();
  });
});

describe("runReviewOne", () => {
  function scratch(): string {
    return mkdtempSync(join(tmpdir(), "review-test-"));
  }

  it("applies validated patches and reports improved", async () => {
    const dir = scratch();
    const p = new FixtureProvider("p", {
      quality: "improved",
      notes: "solutions were vague",
      patches: [
        { field: "documentation", value: "Docker refuses to attach stdin when the container was created with tty enabled but no open stdin stream." },
        { field: "solutions", value: ["Recreate the container with -i", "Use docker exec -it instead"] },
      ],
    });
    const r = await runReviewOne(ENTRY, { p }, cfg(), dir);
    expect(r.quality).toBe("improved");
    expect(r.entry.solutions).toEqual(["Recreate the container with -i", "Use docker exec -it instead"]);
    expect(r.entry.documentation).toContain("attach stdin");
    expect(r.patches.every((x) => x.id === ENTRY.id)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the record untouched on quality=good", async () => {
    const dir = scratch();
    const r = await runReviewOne(ENTRY, { p: new FixtureProvider("p", { quality: "good", notes: "", patches: [] }) }, cfg(), dir);
    expect(r.quality).toBe("good");
    expect(r.entry).toEqual(ENTRY);
    rmSync(dir, { recursive: true, force: true });
  });

  it("never patches around a defective record", async () => {
    const dir = scratch();
    const r = await runReviewOne(
      ENTRY,
      { p: new FixtureProvider("p", { quality: "defective", notes: "message not in source", patches: [{ field: "documentation", value: "x" }] }) },
      cfg(),
      dir
    );
    expect(r.quality).toBe("defective");
    expect(r.patches).toEqual([]);
    expect(r.entry).toEqual(ENTRY);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects the whole patch set when re-validation fails", async () => {
    const dir = scratch();
    const r = await runReviewOne(
      ENTRY,
      // solutions must be an array of strings — a bare string breaks the schema
      { p: new FixtureProvider("p", { quality: "improved", notes: "n", patches: [{ field: "solutions", value: "not-an-array" }] }) },
      cfg(),
      dir
    );
    expect(r.patches).toEqual([]);
    expect(r.entry).toEqual(ENTRY);
    expect(r.notes).toContain("rejected");
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws on a missing or nonsense verdict", async () => {
    const dir = scratch();
    await expect(
      runReviewOne(ENTRY, { p: new FixtureProvider("p", { quality: "excellent" }) }, cfg(), dir)
    ).rejects.toThrow(/no usable verdict/);
    rmSync(dir, { recursive: true, force: true });
  });
});

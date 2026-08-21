import { describe, it, expect } from "vitest";
import { writeFileSync, rmSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { tmpRepo, disposeRepo } from "./tmp-repo.js";
import { openDb } from "../src/db/client.js";
import { errors, repositories } from "../src/db/schema.js";
import { analyzeRepo } from "../src/pipeline.js";
import { mapConfig } from "../src/config/index.js";
import { parseKdl } from "../src/config/kdl.js";
import type { LlmProvider, InvokeOptions, ProviderResult } from "../src/provider/types.js";

const exec = promisify(execFile);
const REPO = "acme/widgets";

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
  return stdout.trim();
}

function pad(n: number): string {
  return Array.from({ length: n }, (_, i) => `// line ${i + 1}`).join("\n");
}

/**
 * Deterministic stand-in for the model: discovery echoes every candidate it is
 * shown (message = the candidate's string literal), analysis documents each
 * error from its message, verify has nothing to patch. Every prompt is kept so
 * the test can assert what the provider was — and was not — asked about.
 */
class EchoProvider implements LlmProvider {
  readonly name = "echo";
  prompts: string[] = [];
  async invoke(prompt: string, _o: InvokeOptions): Promise<ProviderResult> {
    this.prompts.push(prompt);
    if (prompt.includes("CANDIDATES:")) {
      const block = prompt.slice(prompt.indexOf("CANDIDATES:") + 11, prompt.indexOf("RULES:"));
      const cands = JSON.parse(block.trim()) as { file: string; line: number; literal: string | null }[];
      const errs = cands.map((c) => ({ message: c.literal ?? "?", type: "exception", file: c.file, line: c.line, code: null }));
      return { ok: true, parsed: { errors: errs }, raw: JSON.stringify({ errors: errs }) };
    }
    if (prompt.includes("Analyze each of these")) {
      const entries = [...prompt.matchAll(/^\[(\d+)\] message="([^"]+)"/gm)].map((m) => ({ i: Number(m[1]), msg: m[2]! }));
      const enriched = entries.map(({ i, msg }) => ({
        errorIndex: i,
        documentation: `doc for ${msg}`,
        triggerScenarios: `when ${msg}`,
        commonSituations: "often",
        solutions: ["fix it"],
        exampleFix: null,
        severity: "error",
        tags: ["test"],
        backgroundTag: null,
      }));
      const defenseStrategies = entries.map(({ i }) => ({
        errorIndex: i,
        handlingStrategy: "try-catch",
        validationCode: null,
        typeGuard: null,
        tryCatchPattern: "try {} catch {}",
        preventionTips: ["check input"],
      }));
      return { ok: true, parsed: { enriched, defenseStrategies }, raw: "" };
    }
    if (prompt.includes("Review these assembled")) return { ok: true, parsed: { patches: [] }, raw: "" };
    return { ok: false, kind: "parse", error: `unexpected prompt: ${prompt.slice(0, 60)}` };
  }
}

function cfg() {
  return mapConfig(parseKdl(['provider "echo" { command "echo" }', "defaults {", '  primary "echo"', "}"].join("\n")));
}

describe("incremental rescan", () => {
  it("reviews only the changed hunks; carries over, re-anchors, reuses and drops published records", { timeout: 60_000 }, async () => {
    const src = tmpRepo("el-incr-src-");
    const dbPath = resolve(".tmp-test", `incremental-${process.pid}.db`);
    rmSync(dbPath, { force: true });
    const { db, raw } = openDb(dbPath);
    try {
      // v1: three files, one throw each.
      writeFileSync(join(src, "index.js"), `${pad(17)}\nthrow new TypeError('Expected a function');\n`);
      mkdirSync(join(src, "source"));
      writeFileSync(join(src, "source", "is.js"), `${pad(41)}\nthrow new Error('Expected object, received it');\n`);
      mkdirSync(join(src, "lib"));
      writeFileSync(join(src, "lib", "a.js"), `${pad(4)}\nthrow new Error('alpha failed badly');\n`);
      await git(src, "init", "-q", "-b", "main");
      await git(src, "config", "uploadpack.allowAnySHA1InWant", "true");
      await git(src, "add", ".");
      await git(src, "commit", "-q", "-m", "v1");
      const v1 = await git(src, "rev-parse", "HEAD");

      const p1 = new EchoProvider();
      const r1 = await analyzeRepo(REPO, { db, providers: { echo: p1 }, cfg: cfg(), cloneUrlOverride: src });
      expect(r1.failed).toBeUndefined();
      expect(r1.incremental).toBeUndefined();
      expect(r1.errorCount).toBe(3);
      const v1Rows = db.select().from(errors).where(eq(errors.repo, REPO)).all();
      const byMsg = (rows: typeof v1Rows) => new Map(rows.map((r) => [r.errorMessage, r]));
      const m1 = byMsg(v1Rows);
      expect(m1.get("Expected a function")!.lineNumber).toBe(18);

      // v2: shift index.js (untouched site moves), rewrite a.js's message
      // (touched site, new identity), add b.js (new file), leave is.js alone.
      writeFileSync(join(src, "index.js"), `// added 1\n// added 2\n// added 3\n// added 4\n// added 5\n${readFileSync(join(src, "index.js"), "utf8")}`);
      writeFileSync(join(src, "lib", "a.js"), `${pad(4)}\nthrow new Error('alpha exploded badly');\n`);
      writeFileSync(join(src, "lib", "b.js"), `${pad(2)}\nthrow new Error('beta failed badly');\n`);
      await git(src, "add", ".");
      await git(src, "commit", "-q", "-m", "v2");
      const v2 = await git(src, "rev-parse", "HEAD");

      const p2 = new EchoProvider();
      const logs: string[] = [];
      const r2 = await analyzeRepo(REPO, { db, providers: { echo: p2 }, cfg: cfg(), cloneUrlOverride: src, onLog: (m) => logs.push(m) });
      expect(r2.failed).toBeUndefined();
      expect(r2.incremental, logs.join("\n")).toEqual({ carriedOver: 1, remapped: 1, dropped: 1, reused: 0, fresh: 2 });
      expect(r2.errorCount).toBe(4);

      // The provider saw only the reviewed hunks: a.js and b.js, never index.js or is.js.
      const discoveryPrompts = p2.prompts.filter((p) => p.includes("CANDIDATES:"));
      expect(discoveryPrompts.length).toBeGreaterThan(0);
      for (const p of discoveryPrompts) {
        expect(p).not.toContain("index.js");
        expect(p).not.toContain("source/is.js");
      }
      const analysisPrompts = p2.prompts.filter((p) => p.includes("Analyze each of these"));
      expect(analysisPrompts).toHaveLength(1);
      expect(analysisPrompts[0]).toContain("Analyze each of these 2 errors");

      const v2Rows = db.select().from(errors).where(eq(errors.repo, REPO)).all();
      const m2 = byMsg(v2Rows);
      expect([...m2.keys()].sort()).toEqual(["Expected a function", "Expected object, received it", "alpha exploded badly", "beta failed badly"]);
      // carried over verbatim (still pinned to v1 — the file did not change)
      expect(m2.get("Expected object, received it")).toEqual({ ...m1.get("Expected object, received it")!, updatedAt: expect.any(Number) });
      // re-anchored: same identity and docs, new line, source and permalink at v2
      const moved = m2.get("Expected a function")!;
      expect(moved.id).toBe(m1.get("Expected a function")!.id);
      expect(moved.documentation).toBe(m1.get("Expected a function")!.documentation);
      expect(moved.lineNumber).toBe(23);
      expect(moved.analyzedSha).toBe(v2);
      expect(moved.githubUrl).toContain(v2);
      expect(moved.sourceCode).toContain("throw new TypeError");
      // fresh: documented by the provider this run
      expect(m2.get("alpha exploded badly")!.documentation).toBe("doc for alpha exploded badly");
      expect(m2.get("beta failed badly")!.analyzedSha).toBe(v2);
      const repoRow = db.select().from(repositories).where(eq(repositories.repo, REPO)).get()!;
      expect(repoRow.analyzedSha).toBe(v2);
      expect(repoRow.errorCount).toBe(4);
      expect(logs.some((l) => l.startsWith("incremental from " + v1.slice(0, 8)))).toBe(true);

      // v3: edit right next to b.js's throw (touched, same identity → reused,
      // no analysis call) and delete is.js (dropped).
      writeFileSync(join(src, "lib", "b.js"), `${pad(2)}\n// explain\nthrow new Error('beta failed badly');\n`);
      unlinkSync(join(src, "source", "is.js"));
      await git(src, "add", "-A");
      await git(src, "commit", "-q", "-m", "v3");
      const v3 = await git(src, "rev-parse", "HEAD");

      const p3 = new EchoProvider();
      const r3 = await analyzeRepo(REPO, { db, providers: { echo: p3 }, cfg: cfg(), cloneUrlOverride: src });
      expect(r3.failed).toBeUndefined();
      expect(r3.incremental).toEqual({ carriedOver: 2, remapped: 0, dropped: 2, reused: 1, fresh: 0 });
      expect(p3.prompts.filter((p) => p.includes("Analyze each of these"))).toHaveLength(0);
      const v3Rows = db.select().from(errors).where(eq(errors.repo, REPO)).all();
      const m3 = byMsg(v3Rows);
      expect([...m3.keys()].sort()).toEqual(["Expected a function", "alpha exploded badly", "beta failed badly"]);
      const beta = m3.get("beta failed badly")!;
      expect(beta.id).toBe(m2.get("beta failed badly")!.id);
      expect(beta.documentation).toBe("doc for beta failed badly");
      expect(beta.lineNumber).toBe(4);
      expect(beta.analyzedSha).toBe(v3);
      expect(db.select().from(repositories).where(eq(repositories.repo, REPO)).get()!.analyzedSha).toBe(v3);
    } finally {
      raw.close();
      disposeRepo(src);
    }
  });

  it("falls back to a full analysis when the published SHA cannot be fetched", { timeout: 60_000 }, async () => {
    const src = tmpRepo("el-incr-src2-");
    const dbPath = resolve(".tmp-test", `incremental-full-${process.pid}.db`);
    rmSync(dbPath, { force: true });
    const { db, raw } = openDb(dbPath);
    try {
      writeFileSync(join(src, "index.js"), `${pad(3)}\nthrow new Error('first thing broke');\n`);
      await git(src, "init", "-q", "-b", "main");
      await git(src, "config", "uploadpack.allowAnySHA1InWant", "true");
      await git(src, "add", ".");
      await git(src, "commit", "-q", "-m", "v1");
      await analyzeRepo(REPO, { db, providers: { echo: new EchoProvider() }, cfg: cfg(), cloneUrlOverride: src });

      // Rewrite history: the published SHA no longer exists upstream.
      writeFileSync(join(src, "index.js"), `${pad(3)}\nthrow new Error('first thing broke');\n${pad(10)}\nthrow new Error('second thing broke');\n`);
      await git(src, "add", ".");
      await git(src, "commit", "-q", "--amend", "-m", "rewritten");
      await git(src, "reflog", "expire", "--expire=now", "--all");
      await git(src, "gc", "-q", "--prune=now");

      const logs: string[] = [];
      const r = await analyzeRepo(REPO, { db, providers: { echo: new EchoProvider() }, cfg: cfg(), cloneUrlOverride: src, onLog: (m) => logs.push(m) });
      expect(r.failed).toBeUndefined();
      expect(r.incremental).toBeUndefined();
      expect(r.errorCount, logs.join("\n")).toBe(2);
      expect(logs.some((l) => l.includes("cannot diff against published") && l.includes("full analysis"))).toBe(true);
    } finally {
      raw.close();
      disposeRepo(src);
    }
  });
});

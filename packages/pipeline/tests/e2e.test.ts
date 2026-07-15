import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openDb } from "../src/db/client.js";
import { errors, jobHistory } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { analyzeRepo } from "../src/pipeline.js";
import { ScriptedProvider } from "../src/provider/fixture.js";
import { mapConfig } from "../src/config/index.js";
import { parseKdl } from "../src/config/kdl.js";
import { validateErrorEntry } from "@errlookup/schema";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(__dirname, "..", "fixtures");
const fx = (n: string) => resolve(fixtureDir, n);

async function makeLocalRepo(): Promise<{ path: string; sha: string }> {
  const dir = mkdtempSync(join(tmpdir(), "el-e2e-"));
  // index.js with a throw at line 18 (pad to reach the right line)
  const indexJs = Array.from({ length: 17 }, (_, i) => `// line ${i + 1}`).join("\n") + "\nthrow new TypeError('Expected a function');\n";
  writeFileSync(join(dir, "index.js"), indexJs);
  mkdirSync(join(dir, "source"), { recursive: true });
  writeFileSync(
    join(dir, "source", "is.js"),
    Array.from({ length: 41 }, (_, i) => `// line ${i + 1}`).join("\n") + "\nthrow new Error('Expected object, received ' + value);\n"
  );
  await exec("git", ["init", "-q", "-b", "main", dir]);
  await exec("git", ["-C", dir, "add", "."]);
  await exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  const { stdout } = await exec("git", ["-C", dir, "rev-parse", "HEAD"]);
  return { path: dir, sha: stdout.trim() };
}

function makeCfg() {
  return mapConfig(
    parseKdl(['provider "claude" { command "claude" }', "defaults {", '  primary "claude"', "}"].join("\n"))
  );
}

describe("pipeline e2e (fixture-replay)", () => {
  it("runs discovery + enrichment → valid records in DB, SHA-pinned URLs", async () => {
    const local = await makeLocalRepo();
    const dbPath = resolve(".tmp-test", `e2e-${process.pid}.db`);
    rmSync(dbPath, { force: true });
    const { db, raw } = openDb(dbPath);
    const providers = {
      claude: new ScriptedProvider("claude", [
        { match: "Enrich each", fixturePath: fx("provider-stdout-enriched.json") },
        { match: "error patterns", fixturePath: fx("provider-stdout-clean.json") },
      ]),
    };
    const logs: string[] = [];
    const res = await analyzeRepo("sindresorhus/is", {
      db,
      providers,
      cfg: makeCfg(),
      repoPath: local.path,
      sha: local.sha,
      onLog: (m) => logs.push(m),
    });

    expect(res.errorCount).toBe(2);
    expect(res.rejects).toHaveLength(0);

    const rows = db.select().from(errors).where(eq(errors.repo, "sindresorhus/is")).all();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      // every DB row re-validates against the schema
      const v = validateErrorEntry({
        id: r.id,
        repo: r.repo,
        slug: r.slug,
        errorCode: r.errorCode,
        errorMessage: r.errorMessage,
        messagePattern: r.messagePattern,
        errorType: r.errorType,
        errorClass: r.errorClass,
        httpStatus: r.httpStatus,
        severity: r.severity,
        filePath: r.filePath,
        lineNumber: r.lineNumber,
        sourceCode: r.sourceCode,
        sourceCodeStart: r.sourceCodeStart,
        sourceCodeEnd: r.sourceCodeEnd,
        githubUrl: r.githubUrl,
        documentation: r.documentation,
        triggerScenarios: r.triggerScenarios,
        commonSituations: r.commonSituations,
        solutions: r.solutions,
        exampleFix: r.exampleFix,
        handlingStrategy: r.handlingStrategy,
        validationCode: r.validationCode,
        typeGuard: r.typeGuard,
        tryCatchPattern: r.tryCatchPattern,
        preventionTips: r.preventionTips,
        tags: r.tags,
        analyzedSha: r.analyzedSha,
        analyzedAt: r.analyzedAt,
        schemaVersion: r.schemaVersion,
      });
      expect(v.ok, v.ok ? "" : JSON.stringify((v as { error: { issues: unknown[] } }).error.issues)).toBe(true);
      // SHA-pinned permalink (NOT branch-relative)
      expect(r.githubUrl).toContain(`/blob/${local.sha}/`);
      expect(r.githubUrl).not.toContain("/blob/main/");
    }

    // job_history recorded both phases as success
    const jobs = db.select().from(jobHistory).all();
    const successes = jobs.filter((j) => j.status === "success");
    expect(successes.map((j) => j.phase).sort()).toEqual(["discovery", "enrichment"]);

    raw.close();
    rmSync(local.path, { recursive: true, force: true });
    rmSync(dbPath, { force: true });
  }, 60000);

  it("resumes: second run skips phases for the same SHA (idempotent)", async () => {
    const local = await makeLocalRepo();
    const dbPath = resolve(".tmp-test", `e2e-resume-${process.pid}.db`);
    rmSync(dbPath, { force: true });
    const { db, raw } = openDb(dbPath);
    let calls = 0;
    const providers = {
      claude: {
        name: "claude",
        async invoke(prompt: string) {
          calls++;
          const p = new ScriptedProvider("claude", [
            { match: "Enrich each", fixturePath: fx("provider-stdout-enriched.json") },
            { match: "error patterns", fixturePath: fx("provider-stdout-clean.json") },
          ]);
          return p.invoke(prompt, { cwd: "." });
        },
      },
    };

    await analyzeRepo("sindresorhus/is", {
      db,
      providers,
      cfg: makeCfg(),
      repoPath: local.path,
      sha: local.sha,
    });
    const callsAfterFirst = calls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // second run, same SHA, no force → must not invoke the provider again
    const res2 = await analyzeRepo("sindresorhus/is", {
      db,
      providers,
      cfg: makeCfg(),
      repoPath: local.path,
      sha: local.sha,
    });
    expect(calls).toBe(callsAfterFirst);
    expect(res2.skipped).toContain("discovery");
    expect(res2.skipped).toContain("enrichment");

    raw.close();
    rmSync(local.path, { recursive: true, force: true });
    rmSync(dbPath, { force: true });
  }, 60000);
});

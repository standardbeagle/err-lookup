import { createHash } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  renameSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { repositories, errors } from "../db/schema.js";
import {
  CURRENT_SCHEMA_VERSION,
  validateErrorEntry,
  validateRepoEntry,
  type ErrorEntry,
  type RepoEntry,
} from "@errlookup/schema";

export interface ExportOptions {
  /** Target dir for the published dataset (default packages/site/public/data). */
  outDir?: string;
  /** Override the datasetVersion (defaults to now, monotonic). */
  datasetVersion?: string;
}

interface IndexError {
  id: string;
  repo: string;
  slug: string;
  code: string | null;
  msg: string;
  pattern: string;
  type: string;
  cls: string | null;
  tags: string[];
  sev: string;
}

interface RepoIndex extends RepoEntry {}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function rowToErrorEntry(r: typeof errors.$inferSelect): ErrorEntry {
  return {
    id: r.id,
    repo: r.repo,
    slug: r.slug,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    messagePattern: r.messagePattern,
    errorType: r.errorType as ErrorEntry["errorType"],
    errorClass: r.errorClass,
    httpStatus: r.httpStatus,
    severity: r.severity as ErrorEntry["severity"],
    filePath: r.filePath,
    lineNumber: r.lineNumber,
    sourceCode: r.sourceCode,
    sourceCodeStart: r.sourceCodeStart,
    sourceCodeEnd: r.sourceCodeEnd,
    githubUrl: r.githubUrl,
    documentation: r.documentation ?? "",
    triggerScenarios: r.triggerScenarios ?? "",
    commonSituations: r.commonSituations ?? "",
    solutions: r.solutions ?? [],
    exampleFix: r.exampleFix,
    handlingStrategy: (r.handlingStrategy as ErrorEntry["handlingStrategy"]) ?? null,
    validationCode: r.validationCode,
    typeGuard: r.typeGuard,
    tryCatchPattern: r.tryCatchPattern,
    preventionTips: r.preventionTips ?? [],
    tags: r.tags ?? [],
    analyzedSha: r.analyzedSha,
    analyzedAt: r.analyzedAt,
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
}

function rowToRepoEntry(r: typeof repositories.$inferSelect): RepoEntry {
  return {
    repo: r.repo,
    description: r.description,
    language: r.language,
    stars: r.stars,
    defaultBranch: r.defaultBranch,
    analyzedSha: r.analyzedSha ?? "",
    analyzedAt: r.analyzedAt ?? "",
    errorCount: r.errorCount,
  };
}

/** Read all analyzed repos + their errors from the working DB. */
export function readDataset(db: Db): {
  repos: RepoEntry[];
  errorsByRepo: Map<string, ErrorEntry[]>;
} {
  const repoRows = db
    .select()
    .from(repositories)
    .where(eq(repositories.status, "analyzed"))
    .all()
    .filter((r) => r.analyzedSha !== null);
  const repos = repoRows.map(rowToRepoEntry);
  const errorsByRepo = new Map<string, ErrorEntry[]>();
  for (const repo of repos) {
    const rows = db.select().from(errors).where(eq(errors.repo, repo.repo)).all();
    errorsByRepo.set(repo.repo, rows.map(rowToErrorEntry));
  }
  return { repos, errorsByRepo };
}

interface FileOut {
  relPath: string;
  content: string;
}

/**
 * Build the full static dataset (§5). Validates every record against the zod
 * schema; invalid records are dropped (and counted in `rejected`) rather than
 * corrupting the dataset.
 */
export function buildDataset(
  db: Db,
  opts: ExportOptions = {}
): {
  files: FileOut[];
  manifest: object;
  counts: { repos: number; errors: number; rejected: number };
} {
  const { repos, errorsByRepo } = readDataset(db);
  const datasetVersion = opts.datasetVersion ?? new Date().toISOString();

  const validRepos: RepoEntry[] = [];
  let rejected = 0;
  for (const r of repos) {
    const v = validateRepoEntry(r);
    if (v.ok) validRepos.push(v.value);
    else rejected++;
  }

  const allErrors: ErrorEntry[] = [];
  const repoFiles: FileOut[] = [];
  const errorFiles: FileOut[] = [];
  for (const r of validRepos) {
    const rows = errorsByRepo.get(r.repo) ?? [];
    const valid: ErrorEntry[] = [];
    for (const e of rows) {
      const v = validateErrorEntry(e);
      if (v.ok) valid.push(v.value);
      else rejected++;
    }
    allErrors.push(...valid);
    const [owner, name] = r.repo.split("/");
    repoFiles.push({
      relPath: `repos/${owner}/${name}.json`,
      content: JSON.stringify(valid),
    });
    for (const e of valid) {
      errorFiles.push({ relPath: `errors/${e.id}.json`, content: JSON.stringify(e) });
    }
  }

  // index.json — compact search index (§5.2)
  const indexErrors: IndexError[] = allErrors.map((e) => ({
    id: e.id,
    repo: e.repo,
    slug: e.slug,
    code: e.errorCode,
    msg: e.errorMessage,
    pattern: e.messagePattern,
    type: e.errorType,
    cls: e.errorClass,
    tags: e.tags,
    sev: e.severity,
  }));
  const indexJson = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    datasetVersion,
    errors: indexErrors,
  };

  const reposJson = validRepos;

  // manifest.json — MCP freshness poll target (§5.1)
  const indexStr = JSON.stringify(indexJson);
  const reposStr = JSON.stringify(reposJson);
  const files: FileOut[] = [
    { relPath: "index.json", content: indexStr },
    { relPath: "repos.json", content: reposStr },
    ...repoFiles,
    ...errorFiles,
  ];

  const inventory: Record<string, { path: string; bytes: number; sha256: string }> = {
    index: { path: "/data/index.json", bytes: Buffer.byteLength(indexStr), sha256: sha256(indexStr) },
    repos: { path: "/data/repos.json", bytes: Buffer.byteLength(reposStr), sha256: sha256(reposStr) },
  };

  const manifest = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    datasetVersion,
    counts: { repos: validRepos.length, errors: allErrors.length },
    files: inventory,
  };
  files.unshift({ relPath: "manifest.json", content: JSON.stringify(manifest) });

  return { files, manifest, counts: { repos: validRepos.length, errors: allErrors.length, rejected } };
}

/**
 * Atomically publish the dataset (§5.3): write to `<outDir>.tmp/`, then rename
 * over `<outDir>`. Never publishes a partial dataset. Returns the manifest.
 */
export function publishDataset(
  db: Db,
  opts: ExportOptions = {}
): { manifest: object; counts: { repos: number; errors: number; rejected: number } } {
  const outDir = resolve(opts.outDir ?? defaultOutDir());
  const tmpDir = `${outDir}.tmp-${process.pid}`;

  // Build + validate into the temp dir first.
  const { files, manifest, counts } = buildDataset(db, opts);

  rmSync(tmpDir, { recursive: true, force: true });
  for (const f of files) {
    const abs = join(tmpDir, f.relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, "utf8");
  }

  // Atomic swap: move current outDir aside, move tmp into place, remove old.
  const backup = `${outDir}.old-${process.pid}`;
  rmSync(backup, { recursive: true, force: true });
  if (existsSync(outDir)) renameSync(outDir, backup);
  renameSync(tmpDir, outDir);
  rmSync(backup, { recursive: true, force: true });

  return { manifest, counts };
}

function defaultOutDir(): string {
  // §5: packages/site/public/data (from repo root). Created on first export.
  return resolve(process.cwd(), "packages", "site", "public", "data");
}

// re-export for tests / CLI
export { defaultOutDir as resolveDefaultOutDir };

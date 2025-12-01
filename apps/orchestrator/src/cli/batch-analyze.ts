#!/usr/bin/env tsx

/**
 * Batch analyzer for multiple repositories
 * Usage: pnpm batch-analyze [--phase N] [--dry-run]
 */

import { analyzeRepository, checkClaudeAvailable } from "../services/claude.js";
import {
  cloneRepository,
  cleanupRepository,
  detectRepoLanguage,
  getLatestCommitSha,
  parseRepoUrl,
  fetchRepoInfo,
} from "../services/github.js";
import { db, schema } from "../db/client.js";
import { eq } from "drizzle-orm";

// Projects organized by analysis phase
const PROJECTS_BY_PHASE: Record<number, string[]> = {
  // Phase 0: Quick test with smaller libraries
  0: [
    "https://github.com/sindresorhus/is",
    "https://github.com/sindresorhus/ky",
    "https://github.com/chalk/chalk",
    "https://github.com/sindresorhus/got",
    "https://github.com/lukeed/kleur",
  ],
  // Phase 1: Foundation (HTTP/Network focus) - LARGE CODEBASES
  1: [
    "https://github.com/axios/axios",
    "https://github.com/psf/requests",
    "https://github.com/curl/curl",
  ],
  // Phase 2: Database/Storage
  2: [
    "https://github.com/prisma/prisma",
    "https://github.com/redis/redis",
    "https://github.com/sqlalchemy/sqlalchemy",
  ],
  // Phase 3: Web Frameworks
  3: [
    "https://github.com/expressjs/express",
    "https://github.com/pallets/flask",
    "https://github.com/vercel/next.js",
  ],
  // Phase 4: CLI/Systems
  4: [
    "https://github.com/docker/cli",
    "https://github.com/hashicorp/terraform",
    "https://github.com/gohugoio/hugo",
  ],
  // Phase 5: Languages/Compilers
  5: [
    "https://github.com/rust-lang/rust",
    "https://github.com/golang/go",
    "https://github.com/clap-rs/clap",
  ],
  // Phase 6: Complex Systems
  6: [
    "https://github.com/tokio-rs/tokio",
    "https://github.com/apache/kafka",
    "https://github.com/elastic/elasticsearch",
    "https://github.com/kubernetes/kubernetes",
    "https://github.com/sindresorhus/is",
  ],
};

interface AnalysisResult {
  repo: string;
  success: boolean;
  errorCount?: number;
  duration?: number;
  error?: string;
}

async function analyzeRepo(repoUrl: string): Promise<AnalysisResult> {
  const startTime = Date.now();
  let repoPath: string | null = null;

  try {
    const { owner, repo } = parseRepoUrl(repoUrl);
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Analyzing: ${owner}/${repo}`);
    console.log("=".repeat(60));

    // Fetch repo info
    console.log("  Fetching repository info...");
    const repoInfo = await fetchRepoInfo(owner, repo);

    // Check/create database entry
    let dbRepo = await db.query.repositories.findFirst({
      where: eq(schema.repositories.githubId, repoInfo.id),
    });

    if (!dbRepo) {
      const [inserted] = await db
        .insert(schema.repositories)
        .values({
          githubId: repoInfo.id,
          fullName: repoInfo.full_name,
          description: repoInfo.description || null,
          language: repoInfo.language?.toLowerCase() || "unknown",
          stars: repoInfo.stargazers_count,
          status: "pending",
        })
        .returning();
      dbRepo = inserted;
      console.log(`  Created database entry: ID ${dbRepo.id}`);
    } else {
      console.log(`  Found existing entry: ID ${dbRepo.id}`);
    }

    // Clone repository
    console.log("  Cloning repository...");
    repoPath = await cloneRepository(repoUrl);

    // Detect language and get SHA
    const language = await detectRepoLanguage(repoPath);
    const sha = await getLatestCommitSha(repoPath);
    console.log(`  Language: ${language}, SHA: ${sha.slice(0, 8)}`);

    // Analyze with Claude
    console.log("  Analyzing with Claude CLI...");
    const analysis = await analyzeRepository(repoPath, language);
    const duration = (Date.now() - startTime) / 1000;

    console.log(`  Found ${analysis.errors.length} errors in ${duration.toFixed(1)}s`);

    // Save to database
    console.log("  Saving to database...");
    await db.delete(schema.errors).where(eq(schema.errors.repoId, dbRepo.id));

    if (analysis.errors.length > 0) {
      await db.insert(schema.errors).values(
        analysis.errors.map((error) => ({
          repoId: dbRepo.id,
          errorCode: error.code || null,
          errorMessage: error.message,
          errorType: error.type,
          filePath: error.file,
          lineNumber: error.line || null,
          context: error.context || null,
          documentation: error.cause || null,
          solutions: error.resolution ? [error.resolution] : null,
          triggerScenarios: error.triggerScenarios || null,
          commonSituations: error.commonSituations?.join("\n") || null,
          exampleFix: error.exampleFix || null,
          severity: error.severity || "error",
          httpStatus: error.httpStatus || null,
          tags: error.tags || null,
        }))
      );
    }

    // Update repository status
    await db
      .update(schema.repositories)
      .set({
        status: "completed",
        lastAnalyzedAt: new Date(),
        lastAnalyzedSha: sha,
        errorCount: analysis.errors.length,
        language,
        updatedAt: new Date(),
      })
      .where(eq(schema.repositories.id, dbRepo.id));

    // Log to job history
    await db.insert(schema.jobHistory).values({
      repoId: dbRepo.id,
      jobType: "batch-analyze",
      status: "completed",
      startedAt: new Date(startTime),
      completedAt: new Date(),
      metadata: JSON.stringify({
        language,
        sha,
        errorCount: analysis.errors.length,
        durationSeconds: duration,
      }),
    });

    console.log(`  Done! Saved ${analysis.errors.length} errors`);

    return {
      repo: `${owner}/${repo}`,
      success: true,
      errorCount: analysis.errors.length,
      duration,
    };
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`  ERROR: ${errorMessage}`);

    return {
      repo: repoUrl,
      success: false,
      duration,
      error: errorMessage,
    };
  } finally {
    if (repoPath) {
      console.log("  Cleaning up...");
      await cleanupRepository(repoPath);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const phaseArg = args.find((a) => a.startsWith("--phase="));
  const selectedPhase = phaseArg ? parseInt(phaseArg.split("=")[1]) : null;

  console.log("ErrLookup Batch Analyzer");
  console.log("========================\n");

  if (dryRun) {
    console.log("DRY RUN MODE - No analysis will be performed\n");
  }

  // Determine which projects to analyze
  let projectsToAnalyze: string[] = [];

  if (selectedPhase !== null) {
    if (!PROJECTS_BY_PHASE[selectedPhase]) {
      console.error(`Invalid phase: ${selectedPhase}. Valid phases: 0-6`);
      process.exit(1);
    }
    projectsToAnalyze = PROJECTS_BY_PHASE[selectedPhase];
    console.log(`Phase ${selectedPhase}: ${projectsToAnalyze.length} projects`);
  } else {
    // All projects
    for (const projects of Object.values(PROJECTS_BY_PHASE)) {
      projectsToAnalyze.push(...projects);
    }
    console.log(`All phases: ${projectsToAnalyze.length} projects total`);
  }

  console.log("\nProjects to analyze:");
  projectsToAnalyze.forEach((url, i) => {
    const { owner, repo } = parseRepoUrl(url);
    console.log(`  ${i + 1}. ${owner}/${repo}`);
  });

  if (dryRun) {
    console.log("\nDry run complete. Use without --dry-run to execute.");
    process.exit(0);
  }

  // Check Claude CLI
  console.log("\nChecking Claude CLI availability...");
  const claudeAvailable = await checkClaudeAvailable();
  if (!claudeAvailable) {
    console.error("ERROR: Claude CLI is not available");
    process.exit(1);
  }
  console.log("Claude CLI is ready!\n");

  // Run analyses
  const results: AnalysisResult[] = [];
  const startTime = Date.now();

  for (let i = 0; i < projectsToAnalyze.length; i++) {
    const url = projectsToAnalyze[i];
    console.log(`\nProgress: ${i + 1}/${projectsToAnalyze.length}`);

    const result = await analyzeRepo(url);
    results.push(result);

    // Brief pause between analyses to be nice to APIs
    if (i < projectsToAnalyze.length - 1) {
      console.log("\n  Waiting 5s before next analysis...");
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // Print summary
  const totalDuration = (Date.now() - startTime) / 1000;
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  const totalErrors = successful.reduce((sum, r) => sum + (r.errorCount || 0), 0);

  console.log("\n" + "=".repeat(60));
  console.log("BATCH ANALYSIS COMPLETE");
  console.log("=".repeat(60));
  console.log(`\nTotal time: ${(totalDuration / 60).toFixed(1)} minutes`);
  console.log(`Successful: ${successful.length}/${results.length}`);
  console.log(`Total errors documented: ${totalErrors}`);

  if (failed.length > 0) {
    console.log("\nFailed repositories:");
    for (const f of failed) {
      console.log(`  - ${f.repo}: ${f.error}`);
    }
  }

  console.log("\nSuccessful repositories:");
  for (const s of successful) {
    console.log(`  - ${s.repo}: ${s.errorCount} errors (${s.duration?.toFixed(1)}s)`);
  }

  console.log("\nNext steps:");
  console.log("  1. pnpm --filter @err-lookup/site-generator generate -- --all");
  console.log("  2. Review generated sites in /sites/");

  process.exit(failed.length > 0 ? 1 : 0);
}

main();

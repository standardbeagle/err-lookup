#!/usr/bin/env tsx

/**
 * Manual CLI for analyzing a single repository
 * Usage: pnpm analyze <repo-url>
 * Example: pnpm analyze https://github.com/axios/axios
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

async function main() {
  const repoUrl = process.argv[2];

  if (!repoUrl) {
    console.error("Usage: pnpm analyze <repo-url>");
    console.error("Example: pnpm analyze https://github.com/axios/axios");
    process.exit(1);
  }

  console.log(`Analyzing repository: ${repoUrl}`);

  // Check Claude CLI
  const claudeAvailable = await checkClaudeAvailable();
  if (!claudeAvailable) {
    console.error("ERROR: Claude CLI is not available");
    process.exit(1);
  }

  let repoPath: string | null = null;

  try {
    // Parse repo URL
    const { owner, repo } = parseRepoUrl(repoUrl);
    console.log(`Repository: ${owner}/${repo}`);

    // Fetch repo info from GitHub
    console.log("Fetching repository info...");
    const repoInfo = await fetchRepoInfo(owner, repo);

    // Check if repo exists in database
    let dbRepo = await db.query.repositories.findFirst({
      where: eq(schema.repositories.githubId, repoInfo.id),
    });

    if (!dbRepo) {
      // Insert new repository
      const [inserted] = await db
        .insert(schema.repositories)
        .values({
          githubId: repoInfo.id,
          fullName: repoInfo.full_name,
          language: repoInfo.language?.toLowerCase() || "unknown",
          stars: repoInfo.stargazers_count,
          status: "pending",
        })
        .returning();
      dbRepo = inserted;
      console.log(`Created new repository entry: ID ${dbRepo.id}`);
    }

    // Clone repository
    console.log("Cloning repository...");
    repoPath = await cloneRepository(repoUrl);
    console.log(`Cloned to: ${repoPath}`);

    // Detect language
    const language = await detectRepoLanguage(repoPath);
    const sha = await getLatestCommitSha(repoPath);
    console.log(`Detected language: ${language}`);
    console.log(`Commit SHA: ${sha}`);

    // Analyze with Claude
    console.log("\nAnalyzing with Claude CLI...");
    console.log("This may take a few minutes...\n");
    const startTime = Date.now();
    const analysis = await analyzeRepository(repoPath, language);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\nAnalysis complete in ${duration}s`);
    console.log(`Found ${analysis.errors.length} errors\n`);

    // Show summary
    if (analysis.errors.length > 0) {
      console.log("Error summary:");
      console.log("==============");

      const byType: Record<string, number> = {};
      for (const error of analysis.errors) {
        byType[error.type] = (byType[error.type] || 0) + 1;
      }

      for (const [type, count] of Object.entries(byType)) {
        console.log(`  ${type}: ${count}`);
      }

      console.log("\nSample errors:");
      for (const error of analysis.errors.slice(0, 5)) {
        console.log(`\n  [${error.type}] ${error.code || "(no code)"}`);
        console.log(`    Message: ${error.message.slice(0, 80)}...`);
        console.log(`    File: ${error.file}:${error.line || "?"}`);
        if (error.resolution) {
          console.log(`    Resolution: ${error.resolution.slice(0, 80)}...`);
        }
      }

      if (analysis.errors.length > 5) {
        console.log(`\n  ... and ${analysis.errors.length - 5} more`);
      }
    }

    // Save to database
    console.log("\nSaving to database...");

    // Delete existing errors
    await db.delete(schema.errors).where(eq(schema.errors.repoId, dbRepo.id));

    // Insert new errors
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
        status: "analyzed",
        lastAnalyzedAt: new Date(),
        lastAnalyzedSha: sha,
        errorCount: analysis.errors.length,
        language,
        updatedAt: new Date(),
      })
      .where(eq(schema.repositories.id, dbRepo.id));

    console.log("Saved to database successfully!");
    console.log(`\nRepository ID: ${dbRepo.id}`);
    console.log(`Errors in database: ${analysis.errors.length}`);

    // Log to job history
    await db.insert(schema.jobHistory).values({
      repoId: dbRepo.id,
      jobType: "analyze",
      status: "completed",
      startedAt: new Date(startTime),
      completedAt: new Date(),
      metadata: JSON.stringify({
        language,
        sha,
        errorCount: analysis.errors.length,
        durationSeconds: parseFloat(duration),
      }),
    });

    console.log("\nDone!");
  } catch (error) {
    console.error("\nError during analysis:", error);
    process.exit(1);
  } finally {
    if (repoPath) {
      console.log("\nCleaning up...");
      await cleanupRepository(repoPath);
    }
    process.exit(0);
  }
}

main();

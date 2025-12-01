#!/usr/bin/env tsx

/**
 * Multi-agent analyzer for richer error documentation
 * Usage: pnpm multi-analyze <repo-url> [--quick] [--verbose]
 */

import { analyzeRepositoryMultiAgent, collectSuggestedArticles } from "../services/multi-agent-analyzer.js";
import { checkClaudeAvailable } from "../services/claude.js";
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
import type { AnalysisResult } from "@error-schema/core";

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help") {
    console.log(`
Multi-Agent Error Analyzer
==========================

Usage: pnpm multi-analyze <repo-url> [options]

Options:
  --quick       Skip enrichment, defense, and article phases (discovery only)
  --no-enrich   Skip the enrichment phase
  --no-defense  Skip the defensive strategies phase
  --no-articles Skip the article recommendation phase
  --verbose     Show detailed progress and fallback information

Providers:
  Phase 1 (Discovery):  Claude opus with thinking (fallback: MiniMax)
  Phase 2 (Enrichment): Claude opus with thinking, batched (fallback: GLM)
  Phase 3 (Defense):    Claude haiku fast (fallback: Kimi)
  Phase 4 (Articles):   Claude haiku fast (fallback: MiniMax)

Example:
  pnpm multi-analyze https://github.com/sindresorhus/got
  pnpm multi-analyze https://github.com/axios/axios --quick
  pnpm multi-analyze https://github.com/sindresorhus/ky --verbose
`);
    process.exit(0);
  }

  const repoUrl = args[0];
  const quickMode = args.includes("--quick");
  const verbose = args.includes("--verbose");
  const skipEnrichment = quickMode || args.includes("--no-enrich");
  const skipDefense = quickMode || args.includes("--no-defense");
  const skipArticles = quickMode || args.includes("--no-articles");

  console.log("Multi-Agent Error Analyzer");
  console.log("==========================\n");

  // Check Claude CLI
  console.log("Checking Claude CLI availability...");
  const claudeAvailable = await checkClaudeAvailable();
  if (!claudeAvailable) {
    console.error("ERROR: Claude CLI is not available");
    process.exit(1);
  }
  console.log("Claude CLI is ready!\n");

  const startTime = Date.now();
  let repoPath: string | null = null;

  try {
    const { owner, repo } = parseRepoUrl(repoUrl);
    console.log(`Analyzing: ${owner}/${repo}`);
    console.log("=".repeat(50));

    // Fetch repo info
    console.log("\n  Fetching repository info...");
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
    console.log(`  Language: ${language}, SHA: ${sha.slice(0, 8)}\n`);

    // Run multi-agent analysis
    const analysis = await analyzeRepositoryMultiAgent(repoPath, language, {
      skipEnrichment,
      skipDefense,
      skipArticles,
      verbose,
    });

    const duration = (Date.now() - startTime) / 1000;
    console.log(`\nAnalysis complete in ${duration.toFixed(1)}s`);
    console.log(`Found ${analysis.errors.length} errors\n`);

    // Save to database
    console.log("Saving to database...");
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
          // Defensive fields
          handlingStrategy: error.handlingStrategy || null,
          validationCode: error.validationCode || null,
          typeGuard: error.typeGuard || null,
          tryCatchPattern: error.tryCatchPattern || null,
          preventionTips: error.preventionTips || null,
          // Article fields
          recommendedArticles: error.recommendedArticles || null,
          suggestedNewArticles: error.suggestedNewArticles
            ? JSON.stringify(error.suggestedNewArticles)
            : null,
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
      jobType: "multi-agent-analyze",
      status: "completed",
      startedAt: new Date(startTime),
      completedAt: new Date(),
      metadata: JSON.stringify({
        language,
        sha,
        errorCount: analysis.errors.length,
        durationSeconds: duration,
        skipEnrichment,
        skipDefense,
        skipArticles,
      }),
    });

    console.log(`Saved ${analysis.errors.length} errors to database`);

    // Print suggested articles if any
    const suggestions = collectSuggestedArticles([analysis]);
    if (suggestions.length > 0) {
      console.log("\n--- Suggested New Articles ---");
      for (const suggestion of suggestions.slice(0, 5)) {
        console.log(`  - ${suggestion.title} (${suggestion.category})`);
        console.log(`    ${suggestion.description}`);
      }
    }

    // Print sample enriched error
    const enrichedError = analysis.errors.find(e => e.triggerScenarios || e.exampleFix);
    if (enrichedError) {
      console.log("\n--- Sample Enriched Error ---");
      console.log(`Message: ${enrichedError.message.slice(0, 60)}...`);
      if (enrichedError.triggerScenarios) {
        console.log(`Trigger: ${enrichedError.triggerScenarios.slice(0, 100)}...`);
      }
      if (enrichedError.handlingStrategy) {
        console.log(`Strategy: ${enrichedError.handlingStrategy}`);
      }
    }

    console.log("\n--- Next Steps ---");
    console.log("  1. pnpm --filter @err-lookup/site-generator generate -- " + repoInfo.full_name);
    console.log("  2. Review generated site in /sites/");

    process.exit(0);
  } catch (error) {
    console.error("\nERROR:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    if (repoPath) {
      console.log("\nCleaning up...");
      await cleanupRepository(repoPath);
    }
  }
}

main();

#!/usr/bin/env tsx

/**
 * Batch multi-agent analyzer for top 100 npm packages
 * Usage: pnpm batch-multi [--start N] [--count N] [--dry-run]
 */

import { analyzeRepositoryMultiAgent } from "../services/multi-agent-analyzer.js";
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
import { appendFileSync, existsSync, writeFileSync } from "fs";
import { execa } from "execa";

// Top 100 npm packages by downloads + popular error-prone libraries
const TOP_REPOS: string[] = [
  // Tier 1: Most popular utilities (1-20)
  "https://github.com/lodash/lodash",
  "https://github.com/chalk/chalk",
  "https://github.com/sindresorhus/is",
  "https://github.com/sindresorhus/ky",
  "https://github.com/sindresorhus/got",
  "https://github.com/axios/axios",
  "https://github.com/node-fetch/node-fetch",
  "https://github.com/unjs/ofetch",
  "https://github.com/sindresorhus/execa",
  "https://github.com/SBoudrias/Inquirer.js",
  "https://github.com/yargs/yargs",
  "https://github.com/tj/commander.js",
  "https://github.com/cacjs/cac",
  "https://github.com/lukeed/kleur",
  "https://github.com/alexei/sprintf.js",
  "https://github.com/sindresorhus/ora",
  "https://github.com/sindresorhus/log-symbols",
  "https://github.com/sindresorhus/figures",
  "https://github.com/npm/validate-npm-package-name",
  "https://github.com/npm/node-semver",

  // Tier 2: File system & paths (21-35)
  "https://github.com/sindresorhus/globby",
  "https://github.com/mrmlnc/fast-glob",
  "https://github.com/isaacs/node-glob",
  "https://github.com/paulmillr/chokidar",
  "https://github.com/jprichardson/node-fs-extra",
  "https://github.com/sindresorhus/find-up",
  "https://github.com/sindresorhus/pkg-dir",
  "https://github.com/sindresorhus/read-pkg",
  "https://github.com/sindresorhus/write-pkg",
  "https://github.com/sindresorhus/tempy",
  "https://github.com/sindresorhus/del",
  "https://github.com/sindresorhus/make-dir",
  "https://github.com/sindresorhus/move-file",
  "https://github.com/sindresorhus/copy-file",
  "https://github.com/isaacs/rimraf",

  // Tier 3: Data validation & parsing (36-55)
  "https://github.com/colinhacks/zod",
  "https://github.com/jquense/yup",
  "https://github.com/hapijs/joi",
  "https://github.com/ajv-validator/ajv",
  "https://github.com/ianstormtaylor/superstruct",
  "https://github.com/fabian-hiller/valibot",
  "https://github.com/sindresorhus/type-fest",
  "https://github.com/blakeembrey/change-case",
  "https://github.com/validatorjs/validator.js",
  "https://github.com/chriso/validator.js",
  "https://github.com/date-fns/date-fns",
  "https://github.com/iamkun/dayjs",
  "https://github.com/moment/luxon",
  "https://github.com/winstonjs/winston",
  "https://github.com/pinojs/pino",
  "https://github.com/debug-js/debug",
  "https://github.com/jorgebucaran/colorette",
  "https://github.com/davidmarkclements/sonic-boom",
  "https://github.com/mcollina/split2",
  "https://github.com/mafintosh/pump",

  // Tier 4: Web & HTTP (56-75)
  "https://github.com/expressjs/express",
  "https://github.com/fastify/fastify",
  "https://github.com/koajs/koa",
  "https://github.com/honojs/hono",
  "https://github.com/tinyhttp/tinyhttp",
  "https://github.com/expressjs/body-parser",
  "https://github.com/expressjs/cors",
  "https://github.com/expressjs/cookie-parser",
  "https://github.com/expressjs/session",
  "https://github.com/expressjs/multer",
  "https://github.com/jshttp/mime-types",
  "https://github.com/jshttp/content-type",
  "https://github.com/jshttp/http-errors",
  "https://github.com/jshttp/statuses",
  "https://github.com/ljharb/qs",
  "https://github.com/sindresorhus/query-string",
  "https://github.com/unjs/ufo",
  "https://github.com/unjs/radix3",
  "https://github.com/pillarjs/path-to-regexp",
  "https://github.com/lukeed/trouter",

  // Tier 5: Database & Storage (76-90)
  "https://github.com/knex/knex",
  "https://github.com/typeorm/typeorm",
  "https://github.com/drizzle-team/drizzle-orm",
  "https://github.com/kysely-org/kysely",
  "https://github.com/sequelize/sequelize",
  "https://github.com/redis/node-redis",
  "https://github.com/luin/ioredis",
  "https://github.com/Automattic/mongoose",
  "https://github.com/mongodb/node-mongodb-native",
  "https://github.com/brianc/node-postgres",
  "https://github.com/sidorares/node-mysql2",
  "https://github.com/WiseLibs/better-sqlite3",
  "https://github.com/m4heshd/better-sqlite3-multiple-ciphers",
  "https://github.com/Level/level",
  "https://github.com/louischatriot/nedb",

  // Tier 6: Testing & Dev tools (91-100)
  "https://github.com/avajs/ava",
  "https://github.com/mochajs/mocha",
  "https://github.com/jestjs/jest",
  "https://github.com/vitest-dev/vitest",
  "https://github.com/chaijs/chai",
  "https://github.com/sinonjs/sinon",
  "https://github.com/ladjs/supertest",
  "https://github.com/nock/nock",
  "https://github.com/faker-js/faker",
  "https://github.com/Marak/colors.js",
];

interface AnalysisResult {
  repo: string;
  success: boolean;
  errorCount?: number;
  enriched?: number;
  defense?: number;
  articles?: number;
  duration?: number;
  error?: string;
}

const LOG_FILE = "batch-multi-analyze.log";

function log(message: string) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

// ============== VERIFY & ENHANCE PHASE ==============

interface ErrorRecord {
  id: number;
  errorMessage: string;
  errorCode: string | null;
  errorType: string;
  filePath: string;
  lineNumber: number | null;
  documentation: string | null;
  triggerScenarios: string | null;
  commonSituations: string | null;
  exampleFix: string | null;
  handlingStrategy: string | null;
  validationCode: string | null;
  typeGuard: string | null;
  tryCatchPattern: string | null;
  recommendedArticles: string[] | null;
}

interface GapAnalysis {
  repoId: number;
  missingEnrichment: number[];
  missingDefense: number[];
  missingArticles: number[];
}

function extractJson(text: string): string {
  const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) return jsonBlockMatch[1].trim();
  const jsonObjectMatch = text.match(/\{[\s\S]*\}/);
  if (jsonObjectMatch) return jsonObjectMatch[0];
  return text.trim();
}

async function analyzeGaps(repoId: number): Promise<GapAnalysis> {
  const errors = await db.query.errors.findMany({
    where: eq(schema.errors.repoId, repoId),
  }) as ErrorRecord[];

  const missingEnrichment: number[] = [];
  const missingDefense: number[] = [];
  const missingArticles: number[] = [];

  for (const error of errors) {
    if (!error.documentation && !error.triggerScenarios) {
      missingEnrichment.push(error.id);
    }
    if (!error.handlingStrategy && !error.validationCode && !error.tryCatchPattern) {
      missingDefense.push(error.id);
    }
    if (!error.recommendedArticles || error.recommendedArticles.length === 0) {
      missingArticles.push(error.id);
    }
  }

  return { repoId, missingEnrichment, missingDefense, missingArticles };
}

async function fixEnrichmentBatch(errors: ErrorRecord[]): Promise<Map<number, any>> {
  const results = new Map<number, any>();
  const errorList = errors.map((e, i) =>
    `[${i}] ID:${e.id} "${e.errorMessage.slice(0, 60)}" (${e.filePath}:${e.lineNumber || '?'})`
  ).join('\n');

  const prompt = `Fix missing documentation for these errors:

${errorList}

For EACH error provide:
- triggerScenarios: Specific conditions causing this error
- commonSituations: 2-3 real developer scenarios
- rootCause: Why this error exists
- exampleFix: Before/after code fix
- preventionTips: How to avoid

OUTPUT (JSON only):
{"enrichedErrors": [{"index": 0, "errorId": 123, "triggerScenarios": "...", "commonSituations": ["..."], "rootCause": "...", "exampleFix": "...", "preventionTips": ["..."]}]}`;

  try {
    const result = await execa("claude", ["-p", prompt, "--model", "haiku", "--output-format", "json", "--print", "--permission-mode", "bypassPermissions"],
      { timeout: 180000, reject: false, stdin: "ignore" });
    const claudeOutput = JSON.parse(result.stdout?.toString() || '{}');
    const parsed = JSON.parse(extractJson(claudeOutput.result || '{}'));
    for (const e of parsed.enrichedErrors || []) {
      if (e.errorId) results.set(e.errorId, e);
    }
  } catch { /* continue */ }
  return results;
}

async function fixDefenseBatch(errors: ErrorRecord[]): Promise<Map<number, any>> {
  const results = new Map<number, any>();
  const errorList = errors.map((e, i) =>
    `[${i}] ID:${e.id} ${e.errorCode || e.errorMessage.slice(0, 40)} (${e.errorType})`
  ).join('\n');

  const prompt = `Generate defense strategies for these errors:

${errorList}

For EACH error provide:
- handlingStrategy: "retry"|"fallback"|"crash"|"log-continue"|"validate-early"
- validationCode: Input validation code
- typeGuard: TypeScript type guard
- tryCatchPattern: Error handling pattern

OUTPUT (JSON only):
{"defenseStrategies": [{"index": 0, "errorId": 123, "handlingStrategy": "retry", "validationCode": "...", "typeGuard": "...", "tryCatchPattern": "..."}]}`;

  try {
    const result = await execa("claude", ["-p", prompt, "--model", "haiku", "--output-format", "json", "--print", "--permission-mode", "bypassPermissions"],
      { timeout: 120000, reject: false, stdin: "ignore" });
    const claudeOutput = JSON.parse(result.stdout?.toString() || '{}');
    const parsed = JSON.parse(extractJson(claudeOutput.result || '{}'));
    for (const d of parsed.defenseStrategies || []) {
      if (d.errorId) results.set(d.errorId, d);
    }
  } catch { /* continue */ }
  return results;
}

async function fixArticlesBatch(errors: ErrorRecord[]): Promise<Map<number, any>> {
  const results = new Map<number, any>();
  const errorList = errors.map((e, i) =>
    `[${i}] ID:${e.id} ${e.errorCode || e.errorMessage.slice(0, 40)} (${e.errorType})`
  ).join('\n');

  const prompt = `Map these errors to educational articles:

${errorList}

EXISTING ARTICLES: networking/dns, networking/http-status-codes, programming/error-handling-patterns, debugging/reading-stack-traces

OUTPUT (JSON only):
{"articleMappings": [{"index": 0, "errorId": 123, "recommendedArticles": ["networking/http-status-codes"]}]}`;

  try {
    const result = await execa("claude", ["-p", prompt, "--model", "haiku", "--output-format", "json", "--print", "--permission-mode", "bypassPermissions"],
      { timeout: 90000, reject: false, stdin: "ignore" });
    const claudeOutput = JSON.parse(result.stdout?.toString() || '{}');
    const parsed = JSON.parse(extractJson(claudeOutput.result || '{}'));
    for (const m of parsed.articleMappings || []) {
      if (m.errorId) results.set(m.errorId, m);
    }
  } catch { /* continue */ }
  return results;
}

async function applyFix(errorId: number, fix: any, type: 'enrichment' | 'defense' | 'articles') {
  const updates: Record<string, any> = { updatedAt: new Date() };

  if (type === 'enrichment' && fix) {
    if (fix.triggerScenarios) updates.triggerScenarios = fix.triggerScenarios;
    if (fix.commonSituations) updates.commonSituations = fix.commonSituations.join?.('\n') || fix.commonSituations;
    if (fix.rootCause) updates.documentation = fix.rootCause;
    if (fix.exampleFix) updates.exampleFix = fix.exampleFix;
    if (fix.preventionTips) updates.preventionTips = fix.preventionTips;
  } else if (type === 'defense' && fix) {
    if (fix.handlingStrategy) updates.handlingStrategy = fix.handlingStrategy;
    if (fix.validationCode) updates.validationCode = fix.validationCode;
    if (fix.typeGuard) updates.typeGuard = fix.typeGuard;
    if (fix.tryCatchPattern) updates.tryCatchPattern = fix.tryCatchPattern;
  } else if (type === 'articles' && fix) {
    if (fix.recommendedArticles) updates.recommendedArticles = fix.recommendedArticles;
  }

  if (Object.keys(updates).length > 1) {
    await db.update(schema.errors).set(updates).where(eq(schema.errors.id, errorId));
  }
}

async function verifyAndEnhanceRepo(repoId: number, repoName: string): Promise<{ fixed: number; remaining: number }> {
  log(`  Phase 5: Verify & Enhance...`);

  const gaps = await analyzeGaps(repoId);
  const totalGaps = gaps.missingEnrichment.length + gaps.missingDefense.length + gaps.missingArticles.length;

  if (totalGaps === 0) {
    log(`    No gaps found - analysis complete`);
    return { fixed: 0, remaining: 0 };
  }

  log(`    Found ${totalGaps} gaps (E:${gaps.missingEnrichment.length} D:${gaps.missingDefense.length} A:${gaps.missingArticles.length})`);

  const allErrors = await db.query.errors.findMany({ where: eq(schema.errors.repoId, repoId) }) as ErrorRecord[];
  const errorMap = new Map(allErrors.map(e => [e.id, e]));
  let fixed = 0;

  // Fix enrichment gaps
  if (gaps.missingEnrichment.length > 0) {
    const errorsToFix = gaps.missingEnrichment.map(id => errorMap.get(id)!).filter(Boolean);
    for (let i = 0; i < errorsToFix.length; i += 5) {
      const batch = errorsToFix.slice(i, i + 5);
      const fixes = await fixEnrichmentBatch(batch);
      for (const [errorId, fix] of fixes) {
        await applyFix(errorId, fix, 'enrichment');
        fixed++;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Fix defense gaps
  if (gaps.missingDefense.length > 0) {
    const errorsToFix = gaps.missingDefense.map(id => errorMap.get(id)!).filter(Boolean);
    for (let i = 0; i < errorsToFix.length; i += 10) {
      const batch = errorsToFix.slice(i, i + 10);
      const fixes = await fixDefenseBatch(batch);
      for (const [errorId, fix] of fixes) {
        await applyFix(errorId, fix, 'defense');
        fixed++;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Fix article gaps
  if (gaps.missingArticles.length > 0) {
    const errorsToFix = gaps.missingArticles.map(id => errorMap.get(id)!).filter(Boolean);
    for (let i = 0; i < errorsToFix.length; i += 15) {
      const batch = errorsToFix.slice(i, i + 15);
      const fixes = await fixArticlesBatch(batch);
      for (const [errorId, fix] of fixes) {
        await applyFix(errorId, fix, 'articles');
        fixed++;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Re-check gaps
  const afterGaps = await analyzeGaps(repoId);
  const remaining = afterGaps.missingEnrichment.length + afterGaps.missingDefense.length + afterGaps.missingArticles.length;

  log(`    Fixed ${fixed} gaps, ${remaining} remaining`);
  return { fixed, remaining };
}

// ============== MAIN ANALYSIS ==============

async function analyzeRepo(repoUrl: string): Promise<AnalysisResult> {
  const startTime = Date.now();
  let repoPath: string | null = null;

  try {
    const { owner, repo } = parseRepoUrl(repoUrl);
    log(`Starting: ${owner}/${repo}`);

    // Fetch repo info
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
    }

    // Clone repository
    repoPath = await cloneRepository(repoUrl);
    const language = await detectRepoLanguage(repoPath);
    const sha = await getLatestCommitSha(repoPath);

    // Run multi-agent analysis with rate limiting and supervisor
    const analysis = await analyzeRepositoryMultiAgent(repoPath, language, {
      verbose: true,
      rateLimit: {
        requestsPerMinute: 15,          // Conservative to avoid rate limits
        delayBetweenBatchesMs: 5000,    // 5s between batches
        delayBetweenPhasesMs: 10000,    // 10s between phases
        exponentialBackoff: true,
        maxBackoffMs: 120000,           // Max 2 min backoff
      },
      stuckCheck: {
        enabled: true,
        checkIntervalMs: 300000,        // Check every 5 minutes
      },
    }, `${owner}/${repo}`);

    const duration = (Date.now() - startTime) / 1000;

    // Count enrichment stats
    const enriched = analysis.errors.filter(e => e.cause || e.triggerScenarios).length;
    const defense = analysis.errors.filter(e => e.handlingStrategy).length;
    const articles = analysis.errors.filter(e => e.recommendedArticles?.length).length;

    log(`  Found ${analysis.errors.length} errors (enriched: ${enriched}, defense: ${defense}, articles: ${articles}) in ${duration.toFixed(0)}s`);

    // Save to database first
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
          handlingStrategy: error.handlingStrategy || null,
          validationCode: error.validationCode || null,
          typeGuard: error.typeGuard || null,
          tryCatchPattern: error.tryCatchPattern || null,
          preventionTips: error.preventionTips || null,
          recommendedArticles: error.recommendedArticles || null,
          suggestedNewArticles: error.suggestedNewArticles
            ? JSON.stringify(error.suggestedNewArticles)
            : null,
          // Source code fields for SEO
          sourceCode: error.sourceCode || null,
          sourceCodeStart: error.sourceCodeStart || null,
          sourceCodeEnd: error.sourceCodeEnd || null,
          githubUrl: error.githubUrl || null,
        }))
      );
    }

    // Phase 5: Verify & Enhance - fix any gaps from the initial analysis
    let verifyResult = { fixed: 0, remaining: 0 };
    if (analysis.errors.length > 0) {
      verifyResult = await verifyAndEnhanceRepo(dbRepo.id, `${owner}/${repo}`);

      // If there are still gaps, try one more time
      if (verifyResult.remaining > 0) {
        log(`    Retrying ${verifyResult.remaining} remaining gaps...`);
        const retryResult = await verifyAndEnhanceRepo(dbRepo.id, `${owner}/${repo}`);
        verifyResult.fixed += retryResult.fixed;
        verifyResult.remaining = retryResult.remaining;
      }
    }

    const finalDuration = (Date.now() - startTime) / 1000;

    // Re-count stats after verify phase
    const finalErrors = await db.query.errors.findMany({ where: eq(schema.errors.repoId, dbRepo.id) }) as ErrorRecord[];
    const finalEnriched = finalErrors.filter(e => e.documentation || e.triggerScenarios).length;
    const finalDefense = finalErrors.filter(e => e.handlingStrategy || e.validationCode || e.tryCatchPattern).length;
    const finalArticles = finalErrors.filter(e => e.recommendedArticles && e.recommendedArticles.length > 0).length;

    log(`  Final: ${analysis.errors.length} errors (enriched: ${finalEnriched}, defense: ${finalDefense}, articles: ${finalArticles}) in ${finalDuration.toFixed(0)}s`);

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
      jobType: "batch-multi-analyze",
      status: "completed",
      startedAt: new Date(startTime),
      completedAt: new Date(),
      metadata: JSON.stringify({
        language,
        sha,
        errorCount: analysis.errors.length,
        enriched: finalEnriched,
        defense: finalDefense,
        articles: finalArticles,
        gapsFixed: verifyResult.fixed,
        gapsRemaining: verifyResult.remaining,
        durationSeconds: finalDuration,
      }),
    });

    return {
      repo: `${owner}/${repo}`,
      success: true,
      errorCount: analysis.errors.length,
      enriched: finalEnriched,
      defense: finalDefense,
      articles: finalArticles,
      duration: finalDuration,
    };
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`  ERROR: ${errorMessage.slice(0, 100)}`);

    return {
      repo: repoUrl,
      success: false,
      duration,
      error: errorMessage,
    };
  } finally {
    if (repoPath) {
      await cleanupRepository(repoPath);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const startArg = args.find((a) => a.startsWith("--start="));
  const countArg = args.find((a) => a.startsWith("--count="));

  const startIndex = startArg ? parseInt(startArg.split("=")[1]) : 0;
  const count = countArg ? parseInt(countArg.split("=")[1]) : TOP_REPOS.length;

  console.log("ErrLookup Batch Multi-Agent Analyzer");
  console.log("====================================\n");

  const projectsToAnalyze = TOP_REPOS.slice(startIndex, startIndex + count);

  console.log(`Analyzing repos ${startIndex + 1} to ${startIndex + projectsToAnalyze.length} of ${TOP_REPOS.length}`);
  console.log(`Total: ${projectsToAnalyze.length} repositories\n`);

  if (dryRun) {
    console.log("DRY RUN - Repositories to analyze:");
    projectsToAnalyze.forEach((url, i) => {
      const { owner, repo } = parseRepoUrl(url);
      console.log(`  ${startIndex + i + 1}. ${owner}/${repo}`);
    });
    console.log("\nUse without --dry-run to execute.");
    process.exit(0);
  }

  // Initialize log file
  if (!existsSync(LOG_FILE)) {
    writeFileSync(LOG_FILE, `Batch Multi-Analyze started at ${new Date().toISOString()}\n`);
  }
  log(`Starting batch of ${projectsToAnalyze.length} repos (index ${startIndex}-${startIndex + projectsToAnalyze.length - 1})`);

  // Check Claude CLI
  const claudeAvailable = await checkClaudeAvailable();
  if (!claudeAvailable) {
    log("ERROR: Claude CLI is not available");
    process.exit(1);
  }

  // Run analyses
  const results: AnalysisResult[] = [];
  const startTime = Date.now();

  for (let i = 0; i < projectsToAnalyze.length; i++) {
    const url = projectsToAnalyze[i];
    log(`\nProgress: ${i + 1}/${projectsToAnalyze.length} (${((i + 1) / projectsToAnalyze.length * 100).toFixed(0)}%)`);

    const result = await analyzeRepo(url);
    results.push(result);

    // Brief pause between analyses
    if (i < projectsToAnalyze.length - 1) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // Print summary
  const totalDuration = (Date.now() - startTime) / 1000;
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  const totalErrors = successful.reduce((sum, r) => sum + (r.errorCount || 0), 0);
  const totalEnriched = successful.reduce((sum, r) => sum + (r.enriched || 0), 0);
  const totalDefense = successful.reduce((sum, r) => sum + (r.defense || 0), 0);

  log("\n" + "=".repeat(60));
  log("BATCH ANALYSIS COMPLETE");
  log("=".repeat(60));
  log(`Total time: ${(totalDuration / 60).toFixed(1)} minutes`);
  log(`Successful: ${successful.length}/${results.length}`);
  log(`Total errors: ${totalErrors}`);
  log(`Enriched: ${totalEnriched} (${totalErrors ? ((totalEnriched / totalErrors) * 100).toFixed(0) : 0}%)`);
  log(`Defense: ${totalDefense} (${totalErrors ? ((totalDefense / totalErrors) * 100).toFixed(0) : 0}%)`);

  if (failed.length > 0) {
    log("\nFailed repositories:");
    for (const f of failed) {
      log(`  - ${f.repo}: ${f.error?.slice(0, 60)}`);
    }
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

main();

#!/usr/bin/env tsx

/**
 * Verify, Enhance, and Repair Analysis Results
 *
 * This flow:
 * 1. Loads all analyzed repos from the database
 * 2. Identifies gaps (missing enrichment, defense, articles)
 * 3. Re-runs failed/skipped phases with fresh attempts
 * 4. Enhances existing data with additional context
 * 5. Validates quality of the documentation
 *
 * Usage: pnpm verify-enhance [--repo owner/name] [--fix-only] [--enhance-only]
 */

import { db, schema } from "../db/client.js";
import { eq, isNull, or, sql } from "drizzle-orm";
import { execa } from "execa";
import { appendFileSync, writeFileSync } from "fs";

const LOG_FILE = "verify-enhance.log";

function log(message: string) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

interface GapAnalysis {
  repoId: number;
  repoName: string;
  totalErrors: number;
  missingEnrichment: number[];
  missingDefense: number[];
  missingArticles: number[];
  lowQualityErrors: number[];
}

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

// Analyze gaps in a repo's error documentation
async function analyzeGaps(repoId: number, repoName: string): Promise<GapAnalysis> {
  const errors = await db.query.errors.findMany({
    where: eq(schema.errors.repoId, repoId),
  }) as ErrorRecord[];

  const missingEnrichment: number[] = [];
  const missingDefense: number[] = [];
  const missingArticles: number[] = [];
  const lowQualityErrors: number[] = [];

  for (const error of errors) {
    // Check enrichment
    if (!error.documentation && !error.triggerScenarios) {
      missingEnrichment.push(error.id);
    }

    // Check defense
    if (!error.handlingStrategy && !error.validationCode && !error.tryCatchPattern) {
      missingDefense.push(error.id);
    }

    // Check articles
    if (!error.recommendedArticles || error.recommendedArticles.length === 0) {
      missingArticles.push(error.id);
    }

    // Check quality (enrichment exists but is too short/generic)
    if (error.documentation && error.documentation.length < 50) {
      lowQualityErrors.push(error.id);
    }
    if (error.triggerScenarios && error.triggerScenarios.length < 30) {
      lowQualityErrors.push(error.id);
    }
  }

  return {
    repoId,
    repoName,
    totalErrors: errors.length,
    missingEnrichment,
    missingDefense,
    missingArticles,
    lowQualityErrors: [...new Set(lowQualityErrors)],
  };
}

// Fix missing enrichment for specific errors
async function fixEnrichment(errors: ErrorRecord[]): Promise<Map<number, any>> {
  const results = new Map<number, any>();

  const errorList = errors.map((e, i) =>
    `[${i}] ID:${e.id} "${e.errorMessage.slice(0, 60)}" (${e.filePath}:${e.lineNumber || '?'})`
  ).join('\n');

  const prompt = `You are fixing missing documentation for these errors. Provide detailed debugging information.

## Errors to Document
${errorList}

For EACH error, provide:
1. **triggerScenarios**: Specific conditions that cause this error (be detailed)
2. **commonSituations**: 2-3 real-world developer scenarios where this occurs
3. **rootCause**: Why this error exists in the codebase
4. **exampleFix**: Before/after code showing how to fix
5. **preventionTips**: How to avoid this error

OUTPUT FORMAT (JSON only, no markdown):
{
  "enrichedErrors": [
    {
      "index": 0,
      "errorId": 123,
      "triggerScenarios": "This error occurs when...",
      "commonSituations": ["When migrating from v1 to v2...", "When using with TypeScript strict mode..."],
      "rootCause": "The library expects...",
      "exampleFix": "// Before:\\nfoo()\\n// After:\\nfoo({ safe: true })",
      "preventionTips": ["Always check...", "Use TypeScript..."]
    }
  ]
}`;

  try {
    const result = await execa("claude", [
      "-p", prompt,
      "--model", "opus",
      "--output-format", "json",
      "--print",
      "--permission-mode", "bypassPermissions",
    ], {
      timeout: 300000,
      reject: false,
      stdin: "ignore",
    });

    const stdout = result.stdout?.toString() || '';
    const claudeOutput = JSON.parse(stdout);
    const jsonText = extractJson(claudeOutput.result || '');
    const parsed = JSON.parse(jsonText);

    for (const enriched of parsed.enrichedErrors || []) {
      if (enriched.errorId) {
        results.set(enriched.errorId, enriched);
      }
    }
  } catch (err) {
    log(`  Enrichment fix failed: ${(err as Error).message?.slice(0, 60)}`);
  }

  return results;
}

// Fix missing defense strategies for specific errors
async function fixDefense(errors: ErrorRecord[]): Promise<Map<number, any>> {
  const results = new Map<number, any>();

  const errorList = errors.map((e, i) =>
    `[${i}] ID:${e.id} ${e.errorCode || e.errorMessage.slice(0, 40)} (${e.errorType})`
  ).join('\n');

  const prompt = `Generate defensive programming patterns for these errors that are missing them.

## Errors Needing Defense Strategies
${errorList}

For EACH error provide:
1. **handlingStrategy**: "retry" | "fallback" | "crash" | "log-continue" | "validate-early"
2. **validationCode**: Input validation to prevent this error
3. **typeGuard**: TypeScript type guard if applicable
4. **tryCatchPattern**: Proper error handling pattern

OUTPUT FORMAT (JSON only):
{
  "defenseStrategies": [
    {
      "index": 0,
      "errorId": 123,
      "handlingStrategy": "retry",
      "validationCode": "if (!input) throw new Error('Input required');",
      "typeGuard": "function isValid(x: unknown): x is ValidType { return ... }",
      "tryCatchPattern": "try {\\n  await riskyOp();\\n} catch (e) {\\n  if (e instanceof SpecificError) { ... }\\n}"
    }
  ]
}`;

  try {
    const result = await execa("claude", [
      "-p", prompt,
      "--model", "haiku",
      "--output-format", "json",
      "--print",
      "--permission-mode", "bypassPermissions",
    ], {
      timeout: 180000,
      reject: false,
      stdin: "ignore",
    });

    const stdout = result.stdout?.toString() || '';
    const claudeOutput = JSON.parse(stdout);
    const jsonText = extractJson(claudeOutput.result || '');
    const parsed = JSON.parse(jsonText);

    for (const defense of parsed.defenseStrategies || []) {
      if (defense.errorId) {
        results.set(defense.errorId, defense);
      }
    }
  } catch (err) {
    log(`  Defense fix failed: ${(err as Error).message?.slice(0, 60)}`);
  }

  return results;
}

// Fix missing article mappings
async function fixArticles(errors: ErrorRecord[]): Promise<Map<number, any>> {
  const results = new Map<number, any>();

  const errorList = errors.map((e, i) =>
    `[${i}] ID:${e.id} ${e.errorCode || e.errorMessage.slice(0, 40)} (${e.errorType})`
  ).join('\n');

  const prompt = `Map these errors to educational articles.

## Errors Needing Article Mapping
${errorList}

EXISTING ARTICLES:
- networking: dns, tcp-ip, tls-ssl, http-status-codes, websockets, cors
- programming: type-systems, memory-safety, concurrency, error-handling-patterns, async-await
- os: signals, exit-codes, file-descriptors, permissions
- debugging: reading-stack-traces, debugging-node, debugging-python, chrome-devtools

For EACH error provide recommended articles and suggest new ones if needed.

OUTPUT FORMAT (JSON only):
{
  "articleMappings": [
    {
      "index": 0,
      "errorId": 123,
      "recommendedArticles": ["networking/http-status-codes", "debugging/reading-stack-traces"],
      "suggestedNewArticles": [{"title": "Handling Network Timeouts", "category": "networking", "description": "..."}]
    }
  ]
}`;

  try {
    const result = await execa("claude", [
      "-p", prompt,
      "--model", "haiku",
      "--output-format", "json",
      "--print",
      "--permission-mode", "bypassPermissions",
    ], {
      timeout: 120000,
      reject: false,
      stdin: "ignore",
    });

    const stdout = result.stdout?.toString() || '';
    const claudeOutput = JSON.parse(stdout);
    const jsonText = extractJson(claudeOutput.result || '');
    const parsed = JSON.parse(jsonText);

    for (const mapping of parsed.articleMappings || []) {
      if (mapping.errorId) {
        results.set(mapping.errorId, mapping);
      }
    }
  } catch (err) {
    log(`  Articles fix failed: ${(err as Error).message?.slice(0, 60)}`);
  }

  return results;
}

// Enhance existing low-quality documentation
async function enhanceQuality(errors: ErrorRecord[]): Promise<Map<number, any>> {
  const results = new Map<number, any>();

  const errorList = errors.map((e, i) =>
    `[${i}] ID:${e.id} "${e.errorMessage.slice(0, 50)}"
    Current doc: "${(e.documentation || '').slice(0, 100)}"
    Current triggers: "${(e.triggerScenarios || '').slice(0, 100)}"`
  ).join('\n\n');

  const prompt = `These errors have documentation but it's too brief. Enhance with more detail.

## Errors Needing Enhancement
${errorList}

For EACH error, provide EXPANDED versions:
1. **documentation**: Detailed explanation (at least 100 words)
2. **triggerScenarios**: Comprehensive list of conditions
3. **commonSituations**: Real-world examples with context

OUTPUT FORMAT (JSON only):
{
  "enhanced": [
    {
      "index": 0,
      "errorId": 123,
      "documentation": "Expanded detailed documentation...",
      "triggerScenarios": "Comprehensive trigger scenarios...",
      "commonSituations": ["Detailed situation 1...", "Detailed situation 2..."]
    }
  ]
}`;

  try {
    const result = await execa("claude", [
      "-p", prompt,
      "--model", "opus",
      "--output-format", "json",
      "--print",
      "--permission-mode", "bypassPermissions",
    ], {
      timeout: 300000,
      reject: false,
      stdin: "ignore",
    });

    const stdout = result.stdout?.toString() || '';
    const claudeOutput = JSON.parse(stdout);
    const jsonText = extractJson(claudeOutput.result || '');
    const parsed = JSON.parse(jsonText);

    for (const enhanced of parsed.enhanced || []) {
      if (enhanced.errorId) {
        results.set(enhanced.errorId, enhanced);
      }
    }
  } catch (err) {
    log(`  Enhancement failed: ${(err as Error).message?.slice(0, 60)}`);
  }

  return results;
}

// Extract JSON from potential markdown wrapper
function extractJson(text: string): string {
  const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) return jsonBlockMatch[1].trim();
  const jsonObjectMatch = text.match(/\{[\s\S]*\}/);
  if (jsonObjectMatch) return jsonObjectMatch[0];
  return text.trim();
}

// Apply fixes to database
async function applyFixes(
  errorId: number,
  fixes: {
    enrichment?: any;
    defense?: any;
    articles?: any;
    enhancement?: any;
  }
) {
  const updates: Record<string, any> = { updatedAt: new Date() };

  if (fixes.enrichment) {
    if (fixes.enrichment.triggerScenarios) updates.triggerScenarios = fixes.enrichment.triggerScenarios;
    if (fixes.enrichment.commonSituations) updates.commonSituations = fixes.enrichment.commonSituations.join('\n');
    if (fixes.enrichment.rootCause) updates.documentation = fixes.enrichment.rootCause;
    if (fixes.enrichment.exampleFix) updates.exampleFix = fixes.enrichment.exampleFix;
    if (fixes.enrichment.preventionTips) updates.preventionTips = fixes.enrichment.preventionTips;
  }

  if (fixes.defense) {
    if (fixes.defense.handlingStrategy) updates.handlingStrategy = fixes.defense.handlingStrategy;
    if (fixes.defense.validationCode) updates.validationCode = fixes.defense.validationCode;
    if (fixes.defense.typeGuard) updates.typeGuard = fixes.defense.typeGuard;
    if (fixes.defense.tryCatchPattern) updates.tryCatchPattern = fixes.defense.tryCatchPattern;
  }

  if (fixes.articles) {
    if (fixes.articles.recommendedArticles) updates.recommendedArticles = fixes.articles.recommendedArticles;
    if (fixes.articles.suggestedNewArticles) updates.suggestedNewArticles = JSON.stringify(fixes.articles.suggestedNewArticles);
  }

  if (fixes.enhancement) {
    if (fixes.enhancement.documentation) updates.documentation = fixes.enhancement.documentation;
    if (fixes.enhancement.triggerScenarios) updates.triggerScenarios = fixes.enhancement.triggerScenarios;
    if (fixes.enhancement.commonSituations) updates.commonSituations = fixes.enhancement.commonSituations.join('\n');
  }

  if (Object.keys(updates).length > 1) {
    await db.update(schema.errors)
      .set(updates)
      .where(eq(schema.errors.id, errorId));
  }
}

// Process a single repo
async function processRepo(repoId: number, repoName: string, options: { fixOnly?: boolean; enhanceOnly?: boolean }) {
  log(`\nProcessing: ${repoName}`);

  // Analyze gaps
  const gaps = await analyzeGaps(repoId, repoName);

  log(`  Total errors: ${gaps.totalErrors}`);
  log(`  Missing enrichment: ${gaps.missingEnrichment.length}`);
  log(`  Missing defense: ${gaps.missingDefense.length}`);
  log(`  Missing articles: ${gaps.missingArticles.length}`);
  log(`  Low quality: ${gaps.lowQualityErrors.length}`);

  if (gaps.totalErrors === 0) {
    log(`  Skipping - no errors to process`);
    return;
  }

  // Get error records for processing
  const allErrors = await db.query.errors.findMany({
    where: eq(schema.errors.repoId, repoId),
  }) as ErrorRecord[];

  const errorMap = new Map(allErrors.map(e => [e.id, e]));

  // Fix missing enrichment
  if (!options.enhanceOnly && gaps.missingEnrichment.length > 0) {
    log(`  Fixing ${gaps.missingEnrichment.length} missing enrichments...`);
    const errorsToFix = gaps.missingEnrichment.map(id => errorMap.get(id)!).filter(Boolean);

    // Process in batches of 5
    for (let i = 0; i < errorsToFix.length; i += 5) {
      const batch = errorsToFix.slice(i, i + 5);
      const fixes = await fixEnrichment(batch);

      for (const [errorId, fix] of fixes) {
        await applyFixes(errorId, { enrichment: fix });
      }
      log(`    Fixed ${Math.min(i + 5, errorsToFix.length)}/${errorsToFix.length}`);

      // Rate limit
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // Fix missing defense
  if (!options.enhanceOnly && gaps.missingDefense.length > 0) {
    log(`  Fixing ${gaps.missingDefense.length} missing defense strategies...`);
    const errorsToFix = gaps.missingDefense.map(id => errorMap.get(id)!).filter(Boolean);

    // Process in batches of 10
    for (let i = 0; i < errorsToFix.length; i += 10) {
      const batch = errorsToFix.slice(i, i + 10);
      const fixes = await fixDefense(batch);

      for (const [errorId, fix] of fixes) {
        await applyFixes(errorId, { defense: fix });
      }
      log(`    Fixed ${Math.min(i + 10, errorsToFix.length)}/${errorsToFix.length}`);

      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Fix missing articles
  if (!options.enhanceOnly && gaps.missingArticles.length > 0) {
    log(`  Fixing ${gaps.missingArticles.length} missing article mappings...`);
    const errorsToFix = gaps.missingArticles.map(id => errorMap.get(id)!).filter(Boolean);

    // Process in batches of 15
    for (let i = 0; i < errorsToFix.length; i += 15) {
      const batch = errorsToFix.slice(i, i + 15);
      const fixes = await fixArticles(batch);

      for (const [errorId, fix] of fixes) {
        await applyFixes(errorId, { articles: fix });
      }
      log(`    Fixed ${Math.min(i + 15, errorsToFix.length)}/${errorsToFix.length}`);

      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Enhance low quality
  if (!options.fixOnly && gaps.lowQualityErrors.length > 0) {
    log(`  Enhancing ${gaps.lowQualityErrors.length} low quality entries...`);
    const errorsToEnhance = gaps.lowQualityErrors.map(id => errorMap.get(id)!).filter(Boolean);

    // Process in batches of 5
    for (let i = 0; i < errorsToEnhance.length; i += 5) {
      const batch = errorsToEnhance.slice(i, i + 5);
      const enhancements = await enhanceQuality(batch);

      for (const [errorId, enhancement] of enhancements) {
        await applyFixes(errorId, { enhancement });
      }
      log(`    Enhanced ${Math.min(i + 5, errorsToEnhance.length)}/${errorsToEnhance.length}`);

      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // Re-analyze to verify
  const afterGaps = await analyzeGaps(repoId, repoName);
  log(`  After fixes:`);
  log(`    Missing enrichment: ${gaps.missingEnrichment.length} → ${afterGaps.missingEnrichment.length}`);
  log(`    Missing defense: ${gaps.missingDefense.length} → ${afterGaps.missingDefense.length}`);
  log(`    Missing articles: ${gaps.missingArticles.length} → ${afterGaps.missingArticles.length}`);
  log(`    Low quality: ${gaps.lowQualityErrors.length} → ${afterGaps.lowQualityErrors.length}`);
}

async function main() {
  const args = process.argv.slice(2);
  const fixOnly = args.includes("--fix-only");
  const enhanceOnly = args.includes("--enhance-only");
  const repoArg = args.find(a => a.startsWith("--repo="));
  const specificRepo = repoArg ? repoArg.split("=")[1] : null;

  console.log("ErrLookup Verify & Enhance");
  console.log("==========================\n");

  writeFileSync(LOG_FILE, `Verify & Enhance started at ${new Date().toISOString()}\n`);

  // Get repos to process
  let repos: { id: number; fullName: string }[];

  if (specificRepo) {
    const repo = await db.query.repositories.findFirst({
      where: eq(schema.repositories.fullName, specificRepo),
    });
    if (!repo) {
      log(`Repository not found: ${specificRepo}`);
      process.exit(1);
    }
    repos = [{ id: repo.id, fullName: repo.fullName }];
  } else {
    // Get all completed repos
    repos = await db.query.repositories.findMany({
      where: eq(schema.repositories.status, "completed"),
      columns: { id: true, fullName: true },
    });
  }

  log(`Found ${repos.length} repositories to process`);

  // First pass: analyze all gaps
  log("\n=== GAP ANALYSIS ===");
  const allGaps: GapAnalysis[] = [];

  for (const repo of repos) {
    const gaps = await analyzeGaps(repo.id, repo.fullName);
    allGaps.push(gaps);

    const issues = gaps.missingEnrichment.length + gaps.missingDefense.length +
                   gaps.missingArticles.length + gaps.lowQualityErrors.length;
    if (issues > 0) {
      log(`${repo.fullName}: ${issues} issues (E:${gaps.missingEnrichment.length} D:${gaps.missingDefense.length} A:${gaps.missingArticles.length} Q:${gaps.lowQualityErrors.length})`);
    }
  }

  const totalIssues = allGaps.reduce((sum, g) =>
    sum + g.missingEnrichment.length + g.missingDefense.length +
    g.missingArticles.length + g.lowQualityErrors.length, 0);

  log(`\nTotal issues to fix: ${totalIssues}`);

  if (totalIssues === 0) {
    log("All repositories are fully documented!");
    process.exit(0);
  }

  // Second pass: fix issues
  log("\n=== FIXING ISSUES ===");

  for (const repo of repos) {
    const gaps = allGaps.find(g => g.repoId === repo.id)!;
    const issues = gaps.missingEnrichment.length + gaps.missingDefense.length +
                   gaps.missingArticles.length + gaps.lowQualityErrors.length;

    if (issues > 0) {
      await processRepo(repo.id, repo.fullName, { fixOnly, enhanceOnly });
    }
  }

  // Final summary
  log("\n=== FINAL SUMMARY ===");
  let totalFixed = 0;

  for (const repo of repos) {
    const afterGaps = await analyzeGaps(repo.id, repo.fullName);
    const beforeGaps = allGaps.find(g => g.repoId === repo.id)!;

    const beforeIssues = beforeGaps.missingEnrichment.length + beforeGaps.missingDefense.length +
                         beforeGaps.missingArticles.length + beforeGaps.lowQualityErrors.length;
    const afterIssues = afterGaps.missingEnrichment.length + afterGaps.missingDefense.length +
                        afterGaps.missingArticles.length + afterGaps.lowQualityErrors.length;

    if (beforeIssues > 0) {
      const fixed = beforeIssues - afterIssues;
      totalFixed += fixed;
      log(`${repo.fullName}: ${beforeIssues} → ${afterIssues} (fixed ${fixed})`);
    }
  }

  log(`\nTotal issues fixed: ${totalFixed}/${totalIssues}`);
  process.exit(0);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});

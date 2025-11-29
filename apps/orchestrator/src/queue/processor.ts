import { Worker, Job } from "bullmq";
import { redisConnection } from "./connection.js";
import { type AnalyzeRepoJobData, type AnalyzeRepoJobResult } from "./jobs.js";
import { analyzeRepository, rateLimiter } from "../services/claude.js";
import {
  cloneRepository,
  cleanupRepository,
  detectRepoLanguage,
  getLatestCommitSha,
  parseRepoUrl,
} from "../services/github.js";
import { db, schema } from "../db/client.js";
import { eq } from "drizzle-orm";

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_JOBS || "3", 10);

async function processAnalyzeJob(
  job: Job<AnalyzeRepoJobData>
): Promise<AnalyzeRepoJobResult> {
  const { repoUrl, repoId, branch } = job.data;

  console.log(`[Job ${job.id}] Starting analysis of ${repoUrl}`);

  // Update status to analyzing
  await db
    .update(schema.repositories)
    .set({ status: "analyzing", updatedAt: new Date() })
    .where(eq(schema.repositories.id, repoId));

  let repoPath: string | null = null;

  try {
    // Step 1: Clone repository
    await job.updateProgress(10);
    console.log(`[Job ${job.id}] Cloning repository...`);
    repoPath = await cloneRepository(repoUrl, { branch });

    // Step 2: Detect language
    await job.updateProgress(20);
    console.log(`[Job ${job.id}] Detecting language...`);
    const language = await detectRepoLanguage(repoPath);
    const sha = await getLatestCommitSha(repoPath);

    // Step 3: Check rate limit
    const estimatedTokens = 50000; // Conservative estimate per repo
    if (!rateLimiter.canProcess(estimatedTokens)) {
      throw new Error("Daily token budget exceeded. Job will be retried tomorrow.");
    }

    // Step 4: Analyze with Claude
    await job.updateProgress(30);
    console.log(`[Job ${job.id}] Analyzing with Claude CLI...`);
    const analysis = await analyzeRepository(repoPath, language);
    rateLimiter.recordUsage(estimatedTokens);

    // Step 5: Save errors to database
    await job.updateProgress(70);
    console.log(`[Job ${job.id}] Saving ${analysis.errors.length} errors...`);

    // Delete existing errors for this repo
    await db
      .delete(schema.errors)
      .where(eq(schema.errors.repoId, repoId));

    // Insert new errors
    if (analysis.errors.length > 0) {
      await db.insert(schema.errors).values(
        analysis.errors.map((error) => ({
          repoId,
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

    // Step 6: Update repository status
    await job.updateProgress(90);
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
      .where(eq(schema.repositories.id, repoId));

    console.log(`[Job ${job.id}] Analysis complete: ${analysis.errors.length} errors found`);

    await job.updateProgress(100);

    return {
      url: repoUrl,
      errorCount: analysis.errors.length,
      sha,
    };
  } catch (error) {
    // Update status to error
    await db
      .update(schema.repositories)
      .set({
        status: "error",
        updatedAt: new Date(),
      })
      .where(eq(schema.repositories.id, repoId));

    // Log job failure
    await db.insert(schema.jobHistory).values({
      repoId,
      jobType: "analyze",
      status: "failed",
      startedAt: job.timestamp ? new Date(job.timestamp) : new Date(),
      completedAt: new Date(),
      errorLog: error instanceof Error ? error.message : String(error),
    });

    throw error;
  } finally {
    // Cleanup cloned repository
    if (repoPath) {
      await cleanupRepository(repoPath);
    }
  }
}

export function createAnalysisWorker(): Worker<AnalyzeRepoJobData, AnalyzeRepoJobResult> {
  const worker = new Worker<AnalyzeRepoJobData, AnalyzeRepoJobResult>(
    "repo-analysis",
    processAnalyzeJob,
    {
      connection: redisConnection,
      concurrency: MAX_CONCURRENT,
      limiter: {
        max: 10,
        duration: 60000, // 10 jobs per minute max
      },
    }
  );

  worker.on("completed", (job, result) => {
    console.log(`Worker completed job ${job.id}:`, result);
  });

  worker.on("failed", (job, error) => {
    console.error(`Worker failed job ${job?.id}:`, error.message);
  });

  worker.on("error", (error) => {
    console.error("Worker error:", error);
  });

  return worker;
}

export async function closeWorker(worker: Worker): Promise<void> {
  await worker.close();
}

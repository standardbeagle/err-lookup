import { Queue, Job, Worker, QueueEvents } from "bullmq";
import { redisConnection } from "./connection.js";

export interface AnalyzeRepoJobData {
  repoUrl: string;
  repoId: number;
  branch?: string;
  priority?: number;
}

export interface AnalyzeRepoJobResult {
  url: string;
  errorCount: number;
  sha: string;
}

export interface GenerateSiteJobData {
  repoId: number;
}

export interface DeploySiteJobData {
  repoId: number;
  buildPath: string;
}

export type JobData =
  | AnalyzeRepoJobData
  | GenerateSiteJobData
  | DeploySiteJobData;

// Queue definitions
export const analyzeQueue = new Queue<AnalyzeRepoJobData>("repo-analysis", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 10000,
    },
    removeOnComplete: {
      age: 24 * 3600, // Keep completed jobs for 24 hours
      count: 1000,
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // Keep failed jobs for 7 days
    },
  },
});

export const generateQueue = new Queue<GenerateSiteJobData>("site-generation", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: "fixed",
      delay: 5000,
    },
  },
});

export const deployQueue = new Queue<DeploySiteJobData>("site-deployment", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 15000,
    },
  },
});

// Queue events for monitoring
export const analyzeQueueEvents = new QueueEvents("repo-analysis", {
  connection: redisConnection,
});

analyzeQueueEvents.on("completed", ({ jobId, returnvalue }) => {
  console.log(`Job ${jobId} completed with result:`, returnvalue);
});

analyzeQueueEvents.on("failed", ({ jobId, failedReason }) => {
  console.error(`Job ${jobId} failed:`, failedReason);
});

analyzeQueueEvents.on("progress", ({ jobId, data }) => {
  console.log(`Job ${jobId} progress:`, data);
});

// Helper to add analysis job
export async function queueRepoAnalysis(
  data: AnalyzeRepoJobData
): Promise<Job<AnalyzeRepoJobData>> {
  const job = await analyzeQueue.add("analyze", data, {
    priority: data.priority || 0,
    jobId: `analyze-${data.repoId}-${Date.now()}`,
  });
  return job;
}

// Get queue statistics
export async function getQueueStats() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    analyzeQueue.getWaitingCount(),
    analyzeQueue.getActiveCount(),
    analyzeQueue.getCompletedCount(),
    analyzeQueue.getFailedCount(),
    analyzeQueue.getDelayedCount(),
  ]);

  return {
    waiting,
    active,
    completed,
    failed,
    delayed,
    total: waiting + active + delayed,
  };
}

// Graceful shutdown
export async function closeQueues(): Promise<void> {
  await Promise.all([
    analyzeQueue.close(),
    generateQueue.close(),
    deployQueue.close(),
    analyzeQueueEvents.close(),
  ]);
  await redisConnection.quit();
}

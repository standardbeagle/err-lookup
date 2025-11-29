import { createAnalysisWorker, closeWorker } from "./queue/processor.js";
import { closeQueues, getQueueStats } from "./queue/jobs.js";
import { checkClaudeAvailable, rateLimiter } from "./services/claude.js";

async function main() {
  console.log("Starting err-lookup orchestrator...");

  // Check Claude CLI availability
  const claudeAvailable = await checkClaudeAvailable();
  if (!claudeAvailable) {
    console.error("ERROR: Claude CLI is not available. Please install it first.");
    console.error("Visit: https://claude.ai/code");
    process.exit(1);
  }
  console.log("Claude CLI is available");

  // Start the worker
  const worker = createAnalysisWorker();
  console.log("Analysis worker started");

  // Log queue stats every minute
  const statsInterval = setInterval(async () => {
    try {
      const stats = await getQueueStats();
      const usage = rateLimiter.getUsage();
      console.log("Queue stats:", stats);
      console.log(`Token usage: ${usage.used}/${usage.budget} (${usage.percentage.toFixed(1)}%)`);
    } catch (error) {
      console.error("Failed to get queue stats:", error);
    }
  }, 60000);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down gracefully...`);
    clearInterval(statsInterval);

    try {
      await closeWorker(worker);
      await closeQueues();
      console.log("Shutdown complete");
      process.exit(0);
    } catch (error) {
      console.error("Error during shutdown:", error);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  console.log("Orchestrator is running. Press Ctrl+C to stop.");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

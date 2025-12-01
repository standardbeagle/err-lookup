import { execa, type Options as ExecaOptions } from "execa";
import {
  type AnalysisResult,
  type AnalyzedError,
} from "@error-schema/core";
import { retry } from "@err-lookup/shared";

// Provider configurations for load balancing across APIs
interface ProviderConfig {
  name: string;
  baseUrl?: string;
  authToken?: string;
  model?: string;
  smallModel?: string;
  useThinking?: boolean;
  timeoutMs?: number;
}

const PROVIDERS: Record<string, ProviderConfig> = {
  claude: {
    name: "claude",
    // Uses default Claude settings
    useThinking: true,
  },
  "claude-haiku": {
    name: "claude-haiku",
    model: "haiku", // Use alias for latest haiku
    useThinking: false,
  },
  glm: {
    name: "glm",
    baseUrl: "https://api.z.ai/api/anthropic",
    authToken: process.env.GLM_API_KEY || "4127fd23c9c5452ea4474e76afae2f60.iuw5XbOCJbFVWT5X",
    model: "GLM-4.6",
    useThinking: false,
  },
  kimi: {
    name: "kimi",
    baseUrl: "https://api.kimi.com/coding/",
    authToken: process.env.KIMI_API_KEY || "sk-kimi-QSo5Tt5wq1ZPAsd6za2dkJhxenHLluEqxqEwr4fP54dGldkhLOGsl6FANhcOT5N8",
    model: "kimi-for-coding",
    useThinking: false,
  },
  minimax: {
    name: "minimax",
    baseUrl: "https://api.minimax.io/anthropic",
    authToken: process.env.MINIMAX_API_KEY || "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJHcm91cE5hbWUiOiJBbmR5IEJydW1tZXIiLCJVc2VyTmFtZSI6IkFuZHkgQnJ1bW1lciIsIkFjY291bnQiOiIiLCJTdWJqZWN0SUQiOiIxOTgzODg3MDQ3MzcwMjE5NTc3IiwiUGhvbmUiOiIiLCJHcm91cElEIjoiMTk4Mzg4NzA0NzM2MTgyNjg3MyIsIlBhZ2VOYW1lIjoiIiwiTWFpbCI6ImFuZHlicnVtbWVyQHN0YW5kYXJkYmVhZ2xlLmNvbSIsIkNyZWF0ZVRpbWUiOiIyMDI1LTExLTEzIDAzOjU0OjU5IiwiVG9rZW5UeXBlIjo0LCJpc3MiOiJtaW5pbWF4In0.fRjf4Cf98dbG9hbpzRFA3J_b2H6Gb1gJX8VAAx_LwEcfrZYRlYM4j0cfmqGBfpljlc3qIChhR9g9zC51wH59dq9qeNIq_YZ9A3imbgxltc87kCzjURmm21cnhfCyG29cLTNmxzz0vA4hN69rSyMqpOwhzOBfL7W3qkq30UcaBeUWIh2eHANE0mZQAdXknbLuK8K9Hw5x61ikSJjJYDVQNrtwXrmuWZwSq4_XxO5Q0rplKFgFgvNcoDfKIEfpw1-3_pADuIhT5uAW2jj7FKM041aVnYNK3JTMpaV1g9qbYNjlqI-e53HvlDF9FI41MBP99xmiq747sdN5mXbtbmVJag",
    model: "MiniMax-M2",
    useThinking: false,
    timeoutMs: 300000,
  },
};

// Phase-specific provider assignments for load balancing
interface PhaseConfig {
  primary: string;
  fallback: string;
  batchSize?: number;
  timeoutMs: number;
  useThinking: boolean;
}

const PHASE_CONFIGS: Record<string, PhaseConfig> = {
  // Discovery: Complex task - needs opus with thinking
  discovery: {
    primary: "claude",
    fallback: "minimax",
    timeoutMs: 300000, // 5 min
    useThinking: true,
  },
  // Enrichment: Complex but can be batched - spread across providers
  enrichment: {
    primary: "claude",
    fallback: "glm",
    batchSize: 5, // Process 5 errors at a time
    timeoutMs: 180000, // 3 min per batch
    useThinking: true,
  },
  // Defense: Straightforward code generation - use haiku
  defense: {
    primary: "claude-haiku",
    fallback: "kimi",
    timeoutMs: 120000, // 2 min
    useThinking: false,
  },
  // Articles: Simple mapping - use haiku without thinking
  articles: {
    primary: "claude-haiku",
    fallback: "minimax",
    timeoutMs: 90000, // 1.5 min
    useThinking: false,
  },
};

export interface RateLimitOptions {
  requestsPerMinute?: number;       // Max requests per minute (default: 20)
  delayBetweenBatchesMs?: number;   // Delay between batch API calls (default: 3000)
  delayBetweenPhasesMs?: number;    // Delay between phases (default: 5000)
  exponentialBackoff?: boolean;     // Use exponential backoff on rate limit errors (default: true)
  maxBackoffMs?: number;            // Maximum backoff delay (default: 60000)
}

export interface StuckCheckOptions {
  enabled?: boolean;                // Enable stuck process detection (default: true)
  checkIntervalMs?: number;         // How often to run AI check (default: 300000 = 5 min)
  heartbeatIntervalMs?: number;     // How often to emit heartbeat (default: 30000)
  maxSilenceMs?: number;            // Max time without progress before AI evaluation (default: 180000)
  onHeartbeat?: (status: HeartbeatStatus) => void;  // Callback for heartbeat events
  onAction?: (action: CorrectiveAction) => Promise<void>;  // Callback when action is taken
}

export interface HeartbeatStatus {
  phase: string;
  batchIndex: number;
  totalBatches: number;
  lastProgressAt: Date;
  elapsedSinceProgressMs: number;
  totalElapsedMs: number;
  errorsProcessed: number;
  totalErrors: number;
}

export type CorrectiveActionType = 'continue' | 'skip_batch' | 'skip_phase' | 'retry_with_fallback' | 'abort';

export interface CorrectiveAction {
  type: CorrectiveActionType;
  reason: string;
  details?: string;
}

export interface MultiAgentOptions {
  timeoutMs?: number;
  maxRetries?: number;
  skipEnrichment?: boolean;
  skipDefense?: boolean;
  skipArticles?: boolean;
  verbose?: boolean;
  onProgress?: (phase: string, current: number, total: number, message: string) => void;
  rateLimit?: RateLimitOptions;
  stuckCheck?: StuckCheckOptions;
}

interface DiscoveredError {
  message: string;
  type: string;
  file: string;
  line?: number;
  code?: string;
  errorClass?: string;
  httpStatus?: number;
  // Source code fields (populated after discovery)
  sourceCode?: string;
  sourceCodeStart?: number;
  sourceCodeEnd?: number;
  githubUrl?: string;
}

interface EnrichedError extends DiscoveredError {
  triggerScenarios?: string;
  commonSituations?: string[];
  rootCause?: string;
  codeContext?: string;
  exampleFix?: string;
  preventionTips?: string[];
}

interface DefensiveData {
  handlingStrategy?: string;
  validationCode?: string;
  typeGuard?: string;
  tryCatchPattern?: string;
}

interface ArticleRecommendation {
  topic: string;
  category: string;
  slug: string;
  relevance: string;
  priority: string;
}

interface SuggestedArticle {
  title: string;
  category: string;
  description: string;
  relatedErrors: string[];
}

// Phase 1: Error Discovery - Find all errors in the codebase
const DISCOVERY_PROMPT = `Analyze this codebase to find ALL error patterns that users might encounter.

SEARCH SYSTEMATICALLY for:
1. throw new Error(), throw new CustomError() - JavaScript/TypeScript
2. raise Exception, raise ValueError - Python
3. errors.New(), fmt.Errorf() - Go
4. panic!(), Result::Err - Rust
5. console.error(), log.error() with user-facing messages
6. HTTP error responses (status codes 4xx, 5xx)
7. Error constants/enums (ENOTFOUND, EINVAL, etc.)
8. Validation error messages

For EACH error found, output JSON with these EXACT fields:
{
  "message": "The exact error message string from the source code",
  "type": "exception|error_code|console|http|validation|panic",
  "file": "path/relative/to/repo.ts",
  "line": 42,
  "code": "ERROR_CODE_IF_EXISTS",
  "httpStatus": 404
}

RULES:
- Include the EXACT error message, including template literals like \${variable}
- Note line numbers precisely
- Skip test files, mocks, and internal debug logs
- Prioritize production/user-facing errors
- Include at least 10-20 errors if they exist

OUTPUT FORMAT: Return ONLY a JSON object:
{"errors": [...]}`;

// Phase 2: Error Enrichment - Add context and examples (batched version)
function getEnrichmentPrompt(errors: DiscoveredError[], startIndex: number): string {
  const errorList = errors.map((e, i) =>
    `[${startIndex + i}] "${e.message.slice(0, 80)}" (${e.file}:${e.line || '?'})`
  ).join('\n');

  return `Enrich these ${errors.length} errors with debugging information:

${errorList}

For EACH error provide (use the index number in brackets as errorIndex):
1. **triggerScenarios**: SPECIFIC conditions causing this error
2. **commonSituations**: 2-3 real developer scenarios
3. **rootCause**: Why this error exists
4. **exampleFix**: Before/after code fix
5. **preventionTips**: How to avoid it

OUTPUT FORMAT (JSON only):
{
  "enrichedErrors": [
    {
      "errorIndex": 0,
      "triggerScenarios": "...",
      "commonSituations": ["..."],
      "rootCause": "...",
      "exampleFix": "// before/after...",
      "preventionTips": ["..."]
    }
  ]
}`;
}

// Phase 3: Defensive Strategies (batched)
function getDefensePrompt(errors: DiscoveredError[], startIndex: number): string {
  const errorList = errors.map((e, i) =>
    `[${startIndex + i}] ${e.code || e.message.slice(0, 60)} (${e.type})`
  ).join('\n');

  return `Generate defensive programming patterns for these ${errors.length} errors:

${errorList}

For EACH error provide (use the index number in brackets as errorIndex):
1. **handlingStrategy**: "retry"|"fallback"|"crash"|"log-continue"
2. **validationCode**: Input validation code
3. **typeGuard**: TypeScript type guard
4. **tryCatchPattern**: Error handling pattern

OUTPUT FORMAT (JSON only, no markdown):
{
  "defenseStrategies": [
    {
      "errorIndex": 0,
      "handlingStrategy": "retry",
      "validationCode": "// validation...",
      "typeGuard": "// type guard...",
      "tryCatchPattern": "// pattern..."
    }
  ]
}`;
}

// Phase 4: Article Recommendations (batched)
function getArticlePrompt(errors: DiscoveredError[], startIndex: number): string {
  const errorList = errors.map((e, i) =>
    `[${startIndex + i}] ${e.code || e.message.slice(0, 60)} (${e.type})`
  ).join('\n');

  return `Map these ${errors.length} errors to educational articles:

${errorList}

EXISTING ARTICLES:
- networking: dns, tcp-ip, tls-ssl, http-status-codes, websockets
- programming: type-systems, memory-safety, concurrency, error-handling-patterns
- os: signals, exit-codes, file-descriptors
- debugging: reading-stack-traces, debugging-node, debugging-python

For EACH error provide (use the index number in brackets as errorIndex):
1. **recommendedArticles**: 1-2 existing article slugs
2. **suggestedNewArticles**: New article ideas if needed

OUTPUT FORMAT (JSON only, no markdown):
{
  "articleMappings": [
    {
      "errorIndex": 0,
      "recommendedArticles": [{"slug": "dns", "category": "networking", "relevance": "..."}],
      "suggestedNewArticles": [{"title": "...", "category": "...", "description": "..."}]
    }
  ]
}`;
}

async function runAgentWithProvider(
  repoPath: string,
  prompt: string,
  phaseConfig: PhaseConfig,
  providerOverride?: string
): Promise<string> {
  const providerName = providerOverride || phaseConfig.primary;
  const provider = PROVIDERS[providerName] || PROVIDERS.claude;
  const timeoutMs = provider.timeoutMs || phaseConfig.timeoutMs;

  const env: Record<string, string> = {};

  // Copy process.env, filtering out undefined values
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  // Configure provider-specific environment
  if (provider.baseUrl) {
    env.ANTHROPIC_BASE_URL = provider.baseUrl;
  }
  if (provider.authToken) {
    env.ANTHROPIC_AUTH_TOKEN = provider.authToken;
  }
  if (provider.model) {
    env.ANTHROPIC_MODEL = provider.model;
  }

  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--print",
    "--permission-mode",
    "bypassPermissions",
  ];

  // Add model flag if provider specifies a model
  if (provider.model && !provider.baseUrl) {
    // Only add --model for native Claude providers (not external APIs)
    args.push("--model", provider.model);
  }

  const execaOptions: ExecaOptions = {
    cwd: repoPath,
    timeout: timeoutMs,
    maxBuffer: 100 * 1024 * 1024,
    reject: true,
    stdin: "ignore",
    env,
  };

  const result = await execa("claude", args, execaOptions);

  const stdout = result.stdout;
  if (!stdout || typeof stdout !== "string") {
    throw new Error(`${provider.name} returned empty output`);
  }

  // Parse Claude CLI JSON wrapper
  const claudeOutput = JSON.parse(stdout);
  const resultText = claudeOutput.result || "";

  // Extract JSON from the response using helper
  return extractJson(resultText);
}

async function runWithFallback(
  repoPath: string,
  prompt: string,
  phaseConfig: PhaseConfig,
  phaseName: string,
  verbose: boolean
): Promise<string> {
  try {
    return await runAgentWithProvider(repoPath, prompt, phaseConfig);
  } catch (primaryError) {
    if (verbose) {
      const err = primaryError as Error;
      console.log(`    ${phaseConfig.primary} failed: ${err.message?.slice(0, 60)}...`);
      console.log(`    Falling back to ${phaseConfig.fallback}...`);
    }

    try {
      return await runAgentWithProvider(repoPath, prompt, phaseConfig, phaseConfig.fallback);
    } catch (fallbackError) {
      throw new Error(
        `Both ${phaseConfig.primary} and ${phaseConfig.fallback} failed for ${phaseName}`
      );
    }
  }
}

// Batch array into chunks
function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Supervisor agent that monitors progress and takes corrective action
class ProcessSupervisor {
  private startTime: Date;
  private lastProgressTime: Date;
  private currentPhase: string = 'init';
  private currentBatch: number = 0;
  private totalBatches: number = 0;
  private errorsProcessed: number = 0;
  private totalErrors: number = 0;
  private intervalHandle: NodeJS.Timeout | null = null;
  private aborted: boolean = false;
  private skipCurrentBatch: boolean = false;
  private skipCurrentPhase: boolean = false;
  private logFile: string;
  private options: {
    enabled: boolean;
    checkIntervalMs: number;
    logFile: string;
  };

  constructor(options: StuckCheckOptions = {}, logFile?: string) {
    this.options = {
      enabled: options.enabled ?? true,
      checkIntervalMs: options.checkIntervalMs ?? 300000, // 5 minutes
      logFile: logFile || 'supervisor.log',
    };
    this.logFile = this.options.logFile;
    this.startTime = new Date();
    this.lastProgressTime = new Date();
  }

  private async log(message: string): Promise<void> {
    const timestamp = new Date().toISOString();
    const entry = `\n## ${timestamp}\n${message}\n`;
    try {
      const fs = await import('fs/promises');
      await fs.appendFile(this.logFile, entry);
    } catch {
      console.log(`[Supervisor] ${message}`);
    }
  }

  start(): void {
    if (!this.options.enabled) return;

    this.log(`# Supervisor Started\nCheck interval: ${this.options.checkIntervalMs / 1000}s`);

    this.intervalHandle = setInterval(async () => {
      await this.runCheck();
    }, this.options.checkIntervalMs);
  }

  private async runCheck(): Promise<void> {
    const status = this.getStatus();
    const elapsedMin = Math.round(status.elapsedSinceProgressMs / 60000);
    const totalMin = Math.round(status.totalElapsedMs / 60000);

    const prompt = `You are an autonomous process supervisor with FULL SYSTEM ACCESS monitoring a batch error analysis job. You can execute any bash commands needed to diagnose and fix issues.

## Current Status
- **Phase**: ${status.phase}
- **Batch**: ${status.batchIndex}/${status.totalBatches}
- **Progress**: ${status.errorsProcessed}/${status.totalErrors} errors processed
- **Time since last progress**: ${elapsedMin} minutes
- **Total elapsed**: ${totalMin} minutes
- **Log file**: ${this.logFile}

## Expected Timelines
- Enrichment: 1-2 min per batch of 5 errors
- Defense: 30-60s per batch of 15 errors
- Articles: 30-60s per batch of 20 errors

## Your Capabilities
You have full system access. You can:
1. Check running processes: \`ps aux | grep claude\`
2. Check system resources: \`free -h\`, \`df -h\`
3. Kill stuck processes: \`pkill -f "pattern"\`
4. Check network: \`curl -I https://api.anthropic.com\`
5. Read logs: \`tail -50 /path/to/log\`
6. Restart services if needed
7. Clear temp files if disk is full

## Your Task
1. Diagnose why progress may be stalled (if stalled)
2. Take corrective action using bash commands if needed
3. Log your findings and actions

If everything looks fine, just confirm and continue monitoring.
If you take corrective action, describe what you did and why.

Write your analysis in markdown. If you need to signal the main process:
- **ACTION**: CONTINUE - All is well
- **ACTION**: SKIP_BATCH - Skip current batch (you handled it)
- **ACTION**: SKIP_PHASE - Skip rest of phase (too problematic)
- **ACTION**: ABORT - Critical issue, stop everything`;

    try {
      const result = await execa("claude", [
        "-p", prompt,
        "--model", "haiku",
        "--output-format", "text",
        "--print",
        "--permission-mode", "bypassPermissions",
      ], {
        timeout: 120000, // 2 min timeout for supervisor actions
        reject: false,
        stdin: "ignore",
      });

      const response = result.stdout?.toString() || 'Check failed - no response';
      await this.log(response);

      // Parse action from response
      const actionMatch = response.match(/\*\*ACTION\*\*:\s*(CONTINUE|SKIP_BATCH|SKIP_PHASE|ABORT)/i);
      if (actionMatch) {
        const action = actionMatch[1].toUpperCase();
        switch (action) {
          case 'SKIP_BATCH':
            this.skipCurrentBatch = true;
            await this.log('→ Supervisor skipped current batch');
            break;
          case 'SKIP_PHASE':
            this.skipCurrentPhase = true;
            await this.log('→ Supervisor skipped current phase');
            break;
          case 'ABORT':
            this.aborted = true;
            await this.log('→ Supervisor aborted process');
            break;
          default:
            await this.log('→ Supervisor: continuing normally');
        }
      }
    } catch (err) {
      const error = err as Error;
      await this.log(`Supervisor check failed: ${error.message}`);
    }
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.log('# Supervisor Stopped');
  }

  updateProgress(phase: string, batch: number, totalBatches: number, processed: number, total: number): void {
    this.currentPhase = phase;
    this.currentBatch = batch;
    this.totalBatches = totalBatches;
    this.errorsProcessed = processed;
    this.totalErrors = total;
    this.lastProgressTime = new Date();
    // Reset skip flags on progress
    this.skipCurrentBatch = false;
  }

  setPhase(phase: string): void {
    this.currentPhase = phase;
    this.skipCurrentPhase = false;
  }

  isAborted(): boolean {
    return this.aborted;
  }

  shouldSkipBatch(): boolean {
    const skip = this.skipCurrentBatch;
    this.skipCurrentBatch = false; // Reset after check
    return skip;
  }

  shouldSkipPhase(): boolean {
    return this.skipCurrentPhase;
  }

  getStatus(): HeartbeatStatus {
    const now = new Date();
    return {
      phase: this.currentPhase,
      batchIndex: this.currentBatch,
      totalBatches: this.totalBatches,
      lastProgressAt: this.lastProgressTime,
      elapsedSinceProgressMs: now.getTime() - this.lastProgressTime.getTime(),
      totalElapsedMs: now.getTime() - this.startTime.getTime(),
      errorsProcessed: this.errorsProcessed,
      totalErrors: this.totalErrors,
    };
  }
}

// Alias for backward compatibility
const StuckChecker = ProcessSupervisor;

// Rate limiter with exponential backoff
class RateLimiter {
  private lastRequestTime: number = 0;
  private requestCount: number = 0;
  private windowStart: number = Date.now();
  private currentBackoff: number = 1000;
  private options: Required<RateLimitOptions>;

  constructor(options: RateLimitOptions = {}) {
    this.options = {
      requestsPerMinute: options.requestsPerMinute ?? 20,
      delayBetweenBatchesMs: options.delayBetweenBatchesMs ?? 3000,
      delayBetweenPhasesMs: options.delayBetweenPhasesMs ?? 5000,
      exponentialBackoff: options.exponentialBackoff ?? true,
      maxBackoffMs: options.maxBackoffMs ?? 60000,
    };
  }

  async waitForSlot(): Promise<void> {
    const now = Date.now();

    // Reset window if more than a minute has passed
    if (now - this.windowStart > 60000) {
      this.windowStart = now;
      this.requestCount = 0;
    }

    // Check if we're at the rate limit
    if (this.requestCount >= this.options.requestsPerMinute) {
      const waitTime = 60000 - (now - this.windowStart);
      if (waitTime > 0) {
        await this.sleep(waitTime);
        this.windowStart = Date.now();
        this.requestCount = 0;
      }
    }

    // Enforce minimum delay between requests
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.options.delayBetweenBatchesMs) {
      await this.sleep(this.options.delayBetweenBatchesMs - timeSinceLastRequest);
    }

    this.lastRequestTime = Date.now();
    this.requestCount++;
  }

  async waitBetweenPhases(): Promise<void> {
    await this.sleep(this.options.delayBetweenPhasesMs);
    // Reset backoff on phase change
    this.currentBackoff = 1000;
  }

  async handleRateLimitError(): Promise<void> {
    if (!this.options.exponentialBackoff) {
      await this.sleep(5000);
      return;
    }

    await this.sleep(this.currentBackoff);
    this.currentBackoff = Math.min(this.currentBackoff * 2, this.options.maxBackoffMs);
  }

  resetBackoff(): void {
    this.currentBackoff = 1000;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Extract JSON from response that may contain markdown or other text
function extractJson(text: string): string {
  // Try to find JSON in markdown code blocks first
  const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    return jsonBlockMatch[1].trim();
  }

  // Try to find JSON object directly
  const jsonObjectMatch = text.match(/\{[\s\S]*\}/);
  if (jsonObjectMatch) {
    return jsonObjectMatch[0];
  }

  // Return as-is if no patterns found
  return text.trim();
}

// Extract source code region around an error location
async function extractSourceCodeRegion(
  repoPath: string,
  filePath: string,
  lineNumber: number | undefined,
  contextLines = 5
): Promise<{ sourceCode: string; startLine: number; endLine: number } | null> {
  if (!lineNumber) return null;

  const fs = await import('fs/promises');
  const path = await import('path');

  const fullPath = path.join(repoPath, filePath);

  try {
    const content = await fs.readFile(fullPath, 'utf-8');
    const lines = content.split('\n');

    // Calculate region bounds (1-indexed to 0-indexed)
    const startLine = Math.max(1, lineNumber - contextLines);
    const endLine = Math.min(lines.length, lineNumber + contextLines);

    // Extract lines (convert to 0-indexed for array access)
    const extractedLines = lines.slice(startLine - 1, endLine);

    return {
      sourceCode: extractedLines.join('\n'),
      startLine,
      endLine,
    };
  } catch {
    // File not found or unreadable
    return null;
  }
}

// Build GitHub URL for a file location
function buildGitHubErrorUrl(
  repoFullName: string,
  filePath: string,
  lineNumber?: number,
  startLine?: number,
  endLine?: number,
  branch = 'main'
): string {
  const baseUrl = `https://github.com/${repoFullName}/blob/${branch}/${filePath}`;

  // Prefer range if available
  if (startLine && endLine && endLine !== startLine) {
    return `${baseUrl}#L${startLine}-L${endLine}`;
  }

  // Fall back to single line
  if (lineNumber) {
    return `${baseUrl}#L${lineNumber}`;
  }

  return baseUrl;
}

// Enhance discovered errors with source code and GitHub URLs
async function enhanceWithSourceCode(
  errors: DiscoveredError[],
  repoPath: string,
  repoFullName: string,
  verbose = false
): Promise<DiscoveredError[]> {
  const enhanced: DiscoveredError[] = [];

  for (const error of errors) {
    const region = await extractSourceCodeRegion(repoPath, error.file, error.line);

    if (region) {
      enhanced.push({
        ...error,
        sourceCode: region.sourceCode,
        sourceCodeStart: region.startLine,
        sourceCodeEnd: region.endLine,
        githubUrl: buildGitHubErrorUrl(
          repoFullName,
          error.file,
          error.line,
          region.startLine,
          region.endLine
        ),
      });
    } else {
      // Still build GitHub URL even without source code
      enhanced.push({
        ...error,
        githubUrl: buildGitHubErrorUrl(repoFullName, error.file, error.line),
      });
    }
  }

  if (verbose) {
    const withSource = enhanced.filter(e => e.sourceCode).length;
    console.log(`    Extracted source code for ${withSource}/${enhanced.length} errors`);
  }

  return enhanced;
}

export async function analyzeRepositoryMultiAgent(
  repoPath: string,
  language: string,
  options: MultiAgentOptions = {},
  repoFullName?: string  // Optional: provide for GitHub URL generation
): Promise<AnalysisResult> {
  const {
    maxRetries = 2,
    skipEnrichment = false,
    skipDefense = false,
    skipArticles = false,
    verbose = false,
    onProgress,
    rateLimit = {},
    stuckCheck = {},
  } = options;

  const progress = onProgress || ((phase, cur, total, msg) => {
    if (verbose) console.log(`    [${phase}] ${cur}/${total}: ${msg}`);
  });

  // Initialize rate limiter and process supervisor
  const rateLimiter = new RateLimiter(rateLimit);
  const supervisorLogFile = `${repoPath}/supervisor-${Date.now()}.md`;
  const supervisor = new ProcessSupervisor(stuckCheck, supervisorLogFile);

  supervisor.start();
  if (verbose) {
    console.log(`    📋 Supervisor log: ${supervisorLogFile}`);
  }

  try {
    // Phase 1: Discovery (opus with thinking)
    console.log("  Phase 1: Discovering errors...");
    progress("discovery", 0, 1, "Starting error discovery");
    supervisor.updateProgress("discovery", 0, 1, 0, 0);

  const discoveryResult = await retry(
    async () => {
      const json = await runWithFallback(
        repoPath,
        DISCOVERY_PROMPT,
        PHASE_CONFIGS.discovery,
        "discovery",
        verbose
      );
      return JSON.parse(json) as { errors: DiscoveredError[] };
    },
    { maxAttempts: maxRetries, initialDelayMs: 5000, maxDelayMs: 30000, backoffFactor: 2 }
  );

  let discoveredErrors = discoveryResult.errors || [];
  console.log(`    Found ${discoveredErrors.length} errors`);
  progress("discovery", 1, 1, `Found ${discoveredErrors.length} errors`);
  supervisor.updateProgress("discovery", 1, 1, 0, discoveredErrors.length);

  if (discoveredErrors.length === 0) {
    supervisor.stop();
    return {
      repo: { name: repoFullName || "unknown", language },
      errors: [],
    };
  }

  // Extract source code regions and build GitHub URLs
  if (repoFullName) {
    console.log("  Extracting source code regions...");
    discoveredErrors = await enhanceWithSourceCode(
      discoveredErrors,
      repoPath,
      repoFullName,
      verbose
    );
  }

  // Wait before Phase 2
  await rateLimiter.waitBetweenPhases();

  // Phase 2: Enrichment with batching (opus with thinking, batched)
  // Use index-based map for reliable matching
  const enrichmentMap = new Map<number, any>();
  if (!skipEnrichment && discoveredErrors.length > 0) {
    console.log("  Phase 2: Enriching errors with context...");
    const batchSize = PHASE_CONFIGS.enrichment.batchSize || 5;
    const batches = chunk(discoveredErrors, batchSize);

    supervisor.setPhase("enrichment");
    for (let i = 0; i < batches.length; i++) {
      // Check supervisor signals
      if (supervisor.isAborted()) {
        console.log("    ⚠️ Aborting enrichment - supervisor requested abort");
        break;
      }
      if (supervisor.shouldSkipPhase()) {
        console.log("    ⏭️ Skipping rest of enrichment phase - supervisor requested");
        break;
      }
      if (supervisor.shouldSkipBatch()) {
        console.log(`    ⏭️ Skipping batch ${i + 1} - supervisor requested`);
        continue;
      }

      const batch = batches[i];
      const startIndex = i * batchSize;
      progress("enrichment", i + 1, batches.length, `Processing batch ${i + 1}/${batches.length}`);
      supervisor.updateProgress("enrichment", i + 1, batches.length, enrichmentMap.size, discoveredErrors.length);

      // Rate limit before each batch request
      await rateLimiter.waitForSlot();

      try {
        const enrichmentPrompt = getEnrichmentPrompt(batch, startIndex);
        const enrichmentJson = await runWithFallback(
          repoPath,
          enrichmentPrompt,
          PHASE_CONFIGS.enrichment,
          `enrichment batch ${i + 1}`,
          verbose
        );
        const enrichmentResult = JSON.parse(enrichmentJson) as { enrichedErrors: any[] };

        for (const enriched of enrichmentResult.enrichedErrors || []) {
          const idx = enriched.errorIndex ?? enriched.index;
          if (typeof idx === "number") {
            enrichmentMap.set(idx, enriched);
          }
        }

        rateLimiter.resetBackoff();
      } catch (error) {
        const err = error as Error;
        const isRateLimit = err.message?.includes('rate') || err.message?.includes('429');
        console.log(`    Batch ${i + 1} failed: ${err.message?.slice(0, 60)}`);

        if (isRateLimit) {
          console.log("    ⏳ Rate limited, backing off...");
          await rateLimiter.handleRateLimitError();
          i--; // Retry this batch
          continue;
        }
        // Continue with other batches for non-rate-limit errors
      }
    }
    console.log(`    Enriched ${enrichmentMap.size}/${discoveredErrors.length} errors`);
  }

  // Wait before Phase 3
  await rateLimiter.waitBetweenPhases();

  // Phase 3: Defensive strategies with batching (haiku without thinking)
  const defenseMap = new Map<number, DefensiveData>();
  if (!skipDefense && discoveredErrors.length > 0 && !supervisor.isAborted()) {
    console.log("  Phase 3: Generating defensive strategies...");
    const batchSize = 15; // Process 15 errors at a time for defense
    const batches = chunk(discoveredErrors, batchSize);

    supervisor.setPhase("defense");
    for (let i = 0; i < batches.length; i++) {
      // Check supervisor signals
      if (supervisor.isAborted()) {
        console.log("    ⚠️ Aborting defense - supervisor requested abort");
        break;
      }
      if (supervisor.shouldSkipPhase()) {
        console.log("    ⏭️ Skipping rest of defense phase - supervisor requested");
        break;
      }
      if (supervisor.shouldSkipBatch()) {
        console.log(`    ⏭️ Skipping batch ${i + 1} - supervisor requested`);
        continue;
      }

      const batch = batches[i];
      const startIndex = i * batchSize;
      progress("defense", i + 1, batches.length, `Processing batch ${i + 1}/${batches.length}`);
      supervisor.updateProgress("defense", i + 1, batches.length, defenseMap.size, discoveredErrors.length);

      // Rate limit before each batch request
      await rateLimiter.waitForSlot();

      try {
        const defensePrompt = getDefensePrompt(batch, startIndex);
        const defenseJson = await runWithFallback(
          repoPath,
          defensePrompt,
          PHASE_CONFIGS.defense,
          `defense batch ${i + 1}`,
          verbose
        );
        const defenseResult = JSON.parse(defenseJson) as { defenseStrategies: any[] };

        for (const defense of defenseResult.defenseStrategies || []) {
          const idx = defense.errorIndex ?? defense.index;
          if (typeof idx === "number") {
            defenseMap.set(idx, defense);
          }
        }

        rateLimiter.resetBackoff();
      } catch (error) {
        const err = error as Error;
        const isRateLimit = err.message?.includes('rate') || err.message?.includes('429');
        console.log(`    Defense batch ${i + 1} failed: ${err.message?.slice(0, 60)}`);

        if (isRateLimit) {
          console.log("    ⏳ Rate limited, backing off...");
          await rateLimiter.handleRateLimitError();
          i--; // Retry this batch
          continue;
        }
        // Continue with other batches for non-rate-limit errors
      }
    }
    console.log(`    Generated ${defenseMap.size}/${discoveredErrors.length} defense strategies`);
  }

  // Wait before Phase 4
  await rateLimiter.waitBetweenPhases();

  // Phase 4: Article recommendations with batching (haiku without thinking)
  const articleMap = new Map<number, { recommended: ArticleRecommendation[], suggested: SuggestedArticle[] }>();
  if (!skipArticles && discoveredErrors.length > 0 && !supervisor.isAborted()) {
    console.log("  Phase 4: Mapping to educational articles...");
    const batchSize = 20; // Process 20 errors at a time for articles
    const batches = chunk(discoveredErrors, batchSize);

    supervisor.setPhase("articles");
    for (let i = 0; i < batches.length; i++) {
      // Check supervisor signals
      if (supervisor.isAborted()) {
        console.log("    ⚠️ Aborting articles - supervisor requested abort");
        break;
      }
      if (supervisor.shouldSkipPhase()) {
        console.log("    ⏭️ Skipping rest of articles phase - supervisor requested");
        break;
      }
      if (supervisor.shouldSkipBatch()) {
        console.log(`    ⏭️ Skipping batch ${i + 1} - supervisor requested`);
        continue;
      }

      const batch = batches[i];
      const startIndex = i * batchSize;
      progress("articles", i + 1, batches.length, `Processing batch ${i + 1}/${batches.length}`);
      supervisor.updateProgress("articles", i + 1, batches.length, articleMap.size, discoveredErrors.length);

      // Rate limit before each batch request
      await rateLimiter.waitForSlot();

      try {
        const articlePrompt = getArticlePrompt(batch, startIndex);
        const articleJson = await runWithFallback(
          repoPath,
          articlePrompt,
          PHASE_CONFIGS.articles,
          `articles batch ${i + 1}`,
          verbose
        );
        const articleResult = JSON.parse(articleJson) as { articleMappings: any[] };

        for (const mapping of articleResult.articleMappings || []) {
          const idx = mapping.errorIndex ?? mapping.index;
          if (typeof idx === "number") {
            articleMap.set(idx, {
              recommended: mapping.recommendedArticles || [],
              suggested: mapping.suggestedNewArticles || [],
            });
          }
        }

        rateLimiter.resetBackoff();
      } catch (error) {
        const err = error as Error;
        const isRateLimit = err.message?.includes('rate') || err.message?.includes('429');
        console.log(`    Articles batch ${i + 1} failed: ${err.message?.slice(0, 60)}`);

        if (isRateLimit) {
          console.log("    ⏳ Rate limited, backing off...");
          await rateLimiter.handleRateLimitError();
          i--; // Retry this batch
          continue;
        }
        // Continue with other batches for non-rate-limit errors
      }
    }
    console.log(`    Mapped ${articleMap.size}/${discoveredErrors.length} errors to articles`);
  }

  // Valid error types for AnalyzedError
  const validErrorTypes = ["exception", "error_code", "console", "panic", "assert", "custom_class"] as const;
  type ErrorType = typeof validErrorTypes[number];

  // Merge all data using index-based lookups
  const fullErrors: AnalyzedError[] = discoveredErrors.map((discovered, index) => {
    const enriched = enrichmentMap.get(index) || {};
    const defense = defenseMap.get(index) || {};
    const articles = articleMap.get(index) || { recommended: [], suggested: [] };

    // Normalize type to valid enum value
    const normalizedType: ErrorType = validErrorTypes.includes(discovered.type as ErrorType)
      ? (discovered.type as ErrorType)
      : "exception";

    return {
      message: discovered.message,
      type: normalizedType,
      file: discovered.file,
      line: discovered.line,
      code: discovered.code,
      httpStatus: discovered.httpStatus,
      severity: "error" as const,
      // Source code context (for SEO)
      sourceCode: discovered.sourceCode,
      sourceCodeStart: discovered.sourceCodeStart,
      sourceCodeEnd: discovered.sourceCodeEnd,
      githubUrl: discovered.githubUrl,
      // Enrichment data
      cause: (enriched as any).rootCause || (enriched as any).triggerScenarios,
      resolution: (enriched as any).exampleFix,
      context: (enriched as any).codeContext,
      triggerScenarios: (enriched as any).triggerScenarios,
      commonSituations: (enriched as any).commonSituations,
      exampleFix: (enriched as any).exampleFix,
      preventionTips: (enriched as any).preventionTips,
      // Defense data
      handlingStrategy: (defense as any).handlingStrategy,
      validationCode: (defense as any).validationCode,
      typeGuard: (defense as any).typeGuard,
      tryCatchPattern: (defense as any).tryCatchPattern,
      // Article data
      recommendedArticles: articles.recommended.map(a => `${a.category}/${a.slug}`),
      suggestedNewArticles: articles.suggested,
    };
  });

  console.log("  Analysis complete!");

  return {
    repo: {
      name: repoFullName || "unknown",
      language: language,
    },
    errors: fullErrors,
  };
  } finally {
    // Always stop the stuck checker
    supervisor.stop();
  }
}

// Collect all suggested new articles across analyzed repos
export function collectSuggestedArticles(
  analysisResults: AnalysisResult[]
): SuggestedArticle[] {
  const suggestions = new Map<string, SuggestedArticle & { count: number }>();

  for (const result of analysisResults) {
    for (const error of result.errors) {
      const suggested = (error as any).suggestedNewArticles || [];
      for (const article of suggested) {
        const key = `${article.category}/${article.title}`;
        const existing = suggestions.get(key);
        if (existing) {
          existing.count++;
          existing.relatedErrors.push(...(article.relatedErrors || []));
        } else {
          suggestions.set(key, {
            ...article,
            count: 1,
            relatedErrors: article.relatedErrors || [],
          });
        }
      }
    }
  }

  // Sort by frequency
  return Array.from(suggestions.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
}

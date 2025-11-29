import { execa, type ExecaError } from "execa";
import { readFile, writeFile, mkdtemp, rm } from "fs/promises";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import {
  type AnalysisResult,
  validateAnalysisResult,
} from "@error-schema/core";
import { retry } from "@err-lookup/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ClaudeAnalysisOptions {
  timeoutMs?: number;
  maxRetries?: number;
}

const PROMPTS: Record<string, string> = {
  typescript: `Analyze this TypeScript/JavaScript codebase and extract ALL error patterns.

LOOK FOR:
1. throw new Error() and throw new CustomError() statements
2. Error class definitions that extend Error
3. console.error(), console.warn() with user messages
4. reject() calls in Promises with error messages
5. HTTP error responses (status codes with messages)
6. Validation errors (form validation, input checks)
7. Error codes in constants or enums

FOR EACH ERROR FOUND, provide these fields:
- message: The exact error message string (required)
- type: One of [exception, error_code, console, custom_class] (required)
- file: Source file path relative to repo root (required)
- line: Line number (optional)
- code: Unique identifier if available like "INVALID_INPUT" (optional)
- cause: What triggers this error (optional)
- resolution: How to fix it (optional)

PRIORITIZE errors users will actually encounter in production.
SKIP test-only assertions and internal debug logs.

OUTPUT FORMAT: Return ONLY a JSON object like this:
{"errors": [{"message": "...", "type": "exception", "file": "src/index.ts", "line": 42}]}`,

  python: `Analyze this Python codebase and extract ALL error patterns.

LOOK FOR:
1. raise Exception, raise ValueError, raise CustomError statements
2. Custom exception class definitions
3. logging.error(), logging.warning() with user messages
4. HTTP error responses (status codes, error dicts)
5. Validation errors (form validation, pydantic)
6. Error codes in constants or error enums

FOR EACH ERROR FOUND:
- code: Unique identifier if available
- message: The exact error message string
- type: One of [exception, error_code, console, custom_class]
- file: Source file path relative to repo root
- line: Line number
- context: Surrounding code (max 10 lines)
- cause: What triggers this error (1-2 sentences)
- resolution: How to fix it (1-3 sentences)
- severity: One of [critical, error, warning, info]

PRIORITIZE production errors over test assertions.`,

  go: `Analyze this Go codebase and extract ALL error patterns.

LOOK FOR:
1. errors.New() and fmt.Errorf() calls
2. Custom error types implementing error interface
3. log.Fatal, log.Error, log.Warn calls
4. HTTP error responses with status codes
5. Error variables (var ErrNotFound = errors.New(...))
6. Sentinel errors and wrapped errors

FOR EACH ERROR FOUND:
- code: Error variable name or identifier
- message: The exact error message string
- type: One of [exception, error_code, console, panic, custom_class]
- file: Source file path relative to repo root
- line: Line number
- context: Surrounding code (max 10 lines)
- cause: What triggers this error (1-2 sentences)
- resolution: How to fix it (1-3 sentences)
- severity: One of [critical, error, warning, info]

PRIORITIZE exported errors and user-facing messages.`,

  rust: `Analyze this Rust codebase and extract ALL error patterns.

LOOK FOR:
1. panic!() and unwrap() with messages
2. Custom error enums implementing std::error::Error
3. thiserror/anyhow error definitions
4. Result::Err returns with error messages
5. Error variants in enums
6. Error codes and categories

FOR EACH ERROR FOUND:
- code: Error variant name or identifier
- message: The display message
- type: One of [exception, error_code, panic, custom_class]
- file: Source file path relative to repo root
- line: Line number
- context: Surrounding code (max 10 lines)
- cause: What triggers this error (1-2 sentences)
- resolution: How to fix it (1-3 sentences)
- severity: One of [critical, error, warning, info]

PRIORITIZE public API errors.`,

  java: `Analyze this Java codebase and extract ALL error patterns.

LOOK FOR:
1. throw new Exception, throw new CustomException statements
2. Custom exception class definitions
3. Logger.error(), Logger.warn() with messages
4. HTTP error responses (ResponseEntity with status)
5. Error codes in enums or constants
6. @ExceptionHandler methods

FOR EACH ERROR FOUND:
- code: Exception class name or error code
- message: The error message string
- type: One of [exception, error_code, console, custom_class]
- file: Source file path relative to repo root
- line: Line number
- context: Surrounding code (max 10 lines)
- cause: What triggers this error (1-2 sentences)
- resolution: How to fix it (1-3 sentences)
- severity: One of [critical, error, warning, info]

PRIORITIZE public API errors.`,

  default: `Analyze this codebase and extract ALL error patterns.

LOOK FOR:
1. Exception/Error throwing statements
2. Custom error class definitions
3. Logging calls (error, warn levels)
4. HTTP error responses
5. Error codes and constants
6. Panic/Assert statements

FOR EACH ERROR FOUND:
- code: Unique identifier if available
- message: The error message string
- type: One of [exception, error_code, console, panic, assert, custom_class]
- file: Source file path relative to repo root
- line: Line number
- context: Surrounding code (max 10 lines)
- cause: What triggers this error (1-2 sentences)
- resolution: How to fix it (1-3 sentences)
- severity: One of [critical, error, warning, info]

PRIORITIZE production errors users will encounter.`,
};

function getPromptForLanguage(language: string): string {
  const normalizedLang = language.toLowerCase();

  if (normalizedLang === "typescript" || normalizedLang === "javascript") {
    return PROMPTS.typescript;
  }

  return PROMPTS[normalizedLang] || PROMPTS.default;
}

async function loadSchema(): Promise<string> {
  const schemaPath = join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "packages",
    "error-schema",
    "schema.json"
  );
  const schemaContent = await readFile(schemaPath, "utf-8");
  return schemaContent;
}

export async function analyzeRepository(
  repoPath: string,
  language: string,
  options: ClaudeAnalysisOptions = {}
): Promise<AnalysisResult> {
  const { timeoutMs = 600000, maxRetries = 2 } = options; // 10 min timeout

  const prompt = getPromptForLanguage(language);
  const schema = await loadSchema();

  // Create temp directory for prompt files
  const tempDir = await mkdtemp(join(tmpdir(), "err-lookup-"));
  const schemaFile = join(tempDir, "schema.json");

  try {
    // Write schema to file
    await writeFile(schemaFile, schema);

    const executeAnalysis = async (): Promise<AnalysisResult> => {
      console.log("Running Claude CLI analysis...");

      const result = await execa(
        "claude",
        [
          "-p",
          prompt,
          "--output-format",
          "json",
          "--print",
        ],
        {
          cwd: repoPath,
          timeout: timeoutMs,
          maxBuffer: 100 * 1024 * 1024, // 100MB buffer
          reject: true,
        }
      );

      if (!result.stdout) {
        throw new Error("Claude CLI returned empty output");
      }

      // Parse Claude CLI JSON wrapper
      let claudeOutput;
      try {
        claudeOutput = JSON.parse(result.stdout);
      } catch (parseError) {
        console.error("Failed to parse Claude wrapper:", result.stdout.slice(0, 500));
        throw new Error(`Invalid JSON from Claude CLI: ${parseError}`);
      }

      // Extract the result text from Claude's response
      const resultText = claudeOutput.result || "";

      // Find JSON in the result (might be in markdown code block)
      let jsonContent = resultText;
      const jsonMatch = resultText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonContent = jsonMatch[1].trim();
      }

      // Parse the actual error data
      let errorData;
      try {
        errorData = JSON.parse(jsonContent);
      } catch (parseError) {
        console.error("Failed to parse error data:", jsonContent.slice(0, 500));
        throw new Error(`Invalid JSON in Claude result: ${parseError}`);
      }

      // Transform to our schema format
      const analysisResult: AnalysisResult = {
        repo: {
          name: "unknown",
          language: language,
        },
        errors: (errorData.errors || []).map((e: any) => ({
          message: e.message || "",
          type: e.type || "exception",
          file: e.file || "unknown",
          line: e.line,
          code: e.code,
          context: e.context,
          cause: e.cause,
          resolution: e.resolution,
          severity: e.severity || "error",
        })),
      };

      return validateAnalysisResult(analysisResult);
    };

    return await retry(executeAnalysis, {
      maxAttempts: maxRetries,
      initialDelayMs: 5000,
      maxDelayMs: 30000,
      backoffFactor: 2,
    });
  } finally {
    // Cleanup temp directory
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function checkClaudeAvailable(): Promise<boolean> {
  try {
    const result = await execa("claude", ["--version"], { timeout: 10000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export class ClaudeRateLimiter {
  private tokensUsedToday = 0;
  private dailyBudget: number;
  private lastResetDate: string;

  constructor(dailyBudgetTokens: number = 10_000_000) {
    this.dailyBudget = dailyBudgetTokens;
    this.lastResetDate = new Date().toISOString().split("T")[0];
  }

  private checkReset(): void {
    const today = new Date().toISOString().split("T")[0];
    if (today !== this.lastResetDate) {
      this.tokensUsedToday = 0;
      this.lastResetDate = today;
    }
  }

  canProcess(estimatedTokens: number): boolean {
    this.checkReset();
    return this.tokensUsedToday + estimatedTokens <= this.dailyBudget;
  }

  recordUsage(tokens: number): void {
    this.checkReset();
    this.tokensUsedToday += tokens;
  }

  getUsage(): { used: number; budget: number; percentage: number } {
    this.checkReset();
    return {
      used: this.tokensUsedToday,
      budget: this.dailyBudget,
      percentage: (this.tokensUsedToday / this.dailyBudget) * 100,
    };
  }

  getRemainingBudget(): number {
    this.checkReset();
    return Math.max(0, this.dailyBudget - this.tokensUsedToday);
  }
}

export const rateLimiter = new ClaudeRateLimiter(
  parseInt(process.env.DAILY_TOKEN_BUDGET || "10000000", 10)
);

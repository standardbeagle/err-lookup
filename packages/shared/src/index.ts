/**
 * Slugify a string for use in URLs
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

/**
 * Truncate text to a maximum length with ellipsis
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffFactor?: number;
  } = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 30000,
    backoffFactor = 2,
  } = options;

  let lastError: Error | undefined;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === maxAttempts) {
        throw lastError;
      }

      console.warn(
        `Attempt ${attempt}/${maxAttempts} failed: ${lastError.message}. Retrying in ${delay}ms...`
      );

      await sleep(delay);
      delay = Math.min(delay * backoffFactor, maxDelayMs);
    }
  }

  throw lastError;
}

/**
 * Detect primary language from file extensions
 */
export function detectLanguage(files: string[]): string {
  const counts: Record<string, number> = {};

  const extensionMap: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "kotlin",
    ".rb": "ruby",
    ".php": "php",
    ".cs": "csharp",
    ".cpp": "cpp",
    ".c": "c",
  };

  for (const file of files) {
    for (const [ext, lang] of Object.entries(extensionMap)) {
      if (file.endsWith(ext)) {
        counts[lang] = (counts[lang] || 0) + 1;
        break;
      }
    }
  }

  let maxLang = "unknown";
  let maxCount = 0;

  for (const [lang, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxLang = lang;
      maxCount = count;
    }
  }

  return maxLang;
}

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import slugify from 'slugify';
import { db } from './db/client.js';
import { repositories, errors } from './db/schema.js';
import { eq } from 'drizzle-orm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.resolve(__dirname, '../../../packages/repo-template');
const SITES_DIR = path.resolve(__dirname, '../../../sites');

interface ErrorRecord {
  id: number;
  repoId: number | null;
  errorCode: string | null;
  errorMessage: string;
  errorType: string | null;
  filePath: string | null;
  lineNumber: number | null;
  context: string | null;
  documentation: string | null;
  solutions: string[] | null;
  triggerScenarios: string | null;
  commonSituations: string | null;
  exampleFix: string | null;
  severity: string | null;
  // Defensive programming fields
  handlingStrategy: string | null;
  validationCode: string | null;
  typeGuard: string | null;
  tryCatchPattern: string | null;
  preventionTips: string[] | null;
  // Article recommendations
  recommendedArticles: string[] | null;
  suggestedNewArticles: string | null;
  // Source code fields for SEO
  sourceCode: string | null;
  sourceCodeStart: number | null;
  sourceCodeEnd: number | null;
  githubUrl: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

interface RepoRecord {
  id: number;
  fullName: string;
  description: string | null;
  language: string | null;
  errorCount: number | null;
}

function slugifyError(error: ErrorRecord): string {
  const base = error.errorCode || error.errorMessage.slice(0, 50);
  return slugify(base, { lower: true, strict: true, replacement: '-' });
}

function getSeverityClass(severity: string | null): string {
  switch (severity?.toLowerCase()) {
    case 'critical': return 'critical';
    case 'error': return 'error';
    case 'warning': return 'warning';
    default: return 'info';
  }
}

function getErrorTypeClass(errorType: string): string {
  if (errorType.toLowerCase().includes('exception')) return 'exception';
  return 'error-code';
}

function formatHandlingStrategy(strategy: string): string {
  const strategies: Record<string, string> = {
    'retry': '**Retry with backoff** - This error is often transient. Implement exponential backoff and retry the operation.',
    'fallback': '**Use fallback** - Have an alternative approach ready when this error occurs.',
    'crash': '**Fail fast** - This indicates a programming error. Fix the code rather than catching the exception.',
    'log-continue': '**Log and continue** - This error is informational. Log it for monitoring but continue execution.',
  };
  return strategies[strategy] || strategy;
}

// Strip markdown formatting for plain text (used in JSON-LD)
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')     // Bold
    .replace(/\*([^*]+)\*/g, '$1')          // Italic
    .replace(/`([^`]+)`/g, '$1')            // Inline code
    .replace(/```[\s\S]*?```/g, '')         // Code blocks
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Links
    .replace(/^#+\s*/gm, '')                // Headers
    .replace(/^[-*]\s*/gm, '')              // List items
    .replace(/\n{2,}/g, ' ')                // Multiple newlines
    .replace(/\n/g, ' ')                    // Single newlines
    .trim()
    .slice(0, 300);                          // Limit length for JSON-LD
}

// Escape curly braces for MDX - prevents JSX expression parsing
function escapeMdxBraces(text: string): string {
  // Replace { with {'{'} and } with {'}'} but only outside of code fences
  const parts = text.split(/(```[\s\S]*?```)/);
  return parts.map((part, i) => {
    // Odd indices are code blocks (inside ```)
    if (i % 2 === 1) return part;
    // Even indices are regular content - escape braces
    return part.replace(/\{/g, "{'{'}")
               .replace(/\}/g, "{'}'}");
  }).join('');
}

// Wrap code in fences if it looks like code and isn't already fenced
// IMPORTANT: Code fence MUST start on its own line for MDX to parse correctly
function ensureCodeFenced(text: string, language: string): string {
  if (!text) return text;
  // Already has code fences
  if (text.trim().startsWith('```')) return '\n\n' + text.trim() + '\n\n';
  // Looks like code (has common code patterns)
  const codePatterns = [
    /\bconst\s+\w+\s*=/, /\blet\s+\w+\s*=/, /\bvar\s+\w+\s*=/,
    /\bfunction\s*\w*\s*\(/, /=>\s*\{/, /\bclass\s+\w+/,
    /\bimport\s+/, /\brequire\s*\(/, /\bexport\s+/,
    /\bif\s*\(/, /\bfor\s*\(/, /\bwhile\s*\(/,
    /\btry\s*\{/, /\bcatch\s*\(/, /\bthrow\s+new/,
    /^\s*\/\//, /^\s*#/, /\bdef\s+\w+/, /\bfn\s+\w+/,
  ];
  const hasCodePattern = codePatterns.some(p => p.test(text));
  const hasMultipleLines = text.includes('\n');
  const hasBraces = text.includes('{') || text.includes('}');

  if (hasCodePattern || (hasMultipleLines && hasBraces)) {
    // Code fence MUST be on its own line with blank lines before and after
    return '\n\n```' + language + '\n' + text.trim() + '\n```\n\n';
  }
  // Escape curly braces in non-code text for MDX compatibility
  return escapeMdxBraces(text);
}

// Escape inline curly braces in markdown text (outside code fences)
// MDX interprets {} as JSX expressions, so we need to escape them
// In MDX, use {'{'}  for { and {'}'} for } to render literal braces
function escapeInlineBraces(text: string): string {
  // Replace { with {'{'} and } with {'}'} but only outside of code spans and code blocks
  let current = '';
  let inCodeBlock = false;
  let inCodeSpan = false;
  let backtickCount = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChars = text.slice(i, i + 3);

    // Check for code blocks (```)
    if (nextChars === '```' && !inCodeSpan) {
      inCodeBlock = !inCodeBlock;
      current += '```';
      i += 2;
      continue;
    }

    // Check for code spans (`)
    if (char === '`' && !inCodeBlock) {
      // Count consecutive backticks
      let count = 1;
      while (text[i + count] === '`') count++;
      if (!inCodeSpan) {
        inCodeSpan = true;
        backtickCount = count;
      } else if (count === backtickCount) {
        inCodeSpan = false;
      }
      current += text.slice(i, i + count);
      i += count - 1;
      continue;
    }

    // Escape braces outside of code using MDX syntax
    if (!inCodeBlock && !inCodeSpan) {
      if (char === '{') {
        current += "{'{'}";
        continue;
      }
      if (char === '}') {
        current += "{'}'}";
        continue;
      }
    }

    current += char;
  }

  return current;
}

// Build GitHub URL for a file
function buildGitHubUrl(repoFullName: string, filePath: string, lineNumber?: number | null, branch = 'main'): string {
  const baseUrl = `https://github.com/${repoFullName}/blob/${branch}/${filePath}`;
  if (lineNumber) {
    return `${baseUrl}#L${lineNumber}`;
  }
  return baseUrl;
}

// Build GitHub permalink for a specific line range
function buildGitHubPermalink(
  repoFullName: string,
  filePath: string,
  startLine?: number | null,
  endLine?: number | null,
  branch = 'main'
): string | null {
  if (!startLine) return null;
  const baseUrl = `https://github.com/${repoFullName}/blob/${branch}/${filePath}`;
  if (endLine && endLine !== startLine) {
    return `${baseUrl}#L${startLine}-L${endLine}`;
  }
  return `${baseUrl}#L${startLine}`;
}

function replacePlaceholders(content: string, replacements: Record<string, string>): string {
  let result = content;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

function generateErrorTable(repoErrors: ErrorRecord[]): string {
  if (repoErrors.length === 0) {
    return '*No errors documented yet.*';
  }

  let table = '| Error | Type | Severity | File |\n';
  table += '|-------|------|----------|------|\n';

  for (const error of repoErrors.slice(0, 50)) {
    const slug = slugifyError(error);
    // Strip curly braces and escape pipe characters for markdown table
    const titleRaw = error.errorCode || error.errorMessage.slice(0, 40);
    const title = titleRaw
      .replace(/[{}]/g, '')      // Strip braces (MDX issue)
      .replace(/\|/g, '\\|');    // Escape pipes (table delimiter)
    const file = error.filePath ? path.basename(error.filePath) : '-';
    table += `| [${title}](./errors/${slug}) | ${error.errorType} | ${error.severity || 'info'} | ${file} |\n`;
  }

  if (repoErrors.length > 50) {
    table += `\n*...and ${repoErrors.length - 50} more errors. See sidebar for complete list.*`;
  }

  return table;
}

function generateDefaultTriggerScenarios(error: ErrorRecord, repo: RepoRecord): string {
  const title = error.errorCode || error.errorMessage.slice(0, 40);
  return `You'll encounter this error when working with \`${repo.fullName.split('/')[1]}\` and ${error.documentation || 'specific conditions are not met'}.

This error is thrown from \`${error.filePath || 'the source code'}\` when the library detects an invalid state or input.`;
}

function generateDefaultCommonSituations(error: ErrorRecord): string {
  const items = [
    '- Passing incorrect types to a function',
    '- Using the API incorrectly',
    '- Missing required configuration',
    '- Invalid input data',
  ];
  return items.join('\n');
}

function generateDefaultExampleFix(error: ErrorRecord, repo: RepoRecord): string {
  const lang = repo.language?.toLowerCase() || 'javascript';
  if (!error.solutions?.length) {
    return `\`\`\`${lang}
// Check the source code context above for guidance
// Ensure your inputs match the expected types
\`\`\``;
  }

  return `\`\`\`${lang}
// ${error.solutions[0]}
\`\`\``;
}

const RESOURCE_BASE_URL = 'https://errlookup.dev';

interface ResourceLink {
  title: string;
  path: string;
  description: string;
}

function getResourceLinks(error: ErrorRecord, repo: RepoRecord): ResourceLink[] {
  const links: ResourceLink[] = [];
  const errorLower = (error.errorCode || error.errorMessage).toLowerCase();
  const docLower = (error.documentation || '').toLowerCase();
  const lang = repo.language?.toLowerCase() || '';

  // HTTP-related errors
  if (errorLower.includes('http') || errorLower.includes('status') ||
      /\b[45]\d{2}\b/.test(errorLower)) {
    links.push({
      title: 'HTTP Status Codes',
      path: '/concepts/networking/http-status-codes',
      description: 'Understand what HTTP status codes mean',
    });
  }

  // Network/connection errors
  if (errorLower.includes('connection') || errorLower.includes('network') ||
      errorLower.includes('econnrefused') || errorLower.includes('timeout') ||
      errorLower.includes('etimedout') || errorLower.includes('socket')) {
    links.push({
      title: 'TCP/IP Fundamentals',
      path: '/concepts/networking/tcp-ip',
      description: 'How network connections work',
    });
  }

  // DNS errors
  if (errorLower.includes('dns') || errorLower.includes('enotfound') ||
      errorLower.includes('getaddrinfo') || errorLower.includes('nxdomain')) {
    links.push({
      title: 'DNS Resolution',
      path: '/concepts/networking/dns',
      description: 'How domain name resolution works',
    });
  }

  // TLS/SSL/Certificate errors
  if (errorLower.includes('tls') || errorLower.includes('ssl') ||
      errorLower.includes('certificate') || errorLower.includes('cert')) {
    links.push({
      title: 'TLS/SSL',
      path: '/concepts/networking/tls-ssl',
      description: 'Understanding certificate and encryption errors',
    });
  }

  // Memory errors (SIGSEGV, null pointer, etc.)
  if (errorLower.includes('segv') || errorLower.includes('segfault') ||
      errorLower.includes('sigsegv') || errorLower.includes('null pointer') ||
      errorLower.includes('nil pointer') || errorLower.includes('memory')) {
    links.push({
      title: 'Unix Signals',
      path: '/concepts/os/signals',
      description: 'Understanding SIGSEGV and memory-related signals',
    });
    links.push({
      title: 'Memory Management',
      path: '/concepts/os/memory-management',
      description: 'How memory errors occur',
    });
  }

  // Type errors
  if (errorLower.includes('type') || errorLower.includes('typeerror') ||
      errorLower.includes('cannot read') || errorLower.includes('undefined')) {
    links.push({
      title: 'Type Systems',
      path: '/concepts/programming/type-systems',
      description: 'Understanding type errors',
    });
  }

  // Permission errors
  if (errorLower.includes('permission') || errorLower.includes('eacces') ||
      errorLower.includes('forbidden') || errorLower.includes('access denied')) {
    links.push({
      title: 'Permission Errors',
      path: '/guides/troubleshooting/permission-errors',
      description: 'Troubleshooting access issues',
    });
  }

  // Language-specific debugging guides
  if (lang === 'go' || lang === 'golang') {
    links.push({
      title: 'Debugging Go',
      path: '/guides/debugging/debugging-go',
      description: 'Go-specific debugging techniques',
    });
  } else if (lang === 'javascript' || lang === 'typescript') {
    links.push({
      title: 'Debugging Node.js',
      path: '/guides/debugging/debugging-node',
      description: 'Node.js debugging techniques',
    });
  } else if (lang === 'python') {
    links.push({
      title: 'Debugging Python',
      path: '/guides/debugging/debugging-python',
      description: 'Python debugging techniques',
    });
  } else if (lang === 'rust') {
    links.push({
      title: 'Debugging Rust',
      path: '/guides/debugging/debugging-rust',
      description: 'Rust debugging techniques',
    });
  }

  // Always include stack trace guide for exceptions
  if (error.errorType?.toLowerCase().includes('exception')) {
    links.push({
      title: 'Reading Stack Traces',
      path: '/guides/debugging/reading-stack-traces',
      description: 'How to interpret crash reports',
    });
  }

  // Dedupe and limit to 4 links
  const seen = new Set<string>();
  return links.filter(link => {
    if (seen.has(link.path)) return false;
    seen.add(link.path);
    return true;
  }).slice(0, 4);
}

function formatResourceLinks(links: ResourceLink[]): string {
  if (links.length === 0) {
    return `*Visit [ErrLookup Resources](${RESOURCE_BASE_URL}) for guides on debugging and error handling.*`;
  }

  return links.map(link =>
    `- [${link.title}](${RESOURCE_BASE_URL}${link.path}) - ${link.description}`
  ).join('\n');
}

async function generateErrorPage(
  error: ErrorRecord,
  repo: RepoRecord,
  position: number
): Promise<{ slug: string; content: string }> {
  const templatePath = path.join(TEMPLATE_DIR, 'docs/errors/_template.md');
  const template = await fs.readFile(templatePath, 'utf-8');

  const slug = slugifyError(error);
  const title = error.errorCode || error.errorMessage.slice(0, 60);
  const [owner, repoName] = repo.fullName.split('/');

  const lang = repo.language?.toLowerCase() || 'javascript';
  const resolution = error.solutions?.length ? error.solutions.join('\n\n') : null;

  // Wrap solution in code fences if it looks like code
  const quickAnswer = resolution
    ? `**Solution**: ${ensureCodeFenced(error.solutions![0], lang)}`
    : `This error occurs in ${error.filePath || 'the codebase'}. Check the documentation and solutions sections below for details.`;

  // Escape inline braces in text content that might have inline code with {}
  const triggerScenarios = escapeInlineBraces(error.triggerScenarios || generateDefaultTriggerScenarios(error, repo));
  const commonSituations = escapeInlineBraces(error.commonSituations || generateDefaultCommonSituations(error));
  // Ensure exampleFix is properly fenced
  const exampleFix = ensureCodeFenced(
    error.exampleFix || generateDefaultExampleFix(error, repo),
    lang
  );
  const resourceLinks = getResourceLinks(error, repo);

  // Format defensive programming sections
  const handlingStrategySection = error.handlingStrategy
    ? `### Recommended Handling\n\n**Strategy**: ${formatHandlingStrategy(error.handlingStrategy)}`
    : '';

  const validationSection = error.validationCode
    ? `### Input Validation\n\nValidate inputs before calling this API to avoid the error:\n\n\`\`\`${repo.language?.toLowerCase() || 'typescript'}\n${error.validationCode}\n\`\`\``
    : '';

  const tryCatchSection = error.tryCatchPattern
    ? `### Try-Catch Pattern\n\nRecommended error handling pattern:\n\n\`\`\`${repo.language?.toLowerCase() || 'typescript'}\n${error.tryCatchPattern}\n\`\`\``
    : '';

  const preventionSection = error.preventionTips?.length
    ? `### Prevention Tips\n\n${error.preventionTips.map(tip => `- ${tip}`).join('\n')}`
    : '';

  // Build URLs for structured data and links
  const subdomain = `${owner}-${repoName}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const siteUrl = `https://${subdomain}.errlookup.dev`;
  const pageUrl = `${siteUrl}/errors/${slug}`;

  // GitHub URLs
  const githubFileUrl = error.filePath
    ? buildGitHubUrl(repo.fullName, error.filePath, error.lineNumber)
    : `https://github.com/${repo.fullName}`;

  const githubPermalink = error.filePath && error.sourceCodeStart
    ? buildGitHubPermalink(repo.fullName, error.filePath, error.sourceCodeStart, error.sourceCodeEnd)
    : null;

  // Format GitHub permalink section
  const githubPermalinkSection = githubPermalink
    ? `[View on GitHub](${githubPermalink})`
    : `[View repository](https://github.com/${repo.fullName})`;

  // Line number link text
  const lineLink = error.lineNumber ? ` (line ${error.lineNumber})` : '';

  // Use sourceCode if available, otherwise fall back to context
  const codeContext = error.sourceCode || error.context || '// Source code not available';

  // Dates for structured data
  const datePublished = error.createdAt
    ? new Date(error.createdAt).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];
  const dateModified = error.updatedAt
    ? new Date(error.updatedAt).toISOString().split('T')[0]
    : datePublished;

  // Plain text versions for JSON-LD (escaped for JSON)
  const causeTextRaw = error.documentation || 'This error occurs when the library detects an invalid state or input.';
  const resolutionTextPlain = resolution || 'Check the source code and documentation for guidance on fixing this error.';
  // Escape braces for MDX in markdown body
  const causeText = escapeInlineBraces(causeTextRaw);
  // Fenced version for markdown body (prevents MDX from parsing braces as JSX)
  const resolutionText = ensureCodeFenced(resolutionTextPlain, lang);

  // Create article body preview for structured data (using plain text)
  const articleBodyPreview = stripMarkdown(
    `${triggerScenarios} ${causeText} ${resolutionTextPlain}`
  ).replace(/"/g, '\\"'); // Escape quotes for JSON

  // Sanitize for YAML frontmatter - remove/escape problematic characters
  const sanitizeForYaml = (s: string) => s
    .replace(/"/g, "'")           // Replace double quotes with single
    .replace(/[\[\]{}]/g, '')     // Remove brackets
    .replace(/\$/g, '')           // Remove dollar signs
    .replace(/\n/g, ' ')          // Replace newlines
    .trim();

  // For keywords array - even stricter sanitization
  const sanitizeKeyword = (s: string) => s
    .replace(/["\[\]{},\$'`]/g, '') // Remove quotes, brackets, commas, special chars
    .replace(/\s+/g, '-')           // Replace spaces with dashes
    .slice(0, 30)                   // Limit length
    .toLowerCase();

  const titleSafe = sanitizeForYaml(title);
  const errorMsgSafe = sanitizeForYaml(error.errorMessage.slice(0, 80));
  const keywordTitle = sanitizeKeyword(title);

  const replacements: Record<string, string> = {
    SIDEBAR_POSITION: String(position),
    ERROR_TITLE: titleSafe,
    ERROR_DESCRIPTION: `How to fix the ${errorMsgSafe} error in ${repo.fullName}. Causes, solutions, and code examples.`,
    KEYWORDS: `"${repoName}", "${error.errorType || 'error'}", "${error.severity || 'error'}", "${keywordTitle}"`,
    SEVERITY: getSeverityClass(error.severity),
    SEVERITY_LABEL: error.severity || 'Info',
    ERROR_TYPE_CLASS: getErrorTypeClass(error.errorType || 'error'),
    ERROR_TYPE: error.errorType || 'Error',
    QUICK_ANSWER: quickAnswer,
    ERROR_CODE: error.errorCode || 'N/A',
    FILE_PATH: error.filePath || 'Unknown',
    LINE_NUMBER: error.lineNumber?.toString() || '?',
    TRIGGER_SCENARIOS: triggerScenarios,
    COMMON_SITUATIONS: commonSituations,
    CAUSE: causeText,
    RESOLUTION: resolutionText,
    EXAMPLE_FIX: exampleFix,
    PREVENTION_TIPS: preventionSection,
    HANDLING_STRATEGY: handlingStrategySection,
    HANDLING_STRATEGY_LABEL: error.handlingStrategy || 'Not specified',
    VALIDATION_CODE: validationSection,
    TRY_CATCH_PATTERN: tryCatchSection,
    LANGUAGE: repo.language?.toLowerCase() || 'text',
    CODE_CONTEXT: codeContext,
    RESOURCE_LINKS: formatResourceLinks(resourceLinks),
    RELATED_ERRORS: '*No related errors identified.*',
    REPO_FULL_NAME: repo.fullName,
    REPO_NAME: repoName,
    // New SEO fields
    // Strip braces from verbatim error message to avoid MDX parsing issues
    // The full error with braces is preserved in JSON-LD for SEO
    ERROR_MESSAGE_VERBATIM: error.errorMessage.replace(/[{}]/g, ''),
    PAGE_URL: pageUrl,
    SITE_URL: siteUrl,
    DATE_PUBLISHED: datePublished,
    DATE_MODIFIED: dateModified,
    ARTICLE_BODY_PREVIEW: articleBodyPreview,
    // Plain text for JSON-LD (escaped)
    TRIGGER_SCENARIOS_PLAIN: stripMarkdown(triggerScenarios).replace(/"/g, '\\"'),
    CAUSE_PLAIN: stripMarkdown(causeTextRaw).replace(/"/g, '\\"'),
    RESOLUTION_PLAIN: stripMarkdown(resolutionTextPlain).replace(/"/g, '\\"'),
    // GitHub links
    GITHUB_FILE_URL: githubFileUrl,
    GITHUB_PERMALINK: githubPermalinkSection,
    LINE_LINK: lineLink,
  };

  const content = replacePlaceholders(template, replacements);
  return { slug, content };
}

export async function generateSite(repoFullName: string): Promise<string> {
  console.log(`Generating site for ${repoFullName}...`);

  // Fetch repo from database
  const [repo] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.fullName, repoFullName))
    .limit(1);

  if (!repo) {
    throw new Error(`Repository ${repoFullName} not found in database`);
  }

  // Fetch errors
  const repoErrors = await db
    .select()
    .from(errors)
    .where(eq(errors.repoId, repo.id));

  console.log(`Found ${repoErrors.length} errors for ${repoFullName}`);

  // Create site directory
  const [owner, repoName] = repoFullName.split('/');
  const siteDir = path.join(SITES_DIR, owner, repoName);

  // Copy template (excluding _template.md)
  await fs.ensureDir(siteDir);
  await fs.copy(TEMPLATE_DIR, siteDir, {
    filter: (src) => !src.includes('_template.md') && !src.includes('node_modules'),
  });

  // Replace placeholders in config files
  const configPath = path.join(siteDir, 'docusaurus.config.ts');
  let configContent = await fs.readFile(configPath, 'utf-8');

  const subdomain = `${owner}-${repoName}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  configContent = replacePlaceholders(configContent, {
    REPO_NAME: repoName,
    REPO_FULL_NAME: repoFullName,
    REPO_OWNER: owner,
    SUBDOMAIN: subdomain,
  });
  await fs.writeFile(configPath, configContent);

  // Replace placeholders in package.json
  const packagePath = path.join(siteDir, 'package.json');
  let packageContent = await fs.readFile(packagePath, 'utf-8');
  packageContent = replacePlaceholders(packageContent, {
    REPO_NAME: repoName,
  });
  await fs.writeFile(packagePath, packageContent);

  // Replace placeholders in index.md
  const indexPath = path.join(siteDir, 'docs/index.md');
  let indexContent = await fs.readFile(indexPath, 'utf-8');

  const projectDescription = repo.description
    || `**${repoName}** is a ${repo.language || 'software'} project. Visit the [GitHub repository](https://github.com/${repoFullName}) for more details about the project.`;

  indexContent = replacePlaceholders(indexContent, {
    REPO_NAME: repoName,
    REPO_FULL_NAME: repoFullName,
    PROJECT_DESCRIPTION: projectDescription,
    LANGUAGE: repo.language || 'Unknown',
    ERROR_COUNT: String(repoErrors.length),
    LAST_UPDATED: new Date().toISOString().split('T')[0],
    ERROR_TABLE: generateErrorTable(repoErrors),
  });
  await fs.writeFile(indexPath, indexContent);

  // Generate error pages
  const errorsDir = path.join(siteDir, 'docs/errors');
  await fs.ensureDir(errorsDir);

  for (let i = 0; i < repoErrors.length; i++) {
    const error = repoErrors[i];
    const { slug, content } = await generateErrorPage(error, repo, i + 1);
    const errorPagePath = path.join(errorsDir, `${slug}.md`);
    await fs.writeFile(errorPagePath, content);
  }

  // Create errors index if there are errors
  if (repoErrors.length > 0) {
    const errorsIndexPath = path.join(errorsDir, 'index.md');
    const errorsIndexContent = `---
sidebar_position: 0
title: All Errors
---

# All Errors

Browse ${repoErrors.length} documented errors for ${repoFullName}.

${generateErrorTable(repoErrors)}
`;
    await fs.writeFile(errorsIndexPath, errorsIndexContent);
  }

  console.log(`Site generated at ${siteDir}`);
  return siteDir;
}

export async function generateAllSites(): Promise<string[]> {
  const repos = await db
    .select()
    .from(repositories)
    .where(eq(repositories.status, 'completed'));

  const siteDirs: string[] = [];

  for (const repo of repos) {
    try {
      const siteDir = await generateSite(repo.fullName);
      siteDirs.push(siteDir);
    } catch (err) {
      console.error(`Failed to generate site for ${repo.fullName}:`, err);
    }
  }

  return siteDirs;
}

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
  severity: string | null;
}

interface RepoRecord {
  id: number;
  fullName: string;
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
    const title = error.errorCode || error.errorMessage.slice(0, 40);
    const file = error.filePath ? path.basename(error.filePath) : '-';
    table += `| [${title}](./errors/${slug}) | ${error.errorType} | ${error.severity || 'info'} | ${file} |\n`;
  }

  if (repoErrors.length > 50) {
    table += `\n*...and ${repoErrors.length - 50} more errors. See sidebar for complete list.*`;
  }

  return table;
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

  const resolution = error.solutions?.length ? error.solutions.join('\n\n') : null;
  const quickAnswer = resolution
    ? `**Solution**: ${error.solutions![0]}`
    : `This error occurs in ${error.filePath || 'the codebase'}. Check the documentation and solutions sections below for details.`;

  const replacements: Record<string, string> = {
    SIDEBAR_POSITION: String(position),
    ERROR_TITLE: title,
    ERROR_DESCRIPTION: `How to fix ${title} error in ${repo.fullName}`,
    KEYWORDS: `${repoName}, ${error.errorType || 'error'}, ${error.severity || 'error'}, ${title}`,
    SEVERITY: getSeverityClass(error.severity),
    SEVERITY_LABEL: error.severity || 'Info',
    ERROR_TYPE_CLASS: getErrorTypeClass(error.errorType || 'error'),
    ERROR_TYPE: error.errorType || 'Error',
    QUICK_ANSWER: quickAnswer,
    ERROR_CODE: error.errorCode || 'N/A',
    FILE_PATH: error.filePath || 'Unknown',
    LINE_NUMBER: error.lineNumber?.toString() || '?',
    CAUSE: error.documentation || 'Documentation not available.',
    RESOLUTION: resolution || 'Resolution not available. Check the source code for context.',
    LANGUAGE: repo.language?.toLowerCase() || 'text',
    CODE_CONTEXT: error.context || '// No code context available',
    RELATED_ERRORS: '*No related errors identified.*',
    REPO_FULL_NAME: repo.fullName,
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

  indexContent = replacePlaceholders(indexContent, {
    REPO_NAME: repoName,
    REPO_FULL_NAME: repoFullName,
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

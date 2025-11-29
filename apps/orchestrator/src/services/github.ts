import { execa } from "execa";
import { mkdir, rm, readdir, stat } from "fs/promises";
import { join } from "path";
import { detectLanguage } from "@err-lookup/shared";

const REPOS_DIR = process.env.REPOS_DIR || "/tmp/err-lookup-repos";

interface CloneOptions {
  depth?: number;
  branch?: string;
}

export async function cloneRepository(
  repoUrl: string,
  options: CloneOptions = {}
): Promise<string> {
  const { depth = 1, branch } = options;

  // Extract repo name from URL
  const urlParts = repoUrl.replace(/\.git$/, "").split("/");
  const repoName = urlParts[urlParts.length - 1];
  const owner = urlParts[urlParts.length - 2];
  const targetDir = join(REPOS_DIR, `${owner}-${repoName}-${Date.now()}`);

  await mkdir(REPOS_DIR, { recursive: true });

  const args = ["clone", "--depth", String(depth)];

  if (branch) {
    args.push("--branch", branch);
  }

  args.push(repoUrl, targetDir);

  await execa("git", args, {
    timeout: 120000, // 2 minute timeout for clone
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0", // Disable prompts
    },
  });

  return targetDir;
}

export async function cleanupRepository(repoPath: string): Promise<void> {
  try {
    await rm(repoPath, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Failed to cleanup ${repoPath}:`, error);
  }
}

export async function getRepoFiles(repoPath: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = fullPath.replace(repoPath + "/", "");

      // Skip common non-source directories
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "vendor" ||
        entry.name === "__pycache__" ||
        entry.name === "target" ||
        entry.name === "dist" ||
        entry.name === "build" ||
        entry.name === ".next"
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  await walk(repoPath);
  return files;
}

export async function detectRepoLanguage(repoPath: string): Promise<string> {
  const files = await getRepoFiles(repoPath);
  return detectLanguage(files);
}

export async function getLatestCommitSha(repoPath: string): Promise<string> {
  const result = await execa("git", ["rev-parse", "HEAD"], {
    cwd: repoPath,
  });
  return result.stdout.trim();
}

interface GitHubRepoInfo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  description: string | null;
  language: string | null;
  stargazers_count: number;
  default_branch: string;
  html_url: string;
}

export async function fetchRepoInfo(
  owner: string,
  repo: string
): Promise<GitHubRepoInfo> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "err-lookup",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}`,
    { headers }
  );

  if (!response.ok) {
    throw new Error(
      `GitHub API error: ${response.status} ${response.statusText}`
    );
  }

  return response.json() as Promise<GitHubRepoInfo>;
}

interface GitHubRelease {
  tag_name: string;
  published_at: string;
  target_commitish: string;
}

export async function getLatestRelease(
  owner: string,
  repo: string
): Promise<GitHubRelease | null> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "err-lookup",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
    { headers }
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(
      `GitHub API error: ${response.status} ${response.statusText}`
    );
  }

  return response.json() as Promise<GitHubRelease>;
}

export function parseRepoUrl(url: string): { owner: string; repo: string } {
  // Handle various GitHub URL formats
  const patterns = [
    /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/,
    /^([^/]+)\/([^/]+)$/, // owner/repo format
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
  }

  throw new Error(`Invalid repository URL: ${url}`);
}

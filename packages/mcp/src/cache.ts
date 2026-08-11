import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { siteBaseUrl } from "./base-url.js";

export interface CacheConfig {
  baseUrl: string;
  cacheDir: string;
  ttlSeconds: number;
  offline: boolean;
}

export function defaultCacheConfig(env: NodeJS.ProcessEnv = process.env): CacheConfig {
  const xdg = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return {
    baseUrl: siteBaseUrl(env),
    cacheDir: env.ERRLOOKUP_CACHE_DIR ?? join(xdg, "errlookup"),
    ttlSeconds: Number.parseInt(env.ERRLOOKUP_TTL_SECONDS ?? "300", 10),
    offline: env.ERRLOOKUP_OFFLINE === "1",
  };
}

export interface Manifest {
  schemaVersion: number;
  datasetVersion: string;
  counts: { repos: number; errors: number };
  files: Record<string, { path: string; bytes: number; sha256: string }>;
}

export type { IndexError } from "@errlookup/schema";
import type { IndexError } from "@errlookup/schema";

export interface IndexFile {
  schemaVersion: number;
  datasetVersion: string;
  errors: IndexError[];
}

function fileExists(p: string): boolean {
  return existsSync(p);
}

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

function atomicWrite(p: string, content: string): void {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, p);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Local cache store: manifest, index, per-repo files. All reads from disk. */
export class CacheStore {
  constructor(private readonly cfg: CacheConfig) {}

  get dir(): string {
    return this.cfg.cacheDir;
  }

  manifestPath(): string {
    return join(this.cfg.cacheDir, "manifest.json");
  }
  indexPath(): string {
    return join(this.cfg.cacheDir, "index.json");
  }
  repoPath(repo: string): string {
    const [owner, name] = repo.split("/");
    return join(this.cfg.cacheDir, "repos", `${owner}`, `${name}.json`);
  }

  hasManifest(): boolean {
    return fileExists(this.manifestPath());
  }

  readManifest(): Manifest | null {
    return this.hasManifest() ? readJson<Manifest>(this.manifestPath()) : null;
  }

  readIndex(): IndexFile | null {
    return fileExists(this.indexPath()) ? readJson<IndexFile>(this.indexPath()) : null;
  }

  readRepo(repo: string): unknown[] | null {
    const p = this.repoPath(repo);
    return fileExists(p) ? (readJson<unknown[]>(p)) : null;
  }

  /**
   * Download a file, verify its sha256 against the manifest, write atomically.
   * Returns false (and keeps the old cache) if the hash mismatches — corrupt
   * downloads are rejected, never served (§8 mcp suite).
   */
  async fetchVerified(urlPath: string, dest: string, expectedSha?: string): Promise<boolean> {
    const url = `${this.cfg.baseUrl}${urlPath}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${urlPath} → ${res.status}`);
    const text = await res.text();
    if (expectedSha && sha256(text) !== expectedSha) {
      // corrupt download: do NOT overwrite the existing cache file.
      return false;
    }
    atomicWrite(dest, text);
    return true;
  }
}

export { resolve };

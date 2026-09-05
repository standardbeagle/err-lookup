import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  files: Record<string, { path: string; bytes: number; sha256: string; encoding?: string }>;
}

/** What `current.json` records: which cached dataset version is live. */
export interface CachePointer {
  datasetVersion: string;
  /** ETag of the manifest that installed this version, for conditional polls. */
  etag: string | null;
  /** Epoch ms of the last successful freshness check, however it resolved. */
  checkedAt: number;
}

export type { IndexError } from "@errlookup/schema";

/**
 * How many parsed meta chunks stay resident. Each holds META_CHUNK entries
 * (~790 KB of JSON), and a query touches one per distinct hit region, so a
 * handful covers repeated lookups without pinning the whole dataset in heap.
 */
const META_CACHE_LIMIT = 8;

function atomicWrite(p: string, content: string | Buffer): void {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content);
  renameSync(tmp, p);
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Version strings are ISO timestamps; keep them legal as a directory name. */
export function versionDirName(datasetVersion: string): string {
  return datasetVersion.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * Version-scoped local cache.
 *
 * Every dataset file lives under `v/<datasetVersion>/`, and `current.json`
 * names the live version. A version becomes live only once its manifest is on
 * disk, so a reader can never pair one version's manifest with another's
 * shards — the failure the previous flat layout hit whenever a manifest
 * download succeeded and the payload download did not.
 */
export class CacheStore {
  /** Parsed JSON by `<version>\0<relPath>`; meta chunks are evicted, the rest is not. */
  private readonly memory = new Map<string, unknown>();
  private readonly metaKeys: string[] = [];

  constructor(private readonly cfg: CacheConfig) {}

  get dir(): string {
    return this.cfg.cacheDir;
  }
  get offline(): boolean {
    return this.cfg.offline;
  }
  get ttlSeconds(): number {
    return this.cfg.ttlSeconds;
  }
  get baseUrl(): string {
    return this.cfg.baseUrl;
  }

  pointerPath(): string {
    return join(this.cfg.cacheDir, "current.json");
  }
  versionDir(datasetVersion: string): string {
    return join(this.cfg.cacheDir, "v", versionDirName(datasetVersion));
  }
  filePath(datasetVersion: string, relPath: string): string {
    return join(this.versionDir(datasetVersion), relPath);
  }

  readPointer(): CachePointer | null {
    try {
      const p = JSON.parse(readFileSync(this.pointerPath(), "utf8")) as CachePointer;
      return existsSync(this.filePath(p.datasetVersion, "manifest.json")) ? p : null;
    } catch {
      return null;
    }
  }

  writePointer(p: CachePointer): void {
    atomicWrite(this.pointerPath(), JSON.stringify(p));
  }

  readManifest(datasetVersion: string): Manifest | null {
    return this.readCached<Manifest>(datasetVersion, "manifest.json");
  }

  /** Parsed content of a cached file, or null when it is not on disk. */
  readCached<T>(datasetVersion: string, relPath: string): T | null {
    const key = `${datasetVersion}\0${relPath}`;
    const hit = this.memory.get(key);
    if (hit !== undefined) return hit as T;
    const p = this.filePath(datasetVersion, relPath);
    if (!existsSync(p)) return null;
    let parsed: T;
    try {
      parsed = JSON.parse(readFileSync(p, "utf8")) as T;
    } catch {
      // A truncated or half-written file is treated as absent so the caller
      // refetches it; serving a parse error would strand the client.
      rmSync(p, { force: true });
      return null;
    }
    this.remember(key, parsed, relPath);
    return parsed;
  }

  private remember(key: string, value: unknown, relPath: string): void {
    this.memory.set(key, value);
    if (!relPath.startsWith("search/meta/")) return;
    this.metaKeys.push(key);
    while (this.metaKeys.length > META_CACHE_LIMIT) {
      this.memory.delete(this.metaKeys.shift()!);
    }
  }

  /** Drop every parsed object belonging to versions no longer on disk. */
  forgetMemory(): void {
    this.memory.clear();
    this.metaKeys.length = 0;
  }

  /**
   * Fetch one dataset file into the given version's directory. Returns the
   * parsed JSON, or null when it cannot be obtained (offline, 404, network
   * failure, or a sha256 the manifest disagrees with).
   */
  async fetchJson<T>(datasetVersion: string, relPath: string, expected?: { sha256?: string; encoding?: string }): Promise<T | null> {
    const cached = this.readCached<T>(datasetVersion, relPath);
    if (cached !== null) return cached;
    if (this.cfg.offline) return null;

    let raw: Buffer;
    try {
      // Version-pinned URL. Dataset files are served with max-age=86400 and
      // stale-while-revalidate=604800, so the same path can hand back a shard
      // from a previous publish for days — long enough to pair a fresh
      // manifest with stale metadata and resolve entry indexes against the
      // wrong rows. A new dataset version is a new URL, which no cache in the
      // path can answer from what it already holds.
      const url = `${this.cfg.baseUrl}/data/${relPath}?v=${encodeURIComponent(datasetVersion)}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      raw = Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
    if (expected?.sha256 && sha256(raw) !== expected.sha256) return null;

    const text =
      expected?.encoding === "gzip" || relPath.endsWith(".gz")
        ? gunzipSync(raw).toString("utf8")
        : raw.toString("utf8");
    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      return null;
    }
    atomicWrite(this.filePath(datasetVersion, relPath), text);
    this.remember(`${datasetVersion}\0${relPath}`, parsed, relPath);
    return parsed;
  }

  /** Install a manifest as a cached version. Does not make it live. */
  installManifest(manifest: Manifest, body: string): void {
    atomicWrite(this.filePath(manifest.datasetVersion, "manifest.json"), body);
    this.remember(`${manifest.datasetVersion}\0manifest.json`, manifest, "manifest.json");
  }

  /** Cached version directories, newest name last. */
  cachedVersions(): string[] {
    try {
      return readdirSync(join(this.cfg.cacheDir, "v")).sort();
    } catch {
      return [];
    }
  }

  /**
   * Delete every cached version except the named ones. The previous version is
   * normally kept: a tool call already reading it holds paths, not a lock.
   */
  prune(keep: string[]): void {
    const keepDirs = new Set(keep.map(versionDirName));
    for (const name of this.cachedVersions()) {
      if (keepDirs.has(name)) continue;
      rmSync(join(this.cfg.cacheDir, "v", name), { recursive: true, force: true });
    }
    this.forgetMemory();
  }
}

export { resolve };

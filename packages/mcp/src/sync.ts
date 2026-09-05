import type { CacheStore, CachePointer, Manifest } from "./cache.js";

export interface SyncResult {
  /** True when this call made a newer dataset version live. */
  updated: boolean;
  datasetVersion: string | null;
  errorCount: number;
  /** True when the live data could not be confirmed fresh against the origin. */
  stale: boolean;
}

/** One in-flight poll per store, so concurrent tool calls share the round trip. */
const inFlight = new WeakMap<CacheStore, Promise<SyncResult>>();

function fromPointer(store: CacheStore, pointer: CachePointer | null, stale: boolean): SyncResult {
  if (!pointer) return { updated: false, datasetVersion: null, errorCount: 0, stale: true };
  const manifest = store.readManifest(pointer.datasetVersion);
  return {
    updated: false,
    datasetVersion: pointer.datasetVersion,
    errorCount: manifest?.counts.errors ?? 0,
    stale,
  };
}

/**
 * Freshness check against the published manifest.
 *
 * The manifest is the only file this fetches. Dataset content is pulled per
 * query by `CacheStore.fetchJson`, which keeps a version switch cheap: a new
 * publish costs one conditional GET, and only the shards a query actually
 * touches are downloaded again.
 *
 * A version is made live by writing the pointer *after* its manifest is on
 * disk. Nothing else mutates the live version, so a failed download leaves the
 * previous version serving instead of wedging the cache.
 */
export async function syncDataset(store: CacheStore, force: boolean): Promise<SyncResult> {
  const pointer = store.readPointer();

  if (store.offline) return fromPointer(store, pointer, true);

  if (!force && pointer && Date.now() - pointer.checkedAt < store.ttlSeconds * 1000) {
    return fromPointer(store, pointer, false);
  }

  const running = inFlight.get(store);
  if (running) return running;

  const poll = pollManifest(store, pointer).finally(() => inFlight.delete(store));
  inFlight.set(store, poll);
  return poll;
}

async function pollManifest(store: CacheStore, pointer: CachePointer | null): Promise<SyncResult> {
  let res: Response;
  try {
    res = await fetch(`${store.baseUrl}/data/manifest.json`, {
      headers: pointer?.etag ? { "if-none-match": pointer.etag } : undefined,
    });
  } catch {
    return fromPointer(store, pointer, true);
  }

  if (res.status === 304 && pointer) {
    store.writePointer({ ...pointer, checkedAt: Date.now() });
    return fromPointer(store, pointer, false);
  }
  if (!res.ok) return fromPointer(store, pointer, true);

  const body = await res.text();
  let manifest: Manifest;
  try {
    manifest = JSON.parse(body) as Manifest;
  } catch {
    return fromPointer(store, pointer, true);
  }
  if (typeof manifest.datasetVersion !== "string" || !manifest.datasetVersion) {
    return fromPointer(store, pointer, true);
  }

  const etag = res.headers.get("etag");
  if (pointer && manifest.datasetVersion === pointer.datasetVersion) {
    store.writePointer({ ...pointer, etag, checkedAt: Date.now() });
    return fromPointer(store, pointer, false);
  }

  store.installManifest(manifest, body);
  store.writePointer({ datasetVersion: manifest.datasetVersion, etag, checkedAt: Date.now() });
  // Keep the version we just replaced: a tool call mid-flight still reads it.
  store.prune([manifest.datasetVersion, ...(pointer ? [pointer.datasetVersion] : [])]);
  return {
    updated: true,
    datasetVersion: manifest.datasetVersion,
    errorCount: manifest.counts?.errors ?? 0,
    stale: false,
  };
}

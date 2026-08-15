import type { CacheStore, Manifest, IndexFile } from "./cache.js";

export interface SyncResult {
  updated: boolean;
  datasetVersion: string | null;
  errorCount: number;
  stale: boolean;
}

/**
 * Freshness check + index download (§7.1). Fetches the small manifest; if
 * `datasetVersion` is unchanged, no-op. Else downloads index.json, verifies
 * its sha256 against the manifest, and writes it atomically.
 *
 * Offline mode: skip the network, serve from cache, report `stale: true`.
 */
export async function syncDataset(store: CacheStore, ttlOk: boolean): Promise<SyncResult> {
  const cachedManifest = store.readManifest();
  const cachedIndex = store.readIndex();

  if (ttlOk) {
    // Within poll interval: don't hit the network. Report cached state.
    return {
      updated: false,
      datasetVersion: cachedManifest?.datasetVersion ?? null,
      errorCount: cachedIndex?.errors.length ?? 0,
      stale: false,
    };
  }

  let manifest: Manifest;
  try {
    const ok = await store.fetchVerified("/data/manifest.json", store.manifestPath());
    if (!ok) {
      // manifest hash unknown / not provided in a chain — keep prior cache.
      return staleOrError(store, cachedManifest, cachedIndex);
    }
    manifest = store.readManifest()!;
  } catch {
    // network failure: fall back to cache (offline-capable).
    return staleOrError(store, cachedManifest, cachedIndex);
  }

  if (cachedManifest && manifest.datasetVersion === cachedManifest.datasetVersion && cachedIndex) {
    return { updated: false, datasetVersion: manifest.datasetVersion, errorCount: cachedIndex.errors.length, stale: false };
  }

  try {
    // Follow the manifest's advertised path: the index publishes gzipped now
    // (the raw file outgrew Pages' 25 MiB cap). Datasets from before the
    // change carry no index.path override and keep the legacy URL.
    const ok = await store.fetchVerified(
      manifest.files.index?.path ?? "/data/index.json",
      store.indexPath(),
      manifest.files.index?.sha256,
      manifest.files.index?.encoding
    );
    if (!ok) {
      // sha mismatch on index — keep old cache, report stale.
      return staleOrError(store, cachedManifest, cachedIndex);
    }
    const idx = store.readIndex()!;
    // Invalidate lazy per-repo files: they belong to the old dataset.
    return { updated: true, datasetVersion: manifest.datasetVersion, errorCount: idx.errors.length, stale: false };
  } catch {
    return staleOrError(store, cachedManifest, cachedIndex);
  }
}

function staleOrError(
  store: CacheStore,
  cachedManifest: Manifest | null,
  cachedIndex: IndexFile | null
): SyncResult {
  if (cachedManifest && cachedIndex) {
    return {
      updated: false,
      datasetVersion: cachedManifest.datasetVersion,
      errorCount: cachedIndex.errors.length,
      stale: true,
    };
  }
  // No cache and network failed → tools will surface a clear error.
  return { updated: false, datasetVersion: null, errorCount: 0, stale: true };
}

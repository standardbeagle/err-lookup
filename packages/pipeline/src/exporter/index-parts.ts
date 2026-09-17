import { gzipSync } from "node:zlib";
import type { IndexError } from "@errlookup/schema";

/**
 * Cloudflare Pages rejects any single file over 25 MiB, and one oversized file
 * fails the whole deploy. The unsplit index.json.gz crossed it on 2026-09-17
 * (25.1 MiB) and every hourly publish failed from then on. Parts are capped at
 * 20 MiB so a day or two of corpus growth between exports cannot reach the
 * limit; the number of parts grows instead.
 */
export const INDEX_PART_MAX_GZ_BYTES = 20 * 1024 * 1024;

export interface IndexPart {
  relPath: string;
  raw: string;
  gz: Buffer;
}

/**
 * Split the compact search index into gzipped parts, each at most
 * `maxGzBytes`, errors kept in order and each in exactly one part.
 *
 * Parts are equal-count slices. The count starts from the whole index's
 * compressed size and rises until every part fits — slices of similar records
 * compress alike, so this normally settles on the first try. Deterministic:
 * the same errors always produce the same part bytes (gzipSync writes no mtime).
 */
export function splitIndexParts(
  meta: { schemaVersion: number; datasetVersion: string },
  errors: readonly IndexError[],
  maxGzBytes: number = INDEX_PART_MAX_GZ_BYTES
): IndexPart[] {
  const whole = gzipSync(JSON.stringify({ ...meta, part: 1, parts: 1, errors })).byteLength;
  let parts = Math.max(1, Math.ceil(whole / maxGzBytes));
  const most = Math.max(1, errors.length);
  for (; parts <= most; parts++) {
    const size = Math.ceil(errors.length / parts);
    const out: IndexPart[] = [];
    let fits = true;
    for (let i = 0; i < parts; i++) {
      const raw = JSON.stringify({ ...meta, part: i + 1, parts, errors: errors.slice(i * size, (i + 1) * size) });
      const gz = gzipSync(raw);
      if (gz.byteLength > maxGzBytes) {
        fits = false;
        break;
      }
      out.push({ relPath: `index-${i + 1}.json.gz`, raw, gz });
    }
    if (fits) return out;
  }
  throw new Error(`search index cannot be split under the ${maxGzBytes}-byte cap: a single error record exceeds it`);
}

/**
 * Bounded-concurrency map. Results keep input order regardless of completion
 * order, so callers can index back into the source array.
 *
 * `fn` is expected to handle its own failures — a rejection propagates and the
 * remaining items are abandoned, which is the right behaviour for a phase whose
 * per-item errors are already caught, and a loud one for anything else.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const width = Math.max(1, Math.min(Math.floor(limit), items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/** Split an array into fixed-size chunks (last chunk may be short). */
export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

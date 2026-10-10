/** First occurrence wins; order kept. */
export function dedupeKeepOrder<K>(keys: readonly K[]): K[] {
  return [...new Set(keys)];
}

/** Marks a chunk the upstream could not serve; one object per chunk, so a path reports it once. */
export class ChunkFailure extends Error {
  constructor(readonly cause: unknown) {
    super('batch failed');
  }
}

/**
 * Loads `keys` through `fetchChunk` in chunks of at most `size` distinct keys (S48 FR-030, AS-26, AS-27, AS-29).
 * - each distinct key is asked for once; the result has the same length and order as `keys` (duplicates repeat);
 * - an item the upstream hid is `null`, in place;
 * - a chunk that throws, or answers a different number of items than it was asked for, fails only its own keys, with
 *   one shared `ChunkFailure` (a shifted answer must never be handed to the wrong id).
 */
export async function loadInChunks<T>(
  keys: readonly string[],
  size: number,
  fetchChunk: (chunk: string[]) => Promise<readonly (T | null)[]>,
): Promise<(T | null | ChunkFailure)[]> {
  const distinct = dedupeKeepOrder(keys);
  const chunks: string[][] = [];
  for (let i = 0; i < distinct.length; i += size)
    chunks.push(distinct.slice(i, i + size));

  const byKey = new Map<string, T | null | ChunkFailure>();
  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const items = await fetchChunk(chunk);
        if (items.length !== chunk.length)
          throw new Error('batch answer has the wrong length');
        chunk.forEach((key, i) => byKey.set(key, items[i]));
      } catch (error) {
        const failure = new ChunkFailure(error);
        for (const key of chunk) byKey.set(key, failure);
      }
    }),
  );
  return keys.map((key) => byKey.get(key) ?? null);
}

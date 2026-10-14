export const BULK_CHUNK_SIZE = 100;

export type BulkStatus =
  'processing' | 'succeeded' | 'partially_failed' | 'failed';

export interface BulkCounters {
  chunks: number;
  completedChunks: number;
  applied: number;
  replayed: number;
  /** Items whose outcome is not `applied|replayed` (`not_found`, `insufficient_stock`, `conflict`). */
  failed: number;
}

export const chunkCount = (total: number): number =>
  Math.ceil(total / BULK_CHUNK_SIZE);

export function splitIntoChunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += BULK_CHUNK_SIZE)
    out.push(items.slice(i, i + BULK_CHUNK_SIZE));
  return out;
}

export function bulkStatus(c: BulkCounters): BulkStatus {
  if (c.completedChunks < c.chunks) return 'processing';
  if (c.failed === 0) return 'succeeded';
  if (c.applied + c.replayed === 0) return 'failed';
  return 'partially_failed';
}

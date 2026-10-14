import fc from 'fast-check';
import {
  BULK_CHUNK_SIZE,
  BulkCounters,
  bulkStatus,
  chunkCount,
  splitIntoChunks,
} from './bulk-chunking';

describe('S42 bulk chunking (FR-046, FR-047)', () => {
  it.each([
    [101, 2],
    [200, 2],
    [201, 3],
    [10_000, 100],
  ])('%i items → %i chunks', (total, chunks) => {
    expect(chunkCount(total)).toBe(chunks);
    const items = Array.from({ length: total }, (_, i) => i);
    const split = splitIntoChunks(items);
    expect(split).toHaveLength(chunks);
    expect(split.every((c) => c.length <= BULK_CHUNK_SIZE)).toBe(true);
    expect(split.flat()).toEqual(items);
  });

  it('property: chunks = ceil(total / 100), order and content preserved', () => {
    fc.assert(
      fc.property(fc.integer({ min: 101, max: 10_000 }), (n) => {
        const items = Array.from({ length: n }, (_, i) => i);
        const split = splitIntoChunks(items);
        return split.length === Math.ceil(n / 100) && split.flat().length === n;
      }),
    );
  });

  it.each<[string, BulkCounters, string]>([
    [
      'in progress',
      { chunks: 3, completedChunks: 2, applied: 200, replayed: 0, failed: 0 },
      'processing',
    ],
    [
      'all applied',
      { chunks: 2, completedChunks: 2, applied: 150, replayed: 0, failed: 0 },
      'succeeded',
    ],
    [
      'replayed counts as success',
      { chunks: 2, completedChunks: 2, applied: 0, replayed: 150, failed: 0 },
      'succeeded',
    ],
    [
      'mixed',
      { chunks: 2, completedChunks: 2, applied: 100, replayed: 0, failed: 50 },
      'partially_failed',
    ],
    [
      'all failed',
      { chunks: 2, completedChunks: 2, applied: 0, replayed: 0, failed: 150 },
      'failed',
    ],
  ])('status %s', (_n, counters, expected) => {
    expect(bulkStatus(counters)).toBe(expected);
  });
});

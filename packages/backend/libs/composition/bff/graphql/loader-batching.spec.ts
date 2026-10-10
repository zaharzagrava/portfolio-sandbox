import * as fc from 'fast-check';
import { dedupeKeepOrder, loadInChunks } from './loader-batching';

describe('S48 U2 loader batching (pure part)', () => {
  it('S48 AS-26: de-duplicates keeping the first occurrence order', () => {
    expect(dedupeKeepOrder(['A', 'B', 'A', 'C', 'B'])).toEqual(['A', 'B', 'C']);
    expect(dedupeKeepOrder([])).toEqual([]);
  });

  it('S48 AS-26: one call carries each id once, the result keeps request order, nulls stay in place', async () => {
    const calls: string[][] = [];
    const items = await loadInChunks(
      ['A', 'B', 'A', 'C'],
      100,
      async (chunk) => {
        calls.push(chunk);
        return chunk.map((id) => (id === 'B' ? null : { id }));
      },
    );
    expect(calls).toEqual([['A', 'B', 'C']]);
    expect(items).toEqual([{ id: 'A' }, null, { id: 'A' }, { id: 'C' }]);
  });

  it.each([
    [0, []],
    [1, [1]],
    [100, [100]],
    [101, [100, 1]],
    [150, [100, 50]],
    [200, [100, 100]],
    [201, [100, 100, 1]],
  ])(
    'S48 AS-27: %s distinct ids → chunks %j (never more than 100 per call)',
    async (n, sizes) => {
      const ids = Array.from({ length: n }, (_, i) => `id-${i}`);
      const seen: number[] = [];
      const out = await loadInChunks(ids, 100, async (chunk) => {
        seen.push(chunk.length);
        return chunk.map((id) => ({ id }));
      });
      expect(seen).toEqual(sizes);
      expect(out.map((o) => (o as { id: string }).id)).toEqual(ids);
    },
  );

  it('S48 AS-29: a failed chunk fails only its own ids; the others are served', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`);
    const out = await loadInChunks(ids, 100, async (chunk) => {
      if (chunk[0] === 'id-0') throw new Error('boom');
      return chunk.map((id) => ({ id }));
    });
    expect(out.slice(0, 100).every((o) => o instanceof Error)).toBe(true);
    expect(out.slice(100).every((o) => !(o instanceof Error))).toBe(true);
    // one failure object per chunk (reported once per path, not once per id)
    expect(new Set(out.slice(0, 100)).size).toBe(1);
  });

  it('S48 AS-29: an upstream answer of the wrong length fails the whole chunk instead of shifting results', async () => {
    const out = await loadInChunks(['A', 'B', 'C'], 100, async () => [
      { id: 'A' },
    ]);
    expect(out.every((o) => o instanceof Error)).toBe(true);
  });

  it('S48 AS-26: output length equals input length for any input (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.integer({ min: 0, max: 300 }).map((n) => `id-${n}`),
          {
            maxLength: 400,
          },
        ),
        fc.integer({ min: 1, max: 120 }),
        async (ids, size) => {
          const calls: string[][] = [];
          const out = await loadInChunks(ids, size, async (chunk) => {
            calls.push(chunk);
            return chunk.map((id) => (id.endsWith('7') ? null : { id }));
          });
          expect(out).toHaveLength(ids.length);
          expect(calls.every((c) => c.length <= size)).toBe(true);
          expect(new Set(calls.flat()).size).toBe(calls.flat().length); // no id asked twice
          out.forEach((o, i) => {
            if (ids[i].endsWith('7')) expect(o).toBeNull();
            else expect((o as { id: string }).id).toBe(ids[i]);
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});

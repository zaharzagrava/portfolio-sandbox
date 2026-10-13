import { capClusterCells, MAX_CLUSTER_CELLS } from './cluster-cap';

const cell = (cellId: string, offers: number) => ({
  cellId,
  offers,
  pickupPoints: 1,
  lat: 0,
  lng: 0,
});

describe('S19 AS-38 cluster cap', () => {
  it('orders by offers descending, equal offers by cellId', () => {
    const result = capClusterCells([cell('b', 2), cell('a', 2), cell('c', 9)]);
    expect(result.cells.map((c) => c.cellId)).toEqual(['c', 'a', 'b']);
    expect(result.truncated).toBe(false);
  });

  it('keeps at most 500 cells, the highest, and says it cut', () => {
    const cells = Array.from({ length: MAX_CLUSTER_CELLS + 7 }, (_, i) =>
      cell(`c${String(i).padStart(4, '0')}`, i % 5),
    );
    const result = capClusterCells(cells);
    expect(result.cells).toHaveLength(500);
    expect(result.truncated).toBe(true);
    const offers = result.cells.map((c) => c.offers);
    expect(offers).toEqual([...offers].sort((a, b) => b - a));
    // every omitted cell has no more offers than the weakest kept one
    const weakest = offers[offers.length - 1];
    const kept = new Set(result.cells.map((c) => c.cellId));
    for (const omitted of cells.filter((c) => !kept.has(c.cellId)))
      expect(omitted.offers).toBeLessThanOrEqual(weakest);
  });

  it('breaks the tie at the cut by cellId', () => {
    const cells = Array.from({ length: 501 }, (_, i) =>
      cell(`c${String(500 - i).padStart(3, '0')}`, 1),
    );
    const result = capClusterCells(cells);
    expect(result.cells.at(-1)?.cellId).toBe('c499');
    expect(result.truncated).toBe(true);
  });

  it('is not truncated at exactly 500', () => {
    const cells = Array.from({ length: 500 }, (_, i) => cell(`c${i}`, 1));
    expect(capClusterCells(cells).truncated).toBe(false);
  });

  it('trusts the engine when it reports omitted buckets', () => {
    expect(capClusterCells([cell('a', 1)], true).truncated).toBe(true);
  });
});

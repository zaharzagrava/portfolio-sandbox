import { chunkTotals, syncStatus, toOutcomes } from './bulk-outcomes';

const item = (n: number) => ({
  operationId: `o${n}`,
  productId: `p${n}`,
  delta: n,
});

describe('S42 bulk outcomes (FR-046…FR-048, AS-50, AS-51)', () => {
  it('applied and replayed items carry the stock after, not-found items are reported and not applied', () => {
    const outcomes = toOutcomes([item(1), item(2), item(3)], new Set(['p3']), {
      outcome: 'applied',
      results: [
        {
          operationId: 'o1',
          productId: 'p1',
          quantityAfter: 3,
          replayed: false,
        },
        {
          operationId: 'o2',
          productId: 'p2',
          quantityAfter: 13,
          replayed: true,
        },
      ],
    });
    expect(outcomes).toEqual([
      {
        operation_id: 'o1',
        product_id: 'p1',
        outcome: 'applied',
        stock_after: 3,
      },
      {
        operation_id: 'o2',
        product_id: 'p2',
        outcome: 'replayed',
        stock_after: 13,
      },
      { operation_id: 'o3', product_id: 'p3', outcome: 'not_found' },
    ]);
  });

  it('a refused call applies nothing: the failing item says why, every other found item is not_applied', () => {
    const outcomes = toOutcomes(
      [item(1), item(2), item(3), item(4)],
      new Set(['p4']),
      {
        outcome: 'rejected',
        failures: [
          { operationId: 'o1', productId: 'p1', code: 'insufficient_stock' },
          { operationId: 'o3', productId: 'p3', code: 'quantity_limit' },
        ],
      },
    );
    expect(outcomes.map((o) => [o.operation_id, o.outcome])).toEqual([
      ['o1', 'insufficient_stock'],
      ['o2', 'not_applied'],
      ['o3', 'conflict'],
      ['o4', 'not_found'],
    ]);
    expect(outcomes.every((o) => !('stock_after' in o))).toBe(true);
  });

  it('with nothing left to apply every item is not_found', () => {
    const outcomes = toOutcomes([item(1)], new Set(['p1']), undefined);
    expect(outcomes).toEqual([
      { operation_id: 'o1', product_id: 'p1', outcome: 'not_found' },
    ]);
  });

  it.each([
    [
      'all applied',
      [{ outcome: 'applied' }, { outcome: 'replayed' }],
      false,
      'succeeded',
    ],
    [
      'applied plus not found (AS-50)',
      [{ outcome: 'applied' }, { outcome: 'not_found' }],
      false,
      'succeeded',
    ],
    [
      'a refused call',
      [{ outcome: 'insufficient_stock' }, { outcome: 'not_applied' }],
      true,
      'failed',
    ],
    ['nothing applied', [{ outcome: 'not_found' }], false, 'failed'],
  ])('synchronous status: %s', (_n, results, rejected, expected) => {
    expect(syncStatus(results as never, rejected)).toBe(expected);
  });

  it('counts a chunk: applied, replayed and every other outcome as failed, the first failures kept', () => {
    const totals = chunkTotals([
      {
        operation_id: 'a',
        product_id: 'p',
        outcome: 'applied',
        stock_after: 1,
      },
      {
        operation_id: 'b',
        product_id: 'p',
        outcome: 'replayed',
        stock_after: 1,
      },
      { operation_id: 'c', product_id: 'p', outcome: 'not_found' },
      { operation_id: 'd', product_id: 'p', outcome: 'insufficient_stock' },
    ]);
    expect(totals).toEqual({
      applied: 1,
      replayed: 1,
      failed: 2,
      failures: [
        { operation_id: 'c', product_id: 'p', outcome: 'not_found' },
        { operation_id: 'd', product_id: 'p', outcome: 'insufficient_stock' },
      ],
    });
  });
});

import {
  BATCH_BUDGET_MS,
  BatchOperation,
  batchCost,
  deadlineExceeded,
  planBatch,
} from './batch-plan';

const op = (method: string, path: string, body?: unknown): BatchOperation => ({
  method,
  path,
  body,
});

describe('S42 batch plan (FR-043…FR-045, AS-43, AS-44)', () => {
  it.each<[string, BatchOperation, boolean]>([
    ['list products', op('GET', '/v1/products'), true],
    ['get product', op('GET', '/v1/products/p1'), true],
    ['create product', op('POST', '/v1/products', {}), true],
    ['patch product', op('PATCH', '/v1/products/p1', {}), true],
    ['stock read', op('GET', '/v1/stock/p1'), true],
    ['orders are not batchable', op('GET', '/v1/orders'), false],
    ['one order is not batchable', op('GET', '/v1/orders/o1'), false],
    [
      'bulk stock is not batchable',
      op('POST', '/v1/stock/bulk', { items: [] }),
      false,
    ],
    [
      'bulk job read is not batchable',
      op('GET', '/v1/stock/bulk/bsu_' + 'a'.repeat(32)),
      false,
    ],
    ['batch inside batch', op('POST', '/v1/batch', { operations: [] }), false],
    ['the deprecated stock route', op('GET', '/v1/products/p1/stock'), false],
    ['unknown path', op('GET', '/v1/nope'), false],
    ['unsupported method on a product', op('DELETE', '/v1/products/p1'), false],
    ['POST on a product id', op('POST', '/v1/products/p1', {}), false],
    ['openapi', op('GET', '/v1/openapi.json'), false],
  ])('batchable: %s', (_n, operation, batchable) => {
    expect(planBatch([operation])[0].batchable).toBe(batchable);
  });

  it('a query string does not make a path another route', () => {
    expect(planBatch([op('GET', '/v1/products?limit=5')])[0].batchable).toBe(
      true,
    );
    expect(planBatch([op('GET', '/v1/orders?limit=5')])[0].batchable).toBe(
      false,
    );
  });

  it('refuses 0 and 51 operations', () => {
    expect(() => planBatch([])).toThrow(
      expect.objectContaining({ code: 'validation_failed' }),
    );
    expect(() =>
      planBatch(Array.from({ length: 51 }, () => op('GET', '/v1/products'))),
    ).toThrow(expect.objectContaining({ code: 'validation_failed' }));
    expect(
      planBatch(Array.from({ length: 50 }, () => op('GET', '/v1/products'))),
    ).toHaveLength(50);
  });

  it('cost is the operation count', () => {
    expect(
      batchCost(Array.from({ length: 12 }, () => op('GET', '/v1/products'))),
    ).toBe(12);
  });

  it('budget of 10 s with an injected clock', () => {
    const start = 1_000;
    expect(BATCH_BUDGET_MS).toBe(10_000);
    expect(deadlineExceeded(start, start + 9_999)).toBe(false);
    expect(deadlineExceeded(start, start + 10_000)).toBe(true);
  });
});

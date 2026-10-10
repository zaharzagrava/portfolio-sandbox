import * as fc from 'fast-check';
import {
  buildReleaseOperations,
  buildReserveOperations,
} from './stock-operations';

const ORDER = '0194f3a0-0000-7000-8000-000000000001';
const SHOP = '0194f3a0-0000-7000-8000-0000000000aa';
const pid = (n: number) =>
  `0194f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const line = (n: number, quantity: number) => ({
  productId: pid(n),
  shopId: SHOP,
  quantity,
});

describe('S10 AS-35: stock operations', () => {
  it('S10 AS-35: operations are sorted by product id whatever the cart order', () => {
    const a = buildReserveOperations(ORDER, [
      line(3, 1),
      line(1, 2),
      line(2, 3),
    ]);
    const b = buildReserveOperations(ORDER, [
      line(1, 2),
      line(2, 3),
      line(3, 1),
    ]);
    expect(a).toEqual(b);
    expect(a.map((o) => o.productId)).toEqual([pid(1), pid(2), pid(3)]);
  });

  it('S10 AS-35: the operation id and reason follow <service>:<aggregate>:<step>:<product>', () => {
    const [op] = buildReserveOperations(ORDER, [line(1, 3)]);
    expect(op).toEqual({
      operationId: `orders:${ORDER}:reserve:${pid(1)}`,
      productId: pid(1),
      shopId: SHOP,
      delta: -3,
      reason: 'order.reserve',
    });
  });

  it('S10 AS-35: release is a new operation with a positive delta', () => {
    const [op] = buildReleaseOperations(ORDER, [line(1, 3)]);
    expect(op.operationId).toBe(`orders:${ORDER}:release:${pid(1)}`);
    expect(op.delta).toBe(3);
    expect(op.reason).toBe('order.release');
  });

  it('S10 AS-35: a repeated product is summed into one operation', () => {
    const ops = buildReserveOperations(ORDER, [
      line(1, 2),
      line(2, 1),
      line(1, 5),
    ]);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ productId: pid(1), delta: -7 });
  });

  it('S10 AS-35: 100 products fit the catalog’s limits (≤ 100 distinct ids ≤ 128 chars, reason [a-z0-9._-]{1,64}), in order', () => {
    const lines = Array.from({ length: 100 }, (_, i) =>
      line(i + 1, 1),
    ).reverse();
    const ops = buildReserveOperations(ORDER, lines);
    expect(ops).toHaveLength(100);
    expect(new Set(ops.map((o) => o.operationId)).size).toBe(100);
    for (const op of ops) {
      expect(op.operationId.length).toBeLessThanOrEqual(128);
      expect(op.reason).toMatch(/^[a-z0-9._-]{1,64}$/);
    }
    expect(ops.map((o) => o.productId)).toEqual(
      lines.map((l) => l.productId).sort(),
    );
  });

  it('S10 AS-35: properties — ascending ids, summed quantity, ids ≤ 128 chars', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            n: fc.integer({ min: 1, max: 30 }),
            q: fc.integer({ min: 1, max: 20 }),
          }),
          { minLength: 1, maxLength: 60 },
        ),
        (rows) => {
          const ops = buildReserveOperations(
            ORDER,
            rows.map((r) => line(r.n, r.q)),
          );
          const ids = ops.map((o) => o.productId);
          expect([...ids].sort()).toEqual(ids);
          expect(new Set(ids).size).toBe(ids.length);
          for (const op of ops) {
            const sum = rows
              .filter((r) => pid(r.n) === op.productId)
              .reduce((a, r) => a + r.q, 0);
            expect(op.delta).toBe(-sum);
            expect(op.operationId.length).toBeLessThanOrEqual(128);
          }
        },
      ),
    );
  });
});

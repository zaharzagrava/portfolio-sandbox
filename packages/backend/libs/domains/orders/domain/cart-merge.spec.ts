import * as fc from 'fast-check';
import { mergeCarts, type CartLine } from './cart-merge';

const line = (
  productId: string,
  quantity: number,
  addedAt = '2026-01-01T00:00:00.000Z',
): CartLine => ({
  productId,
  quantity,
  addedAt,
});
const byId = (lines: CartLine[]) =>
  Object.fromEntries(lines.map((l) => [l.productId, l.quantity]));

describe('S10 AS-12: cart merge rule', () => {
  it.each([
    ['empty both', [], [], {}, 0],
    ['guest only', [], [line('A', 3)], { A: 3 }, 0],
    ['user only', [line('A', 3)], [], { A: 3 }, 0],
    ['sums a shared product', [line('A', 2)], [line('A', 3)], { A: 5 }, 0],
    [
      'caps a shared product at 20',
      [line('A', 15)],
      [line('A', 9)],
      { A: 20 },
      0,
    ],
    [
      'example {A:4,B:20,C:2}',
      [line('A', 1), line('B', 18)],
      [line('A', 3), line('B', 5), line('C', 2)],
      { A: 4, B: 20, C: 2 },
      0,
    ],
  ])('S10 AS-12: %s', (_n, user, guest, expected, dropped) => {
    const r = mergeCarts(user as CartLine[], guest as CartLine[]);
    expect(byId(r.lines)).toEqual(expected);
    expect(r.droppedLines).toBe(dropped);
  });

  it('S10 AS-12: user lines keep their addedAt and come first; new guest lines keep theirs', () => {
    const r = mergeCarts(
      [line('U', 1, '2026-01-02T00:00:00.000Z')],
      [
        line('U', 1, '2026-01-05T00:00:00.000Z'),
        line('G', 1, '2026-01-04T00:00:00.000Z'),
      ],
    );
    expect(r.lines).toEqual([
      line('U', 2, '2026-01-02T00:00:00.000Z'),
      line('G', 1, '2026-01-04T00:00:00.000Z'),
    ]);
  });

  it('S10 AS-12/AS-07: 40 user + 20 new guest lines → 50 lines, 10 dropped, guest ordered by addedAt then productId', () => {
    const user = Array.from({ length: 40 }, (_, i) =>
      line(`u${String(i).padStart(2, '0')}`, 1),
    );
    // guest lines g00..g19; the 10 oldest survive, with ties broken by productId
    const guest = Array.from({ length: 20 }, (_, i) =>
      line(
        `g${String(i).padStart(2, '0')}`,
        1,
        `2026-02-01T00:00:${String(Math.floor(i / 2)).padStart(2, '0')}.000Z`,
      ),
    ).reverse();
    const r = mergeCarts(user, guest);
    expect(r.lines).toHaveLength(50);
    expect(r.droppedLines).toBe(10);
    expect(r.lines.slice(0, 40).map((l) => l.productId)).toEqual(
      user.map((l) => l.productId),
    );
    expect(r.lines.slice(40).map((l) => l.productId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `g${String(i).padStart(2, '0')}`),
    );
  });

  it('S10 AS-12: a guest line for a product the user has still adds up when the cart is full', () => {
    const user = Array.from({ length: 50 }, (_, i) => line(`u${i}`, 1));
    const r = mergeCarts(user, [line('u3', 4), line('new', 1)]);
    expect(r.lines).toHaveLength(50);
    expect(byId(r.lines).u3).toBe(5);
    expect(r.droppedLines).toBe(1);
  });

  it('S10 AS-12: properties — once per product, min(20, u+g), at most 50 lines, user lines survive, dropped count', () => {
    const lines = fc.uniqueArray(fc.integer({ min: 0, max: 79 }), {
      maxLength: 50,
    });
    const cart = (ids: number[], q: fc.Arbitrary<number>) =>
      fc.tuple(
        fc.constant(ids),
        fc.array(q, { minLength: ids.length, maxLength: ids.length }),
      );
    fc.assert(
      fc.property(
        lines.chain((ids) => cart(ids, fc.integer({ min: 1, max: 20 }))),
        fc
          .uniqueArray(fc.integer({ min: 0, max: 79 }), { maxLength: 50 })
          .chain((ids) => cart(ids, fc.integer({ min: 1, max: 20 }))),
        ([uIds, uQ], [gIds, gQ]) => {
          const user = uIds.map((id, i) =>
            line(
              `p${id}`,
              uQ[i],
              `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
            ),
          );
          const guest = gIds.map((id, i) =>
            line(
              `p${id}`,
              gQ[i],
              `2026-02-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
            ),
          );
          const r = mergeCarts(user, guest);
          const ids = r.lines.map((l) => l.productId);
          expect(new Set(ids).size).toBe(ids.length);
          expect(r.lines.length).toBeLessThanOrEqual(50);
          const u = byId(user);
          const g = byId(guest);
          const out = byId(r.lines);
          for (const id of Object.keys(u))
            expect(out[id]).toBe(Math.min(20, u[id] + (g[id] ?? 0)));
          for (const id of Object.keys(out))
            if (!(id in u)) expect(out[id]).toBe(g[id]);
          const newGuest = Object.keys(g).filter((id) => !(id in u));
          expect(r.droppedLines).toBe(
            newGuest.length - (Object.keys(out).length - Object.keys(u).length),
          );
          expect(Object.keys(out).length + r.droppedLines).toBe(
            new Set([...Object.keys(u), ...Object.keys(g)]).size,
          );
        },
      ),
    );
  });
});

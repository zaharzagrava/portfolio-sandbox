import { decodeHlc, encodeHlc, receive, tick } from './hlc';
import { stockDelta, winningFields } from './merge';

/** Shared with the PWA (same rules client-side for optimistic UI) - pure → unit spec. */
describe('offline merge rules', () => {
  it('HLC: monotonic under a backwards wall clock, ordered by string comparison, after both on receive', () => {
    const a = { physical: 1_000, logical: 0, node: 'dev-a' };
    const a2 = tick(a, 900); // clock went backwards
    expect(encodeHlc(a2) > encodeHlc(a)).toBe(true);
    const remote = { physical: 5_000, logical: 3, node: 'dev-b' };
    const merged = receive(a2, remote, 1_200);
    expect(encodeHlc(merged) > encodeHlc(remote)).toBe(true);
    expect(decodeHlc(encodeHlc(merged))).toEqual(merged);
  });

  it('stock ops commute: any order of the same deltas gives the same result', () => {
    const ops = [
      {
        type: 'stock.adjust' as const,
        opId: '1',
        hlc: 'x',
        productId: 'p',
        delta: 3,
        reason: 'received' as const,
      },
      {
        type: 'stock.adjust' as const,
        opId: '2',
        hlc: 'x',
        productId: 'p',
        delta: -1,
        reason: 'sold' as const,
      },
      {
        type: 'stock.count' as const,
        opId: '3',
        hlc: 'x',
        productId: 'p',
        counted: 8,
        base: 10,
      }, // device saw 2 missing
    ];
    const total = (list: typeof ops) =>
      list.reduce((s, op) => s + stockDelta(op), 0);
    expect(total(ops)).toBe(0);
    expect(total([...ops].reverse())).toBe(total(ops));
  });

  it('LWW per field: newer HLC wins its field only', () => {
    const current = {
      title: '000000000002000-00000-dev-b',
      price: '000000000000500-00000-dev-b',
    };
    expect(
      winningFields(
        { title: 'x', price: 1 },
        '000000000001000-00000-dev-a',
        current,
      ),
    ).toEqual({ win: ['price'], lose: ['title'] });
  });
});

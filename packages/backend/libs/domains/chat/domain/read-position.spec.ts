import fc from 'fast-check';
import { advanceReadPosition, unreadCount } from './read-position';

describe('S24 read position', () => {
  it.each([
    // [current, requested, lastSeq, expected]
    [0, 3, 5, 3],
    [3, 1, 5, 3],
    [3, 3, 5, 3],
    [3, 999, 5, 5],
    [0, 0, 0, 0],
    [0, 7, 0, 0],
    [5, 2, 5, 5],
  ])(
    'S24 AS-32: from %i marking %i in a channel at %i gives %i',
    (current, requested, lastSeq, expected) => {
      expect(advanceReadPosition(current, requested, lastSeq)).toBe(expected);
    },
  );

  it('S24 AS-32: unread is lastSeq minus the position and never negative', () => {
    expect(unreadCount(5, 3)).toBe(2);
    expect(unreadCount(5, 5)).toBe(0);
    expect(unreadCount(5, 9)).toBe(0);
  });

  it('S24 AS-34: the position never decreases and never passes lastSeq, in any order of requests', () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat(1000), { minLength: 1, maxLength: 30 }),
        fc.nat(1000),
        (requests, lastSeq) => {
          const apply = (order: number[]) =>
            order.reduce((pos, r) => {
              const next = advanceReadPosition(pos, r, lastSeq);
              expect(next).toBeGreaterThanOrEqual(pos);
              expect(next).toBeLessThanOrEqual(Math.max(pos, lastSeq));
              return next;
            }, 0);
          const forward = apply(requests);
          expect(forward).toBe(apply([...requests].reverse()));
          expect(forward).toBe(Math.min(Math.max(...requests), lastSeq));
        },
      ),
    );
  });
});

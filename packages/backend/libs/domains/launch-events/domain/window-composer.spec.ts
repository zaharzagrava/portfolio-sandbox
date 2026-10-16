import fc from 'fast-check';
import { composeWindow } from './window-composer';
import type { LiveComment } from './live-constants';

const comment = (
  n: number,
  authorId = 'author',
  priority = false,
): LiveComment => ({
  id: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  streamId: 'stream',
  authorId,
  authorName: 'handle',
  text: `c${n}`,
  at: n,
  ...(priority && { priority: true as const }),
});
const ids = (list: { id: string }[]) => list.map((c) => c.id);

describe('composeWindow', () => {
  it('S23 AS-04: lists a comment that is both priority and sampled once', () => {
    const staff = comment(2, 'staff', true);
    const items = composeWindow({
      priority: [staff],
      sample: [comment(3), staff],
    });
    expect(ids(items)).toEqual([comment(2).id, comment(3).id]);
  });

  it('S23 AS-04: orders ascending by id whatever the input order', () => {
    const items = composeWindow({
      priority: [comment(9, 's', true), comment(1, 's', true)],
      own: [comment(5, 'me')],
      sample: [comment(7), comment(3)],
    });
    expect(ids(items)).toEqual([1, 3, 5, 7, 9].map((n) => comment(n).id));
  });

  it('S23 AS-04: an empty window is empty', () => {
    expect(composeWindow({ priority: [], sample: [] })).toEqual([]);
  });

  it('S23 AS-03: flags the viewer’s own comments `mine`, and only those', () => {
    const items = composeWindow({
      priority: [comment(1, 'staff', true)],
      own: [comment(2, 'me')],
      sample: [comment(3, 'other')],
    });
    expect(items.map((c) => c.mine === true)).toEqual([false, true, false]);
  });

  it('S23 AS-03: a viewer’s own staff comment is both priority and mine, once', () => {
    const mine = comment(1, 'me', true);
    const items = composeWindow({ priority: [mine], own: [mine], sample: [] });
    expect(items).toEqual([{ ...mine, mine: true }]);
  });

  it('S23 AS-03: 30 staff comments in one window are all delivered', () => {
    const priority = Array.from({ length: 30 }, (_, i) =>
      comment(i + 1, 'staff', true),
    );
    expect(composeWindow({ priority, sample: [] })).toHaveLength(30);
  });

  const commentsArb = fc
    .uniqueArray(fc.integer({ min: 1, max: 60 }), { maxLength: 40 })
    .map((numbers) => numbers.map((n) => comment(n, `a${n % 4}`, n % 7 === 0)));

  it('S23 AS-03: priority and own comments are never dropped, the sample adds at most its size (property)', () => {
    fc.assert(
      fc.property(
        commentsArb,
        commentsArb,
        commentsArb,
        (priority, own, sampleAll) => {
          const sample = sampleAll.slice(0, 5);
          const items = composeWindow({ priority, own, sample });
          const got = new Set(ids(items));
          for (const c of [...priority, ...own, ...sample])
            expect(got.has(c.id)).toBe(true);
          expect(items.length).toBeLessThanOrEqual(
            new Set(ids([...priority, ...own, ...sample])).size,
          );
          expect(ids(items)).toEqual([...ids(items)].sort());
          expect(new Set(ids(items)).size).toBe(items.length);
        },
      ),
    );
  });
});

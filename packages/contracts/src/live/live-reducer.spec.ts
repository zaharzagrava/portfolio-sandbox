import fc from 'fast-check';
import {
  initialLiveState,
  reduceLive,
  type LiveClientEvent,
  type LiveClientState,
} from './live-reducer.ts';
import type { LiveComment, LivePin } from './schemas.ts';

const comment = (n: number): LiveComment => ({
  id: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  streamId: '00000000-0000-7000-8000-00000000ffff',
  authorId: '00000000-0000-7000-8000-00000000aaaa',
  authorName: 'handle',
  text: `comment ${n}`,
  at: 1_000 + n,
});
const pin = (version: number): LivePin => ({
  version,
  productId: '00000000-0000-7000-8000-00000000bbbb',
  productTitle: 'Phone',
  text: `v${version}`,
  pinnedAt: '2026-10-05T10:00:00.000Z',
});
const stats = (second: number) => ({ second, reactions: {}, viewers: 1 });

const apply = (events: LiveClientEvent[], from = initialLiveState()) =>
  events.reduce(reduceLive, from);

describe('S23 live client reducer', () => {
  it('S23 AS-09: a pin whose version is not higher is ignored', () => {
    const state = apply([
      { type: 'pin', data: pin(3) },
      { type: 'pin', data: pin(2) },
      { type: 'pin', data: pin(3) },
    ]);
    expect(state.pin?.version).toBe(3);
    expect(state.pinVersion).toBe(3);
  });

  it('S23 AS-09: an unpin orders by its version like a pin', () => {
    const unpinned = apply([
      { type: 'pin', data: pin(1) },
      { type: 'pin', data: { version: 2, unpinned: true } },
      { type: 'pin', data: pin(1) },
    ]);
    expect(unpinned.pin).toBeNull();
    expect(unpinned.pinVersion).toBe(2);
  });

  it('S23 AS-09: a stats whose second is not higher is ignored', () => {
    const state = apply([
      { type: 'stats', data: stats(10) },
      { type: 'stats', data: stats(9) },
      { type: 'stats', data: stats(10) },
    ]);
    expect(state.stats?.second).toBe(10);
  });

  it('S23 AS-09: a removal of an unknown comment is remembered, so the comment is never displayed when it arrives', () => {
    const state = apply([
      { type: 'comment_removed', data: { id: comment(1).id } },
      { type: 'comments', data: { items: [comment(1), comment(2)] } },
    ]);
    expect(state.comments.map((c) => c.id)).toEqual([comment(2).id]);
    expect(state.removed).toEqual([comment(1).id]);
  });

  it('S23 AS-48: a delivered comment is dropped when its removal arrives', () => {
    const state = apply([
      { type: 'comments', data: { items: [comment(1), comment(2)] } },
      { type: 'comment_removed', data: { id: comment(1).id } },
    ]);
    expect(state.comments.map((c) => c.id)).toEqual([comment(2).id]);
  });

  it('S23 AS-09: a snapshot older than the live events does not undo them', () => {
    const state = apply([
      { type: 'pin', data: pin(4) },
      { type: 'comment_removed', data: { id: comment(1).id } },
      { type: 'status', data: { status: 'ENDED' } },
      {
        type: 'snapshot',
        data: {
          status: 'LIVE',
          pin: pin(3),
          recent: [comment(1), comment(2)],
        },
      },
    ]);
    expect(state.pin?.version).toBe(4);
    expect(state.status).toBe('ENDED');
    expect(state.comments.map((c) => c.id)).toEqual([comment(2).id]);
  });

  it('S23 AS-09: comments are kept ascending by id without duplicates', () => {
    const state = apply([
      { type: 'comments', data: { items: [comment(3), comment(1)] } },
      { type: 'comments', data: { items: [comment(2), comment(3)] } },
    ]);
    expect(state.comments.map((c) => c.id)).toEqual(
      [1, 2, 3].map((n) => comment(n).id),
    );
  });

  const eventArb: fc.Arbitrary<LiveClientEvent> = fc.oneof(
    fc
      .integer({ min: 1, max: 6 })
      .map((n) => ({ type: 'comments', data: { items: [comment(n)] } })),
    fc
      .integer({ min: 1, max: 6 })
      .map((n) => ({ type: 'comment_removed', data: { id: comment(n).id } })),
    fc
      .integer({ min: 1, max: 5 })
      .map((v) => ({ type: 'pin', data: pin(v) })),
    fc.integer({ min: 1, max: 5 }).map((v) => ({
      type: 'pin',
      data: { version: v + 5, unpinned: true as const },
    })),
    fc
      .integer({ min: 1, max: 5 })
      .map((s) => ({ type: 'stats', data: stats(s) })),
    fc
      .constantFrom('SCHEDULED', 'LIVE', 'ENDED' as const)
      .map((status) => ({ type: 'status', data: { status } })),
  );

  it('S23 AS-09: any order and any duplication of the events reaches the same state', () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { maxLength: 25 }),
        fc.nat(),
        (events, seed) => {
          const shuffled = [...events, ...events.slice(0, seed % 5)]
            .map((event, i) => ({ event, key: (i * 7919 + seed) % 101 }))
            .sort((a, b) => a.key - b.key)
            .map((entry) => entry.event);
          const normal = (s: LiveClientState) => JSON.stringify(s);
          expect(normal(apply(shuffled))).toBe(normal(apply(events)));
        },
      ),
    );
  });
});

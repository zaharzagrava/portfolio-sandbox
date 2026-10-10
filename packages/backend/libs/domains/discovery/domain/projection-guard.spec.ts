import fc from 'fast-check';
import {
  PRODUCT_EVENT_KINDS,
  decideMedia,
  decidePopularity,
  decideProduct,
  decideShopState,
  decideSponsorship,
  shouldWrite,
  type GuardOutcome,
  type ProductEventKind,
  type StoredProduct,
} from './projection-guard';

describe('projection guard (S32 AS-81)', () => {
  type Row = [
    string,
    StoredProduct | null,
    number,
    ProductEventKind,
    GuardOutcome,
  ];
  const live = (version: number): StoredProduct => ({
    version,
    deleted: false,
  });
  const tomb = (version: number): StoredProduct => ({ version, deleted: true });

  const rows: Row[] = [
    ['no stored row, created', null, 1, 'created', 'applied'],
    ['no stored row, late update', null, 4, 'updated', 'applied'],
    ['no stored row, delete first', null, 3, 'deleted', 'applied'],
    ['newer update', live(3), 4, 'updated', 'applied'],
    ['newer archive', live(3), 9, 'archived', 'applied'],
    ['newer restore', live(3), 4, 'restored', 'applied'],
    ['newer delete', live(3), 4, 'deleted', 'applied'],
    ['equal version update', live(3), 3, 'updated', 'duplicate'],
    ['equal version archive', live(3), 3, 'archived', 'duplicate'],
    ['older update', live(3), 2, 'updated', 'stale'],
    ['older created', live(3), 1, 'created', 'stale'],
    ['older delete', live(3), 2, 'deleted', 'stale'],
    ['tombstone, older update', tomb(6), 5, 'updated', 'stale'],
    ['tombstone, equal update', tomb(6), 6, 'updated', 'stale'],
    ['tombstone, equal created', tomb(6), 6, 'created', 'stale'],
    ['tombstone, same delete again', tomb(6), 6, 'deleted', 'duplicate'],
    ['tombstone, older delete', tomb(6), 4, 'deleted', 'stale'],
    ['tombstone, newer created (new product)', tomb(6), 7, 'created', 'applied'],
    ['tombstone, newer update', tomb(6), 7, 'updated', 'stale'],
    ['tombstone, newer archive', tomb(6), 7, 'archived', 'stale'],
    ['tombstone, newer restore', tomb(6), 7, 'restored', 'stale'],
    ['tombstone, newer delete', tomb(6), 7, 'deleted', 'applied'],
  ];

  it.each(rows)(
    'S32 AS-81: product %s',
    (_name, stored, version, kind, expected) => {
      expect(decideProduct(stored, { version, kind })).toBe(expected);
    },
  );

  it('S32 AS-81: covers every product event kind', () => {
    for (const kind of PRODUCT_EVENT_KINDS)
      expect(rows.some((r) => r[3] === kind)).toBe(true);
  });

  it('S32 AS-81: an unknown kind is rejected by the exhaustive check', () => {
    expect(() =>
      decideProduct(tomb(1), { version: 2, kind: 'bogus' as never }),
    ).toThrow();
  });

  it('S32 AS-81: only applied and duplicate outcomes write', () => {
    expect(shouldWrite('applied')).toBe(true);
    expect(shouldWrite('duplicate')).toBe(true);
    expect(shouldWrite('stale')).toBe(false);
  });

  const versioned = [
    ['media', decideMedia],
    ['sponsorship', decideSponsorship],
  ] as const;
  describe.each(versioned)('%s uses its own version', (_n, decide) => {
    it.each([
      [null, 1, 'applied'],
      [2, 3, 'applied'],
      [2, 2, 'duplicate'],
      [3, 2, 'stale'],
      [0, 0, 'duplicate'],
    ] as const)('S32 AS-81: stored %s incoming %s -> %s', (s, i, out) => {
      expect(decide(s, i)).toBe(out);
    });
  });

  it.each([
    [null, 5, 'applied'],
    [1000, 2000, 'applied'],
    [1000, 1000, 'duplicate'],
    [2000, 1000, 'stale'],
  ] as const)(
    'S32 AS-81: popularity stored %s incoming %s -> %s',
    (s, i, out) => {
      expect(decidePopularity(s, i)).toBe(out);
    },
  );

  describe('shop state', () => {
    const stored = (shopVersion: number | null, lastEventAt: number) => ({
      shopVersion,
      lastEventAt,
    });
    const incoming = (shopVersion: number | null, occurredAt: number) => ({
      shopVersion,
      occurredAt,
    });
    it.each([
      ['no row', null, incoming(1, 10), 'applied'],
      ['both versioned, newer', stored(2, 100), incoming(3, 1), 'applied'],
      ['both versioned, equal', stored(2, 100), incoming(2, 50), 'duplicate'],
      ['both versioned, older (newer clock)', stored(3, 1), incoming(2, 999), 'stale'],
      ['unversioned, later time', stored(null, 100), incoming(null, 200), 'applied'],
      ['unversioned, same time', stored(null, 100), incoming(null, 100), 'duplicate'],
      ['unversioned, earlier time', stored(null, 100), incoming(null, 50), 'stale'],
      ['stored versioned, incoming unversioned, later', stored(5, 100), incoming(null, 200), 'applied'],
      ['stored unversioned, incoming versioned, earlier', stored(null, 100), incoming(7, 50), 'stale'],
    ] as const)('S32 AS-81: %s', (_n, s, i, out) => {
      expect(decideShopState(s, i)).toBe(out);
    });
  });

  describe('convergence (SC-004)', () => {
    type Event = { version: number; kind: ProductEventKind };
    const apply = (
      state: (StoredProduct & { kind: ProductEventKind }) | null,
      event: Event,
    ) => {
      const outcome = decideProduct(state, event);
      return shouldWrite(outcome)
        ? { version: event.version, deleted: event.kind === 'deleted', kind: event.kind }
        : state;
    };

    const history = fc
      .record({
        middle: fc.array(
          fc.constantFrom<ProductEventKind>('updated', 'archived', 'restored'),
          { maxLength: 8 },
        ),
        ending: fc.constantFrom('none', 'deleted', 'deleted-recreated'),
      })
      .map(({ middle, ending }) => {
        const events: Event[] = [{ version: 1, kind: 'created' }];
        middle.forEach((kind, i) => events.push({ version: i + 2, kind }));
        if (ending !== 'none')
          events.push({ version: events.length + 1, kind: 'deleted' });
        if (ending === 'deleted-recreated')
          events.push({ version: events.length + 1, kind: 'created' });
        return events;
      });

    it('S32 AS-81: any permutation with duplicates ends at the newest version', () => {
      fc.assert(
        fc.property(
          history,
          fc.nat(1000),
          fc.array(fc.nat(1000), { maxLength: 12 }),
          (events, seed, dupIdx) => {
            const arrival = [
              ...events,
              ...dupIdx.map((i) => events[i % events.length]),
            ];
            // deterministic shuffle from the seed
            const shuffled = arrival
              .map((e, i) => ({ e, k: ((i + 1) * (seed + 7919)) % 104729 }))
              .sort((a, b) => a.k - b.k)
              .map((x) => x.e);
            const newest = events[events.length - 1];
            const end = shuffled.reduce<ReturnType<typeof apply>>(apply, null);
            expect(end?.version).toBe(newest.version);
            expect(end?.deleted).toBe(newest.kind === 'deleted');
          },
        ),
        { numRuns: 300 },
      );
    });

    it('S32 AS-81: a delete is never revived by an older or non-created event', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 50 }),
          fc.integer({ min: 0, max: 60 }),
          fc.constantFrom<ProductEventKind>('updated', 'archived', 'restored'),
          (deletedAt, incoming, kind) => {
            expect(
              decideProduct(tomb(deletedAt), { version: incoming, kind }),
            ).toBe('stale');
          },
        ),
      );
    });
  });
});

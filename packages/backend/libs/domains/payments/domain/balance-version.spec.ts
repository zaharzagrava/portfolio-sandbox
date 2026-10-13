import * as fc from 'fast-check';
import { applyIfNewer, decideVersion } from './balance-version';

describe('Balance version guard', () => {
  it.each([
    [null, 1, 'apply'],
    [0, 1, 'apply'],
    [4, 5, 'apply'],
    [4, 9, 'apply'], // a gap: absolute values make it safe
    [5, 5, 'duplicate'],
    [5, 4, 'stale'],
    [5, 0, 'stale'],
  ])(
    'S14 AS-30: stored %s, incoming %d is %s',
    (stored, incoming, expected) => {
      expect(decideVersion(stored, incoming)).toBe(expected);
    },
  );

  it('S14 AS-30: a guarded store keeps the highest version it has seen', () => {
    type Row = { version: number; balanceMinor: number };
    const store = new Map<string, Row>();
    const put = (k: string, version: number, balanceMinor: number) =>
      applyIfNewer(store.get(k) ?? null, { version, balanceMinor });
    for (const [k, v, b] of [
      ['a', 3, 30],
      ['a', 2, 20],
      ['a', 3, 30],
      ['a', 4, 40],
    ] as const) {
      const r = put(k, v, b);
      if (r.outcome === 'apply') store.set(k, r.row);
    }
    expect(store.get('a')).toEqual({ version: 4, balanceMinor: 40 });
  });

  it('S14 AS-30: any permutation and duplication of a set of events gives the same final state (property)', () => {
    const event = fc.record({
      key: fc.constantFrom('a#0', 'a#1', 'b#0'),
      version: fc.integer({ min: 1, max: 12 }),
    });
    const run = (events: { key: string; version: number }[]) => {
      const store = new Map<
        string,
        { version: number; balanceMinor: number }
      >();
      for (const e of events) {
        const r = applyIfNewer(store.get(e.key) ?? null, {
          version: e.version,
          balanceMinor: e.version * 100, // absolute value is a function of the version
        });
        if (r.outcome === 'apply') store.set(e.key, r.row);
      }
      return JSON.stringify([...store.entries()].sort());
    };
    fc.assert(
      fc.property(
        fc.array(event, { minLength: 1, maxLength: 40 }),
        fc.array(fc.nat(), { minLength: 0, maxLength: 40 }),
        (events, picks) => {
          const duplicated = [
            ...events,
            ...picks.map((p) => events[p % events.length]),
          ];
          const reversed = [...duplicated].reverse();
          const sorted = [...duplicated].sort((x, y) => x.version - y.version);
          return (
            run(events) === run(reversed) &&
            run(duplicated) === run(sorted) &&
            run(events) === run(sorted)
          );
        },
      ),
    );
  });
});

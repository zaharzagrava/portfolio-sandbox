import {
  compareTimeUuid,
  fromSortableId,
  idTime,
  isTimeUuid,
  RandomSource,
  sortableId,
  TimeIdGenerator,
} from './ids';

/** Deterministic random source (xorshift), so the specs never depend on `node:crypto`. */
const seeded = (seed: number): RandomSource => {
  let s = seed;
  return {
    bytes(length) {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        out[i] = s & 0xff;
      }
      return out;
    },
  };
};

describe('time-based discussion ids', () => {
  it.each([
    '2026-10-13T12:00:00.000Z',
    '2026-10-13T12:00:00.001Z',
    '1970-01-01T00:00:00.000Z',
    '2099-12-31T23:59:59.999Z',
  ])(
    'S25 AS-01: the embedded time of an id made at %s is that instant',
    (iso) => {
      const id = new TimeIdGenerator(seeded(7)).next(new Date(iso));
      expect(isTimeUuid(id)).toBe(true);
      expect(idTime(id).toISOString()).toBe(iso);
    },
  );

  it('S25 AS-19: 500 ids made in the same millisecond are unique and sort in creation order', () => {
    const gen = new TimeIdGenerator(seeded(11));
    const at = new Date('2026-10-13T12:00:00.000Z');
    const ids = Array.from({ length: 500 }, () => gen.next(at));
    expect(new Set(ids).size).toBe(500);
    expect([...ids].sort(compareTimeUuid)).toEqual(ids);
    expect(ids.every((id) => idTime(id).getTime() === at.getTime())).toBe(true);
  });

  it('S25 AS-19: two generators (two processes) in the same millisecond do not collide', () => {
    const at = new Date('2026-10-13T12:00:00.000Z');
    const a = new TimeIdGenerator(seeded(1));
    const b = new TimeIdGenerator(seeded(2));
    const ids = [
      ...Array.from({ length: 100 }, () => a.next(at)),
      ...Array.from({ length: 100 }, () => b.next(at)),
    ];
    expect(new Set(ids).size).toBe(200);
  });

  it('S25 AS-55: sorting by id equals sorting by creation time, whatever the creation order of the instants', () => {
    const gen = new TimeIdGenerator(seeded(3));
    const times = [5, 1, 9, 3, 3, 8, 2].map(
      (n) => new Date(Date.UTC(2026, 9, 13, 12, 0, n)),
    );
    const ids = times.map((t) => gen.next(t));
    const byId = [...ids]
      .sort(compareTimeUuid)
      .map((id) => idTime(id).getTime());
    expect(byId).toEqual(
      [...times].map((t) => t.getTime()).sort((x, y) => x - y),
    );
  });

  it('S25 AS-55: the sortable form puts the timestamp first and round-trips', () => {
    const gen = new TimeIdGenerator(seeded(4));
    const older = gen.next(new Date('2026-01-01T00:00:00.000Z'));
    const newer = gen.next(new Date('2026-06-01T00:00:00.000Z'));
    expect(sortableId(older)).toHaveLength(32);
    expect(sortableId(older) < sortableId(newer)).toBe(true);
    expect(fromSortableId(sortableId(newer))).toBe(newer);
  });

  it('refuses anything that is not a time-based uuid', () => {
    expect(isTimeUuid('product-5b1f')).toBe(false);
    expect(isTimeUuid('0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b')).toBe(false);
    expect(() => sortableId('nope')).toThrow(RangeError);
  });
});

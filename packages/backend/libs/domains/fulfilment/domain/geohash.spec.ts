import fc from 'fast-check';
import { distanceM, geohash } from './geohash';

const ALPHABET = /^[0-9bcdefghjkmnpqrstuvwxyz]+$/;

describe('geohash', () => {
  it.each([
    [57.64911, 10.40744, 11, 'u4pruydqqvj'],
    [57.64911, 10.40744, 5, 'u4pru'],
    [48.669, -4.329, 8, 'gbsuv7zt'],
    [-25.382708, -49.265506, 8, '6gkzwgjz'],
    [0, 0, 5, 's0000'],
  ])(
    'S20 AS-51: (%d, %d) at precision %i is %s',
    (lat, lng, precision, expected) => {
      expect(geohash(lat, lng, precision)).toBe(expected);
    },
  );

  it('S20 AS-51: the default precision is 5', () => {
    expect(geohash(52.52, 13.405)).toHaveLength(5);
  });

  it('S20 AS-51: a point on a cell edge belongs to exactly one cell (the upper or eastern one)', () => {
    // lng 0 / lat 0 is the edge of four precision-1 cells
    expect(geohash(0, 0, 1)).toBe('s');
    expect(geohash(0, -1e-9, 1)).toBe('e');
    expect(geohash(-1e-9, 0, 1)).toBe('k');
    expect(geohash(-1e-9, -1e-9, 1)).toBe('7');
    const hashes = new Set([
      geohash(0, 0, 5),
      geohash(0, -1e-9, 5),
      geohash(-1e-9, 0, 5),
      geohash(-1e-9, -1e-9, 5),
    ]);
    expect(hashes.size).toBe(4);
  });

  it.each([
    [90, 180],
    [90, -180],
    [-90, 180],
    [-90, -180],
    [0, 180],
    [90, 0],
  ])('S20 AS-51: the extreme (%d, %d) encodes without error', (lat, lng) => {
    const hash = geohash(lat, lng, 11);
    expect(hash).toHaveLength(11);
    expect(hash).toMatch(ALPHABET);
  });

  it('S20 AS-51: a coarser cell is a prefix of a finer one', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -90, max: 90, noNaN: true }),
        fc.double({ min: -180, max: 180, noNaN: true }),
        (lat, lng) => {
          expect(geohash(lat, lng, 11).startsWith(geohash(lat, lng, 5))).toBe(
            true,
          );
        },
      ),
    );
  });

  it('S20 AS-51: distance in metres is symmetric and zero for the same point', () => {
    expect(distanceM(52.52, 13.405, 52.52, 13.405)).toBe(0);
    const ab = distanceM(52.52, 13.405, 52.5, 13.38);
    const ba = distanceM(52.5, 13.38, 52.52, 13.405);
    expect(ab).toBeCloseTo(ba, 6);
    expect(ab).toBeGreaterThan(2_000);
    expect(ab).toBeLessThan(4_000);
  });
});

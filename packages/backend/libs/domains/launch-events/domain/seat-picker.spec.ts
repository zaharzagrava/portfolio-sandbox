import fc from 'fast-check';
import { freeRuns, pickSeats } from './seat-picker';

describe('S22 best-available seat picker', () => {
  it('S22 AS-26: runs break at row boundaries and at gaps', () => {
    expect(freeRuns([0, 1, 2, 4, 5, 9, 10, 11], 5)).toEqual([
      { start: 0, length: 3 },
      { start: 4, length: 1 },
      { start: 5, length: 1 },
      { start: 9, length: 1 },
      { start: 10, length: 2 },
    ]);
  });

  it.each([
    [[0, 1, 2, 3], 2, 4, true],
    [[3, 4, 8, 9], 2, 5, true],
    [[4, 5], 2, 5, false],
    [[1, 3, 5, 7], 2, 100, false],
  ])(
    'S22 AS-26: free %j, quantity %i, row %i → adjacent pair %s',
    (free, quantity, row, adjacent) => {
      const seats = pickSeats({
        free,
        quantity,
        seatsPerRow: row,
        random: () => 0,
      })!;
      expect(seats).toHaveLength(quantity);
      const together =
        seats[1] === seats[0] + 1 &&
        Math.floor(seats[0] / row) === Math.floor(seats[1] / row);
      expect(together).toBe(adjacent);
    },
  );

  it('S22 AS-26: not enough free seats gives nothing, never a partial pick', () => {
    expect(
      pickSeats({ free: [4], quantity: 2, seatsPerRow: 10, random: () => 0 }),
    ).toBeNull();
    expect(
      pickSeats({ free: [], quantity: 1, seatsPerRow: 10, random: () => 0 }),
    ).toBeNull();
  });

  it('S22 AS-26 (property): the pick is distinct, free, sorted and of the asked size', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.nat(199), { maxLength: 60 }),
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 30 }),
        fc.double({ min: 0, max: 0.999, noNaN: true }), // Math.random is never NaN
        (free, quantity, row, r) => {
          const sorted = [...free].sort((a, b) => a - b);
          const picked = pickSeats({
            free: sorted,
            quantity,
            seatsPerRow: row,
            random: () => r,
          });
          if (sorted.length < quantity) return expect(picked).toBeNull();
          expect(picked).toHaveLength(quantity);
          expect(new Set(picked).size).toBe(quantity);
          expect(picked!.every((s) => sorted.includes(s))).toBe(true);
          expect([...picked!].sort((a, b) => a - b)).toEqual(picked);
        },
      ),
      { numRuns: 2000 },
    );
  });
});

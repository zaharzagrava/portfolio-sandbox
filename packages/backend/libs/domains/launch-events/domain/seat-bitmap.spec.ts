import fc from 'fast-check';
import {
  bitmapByteLength,
  clearSeat,
  emptyBitmap,
  hasSeat,
  seatBit,
  setSeat,
} from './seat-bitmap';

describe('S22 seat bitmap', () => {
  it.each([
    [1, 1],
    [8, 1],
    [9, 2],
    [800, 100],
    [100_000, 12_500],
  ])('S22 AS-45: %i seats take ceil(n/8) = %i bytes', (seats, bytes) => {
    expect(bitmapByteLength(seats)).toBe(bytes);
    expect(emptyBitmap(seats)).toHaveLength(bytes);
  });

  it.each([
    [0, 0, 0b10000000],
    [1, 0, 0b01000000],
    [7, 0, 0b00000001],
    [8, 1, 0b10000000],
    [9, 1, 0b01000000],
  ])(
    'S22 AS-45: seat %i is byte %i, mask %i (bit 7 − i mod 8)',
    (seat, byte, mask) => {
      expect(seatBit(seat)).toEqual({ byte, mask });
      const map = setSeat(emptyBitmap(16), seat);
      expect(map[byte]).toBe(mask);
    },
  );

  it('S22 AS-45: seats 1, 2, 3 set and everything else clear', () => {
    let map = emptyBitmap(800);
    for (const s of [1, 2, 3]) map = setSeat(map, s);
    expect(map[0]).toBe(0b01110000);
    expect([...map.subarray(1)].every((b) => b === 0)).toBe(true);
  });

  it('S22 AS-45: set/clear round trip and position of every seat (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2_000 }),
        fc.array(fc.nat(1_999), { maxLength: 40 }),
        (seatCount, picks) => {
          const seats = [...new Set(picks.map((p) => p % seatCount))];
          let map = emptyBitmap(seatCount);
          for (const s of seats) map = setSeat(map, s);
          for (let s = 0; s < seatCount; s++)
            expect(hasSeat(map, s)).toBe(seats.includes(s));
          for (const s of seats) map = clearSeat(map, s);
          expect([...map].every((b) => b === 0)).toBe(true);
        },
      ),
    );
  });
});

/**
 * The seat map picture (S22 AS-45): 1 bit per seat, seat `i` is bit `7 − (i mod 8)` of byte `⌊i ÷ 8⌋` (the order of
 * Redis `SETBIT`, so the live store and a rebuild agree). Pure helpers over a `Buffer`; the display, never the authority.
 */
export const bitmapByteLength = (seatCount: number) => Math.ceil(seatCount / 8);

export const emptyBitmap = (seatCount: number): Buffer =>
  Buffer.alloc(bitmapByteLength(seatCount));

export const seatBit = (seat: number) => ({
  byte: Math.floor(seat / 8),
  mask: 1 << (7 - (seat % 8)),
});

const copy = (map: Buffer) => Buffer.from(map);

export const setSeat = (map: Buffer, seat: number): Buffer => {
  const next = copy(map);
  const { byte, mask } = seatBit(seat);
  next[byte] |= mask;
  return next;
};

export const clearSeat = (map: Buffer, seat: number): Buffer => {
  const next = copy(map);
  const { byte, mask } = seatBit(seat);
  next[byte] &= ~mask;
  return next;
};

export const hasSeat = (map: Buffer, seat: number): boolean => {
  const { byte, mask } = seatBit(seat);
  return byte < map.length && (map[byte] & mask) !== 0;
};

/** Pads (or trims) a stored bitmap to the exact length for the event, so a client never sees a short map. */
export const fitBitmap = (map: Buffer | null, seatCount: number): Buffer => {
  const out = emptyBitmap(seatCount);
  if (map) map.copy(out, 0, 0, Math.min(map.length, out.length));
  return out;
};

export type SeatChange = 'held' | 'booked' | 'released';

export interface SeatMapDelta {
  seq: number;
  change: SeatChange;
  seats: number[];
}

/** What a client keeps for one seat map: the last applied `seq`, the base64 bitmap and (for tests) the applied sequence numbers. */
export interface SeatMapClientState {
  seq: number;
  bitmap: string;
  applied: number[];
}

export type SeatMapReduction =
  | { action: 'applied'; state: SeatMapClientState }
  | { action: 'ignored'; state: SeatMapClientState }
  | { action: 'refetch'; state: SeatMapClientState };

/**
 * The client delta rule (S22 FR-039): apply only `seq = last + 1`, ignore `seq <= last`, refetch the map on a gap.
 * Pure: the caller replaces its state with `state` and refetches when the action says so. Bit order as the server:
 * seat `i` is bit `7 - (i mod 8)` of byte `floor(i / 8)`.
 */
export const reduceSeatMap = (
  state: SeatMapClientState,
  delta: SeatMapDelta,
): SeatMapReduction => {
  if (delta.seq <= state.seq) return { action: 'ignored', state };
  if (delta.seq !== state.seq + 1) return { action: 'refetch', state };
  const bytes = Buffer.from(state.bitmap, 'base64');
  const maxSeat = delta.seats.reduce((m, s) => Math.max(m, s), -1);
  const needed = Math.floor(maxSeat / 8) + 1;
  const bits =
    needed > bytes.length
      ? Buffer.concat([bytes, Buffer.alloc(needed - bytes.length)])
      : Buffer.from(bytes);
  for (const seat of delta.seats) {
    const mask = 1 << (7 - (seat % 8));
    const index = Math.floor(seat / 8);
    bits[index] =
      delta.change === 'released' ? bits[index] & ~mask : bits[index] | mask;
  }
  return {
    action: 'applied',
    state: {
      seq: delta.seq,
      bitmap: bits.toString('base64'),
      applied: [...state.applied, delta.seq],
    },
  };
};

import { reduceSeatMap, type SeatMapClientState } from './seat-map-reducer.ts';

const start: SeatMapClientState = { seq: 10, bitmap: 'AAAA', applied: [] };

describe('S22 seat map client delta rule', () => {
  it('S22 AS-47: applies only last+1, ignores seq <= last, asks for a refetch on a gap, never applies twice', () => {
    const deltas = [
      { seq: 11, change: 'held' as const, seats: [1] },
      { seq: 13, change: 'held' as const, seats: [3] },
      { seq: 12, change: 'held' as const, seats: [2] },
      { seq: 12, change: 'held' as const, seats: [2] },
    ];
    let state = start;
    const outcomes: string[] = [];
    for (const delta of deltas) {
      const result = reduceSeatMap(state, delta);
      outcomes.push(result.action);
      state = result.state;
    }
    expect(outcomes).toEqual(['applied', 'refetch', 'applied', 'ignored']);
    expect(state.applied).toEqual([11, 12]);
    expect(state.seq).toBe(12);
  });

  it.each([
    [10, 11, 'applied'],
    [10, 10, 'ignored'],
    [10, 3, 'ignored'],
    [10, 12, 'refetch'],
    [10, 500, 'refetch'],
  ])('S22 AS-47: last %i, delta %i → %s', (last, seq, action) => {
    const result = reduceSeatMap(
      { seq: last, bitmap: 'AAAA', applied: [] },
      { seq, change: 'booked', seats: [0] },
    );
    expect(result.action).toBe(action);
  });

  it('S22 AS-47: held and booked set the bit, released clears it', () => {
    const held = reduceSeatMap(start, {
      seq: 11,
      change: 'held',
      seats: [0, 9],
    });
    expect(Buffer.from(held.state.bitmap, 'base64')[0]).toBe(0b10000000);
    expect(Buffer.from(held.state.bitmap, 'base64')[1]).toBe(0b01000000);
    const released = reduceSeatMap(held.state, {
      seq: 12,
      change: 'released',
      seats: [0],
    });
    expect(Buffer.from(released.state.bitmap, 'base64')[0]).toBe(0);
  });
});

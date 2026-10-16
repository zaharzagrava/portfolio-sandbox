import {
  reduceSeatMap,
  type SeatMapClientState,
} from '@marketplace-sandbox/contracts';

const start: SeatMapClientState = { seq: 10, bitmap: 'AAAA', applied: [] };

describe('S22 seat map client delta rule (shared reducer)', () => {
  it('S22 AS-47: deltas 11, 13, 12, 12 apply last+1, refetch on the gap, ignore the duplicate and never apply twice', () => {
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
  ])('S22 AS-47: last %i, delta %i → %s', (last, seq, action) => {
    const result = reduceSeatMap(
      { seq: last, bitmap: 'AAAA', applied: [] },
      { seq, change: 'booked', seats: [0] },
    );
    expect(result.action).toBe(action);
  });
});

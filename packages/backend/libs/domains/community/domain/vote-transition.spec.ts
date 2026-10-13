import * as fc from 'fast-check';
import {
  applyDelta,
  EMPTY_COUNTS,
  voteDelta,
  type VoteRecord,
} from './vote-transition';

const up = (weight: 0 | 1 = 1): VoteRecord => ({ value: 1, weight });
const down = (weight: 0 | 1 = 1): VoteRecord => ({ value: -1, weight });

describe('S25 vote deltas', () => {
  it.each([
    ['first up', null, up(), { dUps: 1, dDowns: 0, dWups: 1, dWdowns: 0 }],
    ['first down', null, down(), { dUps: 0, dDowns: 1, dWups: 0, dWdowns: 1 }],
    [
      'first up, weight 0',
      null,
      up(0),
      { dUps: 1, dDowns: 0, dWups: 0, dWdowns: 0 },
    ],
    [
      'first down, weight 0',
      null,
      down(0),
      { dUps: 0, dDowns: 1, dWups: 0, dWdowns: 0 },
    ],
    [
      'flip up to down',
      up(),
      down(),
      { dUps: -1, dDowns: 1, dWups: -1, dWdowns: 1 },
    ],
    [
      'flip down to up',
      down(),
      up(),
      { dUps: 1, dDowns: -1, dWups: 1, dWdowns: -1 },
    ],
    ['retract up', up(), null, { dUps: -1, dDowns: 0, dWups: -1, dWdowns: 0 }],
    [
      'retract down',
      down(),
      null,
      { dUps: 0, dDowns: -1, dWups: 0, dWdowns: -1 },
    ],
    [
      'retract weight-0 up',
      up(0),
      null,
      { dUps: -1, dDowns: 0, dWups: 0, dWdowns: 0 },
    ],
    [
      'same vote again',
      up(),
      up(),
      { dUps: 0, dDowns: 0, dWups: 0, dWdowns: 0 },
    ],
    [
      'retract nothing',
      null,
      null,
      { dUps: 0, dDowns: 0, dWups: 0, dWdowns: 0 },
    ],
  ])('S25 AS-24: %s', (_name, previous, next, delta) => {
    expect(voteDelta(previous, next)).toEqual(delta);
  });

  it('S25 AS-24: the score moves by 1, then -2, then +1 for vote, flip, retract', () => {
    let counts = EMPTY_COUNTS;
    const score = () => counts.ups - counts.downs;
    counts = applyDelta(counts, voteDelta(null, up()));
    expect(score()).toBe(1);
    counts = applyDelta(counts, voteDelta(up(), down()));
    expect(score()).toBe(-1);
    counts = applyDelta(counts, voteDelta(down(), null));
    expect(score()).toBe(0);
  });

  it('S25 AS-24: for any sequence of votes by any users the derived counts equal the count of final records', () => {
    const action = fc.record({
      user: fc.integer({ min: 0, max: 5 }),
      value: fc.constantFrom<-1 | 0 | 1>(-1, 0, 1),
      weight: fc.constantFrom<0 | 1>(0, 1),
    });
    fc.assert(
      fc.property(fc.array(action, { maxLength: 80 }), (actions) => {
        const records = new Map<number, VoteRecord>();
        let counts = EMPTY_COUNTS;
        for (const { user, value, weight } of actions) {
          const previous = records.get(user) ?? null;
          const next: VoteRecord | null =
            value === 0 ? null : { value, weight };
          counts = applyDelta(counts, voteDelta(previous, next));
          if (next) records.set(user, next);
          else records.delete(user);
        }
        const final = [...records.values()];
        expect(counts).toEqual({
          ups: final.filter((r) => r.value === 1).length,
          downs: final.filter((r) => r.value === -1).length,
          wups: final.filter((r) => r.value === 1 && r.weight === 1).length,
          wdowns: final.filter((r) => r.value === -1 && r.weight === 1).length,
        });
      }),
      { numRuns: 300 },
    );
  });
});

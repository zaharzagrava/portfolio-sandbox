import { voteWeight } from './vote-weight';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const H = 3_600_000;
const M = 60_000;

describe('S25 FR-025 vote weight', () => {
  it.each([
    ['23 h 59 m old', ago(24 * H - M), false, 0],
    ['exactly 24 h old', ago(24 * H), false, 1],
    ['24 h and 1 ms old', ago(24 * H + 1), false, 1],
    ['1 hour old', ago(H), false, 0],
    ['30 days old', ago(30 * 24 * H), false, 1],
    ['created just now', NOW, false, 0],
    ['30 days old but shadow-banned', ago(30 * 24 * H), true, 0],
    ['unresolved account', null, false, 0],
    ['unresolved and shadow-banned', null, true, 0],
    [
      'created in the future (clock skew)',
      new Date(NOW.getTime() + H),
      false,
      0,
    ],
  ] as const)(
    'S25 AS-44: %s weighs %i',
    (_name, createdAt, shadowBanned, weight) => {
      expect(voteWeight({ createdAt, shadowBanned, now: NOW })).toBe(weight);
    },
  );

  it('S25 AS-44: the age threshold is configurable', () => {
    expect(
      voteWeight({
        createdAt: ago(2 * H),
        shadowBanned: false,
        now: NOW,
        minAgeHours: 1,
      }),
    ).toBe(1);
    expect(
      voteWeight({
        createdAt: ago(2 * H),
        shadowBanned: false,
        now: NOW,
        minAgeHours: 3,
      }),
    ).toBe(0);
  });
});

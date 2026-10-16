import {
  durationSeconds,
  liveTransition,
  type LiveStatus,
  type LiveTransition,
} from './live-state';

describe('liveTransition', () => {
  it.each<[LiveStatus, LiveStatus, LiveTransition]>([
    ['SCHEDULED', 'SCHEDULED', 'noop'],
    ['SCHEDULED', 'LIVE', 'move'],
    ['SCHEDULED', 'ENDED', 'move'],
    ['LIVE', 'SCHEDULED', 'illegal'],
    ['LIVE', 'LIVE', 'noop'],
    ['LIVE', 'ENDED', 'move'],
    ['ENDED', 'SCHEDULED', 'illegal'],
    ['ENDED', 'LIVE', 'illegal'],
    ['ENDED', 'ENDED', 'noop'],
  ])('S23 AS-34: %s → %s is %s', (from, to, expected) => {
    expect(liveTransition(from, to)).toBe(expected);
  });
});

describe('durationSeconds', () => {
  it('S23 AS-34: counts whole seconds between start and end', () => {
    expect(
      durationSeconds(
        new Date('2026-10-05T10:00:00.000Z'),
        new Date('2026-10-05T10:01:30.900Z'),
      ),
    ).toBe(90);
  });

  it('S23 AS-34: a stream cancelled before it started ran 0 seconds', () => {
    expect(durationSeconds(null, new Date())).toBe(0);
  });
});

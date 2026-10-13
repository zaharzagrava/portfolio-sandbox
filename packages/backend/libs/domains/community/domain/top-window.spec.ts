import { isInTopWindow, topWindowStart } from './top-window';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const DAY = 86_400_000;

describe('S25 FR-034 top windows', () => {
  it.each([
    ['day', 1],
    ['week', 7],
    ['month', 30],
    ['year', 365],
  ] as const)(
    'S25 AS-36: the %s window starts %i days before now',
    (window, days) => {
      expect(topWindowStart(window, NOW)?.getTime()).toBe(
        NOW.getTime() - days * DAY,
      );
    },
  );

  it('S25 AS-36: the all window has no start', () => {
    expect(topWindowStart('all', NOW)).toBeNull();
  });

  it.each([
    ['week', 60 * 60 * 1000, true], // 1 hour ago
    ['week', 6 * DAY, true],
    ['week', 7 * DAY, true], // exactly one window ago: inclusive
    ['week', 7 * DAY + 1, false],
    ['week', 8 * DAY, false],
    ['day', DAY, true],
    ['day', DAY + 1, false],
    ['month', 40 * DAY, false],
    ['year', 365 * DAY, true],
    ['year', 400 * DAY, false],
    ['all', 4000 * DAY, true],
  ] as const)(
    'S25 AS-36: in %s a post %i ms old is included: %s',
    (window, ageMs, included) => {
      expect(isInTopWindow(window, new Date(NOW.getTime() - ageMs), NOW)).toBe(
        included,
      );
    },
  );

  it('S25 AS-36: a post from the future is included', () => {
    expect(isInTopWindow('day', new Date(NOW.getTime() + 1000), NOW)).toBe(
      true,
    );
  });
});

import {
  expiryOf,
  initialDeadlines,
  shouldTouch,
  touchedIdleExp,
  ttlMs,
  type Lifetime,
} from './session-lifetime';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const cfg = { idleMs: DAY, absoluteMs: 30 * DAY, touchIntervalMs: 60_000 };
const t0 = 1_700_000_000_000;

describe('S48 AS-52 session lifetime (unit)', () => {
  it('S48 AS-52: a new session is idle for 24 h and absolute for 30 d', () => {
    expect(initialDeadlines(t0, cfg)).toEqual({
      idleExp: t0 + DAY,
      absoluteExp: t0 + 30 * DAY,
    });
  });

  it('S48 AS-52: the identity session caps the absolute lifetime', () => {
    const d = initialDeadlines(t0, cfg, t0 + 2 * DAY);
    expect(d.absoluteExp).toBe(t0 + 2 * DAY);
    expect(d.idleExp).toBe(t0 + DAY);
    expect(initialDeadlines(t0, cfg, t0 + 90 * DAY).absoluteExp).toBe(
      t0 + 30 * DAY,
    );
  });

  it.each<[string, Lifetime, number, 'active' | 'idle' | 'absolute']>([
    ['fresh', { idleExp: t0 + DAY, absoluteExp: t0 + 30 * DAY }, t0, 'active'],
    [
      'just before idle',
      { idleExp: t0 + DAY, absoluteExp: t0 + 30 * DAY },
      t0 + DAY - 1,
      'active',
    ],
    [
      'at idle deadline',
      { idleExp: t0 + DAY, absoluteExp: t0 + 30 * DAY },
      t0 + DAY,
      'idle',
    ],
    [
      'past idle',
      { idleExp: t0 + DAY, absoluteExp: t0 + 30 * DAY },
      t0 + DAY + 1,
      'idle',
    ],
    [
      'at absolute',
      { idleExp: t0 + 31 * DAY, absoluteExp: t0 + 30 * DAY },
      t0 + 30 * DAY,
      'absolute',
    ],
    [
      'idle extended past absolute',
      { idleExp: t0 + 40 * DAY, absoluteExp: t0 + 30 * DAY },
      t0 + 31 * DAY,
      'absolute',
    ],
  ])('S48 AS-52: %s → %s', (_name, life, now, expected) => {
    expect(expiryOf(life, now)).toBe(expected);
  });

  it('S48 AS-52: the store TTL is the remaining lifetime of whichever deadline comes first', () => {
    expect(
      ttlMs({ idleExp: t0 + DAY, absoluteExp: t0 + 30 * DAY }, t0 + HOUR),
    ).toBe(23 * HOUR);
    expect(
      ttlMs({ idleExp: t0 + 40 * DAY, absoluteExp: t0 + 30 * DAY }, t0),
    ).toBe(30 * DAY);
    expect(ttlMs({ idleExp: t0, absoluteExp: t0 }, t0 + 5)).toBe(0);
  });

  it.each([
    [t0, t0 + 59_999, false],
    [t0, t0 + 60_000, true],
    [t0, t0 + 3_600_000, true],
    [t0, t0, false],
  ])(
    'S48 AS-52: last write %s, now %s → touch %s (at most once a minute)',
    (last, now, expected) => {
      expect(shouldTouch(last, now, cfg.touchIntervalMs)).toBe(expected);
    },
  );

  it('S48 AS-52: a touch extends the idle deadline but never past the absolute one', () => {
    const life = { idleExp: t0 + DAY, absoluteExp: t0 + 30 * DAY };
    expect(touchedIdleExp(life, t0 + 2 * HOUR, cfg)).toBe(t0 + 2 * HOUR + DAY);
    expect(touchedIdleExp(life, t0 + 29.5 * DAY, cfg)).toBe(t0 + 30 * DAY);
  });
});

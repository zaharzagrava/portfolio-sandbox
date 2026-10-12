import {
  decideRotation,
  DEFAULT_ROTATION_CONFIG,
  type RotationKey,
} from './key-rotation-policy';

const NOW = new Date('2026-10-12T12:00:00Z');
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const active = (age: number, kid = 'A'): RotationKey => ({
  kid,
  status: 'ACTIVE',
  createdAt: ago(age + D),
  activatedAt: ago(age),
  retiredAt: null,
});
const next = (age: number, kid = 'N'): RotationKey => ({
  kid,
  status: 'NEXT',
  createdAt: ago(age),
  activatedAt: null,
  retiredAt: null,
});
const retired = (age: number, kid = 'R'): RotationKey => ({
  kid,
  status: 'RETIRED',
  createdAt: ago(age + 8 * D),
  activatedAt: ago(age + 8 * D),
  retiredAt: ago(age),
});

describe('Key rotation decisions', () => {
  const none: never[] = [];
  const cases: Array<[string, RotationKey[], unknown[]]> = [
    ['no keys', [], [{ type: 'create', status: 'ACTIVE' }]],
    ['ACTIVE only', [active(1 * H)], [{ type: 'create', status: 'NEXT' }]],
    ['ACTIVE 6 d 23 h with NEXT 2 d', [active(7 * D - H), next(2 * D)], none],
    [
      'ACTIVE 7 d with NEXT 23 h 59 m',
      [active(7 * D), next(24 * H - 60_000)],
      none,
    ],
    [
      'ACTIVE 7 d with NEXT 24 h',
      [active(7 * D), next(24 * H)],
      [{ type: 'promote', retire: 'A', activate: 'N' }],
    ],
    [
      'two NEXT keys, young ACTIVE (the newest is the candidate, nothing to do)',
      [active(1 * D), next(30 * H, 'N1'), next(2 * H, 'N2')],
      none,
    ],
    [
      'two NEXT keys, due: the newest published one is promoted',
      [active(8 * D), next(30 * H, 'N1'), next(26 * H, 'N2')],
      [{ type: 'promote', retire: 'A', activate: 'N2' }],
    ],
    [
      'RETIRED 23 h 59 m',
      [active(1 * H), next(1 * H), retired(23 * H + 59 * 60_000)],
      none,
    ],
    [
      'RETIRED 24 h 1 m',
      [active(1 * H), next(1 * H), retired(24 * H + 60_000)],
      [{ type: 'purge', kid: 'R' }],
    ],
    [
      'NEXT only (no ACTIVE): an ACTIVE is created, the NEXT is left alone',
      [next(2 * D)],
      [{ type: 'create', status: 'ACTIVE' }],
    ],
  ];

  it.each(cases)('S01 AS-62: %s', (_name, keys, expected) => {
    expect(decideRotation(keys, NOW, DEFAULT_ROTATION_CONFIG)).toEqual(
      expected,
    );
  });

  it('S01 AS-62: a due promotion and an expired RETIRED key are both reported, purge last', () => {
    expect(
      decideRotation(
        [active(8 * D), next(2 * D), retired(2 * D, 'old')],
        NOW,
        DEFAULT_ROTATION_CONFIG,
      ),
    ).toEqual([
      { type: 'promote', retire: 'A', activate: 'N' },
      { type: 'purge', kid: 'old' },
    ]);
  });

  it('S01 AS-62: the thresholds are 7 days, 24 hours and 24 hours', () => {
    expect(DEFAULT_ROTATION_CONFIG).toEqual({
      activeMinAgeMs: 7 * D,
      nextPublishedMinMs: 24 * H,
      retiredKeepMs: 24 * H,
    });
  });
});

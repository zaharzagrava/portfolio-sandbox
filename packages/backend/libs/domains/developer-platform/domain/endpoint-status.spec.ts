import {
  EndpointAction,
  EndpointStatus,
  FAILURE_WINDOW_MS,
  isFailureWindowExpired,
  transitionEndpoint,
} from './endpoint-status';

describe('webhook endpoint status (pure)', () => {
  type Row = [EndpointStatus, EndpointAction, unknown];
  const table: Row[] = [
    [
      'enabled',
      { type: 'disable', reason: 'manual' },
      { ok: true, status: 'disabled', disabledReason: 'manual' },
    ],
    [
      'enabled',
      { type: 'disable', reason: 'auto_failing' },
      { ok: true, status: 'disabled', disabledReason: 'auto_failing' },
    ],
    [
      'disabled',
      { type: 'enable' },
      { ok: true, status: 'enabled', disabledReason: null },
    ],
    // every other pair is illegal
    ['enabled', { type: 'enable' }, { ok: false, from: 'enabled' }],
    [
      'disabled',
      { type: 'disable', reason: 'manual' },
      { ok: false, from: 'disabled' },
    ],
    [
      'disabled',
      { type: 'disable', reason: 'auto_failing' },
      { ok: false, from: 'disabled' },
    ],
  ];

  it.each(table)('S43 AS-08: %s --%j--> %j', (from, action, expected) => {
    expect(transitionEndpoint(from, action)).toEqual(expected);
  });

  it('S43 AS-08: the table is complete: every status times every action is covered', () => {
    const statuses: EndpointStatus[] = ['enabled', 'disabled'];
    const actions: EndpointAction[] = [
      { type: 'enable' },
      { type: 'disable', reason: 'manual' },
      { type: 'disable', reason: 'auto_failing' },
    ];
    expect(table).toHaveLength(statuses.length * actions.length);
    for (const s of statuses)
      for (const a of actions)
        expect(() => transitionEndpoint(s, a)).not.toThrow();
  });

  it('S43 AS-08: an unknown status or action is a programmer error (assertNever)', () => {
    expect(() =>
      transitionEndpoint('paused' as EndpointStatus, { type: 'enable' }),
    ).toThrow(/Unexpected value/);
    expect(() =>
      transitionEndpoint('enabled', {
        type: 'pause',
      } as unknown as EndpointAction),
    ).toThrow(/Unexpected value/);
  });

  describe('failure window (AS-55)', () => {
    const failingSince = new Date('2026-10-01T12:00:00.000Z');
    const at = (offsetMs: number) =>
      new Date(failingSince.getTime() + FAILURE_WINDOW_MS + offsetMs);

    it('S43 AS-55: the window is three days', () => {
      expect(FAILURE_WINDOW_MS).toBe(3 * 24 * 60 * 60 * 1000);
    });

    it.each<[string, number, boolean]>([
      ['3 d - 1 s: still enabled', -1000, false],
      ['3 d - 1 ms: still enabled', -1, false],
      ['exactly 3 d: disabled (inclusive)', 0, true],
      ['3 d + 1 s: disabled', 1000, true],
    ])('S43 AS-55: %s', (_name, offsetMs, expected) => {
      expect(isFailureWindowExpired(failingSince, at(offsetMs))).toBe(expected);
    });

    it('S43 AS-55: no failure window means never expired', () => {
      expect(isFailureWindowExpired(null, at(10_000_000))).toBe(false);
    });

    it('S43 AS-55: the window length is a parameter (configuration)', () => {
      expect(
        isFailureWindowExpired(
          failingSince,
          new Date(failingSince.getTime() + 1000),
          1000,
        ),
      ).toBe(true);
    });
  });
});

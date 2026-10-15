import {
  BreakerState,
  BreakerStatus,
  breakerStatus,
  CLOSED_BREAKER,
  decideBreaker,
  describeBreakerStatus,
  onBreakerFailure,
  onBreakerSuccess,
  openDurationMs,
} from './breaker';

const MIN = 60_000;
const NOW = 1_800_000_000_000;

const state = (over: Partial<BreakerState> = {}): BreakerState => ({
  ...CLOSED_BREAKER,
  ...over,
});

describe('webhook circuit breaker (pure state machine)', () => {
  it.each<[number, number]>([
    [0, 0],
    [4, 0],
    [5, 1],
    [6, 2],
    [7, 4],
    [8, 8],
    [9, 16],
    [10, 30],
    [11, 30],
    [40, 30],
  ])(
    'S43 AS-48: after %i consecutive failures the breaker stays open %i minutes',
    (failures, minutes) => {
      expect(openDurationMs(failures)).toBe(minutes * MIN);
    },
  );

  it('S43 AS-48: closed -> open at the 5th failure exactly, not before', () => {
    let s = CLOSED_BREAKER;
    for (let i = 1; i <= 4; i++) {
      s = onBreakerFailure(s, NOW);
      expect(s.openUntil).toBeNull();
      expect(breakerStatus(s, NOW)).toBe('closed');
    }
    s = onBreakerFailure(s, NOW);
    expect(s).toEqual({
      consecutiveFailures: 5,
      openUntil: NOW + MIN,
      probeInFlight: false,
    });
    expect(breakerStatus(s, NOW)).toBe('open');
  });

  it.each<[string, BreakerState, number, string]>([
    ['no failures', state(), NOW, 'closed'],
    ['four failures', state({ consecutiveFailures: 4 }), NOW, 'closed'],
    [
      'open, before the close time',
      state({ consecutiveFailures: 5, openUntil: NOW + 1 }),
      NOW,
      'open',
    ],
    [
      'open at the close time: half-open',
      state({ consecutiveFailures: 5, openUntil: NOW }),
      NOW,
      'half-open',
    ],
    [
      'open long ago: half-open',
      state({ consecutiveFailures: 7, openUntil: NOW - 5 * MIN }),
      NOW,
      'half-open',
    ],
    [
      'half-open with a probe in flight',
      state({
        consecutiveFailures: 5,
        openUntil: NOW - 1,
        probeInFlight: true,
      }),
      NOW,
      'half-open',
    ],
  ])('S43 AS-48: status of %s is %s', (_n, s, now, expected) => {
    expect(breakerStatus(s, now)).toBe(expected);
  });

  describe('decision before an attempt', () => {
    it('S43 AS-48: closed sends', () => {
      expect(decideBreaker(state(), NOW)).toEqual({ action: 'send' });
      expect(decideBreaker(state({ consecutiveFailures: 4 }), NOW)).toEqual({
        action: 'send',
      });
    });

    it('S43 AS-48: open sends nothing and names the time it closes', () => {
      expect(
        decideBreaker(
          state({ consecutiveFailures: 5, openUntil: NOW + 30_000 }),
          NOW,
        ),
      ).toEqual({ action: 'skip', until: NOW + 30_000 });
    });

    it('S43 AS-48: half-open admits exactly one probe', () => {
      const open = state({ consecutiveFailures: 5, openUntil: NOW });
      expect(decideBreaker(open, NOW)).toEqual({ action: 'probe' });
      // once the probe is in flight (the store records it), the next delivery is held back
      const decision = decideBreaker({ ...open, probeInFlight: true }, NOW);
      expect(decision.action).toBe('skip');
      expect((decision as { until: number }).until).toBeGreaterThan(NOW);
    });
  });

  describe('results', () => {
    it('S43 AS-48: a failed probe re-opens for twice as long, up to 30 minutes', () => {
      let s = state({
        consecutiveFailures: 5,
        openUntil: NOW,
        probeInFlight: true,
      });
      const durations: number[] = [];
      let now = NOW;
      for (let i = 0; i < 7; i++) {
        s = onBreakerFailure(s, now);
        expect(s.probeInFlight).toBe(false);
        durations.push((s.openUntil as number) - now);
        now = s.openUntil as number; // half-open again
      }
      expect(durations.map((d) => d / MIN)).toEqual([2, 4, 8, 16, 30, 30, 30]);
    });

    it('S43 AS-48: any success resets the count and closes the breaker', () => {
      for (const s of [
        state({ consecutiveFailures: 3 }),
        state({
          consecutiveFailures: 9,
          openUntil: NOW + MIN,
          probeInFlight: true,
        }),
      ])
        expect(onBreakerSuccess(s)).toEqual(CLOSED_BREAKER);
    });

    it('S43 AS-48: failures before the threshold only count', () => {
      expect(onBreakerFailure(state({ consecutiveFailures: 2 }), NOW)).toEqual({
        consecutiveFailures: 3,
        openUntil: null,
        probeInFlight: false,
      });
    });
  });

  it('S43 AS-48: every status is matched with assertNever', () => {
    const statuses: BreakerStatus[] = ['closed', 'open', 'half-open'];
    for (const s of statuses)
      expect(describeBreakerStatus(s)).toEqual(expect.any(String));
    expect(() => describeBreakerStatus('broken' as BreakerStatus)).toThrow(
      /Unexpected value/,
    );
  });

  it('S43 AS-48: the thresholds are configuration', () => {
    const config = { failureThreshold: 2, baseOpenMs: 1000, maxOpenMs: 3000 };
    expect(openDurationMs(1, config)).toBe(0);
    expect(openDurationMs(2, config)).toBe(1000);
    expect(openDurationMs(3, config)).toBe(2000);
    expect(openDurationMs(4, config)).toBe(3000);
    expect(openDurationMs(9, config)).toBe(3000);
  });
});

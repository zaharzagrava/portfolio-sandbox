import {
  BREAKER_FAILURES,
  BREAKER_OPEN_MS,
  breakerPhase,
  initialBreaker,
  recordFailure,
  recordSuccess,
  tryAcquire,
  type BreakerState,
} from './breaker';

const t0 = new Date('2026-10-15T12:00:00Z');
const at = (ms: number) => new Date(t0.getTime() + ms);

const failTimes = (
  n: number,
  start: BreakerState = initialBreaker(),
  now = t0,
) => {
  let state = start;
  let last = recordFailure(state, now);
  state = last.state;
  for (let i = 1; i < n; i++) {
    last = recordFailure(state, now);
    state = last.state;
  }
  return { state, last };
};

describe('S08 circuit breaker', () => {
  it('S08 AS-59: constants - 5 failures, open 5 minutes', () => {
    expect([BREAKER_FAILURES, BREAKER_OPEN_MS]).toEqual([5, 300_000]);
  });

  it('S08 AS-59: closed breaker lets calls through', () => {
    const s = initialBreaker();
    expect(breakerPhase(s, t0)).toBe('closed');
    expect(tryAcquire(s, t0).decision).toBe('allow');
  });

  it('S08 AS-59: four failures keep it closed, the fifth opens it for 5 minutes and raises one attention event', () => {
    const four = failTimes(4);
    expect(breakerPhase(four.state, t0)).toBe('closed');
    expect(four.last.raiseAttention).toBe(false);
    const five = recordFailure(four.state, t0);
    expect(five.opened).toBe(true);
    expect(five.raiseAttention).toBe(true);
    expect(five.state.openUntil).toEqual(at(300_000));
    expect(breakerPhase(five.state, at(299_999))).toBe('open');
    expect(tryAcquire(five.state, at(299_999)).decision).toBe('blocked');
  });

  it('S08 AS-59: a success resets the consecutive failure counter', () => {
    const reset = recordSuccess(failTimes(4).state);
    expect(failTimes(4, reset).state.openUntil).toBeNull();
  });

  it('S08 AS-59: after 5 minutes exactly one probe is allowed', () => {
    const open = failTimes(5).state;
    expect(breakerPhase(open, at(300_000))).toBe('half_open');
    const first = tryAcquire(open, at(300_000));
    expect(first.decision).toBe('probe');
    expect(tryAcquire(first.state, at(300_001)).decision).toBe('blocked');
    expect(tryAcquire(first.state, at(300_002)).decision).toBe('blocked');
  });

  it('S08 AS-59: probe success closes the breaker and re-arms the attention event', () => {
    const open = failTimes(5).state;
    const probe = tryAcquire(open, at(300_000));
    const closed = recordSuccess(probe.state);
    expect(breakerPhase(closed, at(300_001))).toBe('closed');
    expect(tryAcquire(closed, at(300_001)).decision).toBe('allow');
    expect(failTimes(5, closed, at(400_000)).last.raiseAttention).toBe(true);
  });

  it('S08 AS-59: probe failure reopens for another 5 minutes without a second attention event', () => {
    const open = failTimes(5).state;
    const probe = tryAcquire(open, at(300_000));
    const failed = recordFailure(probe.state, at(300_500));
    expect(failed.opened).toBe(true);
    expect(failed.raiseAttention).toBe(false);
    expect(failed.state.openUntil).toEqual(at(600_500));
    expect(tryAcquire(failed.state, at(600_499)).decision).toBe('blocked');
    expect(tryAcquire(failed.state, at(600_500)).decision).toBe('probe');
  });

  it('S08 AS-59: further failures while open do not extend the window or repeat the event', () => {
    const open = failTimes(5).state;
    const again = recordFailure(open, at(1000));
    expect(again.raiseAttention).toBe(false);
    expect(again.state.openUntil).toEqual(open.openUntil);
  });
});

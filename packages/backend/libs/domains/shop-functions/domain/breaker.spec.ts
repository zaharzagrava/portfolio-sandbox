import {
  CLOSED_BREAKER,
  admit,
  breakerView,
  recordFailure,
  recordSuccess,
  type Breaker,
} from './breaker';

const T = 1_000_000;
const failN = (b: Breaker, n: number, at: number, step = 1000): Breaker => {
  let cur = b;
  for (let i = 0; i < n; i++)
    cur = recordFailure(cur, at + i * step, 'timeout');
  return cur;
};

describe('S45 AS-29: circuit breaker transitions', () => {
  it('stays CLOSED below five failures and admits calls', () => {
    const b = failN(CLOSED_BREAKER, 4, T);
    expect(breakerView(b, T + 5000).state).toBe('CLOSED');
    expect(admit(b, T + 5000).decision).toBe('ADMIT');
  });

  it('opens at the fifth failure within 60 s for 300 s and skips calls', () => {
    const b = failN(CLOSED_BREAKER, 5, T);
    const view = breakerView(b, T + 4000);
    expect(view).toMatchObject({
      state: 'OPEN',
      openUntil: T + 4000 + 300_000,
      lastFailure: { reason: 'timeout', at: T + 4000 },
    });
    expect(admit(b, T + 10_000).decision).toBe('SKIP');
  });

  it('becomes HALF_OPEN when openUntil passes and admits exactly one trial', () => {
    const b = failN(CLOSED_BREAKER, 5, T);
    const later = T + 4000 + 300_000;
    expect(breakerView(b, later - 1).state).toBe('OPEN');
    expect(breakerView(b, later).state).toBe('HALF_OPEN');
    const first = admit(b, later);
    expect(first.decision).toBe('TRIAL');
    expect(admit(first.next, later + 1).decision).toBe('SKIP');
  });

  it('a successful trial closes, a failed trial opens again for 300 s', () => {
    const b = failN(CLOSED_BREAKER, 5, T);
    const later = T + 4000 + 300_000;
    const trial = admit(b, later).next;
    expect(breakerView(recordSuccess(trial, later + 2), later + 3).state).toBe(
      'CLOSED',
    );
    const again = recordFailure(trial, later + 2, 'runtime');
    expect(breakerView(again, later + 3)).toMatchObject({
      state: 'OPEN',
      openUntil: later + 2 + 300_000,
    });
  });

  it('four failures, a success and a 61 s pause never open it', () => {
    let b = failN(CLOSED_BREAKER, 4, T);
    b = recordSuccess(b, T + 5000);
    b = recordFailure(b, T + 5000 + 61_000, 'memory');
    expect(breakerView(b, T + 70_000).state).toBe('CLOSED');
  });

  it('failures outside the 60 s window start a new count', () => {
    let b = failN(CLOSED_BREAKER, 4, T);
    b = failN(b, 4, T + 61_000);
    expect(breakerView(b, T + 70_000).state).toBe('CLOSED');
  });
});

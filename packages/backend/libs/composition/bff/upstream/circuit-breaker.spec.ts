import { UpstreamBreaker } from './circuit-breaker';

const config = { failures: 5, windowMs: 10_000, openMs: 10_000 };

function setup() {
  let t = 1_000_000;
  const breaker = new UpstreamBreaker(config, () => t);
  return {
    breaker,
    advance: (ms: number) => (t += ms),
    fail: (n: number, gapMs = 0) => {
      for (let i = 0; i < n; i++) {
        breaker.tryAcquire();
        breaker.onFailure();
        t += gapMs;
      }
    },
  };
}

describe('S48 AS-17 upstream breaker (unit)', () => {
  it('S48 AS-17: stays closed below five consecutive failures', () => {
    const s = setup();
    s.fail(4);
    expect(s.breaker.state).toBe('closed');
    expect(s.breaker.tryAcquire()).toBe('allow');
  });

  it('S48 AS-17: five consecutive failures within the window open it and calls are rejected', () => {
    const s = setup();
    s.fail(5, 1_000);
    expect(s.breaker.state).toBe('open');
    expect(s.breaker.tryAcquire()).toBe('reject');
    s.advance(8_000); // 9 s since it opened (the loop advanced 1 s after the fifth failure)
    expect(s.breaker.tryAcquire()).toBe('reject');
  });

  it('S48 AS-17: a success resets the consecutive count', () => {
    const s = setup();
    s.fail(4);
    s.breaker.tryAcquire();
    s.breaker.onSuccess();
    s.fail(4);
    expect(s.breaker.state).toBe('closed');
  });

  it('S48 AS-17: failures spread over more than the window do not open it', () => {
    const s = setup();
    s.fail(5, 3_000); // 0, 3, 6, 9, 12 s: only four in any 10 s span
    expect(s.breaker.state).toBe('closed');
  });

  it('S48 AS-17: after the open period exactly one probe is allowed, the others are rejected', () => {
    const s = setup();
    s.fail(5);
    s.advance(10_000);
    expect(s.breaker.tryAcquire()).toBe('probe');
    expect(s.breaker.state).toBe('half-open');
    expect(s.breaker.tryAcquire()).toBe('reject');
    expect(s.breaker.tryAcquire()).toBe('reject');
  });

  it('S48 AS-17: a successful probe closes the breaker', () => {
    const s = setup();
    s.fail(5);
    s.advance(10_000);
    expect(s.breaker.tryAcquire()).toBe('probe');
    s.breaker.onSuccess();
    expect(s.breaker.state).toBe('closed');
    expect(s.breaker.tryAcquire()).toBe('allow');
    expect(s.breaker.tryAcquire()).toBe('allow');
  });

  it('S48 AS-17: a failed probe re-opens it for another open period', () => {
    const s = setup();
    s.fail(5);
    s.advance(10_000);
    expect(s.breaker.tryAcquire()).toBe('probe');
    s.breaker.onFailure();
    expect(s.breaker.state).toBe('open');
    s.advance(9_999);
    expect(s.breaker.tryAcquire()).toBe('reject');
    s.advance(1);
    expect(s.breaker.tryAcquire()).toBe('probe');
  });

  it('S48 AS-17: a released probe (the call was cancelled) lets the next caller probe', () => {
    const s = setup();
    s.fail(5);
    s.advance(10_000);
    expect(s.breaker.tryAcquire()).toBe('probe');
    s.breaker.onAbandoned();
    expect(s.breaker.tryAcquire()).toBe('probe');
  });

  it('S48 AS-17: breakers are independent instances', () => {
    const a = setup();
    const b = setup();
    a.fail(5);
    expect(a.breaker.state).toBe('open');
    expect(b.breaker.state).toBe('closed');
  });
});

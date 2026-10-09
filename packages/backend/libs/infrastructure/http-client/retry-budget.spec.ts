import { FakeClock } from '@app/common/core/clock';
import { RetryBudget } from './retry-budget';

const build = () => {
  const clock = new FakeClock(new Date('2026-03-01T10:00:00.000Z'));
  return { clock, budget: new RetryBudget({ clock }) };
};

const retriesGranted = (
  budget: RetryBudget,
  host: string,
  attempts: number,
) => {
  let granted = 0;
  for (let i = 0; i < attempts; i++)
    if (budget.tryAcquireRetry(host)) granted++;
  return granted;
};

describe('RetryBudget (U-RETB)', () => {
  it.each([
    [0, 10],
    [50, 10],
    [100, 10],
    [200, 20],
    [1_000, 100],
  ])(
    'S54 AS-90: after %d requests to a host at most %d retries are allowed (10 %%, floor 10)',
    (requests, allowed) => {
      const { budget } = build();
      for (let i = 0; i < requests; i++) budget.recordRequest('a.example');
      expect(retriesGranted(budget, 'a.example', allowed + 50)).toBe(allowed);
    },
  );

  it('S54 AS-90: hosts do not share a budget', () => {
    const { budget } = build();
    for (let i = 0; i < 100; i++) budget.recordRequest('a.example');
    expect(retriesGranted(budget, 'a.example', 50)).toBe(10);
    expect(retriesGranted(budget, 'b.example', 50)).toBe(10);
  });

  it('S54 AS-90: the window is 10 s on the injected clock; a new window starts fresh', () => {
    const { budget, clock } = build();
    for (let i = 0; i < 100; i++) budget.recordRequest('a.example');
    expect(retriesGranted(budget, 'a.example', 50)).toBe(10);
    clock.advance(9_999);
    expect(budget.tryAcquireRetry('a.example')).toBe(false);
    clock.advance(1);
    expect(retriesGranted(budget, 'a.example', 50)).toBe(10);
  });

  it('S54 AS-90: exhaustion is reported through the callback with the host', () => {
    const exhausted: string[] = [];
    const clock = new FakeClock();
    const budget = new RetryBudget({
      clock,
      onExhausted: (host) => exhausted.push(host),
    });
    retriesGranted(budget, 'a.example', 11);
    expect(exhausted).toEqual(['a.example']);
  });
});

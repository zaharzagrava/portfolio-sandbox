import {
  DEFAULT_RETRY_SCHEDULE,
  MAX_ATTEMPTS,
  nextRetry,
  RetryDecision,
} from './retry-schedule';

const MIN = 60_000;
const H = 60 * MIN;

describe('webhook retry schedule (pure)', () => {
  const retry = (attempt: number, random: number, retryAfterSec?: number) =>
    nextRetry({ attempt, random, retryAfterSec });

  it('S43 AS-41: eleven attempts in total: three in the lane, then eight delayed retries', () => {
    expect(MAX_ATTEMPTS).toBe(11);
    expect(DEFAULT_RETRY_SCHEDULE.laneAttempts).toBe(3);
    expect(DEFAULT_RETRY_SCHEDULE.delaysMs).toEqual(
      [5, 30, 120, 300, 600, 1440, 1440, 1440].map((m) => m * MIN),
    );
  });

  it.each<[number, number]>([
    [1, 30_000],
    [2, 30_000],
  ])(
    'S43 AS-41: after failed attempt %i the next attempt stays in the ordered lane after 30 s, without jitter',
    (attempt, delayMs) => {
      for (const random of [0, 0.5, 1])
        expect(retry(attempt, random)).toEqual({
          kind: 'retry',
          lane: 'ordered',
          delayMs,
        });
    },
  );

  const centre: [number, number][] = [
    [3, 5 * MIN],
    [4, 30 * MIN],
    [5, 2 * H],
    [6, 5 * H],
    [7, 10 * H],
    [8, 24 * H],
    [9, 24 * H],
    [10, 24 * H],
  ];

  it.each(centre)(
    'S43 AS-41: after failed attempt %i the delay is %i ms +-20 percent (random 0 and 1)',
    (attempt, base) => {
      const lowest = retry(attempt, 0) as Extract<
        RetryDecision,
        { kind: 'retry' }
      >;
      const highest = retry(attempt, 1) as Extract<
        RetryDecision,
        { kind: 'retry' }
      >;
      expect(lowest).toMatchObject({ kind: 'retry', lane: 'delayed' });
      expect(lowest.delayMs).toBe(Math.round(base * 0.8));
      // never above 24 h, even where +20 percent would exceed it
      expect(highest.delayMs).toBe(Math.min(Math.round(base * 1.2), 24 * H));
      const middle = retry(attempt, 0.5) as Extract<
        RetryDecision,
        { kind: 'retry' }
      >;
      expect(middle.delayMs).toBe(base);
    },
  );

  it('S43 AS-41: the sum of the central delays is 3 days 17 hours 35 minutes', () => {
    const sum = centre.reduce(
      (total, [attempt]) =>
        total + (retry(attempt, 0.5) as { delayMs: number }).delayMs,
      0,
    );
    // The 24 h steps are capped at 24 h, which equals their centre.
    expect(sum).toBe((3 * 24 + 17) * H + 35 * MIN);
  });

  it('S43 AS-41: the eleventh failed attempt is exhausted', () => {
    expect(retry(11, 0.5)).toEqual({ kind: 'exhausted' });
    expect(retry(12, 0.5)).toEqual({ kind: 'exhausted' });
    expect(retry(10, 0.5)).toMatchObject({ kind: 'retry' });
  });

  it.each<[string, number, number, number | undefined, number]>([
    ['Retry-After below the delay changes nothing', 3, 0.5, 60, 5 * MIN],
    ['Retry-After of 2 h stretches a 5 min delay', 3, 0.5, 7200, 2 * H],
    ['Retry-After equal to the delay', 3, 0.5, 300, 5 * MIN],
    ['Retry-After above 24 h is capped at 24 h', 4, 0.5, 90_000, 24 * H],
    ['Retry-After stretches the jittered minimum', 3, 0, 600, 10 * MIN],
  ])('S43 AS-41: %s', (_name, attempt, random, retryAfterSec, expected) => {
    expect(retry(attempt, random, retryAfterSec)).toMatchObject({
      kind: 'retry',
      delayMs: expected,
    });
  });

  it('S43 AS-41: a Retry-After longer than the lane delay moves a lane attempt out of the lane', () => {
    expect(retry(1, 0.5, 7200)).toEqual({
      kind: 'retry',
      lane: 'delayed',
      delayMs: 2 * H,
    });
    expect(retry(1, 0.5, 10)).toEqual({
      kind: 'retry',
      lane: 'ordered',
      delayMs: 30_000,
    });
  });

  it('S43 AS-41: a negative, zero or non-finite Retry-After is ignored', () => {
    for (const bad of [-5, 0, Number.NaN, Number.POSITIVE_INFINITY])
      expect(retry(3, 0.5, bad)).toMatchObject({ delayMs: 5 * MIN });
  });

  it('S43 AS-41: a random value outside 0..1 is clamped', () => {
    expect(retry(3, -3)).toEqual(retry(3, 0));
    expect(retry(3, 7)).toEqual(retry(3, 1));
  });

  it('S43 AS-41: an attempt number below 1 is a programmer error', () => {
    expect(() => retry(0, 0.5)).toThrow();
  });
});

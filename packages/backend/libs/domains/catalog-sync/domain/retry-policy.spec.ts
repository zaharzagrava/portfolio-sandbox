import fc from 'fast-check';
import {
  BASE_DELAY_MS,
  CAP_DELAY_MS,
  MAX_ATTEMPTS,
  classifyFailure,
  retryDelayMs,
  shouldRetry,
  type CallFailure,
} from './retry-policy';

const http = (status: number): CallFailure => ({ kind: 'http', status });
const timeout: CallFailure = { kind: 'timeout' };
const network: CallFailure = { kind: 'network' };

describe('S08 retry policy', () => {
  it('S08 AS-57: constants - 3 attempts, base 500 ms, cap 8 s', () => {
    expect([MAX_ATTEMPTS, BASE_DELAY_MS, CAP_DELAY_MS]).toEqual([3, 500, 8000]);
  });

  it.each([
    [http(500), 'transient'],
    [http(502), 'transient'],
    [http(503), 'transient'],
    [http(504), 'transient'],
    [timeout, 'transient'],
    [network, 'transient'],
    [http(429), 'rate_limited'],
    [http(401), 'auth'],
    [http(403), 'forbidden'],
    [http(404), 'gone'],
    [http(400), 'permanent'],
    [http(422), 'permanent'],
    [http(409), 'permanent'],
  ])('S08 AS-57: classify %j -> %s', (failure, klass) => {
    expect(classifyFailure(failure)).toBe(klass);
  });

  it.each([
    [http(503), true],
    [http(429), true],
    [timeout, true],
    [network, true],
    [http(400), false],
    [http(401), false],
    [http(403), false],
    [http(404), false],
    [http(422), false],
  ])(
    'S08 AS-57: idempotent call, failure %j retryable=%s on attempt 1',
    (failure, expected) => {
      expect(shouldRetry({ failure, attempt: 1, idempotent: true })).toBe(
        expected,
      );
    },
  );

  it('S08 AS-57: non-idempotent operations (webhook registration) are never retried, even on timeout', () => {
    expect(
      shouldRetry({ failure: timeout, attempt: 1, idempotent: false }),
    ).toBe(false);
    expect(
      shouldRetry({ failure: http(503), attempt: 1, idempotent: false }),
    ).toBe(false);
  });

  it('S08 AS-57: at most 3 attempts in any call path', () => {
    const f = http(503);
    expect(shouldRetry({ failure: f, attempt: 1, idempotent: true })).toBe(
      true,
    );
    expect(shouldRetry({ failure: f, attempt: 2, idempotent: true })).toBe(
      true,
    );
    expect(shouldRetry({ failure: f, attempt: 3, idempotent: true })).toBe(
      false,
    );
    expect(shouldRetry({ failure: f, attempt: 4, idempotent: true })).toBe(
      false,
    );
  });

  it('S08 AS-57: full jitter - delay is uniform in [0, min(8000, 500 * 2^(attempt-1)))', () => {
    expect(retryDelayMs(1, () => 0)).toBe(0);
    expect(retryDelayMs(1, () => 0.999999)).toBe(499);
    expect(retryDelayMs(2, () => 0.5)).toBe(500);
    expect(retryDelayMs(3, () => 0.5)).toBe(1000);
    expect(retryDelayMs(5, () => 0.999999)).toBeLessThan(8000);
    expect(retryDelayMs(30, () => 0.999999)).toBe(7999);
  });

  it('S08 AS-57: property - the delay is an integer within [0, 8000] and below the exponential ceiling', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }),
        (attempt, r) => {
          const d = retryDelayMs(attempt, () => r);
          expect(Number.isInteger(d)).toBe(true);
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeLessThan(
            Math.min(CAP_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1)),
          );
        },
      ),
    );
  });
});

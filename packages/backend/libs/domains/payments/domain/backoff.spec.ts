import {
  chargeRetryAllowed,
  chargeRetryDelayMs,
  unknownDelayMs,
  type BackoffLimits,
} from './backoff';

const unknownLimits: BackoffLimits = { baseMs: 30_000, capMs: 900_000 };
const chargeLimits: BackoffLimits = { baseMs: 2_000, capMs: 60_000 };
const randoms = [0, 0.5, 0.9999999];

describe('S13 AS-27: unknown-outcome lookup delay (full jitter)', () => {
  it.each(randoms)(
    'stays within [0, min(15 min, 30 s x 2^n)] for random=%p',
    (r) => {
      for (let n = 0; n <= 20; n++) {
        const delay = unknownDelayMs(n, () => r, unknownLimits);
        const bound = Math.min(900_000, 30_000 * 2 ** n);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(bound);
      }
    },
  );

  it('the cap holds for absurd attempt counts and the delay is never negative or NaN', () => {
    const delay = unknownDelayMs(10_000, () => 0.9999999, unknownLimits);
    expect(delay).toBeLessThanOrEqual(900_000);
    expect(Number.isFinite(delay)).toBe(true);
  });

  it('random=0 gives zero and a high random gives close to the bound', () => {
    expect(unknownDelayMs(2, () => 0, unknownLimits)).toBe(0);
    expect(unknownDelayMs(2, () => 0.5, unknownLimits)).toBe(60_000);
  });
});

describe('S13 AS-34: charge retry delay and cut-off', () => {
  it.each(randoms)(
    'stays within [0, min(60 s, 2 s x 2^n)] for random=%p',
    (r) => {
      for (let n = 0; n <= 20; n++) {
        const delay = chargeRetryDelayMs(n, () => r, chargeLimits);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(Math.min(60_000, 2_000 * 2 ** n));
      }
    },
  );

  const createdAt = new Date('2026-10-10T10:00:00Z');
  const rule = { maxAttempts: 6, deadlineSeconds: 600 };
  it('allows another attempt below 6 attempts and inside 10 minutes', () => {
    expect(
      chargeRetryAllowed({
        attempts: 5,
        createdAt,
        now: new Date('2026-10-10T10:09:59Z'),
        ...rule,
      }),
    ).toBe(true);
  });
  it('refuses at 6 attempts', () => {
    expect(
      chargeRetryAllowed({
        attempts: 6,
        createdAt,
        now: new Date('2026-10-10T10:01:00Z'),
        ...rule,
      }),
    ).toBe(false);
  });
  it('refuses at 10 minutes since creation', () => {
    expect(
      chargeRetryAllowed({
        attempts: 1,
        createdAt,
        now: new Date('2026-10-10T10:10:00Z'),
        ...rule,
      }),
    ).toBe(false);
  });
});

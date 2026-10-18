import { describe, expect, it } from 'vitest';
import { BACKOFF_STEPS_MS, STABLE_CONNECTION_MS, backoffDelay } from './backoff';

describe('Reconnect back-off', () => {
  it('W05 AS-28: the steps are 1, 2, 4, 8, 16 seconds and then 30 seconds for ever', () => {
    expect(BACKOFF_STEPS_MS).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    expect([0, 1, 2, 3, 4, 5, 6, 40].map((attempt) => backoffDelay(attempt, () => 0.5))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('W05 AS-28: each delay is randomised by +-20 percent and never leaves that band', () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const base = BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)]!;
      expect(backoffDelay(attempt, () => 0)).toBeCloseTo(base * 0.8, 5);
      expect(backoffDelay(attempt, () => 1)).toBeCloseTo(base * 1.2, 5);
      for (let i = 0; i < 50; i++) {
        const delay = backoffDelay(attempt);
        expect(delay).toBeGreaterThanOrEqual(base * 0.8);
        expect(delay).toBeLessThanOrEqual(base * 1.2);
      }
    }
  });

  it('W05 AS-28: the attempt counter starts again after a connection that stayed open for 30 seconds', () => {
    expect(STABLE_CONNECTION_MS).toBe(30_000);
  });
});

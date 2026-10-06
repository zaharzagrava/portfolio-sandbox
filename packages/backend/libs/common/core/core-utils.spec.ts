import { allocate, allocateEvenly } from '@app/common/money/allocate';
import { fullJitterBackoff } from './backoff';
import { mapWithConcurrency, settleWithConcurrency } from './promise-pool';
import { RetryBudget } from '@app/infrastructure/http-client/retry-budget';
import { parseRetryAfter } from '@app/infrastructure/http-client/resilient-http-client';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle/shutdown-registry.service';

/**
 * Shared building blocks used by many sections (money splits in checkout,
 * proration and payouts; bounded fan-out in BFF/feeds; retries everywhere).
 * Pure logic - no DB needed.
 */
describe('platform core utils', () => {
  describe('allocate (largest remainder)', () => {
    it('never loses or invents a cent', () => {
      expect(allocateEvenly(100, 3)).toEqual([34, 33, 33]);
      expect(allocate(1000, [1, 1, 1, 1, 1, 1, 1])).toHaveLength(7);
      for (let total = 0; total < 500; total += 7) {
        const parts = allocate(total, [3, 5, 11, 0, 2]);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      }
    });

    it('is deterministic and gives ties to earlier parts', () => {
      expect(allocate(5, [1, 1])).toEqual([3, 2]);
      expect(allocate(5, [1, 1])).toEqual(allocate(5, [1, 1]));
    });

    it('handles negative totals (refunds) symmetrically', () => {
      expect(allocate(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    });

    it('rejects invalid input', () => {
      expect(() => allocate(10.5, [1])).toThrow(RangeError);
      expect(() => allocate(10, [0, 0])).toThrow(RangeError);
      expect(() => allocate(10, [])).toThrow(RangeError);
    });
  });

  describe('fullJitterBackoff', () => {
    it('stays within [0, min(max, base * 2^attempt)]', () => {
      expect(fullJitterBackoff(0, { baseMs: 100, maxMs: 5000 }, () => 0.999)).toBe(99);
      expect(fullJitterBackoff(3, { baseMs: 100, maxMs: 5000 }, () => 0.5)).toBe(400);
      expect(fullJitterBackoff(20, { baseMs: 100, maxMs: 5000 }, () => 0.999)).toBe(4995);
      expect(fullJitterBackoff(5, { baseMs: 100, maxMs: 5000 }, () => 0)).toBe(0);
    });
  });

  describe('mapWithConcurrency', () => {
    it('never exceeds the concurrency limit and preserves order', async () => {
      let inFlight = 0;
      let peak = 0;
      const result = await mapWithConcurrency([5, 1, 4, 2, 3, 0], 2, async (ms, i) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, ms));
        inFlight--;
        return i;
      });
      expect(peak).toBe(2);
      expect(result).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('settle variant collects failures instead of rejecting', async () => {
      const result = await settleWithConcurrency([1, 2, 3], 3, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      });
      expect(result.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    });
  });

  describe('RetryBudget', () => {
    it('caps retries at the ratio of recent requests, with a floor', () => {
      let now = 0;
      const budget = new RetryBudget(0.1, 2, 1000, () => now);
      for (let i = 0; i < 50; i++) budget.recordRequest();
      const granted = Array.from({ length: 20 }, () => budget.tryAcquireRetry()).filter(Boolean).length;
      expect(granted).toBe(5);

      now = 1000; // new window
      expect(budget.tryAcquireRetry()).toBe(true);
    });
  });

  describe('parseRetryAfter', () => {
    it('supports seconds and HTTP dates', () => {
      expect(parseRetryAfter('3')).toBe(3000);
      expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
      expect(parseRetryAfter('garbage')).toBeUndefined();
    });
  });

  describe('ShutdownRegistry', () => {
    it('runs tasks in order and continues past failures', async () => {
      const registry = new ShutdownRegistry();
      const ran: string[] = [];
      registry.register({ name: 'close-pools', order: 90, run: async () => void ran.push('close-pools') });
      registry.register({ name: 'stop-consumers', order: 10, run: async () => void ran.push('stop-consumers') });
      registry.register({
        name: 'flush-buffers',
        order: 50,
        run: async () => {
          ran.push('flush-buffers');
          throw new Error('redis gone');
        },
      });

      await registry.beforeApplicationShutdown('SIGTERM');
      expect(ran).toEqual(['stop-consumers', 'flush-buffers', 'close-pools']);
    });
  });
});

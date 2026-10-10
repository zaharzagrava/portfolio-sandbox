import { FallbackLimiter } from './fallback-limiter';

const tb = (limit: number, windowMs = 60_000) => ({
  algorithm: 'tokenBucket' as const,
  limit,
  windowMs,
});

describe('S50 fallback limiter', () => {
  it.each([
    [60, 4, 15],
    [10, 4, 2],
    [3, 4, 1],
    [1, 4, 1],
    [100, 1, 100],
  ])(
    'S50 AS-29: limit %p over %p instances gives capacity %p',
    (limit, instances, capacity) => {
      const f = new FallbackLimiter({ instances });
      let served = 0;
      while (f.check('p.x', tb(limit), 's', 1, 0).allowed && served < 1000)
        served++;
      expect(served).toBe(capacity);
    },
  );

  it('S50 AS-29: cost is charged', () => {
    const f = new FallbackLimiter({ instances: 4 });
    const p = tb(60);
    expect(f.check('p.x', p, 's', 5, 0)).toMatchObject({
      allowed: true,
      remaining: 10,
    });
    expect(f.check('p.x', p, 's', 11, 0).allowed).toBe(false);
    expect(f.check('p.x', p, 's', 10, 0).allowed).toBe(true);
  });

  it('S50 AS-29: refill and retryAfterMs follow token-bucket arithmetic', () => {
    const f = new FallbackLimiter({ instances: 4 });
    const p = tb(60, 60_000); // capacity 15, 15 tokens per 60 s = 1 per 4000 ms
    for (let i = 0; i < 15; i++) f.check('p.x', p, 's', 1, 0);
    const denied = f.check('p.x', p, 's', 1, 0);
    expect(denied).toMatchObject({ allowed: false, retryAfterMs: 4000 });
    expect(f.check('p.x', p, 's', 1, 3999).allowed).toBe(false);
    expect(f.check('p.x', p, 's', 1, 4000).allowed).toBe(true);
    // idle never exceeds capacity
    expect(f.check('p.x', p, 's', 15, 10_000_000).allowed).toBe(true);
    expect(f.check('p.x', p, 's', 1, 10_000_000).allowed).toBe(false);
  });

  it('S50 AS-29: sliding-window policies use the same share', () => {
    const f = new FallbackLimiter({ instances: 4 });
    const p = { algorithm: 'slidingWindow' as const, limit: 8, windowMs: 1000 };
    expect(f.check('p.x', p, 's', 1, 0).allowed).toBe(true);
    expect(f.check('p.x', p, 's', 1, 0).allowed).toBe(true);
    expect(f.check('p.x', p, 's', 1, 0).allowed).toBe(false);
  });

  it('S50 AS-29: subjects and policies are independent', () => {
    const f = new FallbackLimiter({ instances: 4 });
    const p = tb(4);
    expect(f.check('p.x', p, 'a', 1, 0).allowed).toBe(true);
    expect(f.check('p.x', p, 'a', 1, 0).allowed).toBe(false);
    expect(f.check('p.x', p, 'b', 1, 0).allowed).toBe(true);
    expect(f.check('p.y', p, 'a', 1, 0).allowed).toBe(true);
  });

  it('S50 AS-29: retains at most 50,000 subjects; the least recently used is evicted with a full bucket', () => {
    const f = new FallbackLimiter({ instances: 1 });
    const p = tb(1);
    expect(f.check('p.x', p, 'first', 1, 0).allowed).toBe(true);
    expect(f.check('p.x', p, 'first', 1, 0).allowed).toBe(false);
    for (let i = 0; i < 50_000; i++) f.check('p.x', p, `s${i}`, 1, 0);
    expect(f.size).toBe(50_000);
    expect(f.check('p.x', p, 'first', 1, 0).allowed).toBe(true);
    expect(f.size).toBe(50_000);
  });

  it('S50 AS-29: a recently used subject survives eviction', () => {
    const f = new FallbackLimiter({ instances: 1, maxSubjects: 3 });
    const p = tb(1);
    f.check('p.x', p, 'a', 1, 0);
    f.check('p.x', p, 'b', 1, 0);
    f.check('p.x', p, 'c', 1, 0);
    f.check('p.x', p, 'a', 1, 0); // refresh a
    f.check('p.x', p, 'd', 1, 0); // evicts b
    expect(f.check('p.x', p, 'a', 1, 0).allowed).toBe(false);
    expect(f.check('p.x', p, 'b', 1, 0).allowed).toBe(true);
  });

  it('S50 AS-34: concurrency fallback is a semaphore of max(1, floor(limit / instances))', () => {
    const f = new FallbackLimiter({ instances: 4 });
    const p = { algorithm: 'concurrency' as const, limit: 8, windowMs: 1000 };
    const a = f.acquire('p.x', p, 's');
    const b = f.acquire('p.x', p, 's');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(f.acquire('p.x', p, 's')).toBeNull();
    a!();
    a!(); // double release is harmless
    expect(f.acquire('p.x', p, 's')).not.toBeNull();
    expect(f.acquire('p.x', p, 's')).toBeNull();
    const one = { ...p, limit: 1 };
    expect(f.acquire('p.y', one, 's')).not.toBeNull();
    expect(f.acquire('p.y', one, 's')).toBeNull();
  });
});

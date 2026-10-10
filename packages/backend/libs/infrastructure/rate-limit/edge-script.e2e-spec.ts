import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LimiterInstance, createLimiter } from './test/limiter-fixture';

/**
 * The edge worker's sliding-window script (packages/edge-be/src/index.ts) executed for real, against the test Redis.
 * The worker's own spec (packages/edge-be/src/rate-limit.spec.ts) runs the worker against a fake store that mirrors
 * this script; this spec closes that gap by running the script text itself: S50 AS-76, SC-008.
 */
describe('S50 edge script (e2e, real Redis)', () => {
  let a: LimiterInstance;
  const W = 60_000;
  const LIMIT = 120;

  const script = (): string => {
    const source = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'edge-be', 'src', 'index.ts'),
      'utf8',
    );
    const match = /SLIDING_WINDOW_LUA = `([\s\S]*?)`;/.exec(source);
    if (!match) throw new Error('edge sliding-window script not found');
    return match[1];
  };

  beforeAll(async () => {
    a = await createLimiter();
  });

  afterAll(async () => {
    await a.close();
  });

  /** One decision exactly as the worker issues it: two window keys of one hash tag, limit, window, elapsed. */
  const decide = async (subject: string, now: number) => {
    const window = Math.floor(now / W);
    const base = `ratelimit:{${subject}}`;
    return (await a.redis.client.eval(
      script(),
      2,
      `${base}:${window}`,
      `${base}:${window - 1}`,
      String(LIMIT),
      String(W),
      String(now % W),
    )) as [number, number, number];
  };

  it('S50 AS-76: at a window boundary at most limit + 2 requests pass in the second after it', async () => {
    const subject = `user:${randomUUID()}`;
    const boundary = Math.floor(1_900_000_000_000 / W) * W;
    let before = 0;
    for (let i = 0; i < LIMIT; i++)
      if ((await decide(subject, boundary - 1_000))[0] === 1) before++;
    expect(before).toBe(LIMIT);

    let after = 0;
    for (let offset = 0; offset <= 1_000; offset += 100)
      for (let i = 0; i < 20; i++)
        if ((await decide(subject, boundary + offset))[0] === 1) after++;
    expect(after).toBeLessThanOrEqual(2);
  });

  it('S50 AS-77: a denial reports the wait; waiting exactly that long admits, one millisecond less does not', async () => {
    const boundary = Math.floor(1_900_000_000_000 / W) * W;
    const prepare = async () => {
      const subject = `user:${randomUUID()}`;
      for (let i = 0; i < LIMIT; i++) await decide(subject, boundary + 5_000);
      return subject;
    };
    const probe = await prepare();
    const [allowed, , wait] = await decide(probe, boundary + 5_000);
    expect(allowed).toBe(0);
    expect(wait).toBeGreaterThanOrEqual(1);

    const exact = await prepare();
    expect((await decide(exact, boundary + 5_000 + wait))[0]).toBe(1);
    const early = await prepare();
    expect((await decide(early, boundary + 5_000 + wait - 1))[0]).toBe(0);
  });

  it('S50 AS-76: every counter carries an expiry of two windows at most', async () => {
    const subject = `user:${randomUUID()}`;
    const now = Math.floor(1_900_000_000_000 / W) * W + 1_234;
    await decide(subject, now);
    const ttl = await a.redis.client.pttl(
      `ratelimit:{${subject}}:${Math.floor(now / W)}`,
    );
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2 * W);
  });
});

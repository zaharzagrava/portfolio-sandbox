import Redis from 'ioredis';

/**
 * The limiters are per client IP or user (register: 10 an hour, create shop: a few an hour) and every journey actor
 * comes from this machine, so one run would meet `429`. Clears the limiter counters (`rl:*`) of the stack's Redis; the
 * policies themselves stay as they are (the same practice as `packages/web/tests/helpers.ts`). Local/test stacks only.
 */
export async function resetRateLimits(): Promise<void> {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6300/0', {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  try {
    await redis.connect();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(
        cursor,
        'MATCH',
        'rl:*',
        'COUNT',
        1000,
      );
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== '0');
  } catch (error) {
    console.error(
      `WARNING: could not reset the rate limits (${(error as Error).message}); a 429 may follow.`,
    );
  } finally {
    redis.disconnect();
  }
}

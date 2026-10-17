import type Redis from 'ioredis';

/** Take the key if it is free, renew it if it is ours; 1 when we hold it afterwards. */
const ACQUIRE_OR_RENEW = `
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]) return 1 end
if not current then redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 end
return 0`;

/** Delete the key only if it is ours. */
const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

/**
 * One owner per key for periodic work: several instances split the shops between them, the holder renews while it ticks,
 * and a holder that stops (shutdown releases at once; a crash waits for the TTL) is replaced within `ttlMs` (S40 FR-032).
 */
export class Lease {
  constructor(
    private readonly redis: Redis,
    private readonly owner: string,
    private readonly ttlMs: number,
  ) {}

  async acquire(key: string): Promise<boolean> {
    return (
      (await this.redis.eval(
        ACQUIRE_OR_RENEW,
        1,
        key,
        this.owner,
        this.ttlMs,
      )) === 1
    );
  }

  async release(key: string): Promise<void> {
    await this.redis.eval(RELEASE, 1, key, this.owner);
  }
}

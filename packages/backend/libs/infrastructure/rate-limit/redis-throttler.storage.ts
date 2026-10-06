import { ThrottlerStorage } from '@nestjs/throttler';
import { RedisService } from '@app/infrastructure/redis/redis.service';

const FIXED_WINDOW = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl < 0 and hits > tonumber(ARGV[2]) and tonumber(ARGV[3]) > 0 then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  blockTtl = tonumber(ARGV[3])
end
return { hits, ttl, blockTtl }
`;

/**
 * Backs the global `@nestjs/throttler` guard with Redis. The default storage
 * is per-process memory, so with N API instances the effective limit was N×
 * the configured one (and reset on every deploy).
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: RedisService) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string) {
    const base = `throttle:{${throttlerName}:${key}}`;
    try {
      const [hits, ttlMs, blockMs] = (await this.redis.client.eval(FIXED_WINDOW, 2, base, `${base}:blocked`, ttl, limit, blockDuration)) as [
        number,
        number,
        number,
      ];
      const isBlocked = blockMs > 0 || hits > limit;
      return {
        totalHits: hits,
        timeToExpire: Math.ceil(Math.max(ttlMs, 0) / 1000),
        isBlocked,
        timeToBlockExpire: Math.ceil(Math.max(blockMs, 0) / 1000),
      };
    } catch {
      // Global coarse throttle fails open: endpoint-specific @RateLimit policies decide fail-closed cases.
      return { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
    }
  }
}

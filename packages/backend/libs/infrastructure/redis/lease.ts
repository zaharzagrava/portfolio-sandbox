import { RedisService } from './redis.service';

/** Renew if the lease is ours, otherwise take it only if free. Returns 1 when we hold it. */
const ACQUIRE_OR_RENEW = `
local cur = redis.call('GET', KEYS[1])
if cur == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]) return 1 end
if not cur then redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 end
return 0`;

/**
 * Per-key ownership for periodic work (tickers): N instances split N keys
 * between them, the owner keeps renewing, and a crashed owner's keys are
 * picked up after `ttlMs`.
 */
export async function holdLease(redis: RedisService, key: string, owner: string, ttlMs: number): Promise<boolean> {
  return (await redis.client.eval(ACQUIRE_OR_RENEW, 1, key, owner, ttlMs)) === 1;
}

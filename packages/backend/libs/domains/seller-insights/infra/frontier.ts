import { RedisService } from '@app/infrastructure/redis/redis.service';

const READY = 'crawl:ready';
const hostQueue = (host: string) => `crawl:host:${host}`;

/**
 * Atomically take one URL from a host whose next-allowed time has come, and
 * lease the host (score pushed `leaseMs` ahead) so no other fetcher touches it
 * meanwhile → per-host concurrency 1. KEYS[1] = ready ZSET.
 */
const TAKE = `
local hosts = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 10)
for _, host in ipairs(hosts) do
  local url = redis.call('LPOP', 'crawl:host:' .. host)
  if url then
    redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[2]), host)
    return {host, url}
  end
  redis.call('ZREM', KEYS[1], host)
end
return false`;

/**
 * URL frontier (10/09 #35): per-host FIFO lists + a ZSET of hosts scored by
 * the earliest time we may hit them again. Politeness is structural: a host
 * appears once in the ZSET, so fetchers can't stampede it however many
 * instances run. (A sharded deployment partitions hosts by hash across Redis shards.)
 */
export class Frontier {
  constructor(private readonly redis: RedisService) {}

  async push(host: string, url: string) {
    await this.redis.client.multi().rpush(hostQueue(host), url).zadd(READY, 'NX', Date.now(), host).exec();
  }

  /** Note: the hash tag-free keys are touched inside Lua - fine on a single shard; with Redis Cluster, use `{host}` tags + one ZSET per shard. */
  async take(leaseMs = 60_000): Promise<{ host: string; url: string } | null> {
    const res = (await this.redis.client.eval(TAKE, 1, READY, Date.now(), leaseMs)) as [string, string] | null;
    return res ? { host: res[0], url: res[1] } : null;
  }

  /** After the fetch: the host becomes available again after its crawl delay. */
  async release(host: string, delayMs: number) {
    await this.redis.client.zadd(READY, Date.now() + delayMs, host);
  }

  async size(host: string) {
    return this.redis.client.llen(hostQueue(host));
  }
}

import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import type { FrontierPort } from '../domain/crawler-ports';
import { CrawlerConfig } from '../application/crawler.config';

export const CRAWLER_REDIS = Symbol('S41_CRAWLER_REDIS');
/** Politeness is real time: a spec that freezes the application clock does not freeze the gap between two requests. */
export const CRAWLER_WALL_CLOCK = Symbol('S41_CRAWLER_WALL_CLOCK');

const READY = 'crawl:{s}:ready';
const hostList = (host: string) => `crawl:{s}:host:${host}`;
const hostGap = (host: string) => `crawl:{s}:gap:${host}`;
const mark = (targetId: string) => `crawl:queued:${targetId}`;
const MARK_TTL_SECONDS = 900;

/**
 * Appends the target id to the host's list and makes the host ready no earlier than its remaining gap (the gap key
 * outlives the ready entry, so a host drained and refilled is still left alone). KEYS[1] ready ZSET, ARGV: now, host,
 * target id.
 */
const PUSH = `
local gap = redis.call('GET', 'crawl:{s}:gap:' .. ARGV[2])
local score = tonumber(ARGV[1])
if gap and tonumber(gap) > score then score = tonumber(gap) end
redis.call('RPUSH', 'crawl:{s}:host:' .. ARGV[2], ARGV[3])
redis.call('ZADD', KEYS[1], 'NX', score, ARGV[2])
return 1`;

/**
 * Takes one target from a host whose time has come and leases the host (its score moves `lease` ahead), so no other
 * fetcher touches it meanwhile: per-host concurrency 1 across every worker. A host with nothing queued leaves the set.
 */
const TAKE = `
local hosts = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 10)
for _, host in ipairs(hosts) do
  local id = redis.call('LPOP', 'crawl:{s}:host:' .. host)
  if id then
    redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[2]), host)
    return {host, id}
  end
  redis.call('ZREM', KEYS[1], host)
end
return false`;

/** After a fetch: the host is next allowed at `now + delay`; kept even when its list is empty. ARGV: until, ttl, host. */
const RELEASE = `
redis.call('SET', 'crawl:{s}:gap:' .. ARGV[3], ARGV[1], 'PX', ARGV[2])
if redis.call('LLEN', 'crawl:{s}:host:' .. ARGV[3]) > 0 then
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[3])
else
  redis.call('ZREM', KEYS[1], ARGV[3])
end
return 1`;

/**
 * URL frontier (SD-35, P0507-era design kept): per-host FIFO lists of target ids and a ZSET of hosts scored by the
 * earliest time they may be hit again. Politeness is structural: a host appears once in the set. Keys carry the `{s}`
 * hash tag, so a cluster keeps them on one shard. Everything here is derived from the database and rebuilt by the
 * scheduler; a list holds target ids, never URLs.
 */
@Injectable()
export class RedisFrontier implements FrontierPort {
  constructor(
    @Inject(CRAWLER_REDIS) private readonly redis: Redis,
    @Inject(CRAWLER_WALL_CLOCK) private readonly wall: () => number,
    private readonly config: CrawlerConfig,
  ) {}

  async push(host: string, targetId: string) {
    await this.redis.eval(PUSH, 1, READY, this.wall(), host, targetId);
  }

  async take() {
    const res = (await this.redis.eval(
      TAKE,
      1,
      READY,
      this.wall(),
      this.config.settings.leaseMs,
    )) as [string, string] | null;
    return res ? { host: res[0], targetId: res[1] } : null;
  }

  async release(host: string, delayMs: number) {
    const until = this.wall() + delayMs;
    await this.redis.eval(RELEASE, 1, READY, until, delayMs + 60_000, host);
  }

  readyHosts() {
    return this.redis.zcard(READY);
  }

  async mark(targetId: string, nowMs: number, staleMs: number) {
    const key = mark(targetId);
    if (await this.redis.set(key, String(nowMs), 'EX', MARK_TTL_SECONDS, 'NX'))
      return true;
    const at = Number(await this.redis.get(key));
    if (Number.isFinite(at) && nowMs - at > staleMs) {
      await this.redis.set(key, String(nowMs), 'EX', MARK_TTL_SECONDS);
      return true;
    }
    return false;
  }

  async unmark(targetId: string) {
    await this.redis.del(mark(targetId));
  }
}

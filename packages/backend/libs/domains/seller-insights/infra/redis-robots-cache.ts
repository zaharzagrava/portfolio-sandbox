import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import type { RobotsCache, RobotsEntry } from '../domain/crawler-ports';
import { CRAWLER_REDIS } from './redis-frontier';

/**
 * robots.txt rules per origin, shared by the fleet (S41 FR-016, research D-12). The key holds scheme, host and port,
 * so two ports never share rules. The entry carries its own expiry on the application clock; the Redis TTL is the
 * backstop that keeps the store clean.
 */
@Injectable()
export class RedisRobotsCache implements RobotsCache {
  constructor(@Inject(CRAWLER_REDIS) private readonly redis: Redis) {}

  async get(origin: string, nowMs: number) {
    const raw = await this.redis.get(key(origin));
    if (!raw) return null;
    try {
      const entry = JSON.parse(raw) as RobotsEntry;
      return entry.expiresAt > nowMs ? entry : null;
    } catch {
      return null;
    }
  }

  async put(origin: string, entry: RobotsEntry, ttlSeconds: number) {
    await this.redis.set(key(origin), JSON.stringify(entry), 'EX', ttlSeconds);
  }
}

const key = (origin: string) => `crawl:robots:${origin}`;

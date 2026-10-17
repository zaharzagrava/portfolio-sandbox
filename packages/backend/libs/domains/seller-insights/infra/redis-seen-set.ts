import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { RedisBloomFilter } from '@app/infrastructure/cache';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { SeenSet } from '../domain/crawler-ports';
import { CRAWLER_REDIS } from './redis-frontier';

const KEY = 'crawl:seen';
const EXPECTED_URLS = 10_000_000;
const FALSE_POSITIVE_RATE = 0.01;
const KEY_TTL_SECONDS = 30 * 24 * 3600;

/**
 * Seen-set of normalised URLs (P1103): a Bloom filter in front of the authoritative target table. It is a negative
 * filter only, "probably seen" is always confirmed against the table and nothing is skipped because of it (FR-010).
 * It is derived: losing it changes no outcome and it refills lazily. Reuses the cache library's filter.
 */
@Injectable()
export class RedisSeenSet implements SeenSet {
  private readonly filter: RedisBloomFilter;

  constructor(
    redisService: RedisService,
    @Inject(CRAWLER_REDIS) private readonly redis: Redis,
  ) {
    this.filter = new RedisBloomFilter(
      redisService,
      KEY,
      EXPECTED_URLS,
      FALSE_POSITIVE_RATE,
    );
  }

  contains(url: string) {
    return this.filter.mightContain(url);
  }

  async add(url: string) {
    await this.filter.add([url]);
    await this.redis.expire(KEY, KEY_TTL_SECONDS);
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { ApiConfigService } from '@app/common/config';
import { FEED_TTL, isCelebrityKey } from '../domain/feed-keys';
import { FEED_REDIS_CLIENT, type CelebrityStore } from '../domain/ports';
import { withTimeout } from '../domain/with-timeout';
import { FeedScylla, long } from './feed-scylla';

const IN_CHUNK = 100;
const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

/**
 * Celebrity status (S26 C1, R-3): the durable truth is `celebrity_accounts` (written once with `IF NOT EXISTS`, never
 * deleted by code, so the status is sticky); `fd:iscel:{accountId}` is a read-through cache, one key per account. A
 * promotion overwrites a cached "no" at once; a cached "no" otherwise lives for minutes only. The cache is optional: when
 * Redis fails the table answers, so losing every `fd:` key loses no status (AS-28).
 */
@Injectable()
export class ScyllaCelebrityStore implements CelebrityStore {
  private readonly logger = new Logger(ScyllaCelebrityStore.name);

  constructor(
    private readonly db: FeedScylla,
    @Inject(FEED_REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ApiConfigService,
  ) {}

  async isCelebrity(accountId: string): Promise<boolean> {
    return (await this.areCelebrities([accountId])).has(accountId);
  }

  async areCelebrities(accountIds: string[]): Promise<Set<string>> {
    const unique = [...new Set(accountIds)];
    const celebrities = new Set<string>();
    if (!unique.length) return celebrities;

    const cached = await this.cacheGet(unique);
    const unknown: string[] = [];
    for (const id of unique) {
      const value = cached.get(id);
      if (value === '1') celebrities.add(id);
      else if (value !== '0') unknown.push(id);
    }
    if (!unknown.length) return celebrities;

    const found = new Set<string>();
    for (const part of chunks(unknown, IN_CHUNK)) {
      const result = await this.db.read(
        'SELECT account_id FROM celebrity_accounts WHERE account_id IN ?',
        [part],
      );
      for (const row of result.rows) found.add(row.account_id);
    }
    for (const id of found) celebrities.add(id);
    await this.cacheSet(unknown.map((id) => [id, found.has(id)] as const));
    return celebrities;
  }

  async promote(
    accountId: string,
    followers: number,
    at: Date,
  ): Promise<boolean> {
    const { applied } = await this.db.lwt(
      'INSERT INTO celebrity_accounts (account_id, since, followers_at_promotion) VALUES (?, ?, ?) IF NOT EXISTS',
      [accountId, at, long(followers)],
    );
    // also when another caller promoted first: the cache must say yes whatever it said before
    await this.cacheSet([[accountId, true]]);
    return applied;
  }

  private async cacheGet(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    try {
      await withTimeout(
        (async () => {
          const pipeline = this.redis.pipeline();
          for (const id of ids) pipeline.get(isCelebrityKey(id));
          const results = await pipeline.exec();
          results?.forEach(([error, value], i) => {
            if (!error && typeof value === 'string') out.set(ids[i], value);
          });
        })(),
        this.config.get('feed_timeline_timeout_ms') * 10,
        () => new Error('timeout'),
      );
    } catch (error) {
      this.logger.warn(
        `celebrity cache read failed cause=${(error as Error).name}`,
      );
      out.clear();
    }
    return out;
  }

  private async cacheSet(
    entries: ReadonlyArray<readonly [string, boolean]>,
  ): Promise<void> {
    try {
      await withTimeout(
        (async () => {
          const pipeline = this.redis.pipeline();
          for (const [id, yes] of entries)
            pipeline.set(
              isCelebrityKey(id),
              yes ? '1' : '0',
              'EX',
              yes ? FEED_TTL.iscel : FEED_TTL.iscelNegative,
            );
          await pipeline.exec();
        })(),
        this.config.get('feed_timeline_timeout_ms') * 10,
        () => new Error('timeout'),
      );
    } catch (error) {
      this.logger.warn(
        `celebrity cache write failed cause=${(error as Error).name}`,
      );
    }
  }
}

import { Injectable } from '@nestjs/common';
import { types } from 'cassandra-driver';
import { CassandraService } from '@app/infrastructure/cassandra/cassandra.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { mapWithConcurrency } from '@app/common/core/promise-pool';
import {
  decodeEntry,
  encodeEntry,
  mergeNewestFirst,
  TimelineEntry,
} from '../domain/merge';
import { monthOf } from './feed-publisher.service';

/** Above this many followers an account is a "celebrity": its items are pulled at read time, not pushed. */
export const CELEBRITY_THRESHOLD = 10_000;
export const TIMELINE_LENGTH = 800;
export const ACTIVE_TTL_SEC = 7 * 86_400;
const CELEB_RECENT = 200;

export const timelineKey = (userId: string) => `tl:{${userId}}`;
export const celebKey = (accountId: string) => `celeb:{${accountId}}:recent`;
export const activeKey = (userId: string) => `active:{${userId}}`;
const followingKey = (userId: string) => `following:{${userId}}`;
const followerCountKey = (accountId: string) => `followers:{${accountId}}`;
export const CELEBRITIES = 'feed:celebrities';

export interface FeedItemView {
  itemId: string;
  authorId: string;
  kind: string;
  title: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Home timeline (lesson 10/05 #9) - hybrid fan-out:
 *  - normal authors: items pushed by the fan-out worker into ACTIVE followers'
 *    Redis lists (LPUSH + LTRIM 800, ids only),
 *  - celebrities: never fanned out; their recent items sit in one capped ZSET
 *    and are k-way merged into each reader's page at read time,
 *  - inactive users get nothing pushed; on return their list is rebuilt by
 *    pulling recent items of everyone they follow (pull = cheap writes).
 * Pages hydrate item ids with multi-gets; unfollowed/deleted items are
 * filtered at hydration because fan-out already happened.
 */
@Injectable()
export class FeedService {
  constructor(
    private readonly cassandra: CassandraService,
    private readonly redis: RedisService,
  ) {}

  async follow(userId: string, accountId: string): Promise<void> {
    const now = new Date();
    await Promise.all([
      this.cassandra.execute(
        'INSERT INTO followers_by_account (account_id, follower_id, followed_at) VALUES (?, ?, ?)',
        [accountId, userId, now],
      ),
      this.cassandra.execute(
        'INSERT INTO following_by_user (user_id, account_id, followed_at) VALUES (?, ?, ?)',
        [userId, accountId, now],
      ),
    ]);
    const added = await this.redis.client.sadd(followingKey(userId), accountId);
    if (added) {
      await this.cassandra.client.execute(
        'UPDATE follower_counts SET followers = followers + 1 WHERE account_id = ?',
        [accountId],
        { prepare: true },
      );
      const count = await this.redis.client.incr(followerCountKey(accountId));
      if (count >= CELEBRITY_THRESHOLD)
        await this.redis.client.sadd(CELEBRITIES, accountId);
    }
  }

  async unfollow(userId: string, accountId: string): Promise<void> {
    await Promise.all([
      this.cassandra.execute(
        'DELETE FROM followers_by_account WHERE account_id = ? AND follower_id = ?',
        [accountId, userId],
      ),
      this.cassandra.execute(
        'DELETE FROM following_by_user WHERE user_id = ? AND account_id = ?',
        [userId, accountId],
      ),
    ]);
    if (await this.redis.client.srem(followingKey(userId), accountId)) {
      await this.cassandra.client.execute(
        'UPDATE follower_counts SET followers = followers - 1 WHERE account_id = ?',
        [accountId],
        { prepare: true },
      );
      await this.redis.client.decr(followerCountKey(accountId));
    }
  }

  async following(userId: string): Promise<string[]> {
    const cached = await this.redis.client.smembers(followingKey(userId));
    if (cached.length) return cached;
    const rows = await this.cassandra.execute(
      'SELECT account_id FROM following_by_user WHERE user_id = ?',
      [userId],
      { fetchSize: 5_000 },
    );
    const ids = rows.rows.map((r) => r.account_id as string);
    if (ids.length) await this.redis.client.sadd(followingKey(userId), ...ids);
    return ids;
  }

  async timeline(
    userId: string,
    limit = 30,
    beforeMs?: number,
  ): Promise<{ items: FeedItemView[]; nextBefore?: number }> {
    const wasActive = await this.redis.client.set(
      activeKey(userId),
      '1',
      'EX',
      ACTIVE_TTL_SEC,
      'GET',
    );
    if (wasActive === null) await this.rebuild(userId);

    const following = await this.following(userId);
    const celebs = following.length
      ? await this.redis.client.smismember(CELEBRITIES, ...following)
      : [];
    const followedCelebs = following.filter((_, i) => celebs[i] === 1);

    const own = (
      await this.redis.client.lrange(
        timelineKey(userId),
        0,
        TIMELINE_LENGTH - 1,
      )
    ).map(decodeEntry);
    const pulled = await mapWithConcurrency(followedCelebs, 16, async (celeb) =>
      (
        await this.redis.client.zrevrangebyscore(
          celebKey(celeb),
          beforeMs ? `(${beforeMs}` : '+inf',
          '-inf',
          'LIMIT',
          0,
          limit,
        )
      ).map(decodeEntry),
    );

    const page = mergeNewestFirst([own, ...pulled], limit, beforeMs);
    const items = await this.hydrate(page, new Set(following));
    return {
      items,
      nextBefore: page.length === limit ? page[page.length - 1].ms : undefined,
    };
  }

  /** Returning user: pull the newest items of every followed (non-celebrity) author and seed the Redis list. */
  async rebuild(userId: string): Promise<number> {
    const following = await this.following(userId);
    const month = monthOf(Date.now());
    const perAuthor = await mapWithConcurrency(
      following,
      16,
      async (author) => {
        const rows = await this.cassandra.execute(
          'SELECT item_id FROM items_by_author WHERE author_id = ? AND month IN (?, ?) LIMIT 50',
          [author, month, previousMonth(month)],
        );
        return rows.rows
          .map((r) => ({
            ms: (r.item_id as types.TimeUuid).getDate().getTime(),
            itemId: r.item_id.toString(),
          }))
          .sort((a, b) => b.ms - a.ms);
      },
    );
    const merged = mergeNewestFirst(perAuthor, TIMELINE_LENGTH);
    const key = timelineKey(userId);
    const tx = this.redis.client.multi().del(key);
    if (merged.length) tx.rpush(key, ...merged.map(encodeEntry));
    await tx.exec();
    return merged.length;
  }

  private async hydrate(
    entries: TimelineEntry[],
    following: Set<string>,
  ): Promise<FeedItemView[]> {
    const rows = await mapWithConcurrency(entries, 32, (e) =>
      this.cassandra.execute('SELECT * FROM feed_items WHERE item_id = ?', [
        e.itemId,
      ]),
    );
    return rows
      .map((r) => r.rows[0])
      .filter((row) => row && following.has(row.author_id))
      .map((row) => ({
        itemId: row.item_id.toString(),
        authorId: row.author_id,
        kind: row.kind,
        title: row.title,
        payload: JSON.parse(row.payload ?? '{}'),
        createdAt: row.created_at,
      }));
  }
}

function previousMonth(month: number): number {
  return month % 100 === 1
    ? (Math.floor(month / 100) - 1) * 100 + 12
    : month - 1;
}

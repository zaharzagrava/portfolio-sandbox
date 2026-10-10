import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { types } from 'cassandra-driver';
import { CassandraService } from '@app/infrastructure/cassandra/cassandra.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { RealtimePublisher } from '@app/infrastructure/realtime';

export interface InboxItem {
  id: string;
  type: string;
  category: string;
  title: string;
  body: string;
  link: string;
  read: boolean;
  createdAt: string;
}

const unreadKey = (userId: string) => `notif:unread:{${userId}}`;
const readAllKey = (userId: string) => `notif:readall:{${userId}}`;
const countedKey = (notifId: string) => `notif:counted:${notifId}`;
const MONTHS_KEPT = 6;

const bucketOf = (d: Date) => d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
const previousBucket = (b: number) =>
  b % 100 === 1 ? (Math.floor(b / 100) - 1) * 100 + 12 : b - 1;

/**
 * In-app inbox: Scylla partitions per (user, month), newest first; unread
 * badge from a Redis counter (O(1), no COUNT over a partition); live push
 * through the realtime gateway (F-03).
 *
 * Idempotent under replays: the notification id is a time-UUID DERIVED from
 * the dedupe key (same event → same row, an upsert), and the counter
 * increment is guarded by a SET NX marker.
 */
@Injectable()
export class InboxService {
  constructor(
    private readonly cassandra: CassandraService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimePublisher,
  ) {}

  static notificationId(
    dedupeKey: string,
    userId: string,
    at: Date,
  ): types.TimeUuid {
    const h = createHash('sha256').update(`${dedupeKey}:${userId}`).digest();
    return types.TimeUuid.fromDate(
      at,
      h.readUInt16BE(0) % 10_000,
      h.subarray(2, 8),
      h.subarray(8, 10),
    );
  }

  async add(
    userId: string,
    dedupeKey: string,
    at: Date,
    item: Omit<InboxItem, 'id' | 'read' | 'createdAt'>,
  ): Promise<string> {
    const id = InboxService.notificationId(dedupeKey, userId, at);
    await this.cassandra.execute(
      `INSERT INTO inbox_by_user (user_id, bucket, notif_id, type, category, title, body, link, read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, false)`,
      [
        userId,
        bucketOf(at),
        id,
        item.type,
        item.category,
        item.title,
        item.body,
        item.link,
      ],
    );
    const firstTime = await this.redis.client.set(
      countedKey(id.toString()),
      '1',
      'EX',
      7 * 86_400,
      'NX',
    );
    const unread = firstTime
      ? await this.redis.client.incr(unreadKey(userId))
      : Number((await this.redis.client.get(unreadKey(userId))) ?? 0);
    if (firstTime) {
      await this.realtime.publish(`user:${userId}`, 'notification', {
        id: id.toString(),
        ...item,
        unread,
        createdAt: at.toISOString(),
      });
    }
    return id.toString();
  }

  /** Cursor = "<bucket>:<pageState>". Walks back month by month until the page is full or history ends. */
  async list(
    userId: string,
    cursor: string | undefined,
    limit = 20,
  ): Promise<{ items: InboxItem[]; nextCursor: string | null }> {
    let [bucket, pageState] = cursor
      ? [Number(cursor.split(':')[0]), cursor.split(':')[1] || undefined]
      : [bucketOf(new Date()), undefined];
    const oldest = (() => {
      let b = bucketOf(new Date());
      for (let i = 0; i < MONTHS_KEPT; i++) b = previousBucket(b);
      return b;
    })();
    const readAll = Number(
      (await this.redis.client.get(readAllKey(userId))) ?? 0,
    );
    const items: InboxItem[] = [];

    while (items.length < limit && bucket >= oldest) {
      const res = await this.cassandra.execute(
        `SELECT * FROM inbox_by_user WHERE user_id = ? AND bucket = ?`,
        [userId, bucket],
        { fetchSize: limit - items.length, pageState },
      );
      for (const row of res.rows) {
        const id = row.get('notif_id') as types.TimeUuid;
        const createdAt = id.getDate();
        items.push({
          id: id.toString(),
          type: row.get('type'),
          category: row.get('category'),
          title: row.get('title'),
          body: row.get('body'),
          link: row.get('link'),
          read: row.get('read') || createdAt.getTime() <= readAll,
          createdAt: createdAt.toISOString(),
        });
      }
      if (res.pageState) {
        pageState = res.pageState;
        if (items.length >= limit)
          return { items, nextCursor: `${bucket}:${pageState}` };
      } else {
        bucket = previousBucket(bucket);
        pageState = undefined;
      }
    }
    return { items, nextCursor: bucket >= oldest ? `${bucket}:` : null };
  }

  async unreadCount(userId: string): Promise<number> {
    return Math.max(
      0,
      Number((await this.redis.client.get(unreadKey(userId))) ?? 0),
    );
  }

  /** LWT (`IF read = false`) so two tabs marking the same item read decrement the badge once. */
  async markRead(userId: string, ids: string[]): Promise<number> {
    let changed = 0;
    const readAll = Number(
      (await this.redis.client.get(readAllKey(userId))) ?? 0,
    );
    for (const raw of ids) {
      const id = types.TimeUuid.fromString(raw);
      if (id.getDate().getTime() <= readAll) continue; // already counted as read by "mark all"
      const res = await this.cassandra.execute(
        `UPDATE inbox_by_user SET read = true WHERE user_id = ? AND bucket = ? AND notif_id = ? IF read = false`,
        [userId, bucketOf(id.getDate()), id],
      );
      if (res.wasApplied()) changed++;
    }
    if (changed > 0) {
      const left = await this.redis.client.decrby(unreadKey(userId), changed);
      if (left < 0) await this.redis.client.set(unreadKey(userId), '0');
    }
    return this.unreadCount(userId);
  }

  /** "Mark all read" is O(1): a watermark instead of rewriting every row. */
  async markAllRead(userId: string): Promise<void> {
    await this.redis.client
      .multi()
      .set(readAllKey(userId), String(Date.now()))
      .set(unreadKey(userId), '0')
      .exec();
  }
}

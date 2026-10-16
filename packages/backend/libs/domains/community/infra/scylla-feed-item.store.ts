import { Injectable } from '@nestjs/common';
import type { types } from 'cassandra-driver';
import { announcementShard } from '../domain/feed-events';
import { fromSortableId, idTime } from '../domain/ids';
import { monthBucketOf } from '../domain/months';
import type {
  AuthorHistoryEntry,
  FeedItemStore,
  StoreItemOptions,
  StoredFeedItem,
} from '../domain/ports';
import { FeedScylla, long } from './feed-scylla';

const IN_CHUNK = 100;
const DAY_MS = 86_400_000;

const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

const toItem = (row: types.Row): StoredFeedItem => ({
  itemId: row.item_id.toString(),
  authorId: row.author_id,
  kind: row.kind,
  title: row.title,
  payload: JSON.parse(row.payload ?? '{}'),
  createdAt: row.created_at,
  productId: row.product_id ?? null,
  shopId: row.shop_id ?? null,
  postId: row.post_id ?? null,
});

/**
 * Feed items on ScyllaDB (S26 B7, B8, R-4, R-5). One item per `(kind, source)`: the claim row decides with
 * `INSERT ... IF NOT EXISTS`; the item, its author-history row and its pending announcement are then written in one
 * logged batch under the winning id, so a crash between the claim and the batch is repaired by the redelivered source
 * event (it finds the claim and re-runs the idempotent batch). Item and history rows carry the retention TTL.
 */
@Injectable()
export class ScyllaFeedItemStore implements FeedItemStore {
  constructor(private readonly db: FeedScylla) {}

  async store(
    item: StoredFeedItem,
    sourceKey: string,
    options: StoreItemOptions,
  ): Promise<{ created: boolean; itemId: string }> {
    const ttl = options.claimTtlSeconds;
    const { applied, row } = await this.db.lwt(
      `INSERT INTO item_claims (kind, source_key, item_id, created_at) VALUES (?, ?, ?, ?) IF NOT EXISTS${
        ttl ? ' USING TTL ?' : ''
      }`,
      [item.kind, sourceKey, item.itemId, options.now, ...(ttl ? [ttl] : [])],
    );
    const itemId = applied ? item.itemId : row.get('item_id').toString();
    if (!applied && (await this.getMany([itemId])).length)
      return { created: false, itemId };

    const createdAt = idTime(itemId);
    await this.db.batch([
      {
        query:
          'INSERT INTO feed_items (item_id, author_id, kind, title, payload, created_at, product_id, shop_id, post_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) USING TTL ?',
        params: [
          itemId,
          item.authorId,
          item.kind,
          item.title,
          JSON.stringify(item.payload),
          createdAt,
          item.productId,
          item.shopId,
          item.postId,
          options.ttlSeconds,
        ],
      },
      {
        query:
          'INSERT INTO items_by_author (author_id, month, item_id, kind) VALUES (?, ?, ?, ?) USING TTL ?',
        params: [
          item.authorId,
          monthBucketOf(createdAt),
          itemId,
          item.kind,
          options.ttlSeconds,
        ],
      },
      {
        query:
          'INSERT INTO pending_announcements (hour_shard, item_id, author_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
        params: [
          long(announcementShard(itemId, options.now)),
          itemId,
          item.authorId,
          item.kind,
          createdAt,
        ],
      },
    ]);
    return { created: true, itemId };
  }

  async getMany(itemIds: string[]): Promise<StoredFeedItem[]> {
    const out: StoredFeedItem[] = [];
    for (const part of chunks([...new Set(itemIds)], IN_CHUNK)) {
      const result = await this.db.read(
        'SELECT item_id, author_id, kind, title, payload, created_at, product_id, shop_id, post_id FROM feed_items WHERE item_id IN ?',
        [part],
      );
      out.push(...result.rows.filter((r) => r.author_id).map(toItem));
    }
    return out;
  }

  async authorHistory(
    authorId: string,
    before: { ms: number; itemId: string } | null,
    notBefore: Date,
    limit: number,
    now: Date,
  ): Promise<AuthorHistoryEntry[]> {
    const startMonth = monthBucketOf(
      before ? new Date(before.ms) : new Date(now.getTime() + DAY_MS),
    );
    const floorMonth = monthBucketOf(notBefore);
    const out: AuthorHistoryEntry[] = [];
    for (
      let month = startMonth;
      month >= floorMonth && out.length < limit;
      month =
        month % 100 === 1 ? (Math.floor(month / 100) - 1) * 100 + 12 : month - 1
    ) {
      const bounded = before !== null && month === startMonth;
      const result = await this.db.read(
        `SELECT item_id FROM items_by_author WHERE author_id = ? AND month = ?${
          bounded ? ' AND item_id < ?' : ''
        } AND item_id >= minTimeuuid(?) LIMIT ?`,
        [
          authorId,
          month,
          ...(bounded ? [fromSortableId(before.itemId)] : []),
          notBefore,
          limit - out.length,
        ],
      );
      for (const row of result.rows) {
        const itemId = row.item_id.toString();
        out.push({ itemId, createdAt: idTime(itemId) });
      }
    }
    return out;
  }
}

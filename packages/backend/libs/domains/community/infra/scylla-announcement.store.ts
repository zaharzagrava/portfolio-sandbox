import { Injectable } from '@nestjs/common';
import type { AnnouncementStore, PendingAnnouncement } from '../domain/ports';
import { FeedScylla, long } from './feed-scylla';

/**
 * The announcement work queue and the fan-out completion marker (S26 B2, R-5, AS-22). `pending_announcements` rows are
 * written in the item batch and deleted after the bus accepted the event; a row that cannot be turned into a valid
 * announcement moves to `dead_announcements`. `fanout_done` makes a redelivered `feed.item_published` a no-op.
 */
@Injectable()
export class ScyllaAnnouncementStore implements AnnouncementStore {
  constructor(private readonly db: FeedScylla) {}

  async pending(
    hourShards: number[],
    limit: number,
  ): Promise<PendingAnnouncement[]> {
    const out: PendingAnnouncement[] = [];
    for (const shard of hourShards) {
      if (out.length >= limit) break;
      const result = await this.db.read(
        'SELECT hour_shard, item_id, author_id, kind, created_at FROM pending_announcements WHERE hour_shard = ? LIMIT ?',
        [long(shard), limit - out.length],
      );
      for (const row of result.rows)
        out.push({
          hourShard: row.hour_shard.toNumber(),
          itemId: row.item_id.toString(),
          authorId: row.author_id,
          kind: row.kind,
          createdAt: row.created_at,
        });
    }
    return out;
  }

  async delivered(row: PendingAnnouncement): Promise<void> {
    await this.db.write(
      'DELETE FROM pending_announcements WHERE hour_shard = ? AND item_id = ?',
      [long(row.hourShard), row.itemId],
    );
  }

  async deadLetter(
    row: PendingAnnouncement,
    reason: string,
    day: number,
  ): Promise<void> {
    await this.db.batch([
      {
        query:
          'INSERT INTO dead_announcements (day, item_id, reason, payload) VALUES (?, ?, ?, ?)',
        params: [
          day,
          row.itemId,
          reason,
          JSON.stringify({
            authorId: row.authorId,
            kind: row.kind,
            createdAt: row.createdAt?.toISOString?.() ?? null,
          }),
        ],
      },
      {
        query:
          'DELETE FROM pending_announcements WHERE hour_shard = ? AND item_id = ?',
        params: [long(row.hourShard), row.itemId],
      },
    ]);
  }

  async isFannedOut(itemId: string): Promise<boolean> {
    return (
      (
        await this.db.read(
          'SELECT item_id FROM fanout_done WHERE item_id = ?',
          [itemId],
        )
      ).first() !== null
    );
  }

  async markFannedOut(itemId: string, at: Date): Promise<void> {
    await this.db.write(
      'INSERT INTO fanout_done (item_id, done_at) VALUES (?, ?)',
      [itemId, at],
    );
  }
}

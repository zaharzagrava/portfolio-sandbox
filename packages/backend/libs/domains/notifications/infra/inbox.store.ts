import { Injectable } from '@nestjs/common';
import { types } from 'cassandra-driver';
import { CassandraService } from '@app/infrastructure/cassandra/cassandra.service';
import { isEffectivelyRead } from '../domain/inbox-read';
import type {
  InboxItemRecord,
  InboxPosition,
  InboxRange,
  InboxStore,
} from '../domain/ports';
import { WIDE_COLUMN_TIMEOUT_MS, withTimeout } from './with-timeout';

const bucketOf = (d: Date) => d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
const previousBucket = (b: number) =>
  b % 100 === 1 ? (Math.floor(b / 100) - 1) * 100 + 12 : b - 1;

const COLUMNS = `notif_id, type, category, title, body, link, read, arrived_at`;
const PAGE = 100;

type Row = types.Row;

/**
 * Wide-column adapter of `INBOX_STORE`: partition `(user_id, bucket)` with bucket = `yyyymm` of the event time, newest
 * first by the time-UUID `notif_id` (its time is the event time, its other bytes come from the dedupe identity).
 * Every call has a 1 s timeout.
 */
@Injectable()
export class CassandraInboxStore implements InboxStore {
  constructor(private readonly cassandra: CassandraService) {}

  private run(
    query: string,
    params: unknown[],
    options: { fetchSize?: number; idempotent?: boolean } = {},
  ) {
    return withTimeout(
      this.cassandra.execute(query, params, options),
      WIDE_COLUMN_TIMEOUT_MS,
      'inbox store',
    );
  }

  private toRecord(userId: string, row: Row): InboxItemRecord {
    const id = row.get('notif_id') as types.TimeUuid;
    return {
      id: id.toString(),
      userId,
      type: row.get('type'),
      category: row.get('category'),
      title: row.get('title'),
      body: row.get('body'),
      link: row.get('link') ?? null,
      read: row.get('read') === true,
      eventTime: id.getDate(),
      arrivedAt: (row.get('arrived_at') as Date | null) ?? null,
    };
  }

  async insertIfAbsent(item: InboxItemRecord): Promise<boolean> {
    const id = types.TimeUuid.fromString(item.id);
    const res = await this.run(
      `INSERT INTO inbox_by_user (user_id, bucket, notif_id, type, category, title, body, link, read, arrived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) IF NOT EXISTS`,
      [
        item.userId,
        bucketOf(item.eventTime),
        id,
        item.type,
        item.category,
        item.title,
        item.body,
        item.link,
        item.read,
        item.arrivedAt,
      ],
      { idempotent: true },
    );
    return res.wasApplied();
  }

  async page(
    userId: string,
    limit: number,
    after: InboxPosition | null,
    range: InboxRange,
  ): Promise<InboxItemRecord[]> {
    const out: InboxItemRecord[] = [];
    const oldest = bucketOf(range.from);
    let bucket = bucketOf(after?.eventTime ?? range.to);
    let afterId = after ? types.TimeUuid.fromString(after.id) : null;
    while (out.length < limit && bucket >= oldest) {
      const res = afterId
        ? await this.run(
            `SELECT ${COLUMNS} FROM inbox_by_user WHERE user_id = ? AND bucket = ? AND notif_id < ? LIMIT ?`,
            [userId, bucket, afterId, limit - out.length],
          )
        : await this.run(
            `SELECT ${COLUMNS} FROM inbox_by_user WHERE user_id = ? AND bucket = ? LIMIT ?`,
            [userId, bucket, limit - out.length],
          );
      for (const row of res.rows) {
        const record = this.toRecord(userId, row);
        if (record.eventTime < range.from) return out; // older than retention: nothing newer follows in this order
        if (record.eventTime > range.to) continue;
        out.push(record);
      }
      bucket = previousBucket(bucket);
      afterId = null;
    }
    return out;
  }

  async findOwned(
    userId: string,
    ids: string[],
    range: InboxRange,
  ): Promise<InboxItemRecord[]> {
    const byBucket = new Map<number, types.TimeUuid[]>();
    for (const raw of new Set(ids)) {
      let id: types.TimeUuid;
      try {
        id = types.TimeUuid.fromString(raw);
      } catch {
        continue;
      }
      const at = id.getDate();
      if (at < range.from || at > range.to) continue;
      const bucket = bucketOf(at);
      byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), id]);
    }
    const out: InboxItemRecord[] = [];
    for (const [bucket, bucketIds] of byBucket) {
      const res = await this.run(
        `SELECT ${COLUMNS} FROM inbox_by_user WHERE user_id = ? AND bucket = ? AND notif_id IN ?`,
        [userId, bucket, bucketIds],
      );
      for (const row of res.rows) out.push(this.toRecord(userId, row));
    }
    return out;
  }

  async markRead(userId: string, item: InboxPosition): Promise<boolean> {
    const res = await this.run(
      `UPDATE inbox_by_user SET read = true WHERE user_id = ? AND bucket = ? AND notif_id = ? IF read = false`,
      [userId, bucketOf(item.eventTime), types.TimeUuid.fromString(item.id)],
    );
    return res.wasApplied();
  }

  async readAllBefore(userId: string): Promise<Date | null> {
    const res = await this.run(
      `SELECT read_all_before FROM inbox_state WHERE user_id = ?`,
      [userId],
    );
    return (res.first()?.get('read_all_before') as Date | null) ?? null;
  }

  async setReadAllBefore(userId: string, at: Date): Promise<void> {
    await this.run(
      `UPDATE inbox_state SET read_all_before = ? WHERE user_id = ?`,
      [at, userId],
    );
  }

  async countUnread(
    userId: string,
    bound: number,
    range: InboxRange,
  ): Promise<number> {
    const watermark = await this.readAllBefore(userId);
    const oldest = bucketOf(range.from);
    let count = 0;
    for (
      let bucket = bucketOf(range.to);
      bucket >= oldest;
      bucket = previousBucket(bucket)
    ) {
      let pageState: string | undefined;
      do {
        const res = await withTimeout(
          this.cassandra.execute(
            `SELECT ${COLUMNS} FROM inbox_by_user WHERE user_id = ? AND bucket = ?`,
            [userId, bucket],
            { fetchSize: PAGE, pageState },
          ),
          WIDE_COLUMN_TIMEOUT_MS,
          'inbox store',
        );
        for (const row of res.rows) {
          const record = this.toRecord(userId, row);
          if (record.eventTime < range.from || record.eventTime > range.to)
            continue;
          if (!isEffectivelyRead(record, watermark) && ++count >= bound)
            return bound;
        }
        pageState = res.pageState ?? undefined;
      } while (pageState);
    }
    return count;
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { types } from 'cassandra-driver';
import {
  UNREAD_COUNT_BOUND,
  type NotificationItem,
  type NotificationPage,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { signCursor, verifyCursor } from '../domain/cursor';
import { invalidCursor } from '../domain/errors';
import { isEffectivelyRead } from '../domain/inbox-read';
import { unreadRebuiltCounter } from '../domain/metrics';
import {
  COUNTER_STORE,
  INBOX_STORE,
  type CounterStore,
  type InboxItemRecord,
  type InboxPosition,
  type InboxRange,
  type InboxStore,
} from '../domain/ports';
import { readNotificationsSettings } from './notifications-settings';

/** The inbox keeps 180 days (the stores' row TTL); the window is by age, never by calendar month. */
const RETENTION_MS = 180 * 86_400_000;
/** A producer's clock may run ahead of ours: its newest facts are still the user's. */
const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Reads and read-state of the in-app inbox (FR-037..FR-039) over the `InboxStore` and `CounterStore` ports. Items are
 * written by `NotificationRouterService`. The unread badge is a derived Redis counter (O(1) to read); it is rebuilt from
 * the inbox when absent and repaired by `UnreadReconcileService` after a crash.
 */
@Injectable()
export class InboxService {
  private readonly secret: string;

  constructor(
    @Inject(COUNTER_STORE) private readonly counter: CounterStore,
    @Inject(INBOX_STORE) private readonly store: InboxStore,
    @Inject(CLOCK) private readonly clock: Clock,
    config: ApiConfigService,
  ) {
    this.secret = readNotificationsSettings(config).secret;
  }

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

  private range(): InboxRange {
    const now = this.clock.now().getTime();
    return {
      from: new Date(now - RETENTION_MS),
      to: new Date(now + CLOCK_SKEW_MS),
    };
  }

  /** Newest first by (event time, id); the cursor is signed and bound to `userId`. */
  async list(
    userId: string,
    query: { limit: number; cursor?: string },
  ): Promise<NotificationPage> {
    let after: InboxPosition | null = null;
    if (query.cursor) {
      after = verifyCursor(query.cursor, userId, this.secret);
      if (!after) throw invalidCursor();
    }
    const [records, watermark] = await Promise.all([
      this.store.page(userId, query.limit + 1, after, this.range()),
      this.store.readAllBefore(userId),
    ]);
    const shown = records.slice(0, query.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((record) => toItem(record, watermark)),
      nextCursor:
        records.length > query.limit && last
          ? signCursor(userId, last, this.secret)
          : null,
    };
  }

  /**
   * The counter is derived data: a missing one (never counted, or lost) is rebuilt from the inbox itself, bounded, and
   * stored for the next read. Routing increments only an existing counter, so a rebuild is always up to date.
   */
  async unreadCount(userId: string): Promise<number> {
    const cached = await this.counter.get(userId);
    if (cached !== null) return Math.min(cached, UNREAD_COUNT_BOUND);
    return this.rebuildUnread(userId);
  }

  /** Counts the unread items of the retention window (stopping at the bound) and stores the result. */
  async rebuildUnread(userId: string): Promise<number> {
    const rebuilt = await this.store.countUnread(
      userId,
      UNREAD_COUNT_BOUND,
      this.range(),
    );
    await this.counter.set(userId, rebuilt);
    unreadRebuiltCounter.add(1);
    return rebuilt;
  }

  /**
   * Foreign, unknown and expired ids are ignored. The row flips once (`IF read = false`), so two tabs marking the same
   * item decrement the badge once; an item already covered by "mark all" is not counted again.
   */
  async markRead(userId: string, ids: string[]): Promise<number> {
    const owned = await this.store.findOwned(
      userId,
      [...new Set(ids)],
      this.range(),
    );
    const watermark = await this.store.readAllBefore(userId);
    let flipped = 0;
    for (const item of owned) {
      if (isEffectivelyRead(item, watermark)) continue;
      if (await this.store.markRead(userId, item)) flipped++;
    }
    if (flipped > 0) await this.counter.decrement(userId, flipped);
    return this.unreadCount(userId);
  }

  /**
   * O(1): a watermark on arrival time instead of rewriting rows, so whatever arrives afterwards stays unread, even with
   * an older event time. An arrival racing the counter reset leaves the user dirty, and the sweep recounts.
   */
  async markAllRead(userId: string): Promise<number> {
    const now = this.clock.now();
    const previous = await this.store.readAllBefore(userId);
    await this.counter.markDirty(userId, now);
    await this.store.setReadAllBefore(
      userId,
      previous && previous > now ? previous : now,
    );
    await this.counter.set(userId, 0);
    return 0;
  }
}

function toItem(
  record: InboxItemRecord,
  watermark: Date | null,
): NotificationItem {
  return {
    id: record.id,
    type: record.type,
    category: record.category,
    title: record.title,
    body: record.body,
    link: record.link,
    read: isEffectivelyRead(record, watermark),
    createdAt: record.eventTime.toISOString(),
  };
}

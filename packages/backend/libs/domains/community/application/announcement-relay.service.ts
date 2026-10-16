import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { EventPublisher } from '@app/infrastructure/events/event-publisher';
import { feedRelayBacklog, feedRelayCounter } from '../domain/feed-metrics';
import {
  announcementEventId,
  FeedItemPublished,
  RELAY_SHARDS_PER_HOUR,
} from '../domain/feed-events';
import { isTimeUuid } from '../domain/ids';
import { dayOf, hourOf } from '../domain/months';
import {
  ANNOUNCEMENT_STORE,
  type AnnouncementStore,
  type PendingAnnouncement,
} from '../domain/ports';

const BATCH = 200;
const HOUR_MS = 3_600_000;

/**
 * Announces stored items on `feed.item_published` at least once (S26 B2, R-5, AS-48). The announcement row was written in
 * the item batch; it is deleted only after the bus accepted the event, whose `eventId` derives from the item id, so a
 * repeat after a crash is the same event and harmless (the fan-out consumer is idempotent). A row that cannot become a
 * valid announcement goes to `dead_announcements` with the reason and has no other effect.
 */
@Injectable()
export class AnnouncementRelayService {
  private readonly logger = new Logger(AnnouncementRelayService.name);

  constructor(
    @Inject(ANNOUNCEMENT_STORE) private readonly store: AnnouncementStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly publisher: EventPublisher,
  ) {}

  /** Scans the relay shards of the last `hours` hours (48 covers everything the queue keeps). */
  async relay(
    hours = 3,
  ): Promise<{ published: number; failed: number; dead: number }> {
    const shards: number[] = [];
    for (let h = 0; h <= hours; h++) {
      const hour = hourOf(new Date(this.clock.nowMs() - h * HOUR_MS));
      for (let s = 0; s < RELAY_SHARDS_PER_HOUR; s++)
        shards.push(hour * RELAY_SHARDS_PER_HOUR + s);
    }
    const result = { published: 0, failed: 0, dead: 0 };
    const pending = await this.store.pending(shards, BATCH);
    feedRelayBacklog.set(pending.length);
    for (const row of pending) {
      const verdict = this.envelope(row);
      if (typeof verdict === 'string') {
        await this.store.deadLetter(row, verdict, dayOf(this.clock.now()));
        feedRelayCounter.add(1, { result: 'dead' });
        result.dead++;
        continue;
      }
      try {
        await this.publisher.publish(verdict);
        await this.store.delivered(row);
        feedRelayCounter.add(1, { result: 'published' });
        result.published++;
      } catch (error) {
        feedRelayCounter.add(1, { result: 'failed' });
        this.logger.warn(
          `announcement relay failed cause=${(error as Error).name}`,
        );
        result.failed++;
      }
    }
    return result;
  }

  /** The envelope when the row is a valid announcement; otherwise the reason (a short code, never the content). */
  private envelope(row: PendingAnnouncement) {
    if (!isTimeUuid(row.itemId)) return 'invalid_item_id';
    const createdAt = row.createdAt instanceof Date ? row.createdAt : null;
    if (!createdAt || Number.isNaN(createdAt.getTime()))
      return 'invalid_created_at';
    const payload = FeedItemPublished.schema.safeParse({
      itemId: row.itemId,
      authorId: row.authorId,
      kind: row.kind,
      createdAt: createdAt.toISOString(),
    });
    if (!payload.success) return 'invalid_payload';
    return {
      ...FeedItemPublished.create(row.authorId, 1, payload.data, createdAt),
      eventId: announcementEventId(row.itemId),
    };
  }
}

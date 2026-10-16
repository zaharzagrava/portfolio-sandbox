import { feedItemPublishedPayloadSchema } from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';

/**
 * `feed.events` (key = `authorId`): the announcement that a feed item was stored (S26 contracts/events.md). Recorded in
 * the item batch (`pending_announcements`) and relayed at least once; `eventId` derives from `itemId`. Modules that
 * publish or consume it register the aggregate with `EventsModule.forAggregates([FEED_AGGREGATE])`.
 */
export const FEED_AGGREGATE: TopicRegistration = {
  aggregateType: 'feed',
  retention: 'full-history',
};

export const FeedItemPublished = defineEvent(
  'feed.item_published',
  'feed',
  1,
  feedItemPublishedPayloadSchema,
);

export const FEED_EVENTS = [FeedItemPublished] as const;

export const RELAY_SHARDS_PER_HOUR = 8;

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Relay shard of an announcement: `yyyymmddhh * 8 + hash(itemId) % 8` (data-model.md). The hour is the hour it was
 * stored, so the relay finds it by walking the recent hours.
 */
export function announcementShard(itemId: string, at: Date): number {
  const hour = Number(
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}${pad(at.getUTCHours())}`,
  );
  const tail = Number.parseInt(itemId.replace(/-/g, '').slice(-2), 16);
  return (
    hour * RELAY_SHARDS_PER_HOUR +
    (Number.isNaN(tail) ? 0 : tail % RELAY_SHARDS_PER_HOUR)
  );
}

/**
 * The `eventId` of the announcement of an item: a UUIDv7-shaped id derived from the item id, so a repeated
 * announcement of the same item carries the same id (contracts/events.md). The 48-bit prefix is the item's time.
 */
export function announcementEventId(itemId: string): string {
  const m =
    /^([0-9a-f]{8})-([0-9a-f]{4})-1([0-9a-f]{3})-([0-9a-f]{4})-([0-9a-f]{12})$/.exec(
      itemId.toLowerCase(),
    );
  if (!m) throw new RangeError('not a time-based UUID');
  const timestamp = BigInt(`0x${m[3]}${m[2]}${m[1]}`);
  const ms = timestamp / 10_000n - 12_219_292_800_000n;
  const prefix = ms.toString(16).padStart(12, '0').slice(-12);
  const variant = ((Number.parseInt(m[4][0], 16) & 0x3) | 0x8).toString(16);
  return `${prefix.slice(0, 8)}-${prefix.slice(8)}-7${m[1].slice(5)}-${variant}${m[4].slice(1)}-${m[5]}`;
}

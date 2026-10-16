import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuctionCreated, AuctionOpened } from '@app/domains/auctions';
import {
  ProductArchived,
  ProductCreated,
  ProductDeleted,
  ProductRestored,
  ProductUpdated,
} from '@app/domains/catalog';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { FanoutService } from '../application/fanout.service';
import {
  ItemProjectionService,
  type ItemOutcome,
} from '../application/item-projection.service';
import {
  DiscussionPostCreated,
  DiscussionPostDeleted,
} from '../domain/discussion-events';
import { FeedItemPublished } from '../domain/feed-events';
import type { ProductEventKind } from '../domain/item-rules';

const counts = (): SinkCounts => ({ applied: 0, duplicate: 0, stale: 0 });
const note = (sink: SinkCounts, outcome: ItemOutcome | 'stale') => {
  if (outcome === 'created') sink.applied++;
  else if (outcome === 'duplicate') sink.duplicate++;
  else sink.stale++;
};

/** Most attempts a consumer makes at an event that waits for another event (FR-025) before it is dead-lettered. */
const WAITING_ATTEMPTS = 5;

const SNAPSHOTS = [
  [ProductCreated, 'created'],
  [ProductUpdated, 'updated'],
  [ProductArchived, 'archived'],
  [ProductRestored, 'restored'],
] as const;

/**
 * `products.events` -> the product copy and the `new_product` / `price_drop` items (S26 B3, B4, D-7, D-12). The topic is
 * compacted and carries full state, but the consumer is not coalesced: every step of a price matters. The copy is moved by
 * a version-guarded conditional write, so a duplicate or older event has no effect. `catalog.product_changed` is not in
 * `handles`, so the framework skips it.
 */
@Injectable()
export class FeedProductsProjector implements Projector {
  readonly name = 'feed-products';
  readonly topics = [ProductCreated.topic];
  readonly idempotency = 'versionGuard' as const;
  readonly handles = [
    { event: ProductCreated },
    { event: ProductUpdated },
    { event: ProductArchived },
    { event: ProductRestored },
    { event: ProductDeleted },
  ];
  readonly aggregateIdSchema = z.string().uuid();

  constructor(private readonly items: ItemProjectionService) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const sink = counts();
    for (const event of events) {
      const deleted = ProductDeleted.match(event);
      if (deleted) {
        await this.items.applyProductDeleted(deleted.payload);
        sink.applied++;
        continue;
      }
      for (const [definition, kind] of SNAPSHOTS) {
        const matched = definition.match(event);
        if (!matched) continue;
        note(
          sink,
          await this.items.applyProduct(
            kind as ProductEventKind,
            matched.payload,
            new Date(event.occurredAt),
          ),
        );
        break;
      }
    }
    return sink;
  }
}

/** `discussion.events` -> `post` items; a deletion seen first is remembered for 30 days (S26 B3, AS-17). */
@Injectable()
export class FeedPostsProjector implements Projector {
  readonly name = 'feed-posts';
  readonly topics = [DiscussionPostCreated.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [
    { event: DiscussionPostCreated },
    { event: DiscussionPostDeleted },
  ];

  constructor(private readonly items: ItemProjectionService) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const sink = counts();
    for (const event of events) {
      const deleted = DiscussionPostDeleted.match(event);
      if (deleted) {
        await this.items.postDeleted(deleted.payload.postId);
        sink.applied++;
        continue;
      }
      const created = DiscussionPostCreated.match(event);
      if (created)
        note(
          sink,
          await this.items.postCreated(
            created.payload,
            new Date(event.occurredAt),
          ),
        );
    }
    return sink;
  }
}

/**
 * `auctions.events` -> `drop_announced` and `auction_started` items. The title comes from the product copy; without it the
 * event waits: it is retried (at most 5 attempts) and then dead-lettered, never half-applied (FR-025).
 */
@Injectable()
export class FeedAuctionsProjector implements Projector {
  readonly name = 'feed-auctions';
  readonly topics = [AuctionCreated.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: AuctionCreated }, { event: AuctionOpened }];
  readonly attempts = WAITING_ATTEMPTS;

  constructor(private readonly items: ItemProjectionService) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const sink = counts();
    for (const event of events) {
      const created = AuctionCreated.match(event);
      if (created) {
        const p = created.payload;
        note(
          sink,
          await this.items.auction(
            'created',
            {
              auctionId: p.auctionId,
              shopId: p.shopId,
              productId: p.productId,
              startsAt: p.startsAt,
            },
            new Date(event.occurredAt),
          ),
        );
        continue;
      }
      const opened = AuctionOpened.match(event);
      if (opened) {
        const p = opened.payload;
        note(
          sink,
          await this.items.auction(
            'opened',
            {
              auctionId: p.auctionId,
              shopId: p.shopId,
              productId: p.productId,
              endsAt: p.endsAt,
            },
            new Date(event.occurredAt),
          ),
        );
      }
    }
    return sink;
  }
}

/**
 * `feed.events` (key `authorId`, so one author's announcements arrive in order) -> pushes to the active followers'
 * timelines. A completed fan-out is recorded per item, so a redelivery does nothing twice.
 */
@Injectable()
export class FeedFanoutProjector implements Projector {
  readonly name = 'feed-fanout';
  readonly topics = [FeedItemPublished.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: FeedItemPublished }];

  constructor(private readonly fanout: FanoutService) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const sink = counts();
    for (const event of events) {
      const published = FeedItemPublished.match(event);
      if (!published) continue;
      try {
        const result = await this.fanout.fanOut(published.payload);
        if (result.replayed) sink.duplicate++;
        else sink.applied++;
      } catch (error) {
        if (error instanceof RangeError)
          throw new PermanentError('invalid_item_id', { cause: error });
        throw error;
      }
    }
    return sink;
  }
}

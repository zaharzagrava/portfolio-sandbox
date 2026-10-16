import { Module } from '@nestjs/common';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { CelebrityRecentsService } from './application/celebrity-recents.service';
import { FanoutService } from './application/fanout.service';
import { ItemProjectionService } from './application/item-projection.service';
import { FEED_AGGREGATE } from './domain/feed-events';
import { FeedStoresModule } from './feed-stores.module';
import { FollowQueryModule } from './follow-query.module';
import {
  FeedAuctionsProjector,
  FeedFanoutProjector,
  FeedPostsProjector,
  FeedProductsProjector,
} from './infra/feed-projectors';

/**
 * Read-model side of the feed (apps/projector, S26): the four consumers (`products.events`, `discussion.events`,
 * `auctions.events`, `feed.events`). The app lists `FeedProjectorsModule.projectors` in
 * `ProjectionsModule.forProjectors` and imports this module for what they inject. No consumer class is exported from the
 * domain barrel (X.4, D-8).
 */
@Module({
  imports: [
    FeedStoresModule,
    FollowQueryModule,
    ClockModule,
    EventsModule.forAggregates([FEED_AGGREGATE]),
  ],
  providers: [
    ItemProjectionService,
    CelebrityRecentsService,
    FanoutService,
    FeedProductsProjector,
    FeedPostsProjector,
    FeedAuctionsProjector,
    FeedFanoutProjector,
  ],
  exports: [
    FeedProductsProjector,
    FeedPostsProjector,
    FeedAuctionsProjector,
    FeedFanoutProjector,
    ItemProjectionService,
    FanoutService,
    FeedStoresModule,
  ],
})
export class FeedProjectorsModule {
  static readonly projectors = [
    FeedProductsProjector,
    FeedPostsProjector,
    FeedAuctionsProjector,
    FeedFanoutProjector,
  ];
}

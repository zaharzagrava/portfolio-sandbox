import { Module } from '@nestjs/common';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { AnnouncementRelayService } from './application/announcement-relay.service';
import { FeedReconcileService } from './application/feed-reconcile.service';
import { FEED_AGGREGATE } from './domain/feed-events';
import { FeedStoresModule } from './feed-stores.module';
import { FeedJobs } from './infra/feed.jobs';

/**
 * Background side of the feed (apps/worker, S26 E5): the single owner of the announcement relay and of the scheduled
 * jobs. It registers the `feed` aggregate with the topic registry, so `feed.events` exists before the first publish.
 * Shares the stores module with the HTTP and projector sides; it provides no second copy of any store.
 */
@Module({
  imports: [
    FeedStoresModule,
    ClockModule,
    JobsModule,
    EventsModule.forAggregates([FEED_AGGREGATE]),
  ],
  providers: [AnnouncementRelayService, FeedReconcileService, FeedJobs],
  exports: [AnnouncementRelayService],
})
export class FeedWorkerModule {}

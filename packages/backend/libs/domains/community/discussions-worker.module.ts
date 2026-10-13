import { Module } from '@nestjs/common';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { BackfillService } from './application/backfill.service';
import { EventRelayService } from './application/event-relay.service';
import { ReconcileService } from './application/reconcile.service';
import { DiscussionsStoresModule } from './discussions-stores.module';
import { DISCUSSION_AGGREGATE } from './domain/discussion-events';
import { BACKFILL_STORE } from './domain/ports';
import { DiscussionsJobs } from './infra/discussions.jobs';
import { ScyllaBackfillStore } from './infra/scylla-backfill.store';

/**
 * Background side of discussions (apps/worker, S25 G7): the single owner of the scheduled jobs and of the event relay.
 * It registers the `discussion` aggregate with the topic registry, so `discussion.events` exists before the first
 * publish. Shares the stores module with the HTTP side; it provides no second copy of any service.
 */
@Module({
  imports: [
    DiscussionsStoresModule,
    JobsModule,
    EventsModule.forAggregates([DISCUSSION_AGGREGATE]),
  ],
  providers: [
    { provide: BACKFILL_STORE, useClass: ScyllaBackfillStore },
    BackfillService,
    ReconcileService,
    EventRelayService,
    DiscussionsJobs,
  ],
  exports: [ReconcileService, EventRelayService],
})
export class DiscussionsWorkerModule {}

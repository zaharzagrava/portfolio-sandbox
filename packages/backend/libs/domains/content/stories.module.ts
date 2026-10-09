import { Injectable, Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { StoriesService } from './application/stories.service';
import { StoriesController } from './api/stories.controller';
import {
  CDN_PURGER_PROVIDER,
  StoryCacheInvalidator,
} from './infra/cache-invalidation';

/** SD-05 CMS + public read (core). */
@Module({
  imports: [
    AuthModule,
    EventsModule.forAggregates([
      { aggregateType: 'stories', retention: 'full-history' },
    ]),
    JobsModule,
  ],
  providers: [StoriesService],
  exports: [StoriesService],
  controllers: [StoriesController],
})
export class StoriesModule {}

@Injectable()
export class StoriesJobs {
  constructor(private readonly stories: StoriesService) {}

  @JobHandler('stories.publish', { concurrency: 5 })
  publish(payload: { storyId: string; scheduledAt: string }) {
    return this.stories.publishScheduled(payload);
  }
}

/** SD-05 scheduled publishing (apps/worker). */
@Module({
  imports: [
    EventsModule.forAggregates([
      { aggregateType: 'stories', retention: 'full-history' },
    ]),
    JobsModule,
  ],
  providers: [StoriesService, StoriesJobs],
})
export class StoriesWorkerModule {}

/** SD-05 cache invalidation consumer deps (apps/projector). */
@Module({ providers: [CDN_PURGER_PROVIDER], exports: [CDN_PURGER_PROVIDER] })
export class StoryCacheModule {}

export { StoryCacheInvalidator };

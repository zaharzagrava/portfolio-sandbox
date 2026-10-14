import { Module } from '@nestjs/common';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { StoreDeadLetterWatcher } from './application/store-dead-letter-watcher.service';
import { AnalyticsJobs } from './infra/analytics.jobs';

/** Background side of analytics (apps/worker): the dead-letter watcher job, scheduled through the jobs toolkit (S49). */
@Module({
  imports: [ClickHouseModule, JobsModule],
  providers: [StoreDeadLetterWatcher, AnalyticsJobs],
  exports: [StoreDeadLetterWatcher],
})
export class AnalyticsWorkerModule {}

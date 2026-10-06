import { Module } from '@nestjs/common';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { CoOccurrenceJobs } from './infra/co-occurrence.jobs';

/** X-01 nightly build (apps/worker). */
@Module({
  imports: [ClickHouseModule, JobsModule],
  providers: [CoOccurrenceJobs],
  exports: [CoOccurrenceJobs],
})
export class RecommendationsWorkerModule {}

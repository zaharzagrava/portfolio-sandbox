import { Module } from '@nestjs/common';
import { TenancyBackfillJobs } from './infra/tenancy-backfill.jobs';

/** Backfill job, hosted by apps/worker. Enqueue once: `jobs.enqueue('tenancy.backfill-shops', {})`. */
@Module({
  providers: [TenancyBackfillJobs],
})
export class TenancyWorkerModule {}

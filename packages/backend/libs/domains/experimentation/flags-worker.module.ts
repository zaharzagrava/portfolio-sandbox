import { Module } from '@nestjs/common';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { RulesetPublisherService } from './application/ruleset-publisher.service';
import { RulesetRepairService } from './application/ruleset-repair.service';
import { FlagsStoresModule } from './flags-stores.module';
import { FlagsJobs } from './infra/flags.jobs';

/**
 * Background side of flags (apps/worker, S38 R-8): the ruleset repair job, scheduled through the jobs toolkit (S49).
 * Shares the stores module with the other sides; it provides no second copy of any adapter.
 */
@Module({
  imports: [FlagsStoresModule, JobsModule],
  providers: [RulesetPublisherService, RulesetRepairService, FlagsJobs],
  exports: [RulesetRepairService],
})
export class FlagsWorkerModule {}

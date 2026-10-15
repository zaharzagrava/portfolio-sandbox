import { Module } from '@nestjs/common';
import { BillingCoreModule } from './billing-core.module';
import { BillingJobs } from './infra/billing.jobs';

/** Background side (apps/worker): the billing run, the charge, resolution and manual-attempt jobs, and the schedule. */
@Module({
  imports: [BillingCoreModule],
  providers: [BillingJobs],
  exports: [BillingJobs],
})
export class BillingWorkerModule {}

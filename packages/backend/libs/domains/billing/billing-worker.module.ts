import { Module } from '@nestjs/common';
import { BillingCoreModule } from './billing-core.module';
import { BillingJobs } from './infra/billing.jobs';
import { UsageReconcileJob } from './infra/usage-reconcile.job';

/**
 * Background side (apps/worker): the billing run, the charge, resolution and manual-attempt jobs and their schedule
 * (S17), and S18's daily check of the usage settlement ledger.
 */
@Module({
  imports: [BillingCoreModule],
  providers: [BillingJobs, UsageReconcileJob],
  exports: [BillingJobs, UsageReconcileJob],
})
export class BillingWorkerModule {}

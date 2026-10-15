import { Module } from '@nestjs/common';
import { PayoutJobs } from './infra/payout.jobs';
import { PayoutsCoreModule } from './payouts-core.module';

/** Background side (apps/worker): the weekly run, the send, the resolver and the audit job handlers. */
@Module({
  imports: [PayoutsCoreModule],
  providers: [PayoutJobs],
  exports: [PayoutJobs],
})
export class PayoutsWorkerModule {}

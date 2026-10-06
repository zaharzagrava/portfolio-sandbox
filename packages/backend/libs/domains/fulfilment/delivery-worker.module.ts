import { Module } from '@nestjs/common';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { DeliveryCoreModule } from './delivery-core.module';
import { OfferTimeoutWorker, SurgeJob } from './infra/delivery-workers';

/** SD-23 (apps/worker): offer timeouts + surge. */
@Module({
  imports: [DeliveryCoreModule, JobsModule],
  providers: [OfferTimeoutWorker, SurgeJob],
  exports: [SurgeJob, OfferTimeoutWorker],
})
export class DeliveryWorkerModule {}

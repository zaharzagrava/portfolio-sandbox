import { Module } from '@nestjs/common';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { PaymentsCoreModule } from './payments-core.module';
import { RefundRequestService } from './application/refund-request.service';
import { ChargeCommandWorker } from './infra/charge-command.worker';
import { OrdersEventsConsumer } from './infra/orders-events.consumer';
import { PaymentJobs } from './infra/payment.jobs';
import { RefundRequestWorker } from './infra/refund-request.worker';

/**
 * The queue workers (charge command, refund request) and the job handlers. The e2e specs load this module without a
 * `TaskQueue` consumer running and call the workers and handlers directly, so nothing polls in a spec.
 */
@Module({
  imports: [PaymentsCoreModule],
  providers: [
    RefundRequestService,
    ChargeCommandWorker,
    RefundRequestWorker,
    PaymentJobs,
  ],
  exports: [ChargeCommandWorker, RefundRequestWorker, PaymentJobs],
})
export class PaymentProcessingModule {}

/**
 * Background side (apps/payment-processor, apps/worker): processing plus the consumer of `orders.events`. The consumer
 * is only started by the Kafka framework here; specs call `OrdersEventsConsumer.project` through their own probe module.
 */
@Module({
  imports: [
    PaymentProcessingModule,
    ProjectionsModule.forProjectors(
      [OrdersEventsConsumer],
      [PaymentsCoreModule],
    ),
  ],
})
export class PaymentProcessorModule {}

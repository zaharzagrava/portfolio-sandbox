import { Module } from '@nestjs/common';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { OrderCommandModule } from '@app/domains/orders';
import { DeliveryCoreModule } from './delivery-core.module';
import { OrderLifecycleService } from './application/order-lifecycle.service';
import { ORDER_LIFECYCLE_PORT } from './domain/delivery-ports';
import { DeliveryJobHandlers } from './infra/delivery-job-handlers';
import { DeliveryQueueWorker } from './infra/delivery-queue.worker';
import { OrderLifecycleAdapter } from './infra/order-lifecycle.adapter';
import { RingHeartbeat } from './infra/ring-heartbeat';

/**
 * SD-23 (apps/worker): the timer queue consumer, the recovery, surge and order write-back jobs, and the ring heartbeat
 * that makes this instance an owner of cities (graceful leave on shutdown). The order is reached through the orders
 * capability's exported command service only (R1).
 */
@Module({
  imports: [DeliveryCoreModule, JobsModule, OrderCommandModule],
  providers: [
    { provide: ORDER_LIFECYCLE_PORT, useClass: OrderLifecycleAdapter },
    OrderLifecycleService,
    RingHeartbeat,
    DeliveryQueueWorker,
    DeliveryJobHandlers,
  ],
  exports: [DeliveryQueueWorker, DeliveryJobHandlers, RingHeartbeat],
})
export class DeliveryWorkerModule {}

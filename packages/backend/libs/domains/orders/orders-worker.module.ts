import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { FlashStockService } from './infra/flash-stock.service';
import { FlashSaleJobs } from './infra/flash-sale.jobs';
import { OrderJobs } from './infra/order.jobs';
import { PaymentsEventsConsumer } from './infra/payments-events.consumer';
import { ORDER_MODELS } from './orders-models';
import { OrdersCoreModule } from './orders-core.module';

/** The job handlers: hold expiry, sweeper, recovery, release, cart clean-up, webhook processing, flash-sale lifecycle. */
@Module({
  imports: [OrdersCoreModule, SequelizeModule.forFeature(ORDER_MODELS)],
  providers: [FlashStockService, FlashSaleJobs, OrderJobs],
})
export class OrdersJobsModule {}

/**
 * Background side of orders (apps/worker): the job handlers and the consumer of `payments.events`. The e2e specs load
 * `OrdersJobsModule` alone and call the handlers and the consumer directly, so no Kafka consumer starts in a spec.
 */
@Module({
  imports: [
    OrdersJobsModule,
    ProjectionsModule.forProjectors(
      [PaymentsEventsConsumer],
      [OrdersCoreModule],
    ),
  ],
})
export class OrdersWorkerModule {}

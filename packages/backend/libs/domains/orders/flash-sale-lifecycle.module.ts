import { Module } from '@nestjs/common';
import { ProductModule } from '@app/domains/catalog';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { ORDERS_AGGREGATE } from './application/events/order-events';
import { FlashLifecycleService } from './application/flash-lifecycle.service';
import { FlashSaleCoreModule } from './flash-sale-core.module';
import { OrdersCoreModule } from './orders-core.module';

/** The lifecycle service, shared by the routes (cancel) and the jobs (load, end, reconcile, verify, sweep). */
@Module({
  imports: [
    OrdersCoreModule,
    FlashSaleCoreModule,
    ProductModule,
    JobsModule,
    EventsModule.forAggregates([ORDERS_AGGREGATE]),
  ],
  providers: [FlashLifecycleService],
  exports: [FlashLifecycleService],
})
export class FlashSaleLifecycleModule {}

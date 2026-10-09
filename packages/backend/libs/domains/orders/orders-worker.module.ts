import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { RealtimeModule } from '@app/infrastructure/realtime/realtime.module';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { FlashStockService } from './infra/flash-stock.service';
import { OrderService } from './application/order.service';
import { OrderJobs } from './infra/order.jobs';
import { OrderPaymentListener } from './infra/order-payment.listener';
import { ORDER_MODELS } from './orders.module';

/** Order state machine for background code: the payment listener runs inside ProjectionsModule, so it needs an exporting module. */
@Module({
  imports: [
    EventsModule,
    RealtimeModule,
    SequelizeModule.forFeature(ORDER_MODELS),
  ],
  providers: [FlashStockService, OrderService],
  exports: [FlashStockService, OrderService],
})
class OrderStateModule {}

/** SD-19 background side (apps/worker): hold expiry, flash-sale lifecycle, payment → order saga step. */
@Module({
  imports: [
    OrderStateModule,
    SequelizeModule.forFeature(ORDER_MODELS),
    ProjectionsModule.forProjectors(
      [OrderPaymentListener],
      [SequelizeModule.forFeature(ORDER_MODELS), OrderStateModule],
    ),
  ],
  providers: [OrderJobs],
})
export class OrdersWorkerModule {}

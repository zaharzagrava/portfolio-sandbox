import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { ConsumerPauseFlags } from '@app/infrastructure/projections/consumer-pause';
import { VoucherService } from './application/voucher.service';
import VoucherModel from './infra/models/voucher.model';
import { BookingVoucherConsumer } from './infra/booking-voucher.consumer';

/**
 * The voucher record and what reads and writes it (J03 G-04, G-44), without a queue consumer: the HTTP side
 * (`OrdersModule`) and the e2e specs load this alone and call the service directly.
 */
@Module({
  imports: [ClockModule, SequelizeModule.forFeature([VoucherModel])],
  providers: [VoucherService],
  exports: [VoucherService],
})
export class VouchersCoreModule {}

/** Background side: the consumer of `orders-booking-voucher-requested` (apps/worker, local monolith). */
@Module({
  imports: [VouchersCoreModule, RedisModule],
  providers: [BookingVoucherConsumer, ConsumerPauseFlags],
})
export class VouchersWorkerModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { DeliveryCoreModule } from './delivery-core.module';
import { DeliveryController } from './api/delivery.controller';

/** SD-23 HTTP side (core). */
@Module({
  imports: [AuthModule, DeliveryCoreModule],
  controllers: [DeliveryController],
})
export class DeliveryModule {}

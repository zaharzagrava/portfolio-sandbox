import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { DeliveryReadService } from './application/delivery-read.service';
import { DeliveryRequestService } from './application/delivery-request.service';
import { DeliveryCoreModule } from './delivery-core.module';
import { CourierController } from './api/courier.controller';
import { DeliveryController } from './api/delivery.controller';
import { ShopDeliveryController } from './api/shop-delivery.controller';
import { fulfilmentRatePolicies } from './rate-limit-policies';

/**
 * SD-23 HTTP side (core): the courier's own routes, the courier's delivery actions, the role reads and the shop's
 * delivery routes (request is `@Idempotent`, so the idempotency module is imported).
 */
@Module({
  imports: [
    AuthModule,
    DeliveryCoreModule,
    IdempotencyModule,
    RateLimitModule.forFeature(fulfilmentRatePolicies),
  ],
  controllers: [CourierController, DeliveryController, ShopDeliveryController],
  providers: [DeliveryRequestService, DeliveryReadService],
})
export class DeliveryModule {}

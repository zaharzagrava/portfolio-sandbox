import { Module } from '@nestjs/common';
import { OrderEntitlementService } from './application/order-entitlement.service';
import { ORDER_REPOSITORY } from './domain/ports';
import { SequelizeOrderRepository } from './infra/order.repository';

/** `OrderEntitlementService` alone, for capabilities that only ask what a buyer has paid for. No route, no events. */
@Module({
  providers: [
    { provide: ORDER_REPOSITORY, useClass: SequelizeOrderRepository },
    OrderEntitlementService,
  ],
  exports: [OrderEntitlementService],
})
export class OrderEntitlementModule {}

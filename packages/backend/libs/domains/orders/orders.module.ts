import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import BisOrder from './infra/models/bis-order.model';
import BisOrderItem from './infra/models/bis-order-item.model';
import ShopOrder from './infra/models/shop-order.model';
import StockReservation from './infra/models/stock-reservation.model';
import FlashSale from './infra/models/flash-sale.model';
import { ProductModel as Product } from '@app/domains/catalog';
import { PaymentModel as Payment } from '@app/domains/payments';
import { ApiConfigModule } from '@app/common/config';
import { AuthModule } from '@app/domains/identity';
import { StripeModule } from '@app/infrastructure/stripe/stripe.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { RealtimeModule } from '@app/infrastructure/realtime/realtime.module';
import { CartRepository } from './infra/cart.repository';
import { FlashStockService } from './infra/flash-stock.service';
import { OrderService } from './application/order.service';
import { CheckoutService } from './application/checkout.service';
import { CartController } from './api/cart.controller';
import { OrdersController } from './api/orders.controller';
import { StripeWebhookController } from './api/stripe-webhook.controller';

import { TenancyModule } from '@app/domains/tenancy';

export const ORDER_MODELS = [
  BisOrder,
  BisOrderItem,
  ShopOrder,
  StockReservation,
  FlashSale,
  Product,
  Payment,
];

/** SD-19 HTTP side (core). Needs global Redis + Dynamo modules. */
@Module({
  imports: [
    ApiConfigModule,
    AuthModule,
    StripeModule,
    EventsModule.forAggregates([
      { aggregateType: 'orders', retention: 'full-history' },
    ]),
    JobsModule,
    RealtimeModule,
    TenancyModule,
    SequelizeModule.forFeature(ORDER_MODELS),
  ],
  providers: [CartRepository, FlashStockService, OrderService, CheckoutService],
  exports: [OrderService, FlashStockService, CartRepository],
  controllers: [CartController, OrdersController, StripeWebhookController],
})
export class OrdersModule {}

import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { AuthModule } from '@app/domains/identity';
import { ProductModule } from '@app/domains/catalog';
import { TenancyModule } from '@app/domains/tenancy';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { InboxModule } from '@app/infrastructure/inbox';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { FlashSaleCoreModule } from './flash-sale-core.module';
import { FlashSaleModule } from './flash-sale.module';
import { OrderService } from './application/order.service';
import { CartService } from './application/cart.service';
import { CheckoutService } from './application/checkout.service';
import { WebhookIntakeService } from './application/webhook-intake.service';
import { CartCookie } from './api/cart-cookie';
import { CartController } from './api/cart.controller';
import { CheckoutController } from './api/checkout.controller';
import { OrdersController } from './api/orders.controller';
import { VouchersController } from './api/vouchers.controller';
import { VouchersCoreModule } from './vouchers-core.module';
import { ShopOrdersController } from './api/shop-orders.controller';
import { EmptyBodyMiddleware } from './api/empty-body.middleware';
import { StripeWebhookController } from './api/stripe-webhook.controller';
import { WebhookRawBodyMiddleware } from './api/webhook-raw-body.middleware';
import { ORDER_MODELS } from './orders-models';
import { OrdersCoreModule } from './orders-core.module';
import { ordersRatePolicies } from './rate-limit-policies';

export { ORDER_MODELS } from './orders-models';

/** HTTP side (apps/core): the cart, checkout, order and webhook routes. Shares its providers with the worker side. */
@Module({
  imports: [
    OrdersCoreModule,
    AuthModule,
    ProductModule,
    TenancyModule,
    IdempotencyModule,
    InboxModule,
    FlashSaleCoreModule,
    FlashSaleModule,
    VouchersCoreModule,
    RateLimitModule.forFeature(ordersRatePolicies),
    SequelizeModule.forFeature(ORDER_MODELS),
  ],
  providers: [
    OrderService,
    CartService,
    CartCookie,
    CheckoutService,
    WebhookIntakeService,
  ],
  exports: [OrdersCoreModule, OrderService],
  controllers: [
    CartController,
    CheckoutController,
    VouchersController, // before OrdersController: `/orders/vouchers` must not reach `/orders/:orderId`
    OrdersController,
    ShopOrdersController,
    StripeWebhookController,
  ],
})
export class OrdersModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(WebhookRawBodyMiddleware)
      .forRoutes({ path: 'webhooks/stripe', method: RequestMethod.POST });
    consumer
      .apply(EmptyBodyMiddleware)
      .forRoutes({ path: 'checkout', method: RequestMethod.POST });
  }
}

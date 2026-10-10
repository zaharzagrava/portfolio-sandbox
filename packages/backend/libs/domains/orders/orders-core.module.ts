import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config';
import { ProblemCatalogModule } from '@app/common/errors';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { InboxModule } from '@app/infrastructure/inbox';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { RealtimeModule } from '@app/infrastructure/realtime/realtime.module';
import { ProductModule } from '@app/domains/catalog';
import { TenancyModule } from '@app/domains/tenancy';
import { ORDER_MODELS } from './orders-models';
import {
  CART_STORE,
  CHECKOUT_LOCK,
  ORDER_HISTORY_REPOSITORY,
  ORDER_REPOSITORY,
  PAYMENT_STATUS,
  PRODUCT_CATALOG,
  REALTIME_PORT,
  REFUND_COMMAND,
  RESERVATION_REPOSITORY,
  RESERVATION_SOURCE,
  SHOP_DIRECTORY,
  SHOP_DISCOUNTS,
  SHOP_ORDER_REPOSITORY,
} from './domain/ports';
import { ORDERS_PROBLEMS } from './domain/order-problems';
import { ORDERS_AGGREGATE } from './application/events/order-events';
import { OrderFulfilmentService } from './application/order-fulfilment.service';
import { OrderCancellationService } from './application/order-cancellation.service';
import { OrderLifecycleService } from './application/order-lifecycle.service';
import { OrderQueryService } from './application/order-query.service';
import { OrderReservationService } from './application/order-reservation.service';
import { PaymentResultService } from './application/payment-result.service';
import { WebhookProcessorService } from './application/webhook-processor.service';
import { ReservationRecoveryService } from './application/reservation-recovery.service';
import { ReservationReleaseService } from './application/reservation-release.service';
import { CatalogAdapter } from './infra/catalog.adapter';
import { CatalogReservationSource } from './infra/catalog-reservation-source';
import { RedisCheckoutLock } from './infra/checkout-lock.redis';
import { DynamoCartStore } from './infra/cart.dynamo-store';
import { LegacyCheckoutDiscountsAdapter } from './infra/discounts.adapter';
import { SequelizeOrderHistoryRepository } from './infra/order-history.repository';
import { SequelizeOrderRepository } from './infra/order.repository';
import { PaymentStatusUnavailableAdapter } from './infra/payment-status.adapter';
import { RealtimeAdapter } from './infra/realtime.adapter';
import { RefundCommandAdapter } from './infra/refund-command.adapter';
import { SequelizeReservationRepository } from './infra/reservation.repository';
import { ShopDirectoryAdapter } from './infra/shop-directory.adapter';
import { SequelizeShopOrderRepository } from './infra/shop-order.repository';

/**
 * Everything the HTTP side (`OrdersModule`) and the background side (`OrdersWorkerModule`) share: the repositories and
 * adapters bound to their ports and the application services (research D-1, D-6). One module, so the two sides never
 * declare the same provider twice.
 */
@Module({
  imports: [
    ApiConfigModule,
    ClockModule,
    EventsModule.forAggregates([ORDERS_AGGREGATE]),
    InboxModule,
    JobsModule,
    RealtimeModule,
    ProductModule,
    TenancyModule,
    ProblemCatalogModule.forFeature(ORDERS_PROBLEMS),
    SequelizeModule.forFeature(ORDER_MODELS),
  ],
  providers: [
    { provide: ORDER_REPOSITORY, useClass: SequelizeOrderRepository },
    { provide: SHOP_ORDER_REPOSITORY, useClass: SequelizeShopOrderRepository },
    {
      provide: RESERVATION_REPOSITORY,
      useClass: SequelizeReservationRepository,
    },
    {
      provide: ORDER_HISTORY_REPOSITORY,
      useClass: SequelizeOrderHistoryRepository,
    },
    { provide: CART_STORE, useClass: DynamoCartStore },
    { provide: CHECKOUT_LOCK, useClass: RedisCheckoutLock },
    { provide: PRODUCT_CATALOG, useClass: CatalogAdapter },
    { provide: SHOP_DIRECTORY, useClass: ShopDirectoryAdapter },
    { provide: SHOP_DISCOUNTS, useClass: LegacyCheckoutDiscountsAdapter },
    CatalogReservationSource,
    { provide: RESERVATION_SOURCE, useExisting: CatalogReservationSource },
    { provide: REALTIME_PORT, useClass: RealtimeAdapter },
    { provide: PAYMENT_STATUS, useClass: PaymentStatusUnavailableAdapter },
    { provide: REFUND_COMMAND, useClass: RefundCommandAdapter },
    ReservationReleaseService,
    OrderLifecycleService,
    OrderFulfilmentService,
    OrderReservationService,
    ReservationRecoveryService,
    OrderQueryService,
    OrderCancellationService,
    PaymentResultService,
    WebhookProcessorService,
  ],
  exports: [
    InboxModule,
    SequelizeModule,
    CART_STORE,
    CHECKOUT_LOCK,
    ORDER_REPOSITORY,
    SHOP_ORDER_REPOSITORY,
    RESERVATION_REPOSITORY,
    ORDER_HISTORY_REPOSITORY,
    PRODUCT_CATALOG,
    SHOP_DIRECTORY,
    SHOP_DISCOUNTS,
    RESERVATION_SOURCE,
    REALTIME_PORT,
    PAYMENT_STATUS,
    REFUND_COMMAND,
    CatalogReservationSource,
    ReservationReleaseService,
    OrderLifecycleService,
    OrderFulfilmentService,
    OrderReservationService,
    ReservationRecoveryService,
    OrderQueryService,
    OrderCancellationService,
    PaymentResultService,
    WebhookProcessorService,
  ],
})
export class OrdersCoreModule {}

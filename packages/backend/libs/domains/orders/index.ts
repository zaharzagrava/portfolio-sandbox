/**
 * Public entry point of the `orders` domain (constitution X.4). Code outside this domain imports only from
 * `@app/domains/orders`: modules, the exported R1 services, their DTO types, error classes and event contracts.
 */

// Registers the orders job contracts for any app that enqueues them (e.g. auctions) without loading order.jobs.
import './application/order.job-types';

// Registers the order-export job contracts for any app that enqueues or schedules them without loading the handlers.
import './application/order-export.job-types';

export { OrdersWorkerModule } from './orders-worker.module';
export { OrdersModule } from './orders.module';
export { OrderExportModule } from './order-export.module';
export { OrderExportWorkerModule } from './order-export-worker.module';
export { OrderExportTopicsModule } from './order-export-topics.module';
export { OrderQueryService } from './application/order-query.service';
export { OrderEntitlementService } from './application/order-entitlement.service';
export { OrderEntitlementModule } from './order-entitlement.module';
export type { OrderLineDto, PayableOrderDto } from './domain/order-views';
export { OrderCommandService } from './application/order-command.service';
export { OrderCommandModule } from './order-command.module';
export { OrderCommandRejectedError } from './domain/order-command';
export type {
  FixedPriceOrderAnswer,
  FixedPriceOrderCommand,
  OrderCommandRejectionCode,
} from './domain/order-command';
export { OrderFulfilmentService } from './application/order-fulfilment.service';
export type { FulfilmentCommand } from './application/order-fulfilment.service';
export {
  InvalidOrderTransitionError,
  OrderNotFoundError,
  OrderNotPayableError,
  TooManyIdsError,
} from './domain/order-errors';
export type {
  CancelReason,
  OrderCommand,
  OrderStatus,
} from './domain/order-state';
export type { ShopOrderStatus } from './domain/ports';
export {
  OrderCancelled,
  OrderFulfilmentChanged,
  OrderPaid,
  OrderRefunded,
  OrderReserved,
} from './application/events/order-events';
export { ordersRatePolicies } from './rate-limit-policies';

// TRANSITIONAL (specs/domains/S10-cart-checkout/plan.md, Complexity Tracking CT-1): the exports below stay only while the
// capabilities that still import them have not converted (auctions, payments, asset-library, catalog-sync,
// shop-functions, sse-gateway). Do not add to this block; delete a line when its last importer is gone
// (`orders-boundary.e2e-spec.ts` pins the list so it can only shrink). Removal date: 2027-01-31.
export { default as BisOrderItemModel } from './infra/models/bis-order-item.model';
export {
  default as BisOrderModel,
  BisOrderScope,
} from './infra/models/bis-order.model';
export type { BisOrderWithAllFilters } from './infra/models/bis-order.model';
export { default as ShopOrderModel } from './infra/models/shop-order.model';
export { default as StockReservationModel } from './infra/models/stock-reservation.model';
export { ORDER_MODELS } from './orders-models';
export { CreateBisOrderDto } from './api/bis-order.dto';
export { OrderService } from './application/order.service';

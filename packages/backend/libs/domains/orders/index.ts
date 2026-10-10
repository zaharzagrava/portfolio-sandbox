/**
 * Public entry point of the `orders` domain (constitution X.4). Code outside this domain imports only from
 * `@app/domains/orders`: modules, the exported R1 services, their DTO types, error classes and event contracts.
 */

// Registers the orders job contracts for any app that enqueues them (e.g. auctions) without loading order.jobs.
import './application/order.job-types';

export { OrdersWorkerModule } from './orders-worker.module';
export { OrdersModule } from './orders.module';
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
export { default as FlashSaleModel } from './infra/models/flash-sale.model';
export { default as ShopOrderModel } from './infra/models/shop-order.model';
export { default as StockReservationModel } from './infra/models/stock-reservation.model';
export { CheckoutDiscounts } from './domain/checkout-discounts.port';
export type { DiscountableLine } from './domain/checkout-discounts.port';
export { ORDER_MODELS } from './orders-models';
export { CreateBisOrderDto } from './api/bis-order.dto';
export { OrderExportService } from './application/order-export.service';
export { OrderService } from './application/order.service';
export { FlashStockService } from './infra/flash-stock.service';
export { ExportJobTopicsModule } from './realtime-topics.module';

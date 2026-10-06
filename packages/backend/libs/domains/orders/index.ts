/**
 * Public entry point of the `orders` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/orders`. Generated from actual cross-domain usage in Phase 2 (later batches append); extend
 * it by hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 */
export { default as BisOrderItemModel } from './infra/models/bis-order-item.model';
export { default as BisOrderModel, BisOrderScope } from './infra/models/bis-order.model';
export type { BisOrderWithAllFilters } from './infra/models/bis-order.model';
export { default as FlashSaleModel } from './infra/models/flash-sale.model';
export { default as ShopOrderModel } from './infra/models/shop-order.model';
export { default as StockReservationModel } from './infra/models/stock-reservation.model';
export { CheckoutDiscounts } from './domain/checkout-discounts.port';
export type { DiscountableLine } from './domain/checkout-discounts.port';
export { OrdersWorkerModule } from './orders-worker.module';
export { ORDER_MODELS, OrdersModule } from './orders.module';
export { CreateBisOrderDto } from './api/bis-order.dto';
export { OrderCancelled, OrderPaid, OrderReserved } from './application/events/order-events';
export { OrderExportService } from './application/order-export.service';
export { OrderService } from './application/order.service';
export { FlashStockService } from './infra/flash-stock.service';
export { ExportJobTopicsModule } from './realtime-topics.module';

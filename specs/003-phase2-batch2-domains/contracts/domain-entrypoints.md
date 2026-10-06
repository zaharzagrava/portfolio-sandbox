# Contract: Domain Entry Points (batch 2)

Same rules as [batch 1](../../002-phase2-domain-restructuring/contracts/domain-entrypoints.md).
**[T]** marks a transitional export (D-7 for models, D-8 for infra internals).

## `@app/domains/orders`

| Export | Kind |
|---|---|
| `BisOrderModel` [T], `BisOrderScope`, `type BisOrderWithAllFilters`, `BisOrderItemModel` [T], `ShopOrderModel` [T], `StockReservationModel` [T], `FlashSaleModel` [T] | models / scopes |
| `OrdersModule`, `OrdersWorkerModule`, `ORDER_MODELS` | Nest modules, model list |
| `CheckoutDiscounts`, `type DiscountableLine` | domain port, implemented by shop-functions |
| `CreateBisOrderDto` | DTO |
| `OrderReserved`, `OrderPaid`, `OrderCancelled` | published event contracts |
| `OrderService`, `OrderExportService` | exported services (R1). The export service is still routed by catalog-import (D-10). |
| `FlashStockService` [T] | infra internal |

## `@app/domains/payments`

| Export | Kind |
|---|---|
| `PaymentModel` [T], `PaymentStatus`, `LedgerEntryModel` [T], `PayoutModel` [T] | models / enum |
| `PaymentModule`, `PaymentDtoModule`, `LedgerModule`, `FinanceModule`, `FinanceWorkerModule` | Nest modules |
| `LEDGER_ACCOUNTS`, `shopAccount` | domain (chart of accounts) |
| `CreatePaymentDto`, `CreateLedgerEntryDto`, `SystemAccount`, `type LedgerAccountId` | DTOs |
| `LedgerService` | exported service (R1) |
| `BalanceProjector` [T], `PaymentDtoService` [T] | infra internals |

`Domain_CircuitBreakerOpenError` is **no longer** exported. It now lives in
`@app/infrastructure/stripe/stripe.errors`.

## `@app/domains/chat`

| Export | Kind |
|---|---|
| `ChatChannelModel` [T], `ChatChannelMemberModel` [T], `ChatMessageModel` [T] | models |
| `ChatModule`, `ChatSyncModule`, `ChatOfflineWorkerModule` | Nest modules |
| `ChatOfflineScheduler` [T] | infra internal |

## `@app/domains/fulfilment`

| Export | Kind |
|---|---|
| `PickupModule`, `DeliveryModule`, `DeliveryWorkerModule` | Nest modules |
| `AvailabilityIndex` [T], `PickupAvailabilityProjector` [T], `CourierTrackProjector` [T] | infra internals, used by the projector app |

## `@app/domains/seller-onboarding`

| Export | Kind |
|---|---|
| `OnboardingModule`, `OnboardingWorkerModule`, `OnboardingExtractionModule` | Nest modules |
| `ExtractionService` | exported service, used by the Lambda document extractor |

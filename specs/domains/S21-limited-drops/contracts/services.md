# Service contract (R1), ports and jobs: S21 — `auctions`

## Exported from `@app/domains/auctions` (barrel after S21)

`AuctionsModule` (core), `AuctionsWorkerModule` (worker), `AuctionTopicsModule`, `auctionsRatePolicies`, the event definitions `AuctionCreated`, `AuctionOpened`, `AuctionBidPlaced`, `AuctionLeaderChanged`, `AuctionClosed`, `AuctionSecondChanceOffered`, `AuctionSold`, `AuctionUnsold`, `AuctionCancelled`. Removed: `AuctionModel`, `AuctionService` (module export). Nothing else; no R1 provider is exported (the BFF composes over HTTP, R2).

## Imported (R1, exact signatures that exist today)

| From | Use | Where |
|---|---|---|
| catalog `ProductQueryService.getProductsByIds(ids, {shopId})` | schedule: existence in the shop, status, stock, currency, price | `AuctionScheduleService` via `ProductCatalogPort` (timeout 1 s) |
| catalog `ProductStockService.applyStockDelta(ops)` | hold and return | `AuctionStockPort` adapter, timeout 2 s |
| tenancy `ShopAccessService.getRole(shopId, userId)` | shill guard | `ShopMembershipPort` adapter, timeout 200 ms |
| billing `RequiresShopEntitlement('auctions')` | create route only | controller |
| orders `OrderCommandService.createFixedPriceOrder` | **new, built in WP-3** | `OrderRequestPort` adapter |
| infrastructure: `TransactionRunner`, `OutboxService`, `JobsService` + `declareJobType`, `@Idempotent`, `CacheService.getOrLoad`, `RealtimePublisher`, `RateLimitModule`, `CLOCK`, metrics registry, `Projector` framework | | |

## New in `orders` (S10 amendment, WP-3) — `OrderCommandService`

```ts
createFixedPriceOrder(cmd: {
  idempotencyKey: string;            // 1–128; 'auction:<id>:winner' | 'auction:<id>:second-chance'
  buyerId: string; shopId: string; productId: string;
  quantity: 1; unitPriceMinor: number; currency: string; titleSnapshot: string;
  reservedUntil: string;             // ISO instant
  origin: { kind: 'AUCTION'; ref: string; step: 'winner' | 'second-chance' };
  stockHandling: 'EXTERNALLY_HELD';
}): Promise<{ orderId: string; status: 'RESERVED'; reservedUntil: string; replayed: boolean }>;
```

- Exported from `orders/index.ts` with `OrderCommandRejectedError {code: 'buyer_not_eligible' | 'shop_not_eligible' | 'invalid_price'}` (permanent); every other failure is a plain error (transient).
- Behavior: see research R-04. Edits to existing S10 files (the complete list): `domain/ports.ts` (`ReservationRecord.source` adds `'EXTERNAL'`), `application/reservation-release.service.ts` (skip `EXTERNAL` rows; the row still goes `HELD → RELEASED` without a stock operation), `orders.module.ts` (provide/export), `index.ts` (export), the migration widening the `source` CHECK. New files: `application/order-command.service.ts`, `domain/order-command.ts` (command schema, error), `order-command.e2e-spec.ts` (replay, rejection, no stock operation on cancel or expiry, `order.reserved` emitted, payable through `getPayableOrder`).
- Only `EXTERNAL` reservations skip stock; `CATALOG` and `FLASH` paths are unchanged (existing S10 and S11 specs are the regression).

## Internal ports (`domain/auction-ports.ts`; adapters in `infra/`)

| Port | Adapter | Notes |
|---|---|---|
| `AuctionRepository` | `infra/auction.repository.ts` (Sequelize) | `create`, `lockById(id, tx)`, `applyBid`, `transition`, list/read, `findDue`, `findSettlementOrder`; shop in every predicate for seller reads |
| `BidRepository` | `infra/bid.repository.ts` | append, history page, my-bid, runner-up candidates |
| `ProductCatalogPort` | `infra/product-catalog.adapter.ts` | wraps `ProductQueryService`, maps to `{status, stock, currency, priceMinor}`; timeout |
| `AuctionStockPort` | `infra/auction-stock.adapter.ts` | `hold(auctionId, productId, shopId)`, `return(…)`; maps `rejected` → `insufficient_stock \| unavailable` |
| `ShopMembershipPort` | `infra/shop-membership.adapter.ts` | `isMember(shopId, userId)` throws `MembershipUnavailableError` on timeout/failure |
| `OrderRequestPort` | `infra/order-request.adapter.ts` | wraps `OrderCommandService`; maps rejection to `permanent` |
| `AuctionViewCache` | `infra/auction-view.cache.ts` | `getOrLoad`/`invalidate` over `CacheService`; store failure → loader |
| `AuctionRealtimePort` | `infra/auction-realtime.adapter.ts` | `publishPrice`, `publishClosed`, errors counted |
| `Clock` | `CLOCK` | `FakeClock` in specs |

Application services (one per use case, controllers and jobs call only these): `AuctionScheduleService` (create, cancel, hold/open handlers), `BidService` (place bid, my-bid), `AuctionCloseService` (`closeIfDue`, `sweepDue`), `SettlementService` (`requestOrder`, `onOrderPaid`, `onOrderCancelled`, `onWinnerUnpaid`, `returnStock`), `AuctionQueryService` (seller list/read, public view, batch, history). Plus test seams `BidDecisionGate`, `CrashPoint` (R-02).

## Jobs (S49 `declareJobType` in `application/auction.job-types.ts`, handlers in `infra/auction.jobs.ts`)

| Type | Payload contract | Trigger | Options |
|---|---|---|---|
| `auctions.open` | `{auctionId}` | at `startsAt`, key `auction-open:<id>` | `maxAttempts: 5` |
| `auctions.close` | `{auctionId}` | at `endsAt`, key `auction-close:<id>:<endsAtMs>` | `maxAttempts: 5` |
| `auctions.hold-stock` | `{auctionId}` | at create | `maxAttempts: 5`, backoff |
| `auctions.return-stock` | `{auctionId}` | in the transition's transaction | `maxAttempts: 8`, backoff, dead letter + alert |
| `auctions.request-order` | `{auctionId, step: 'winner'\|'second-chance'}` | after `CLOSED` / `SECOND_CHANCE` | `maxAttempts: 8`, 5 s × 2ⁿ, full jitter, dead letter, metric `auction_order_request_failed_total` |
| `auctions.sweep-due` | `{}` | every 30 s | `fleetConcurrency: 1`, ≤ 200 per run, `SKIP LOCKED`: due closes, stuck holds (> 1 min retry, > 5 min cancel), pending returns, `CLOSED` without order ID older than 60 s |
| `auctions.ensure-bid-partitions` | `{}` | daily | `fleetConcurrency: 1` |

An unknown auction ID or a payload that fails its schema is rejected (`PermanentJobError`), no state change, nothing published (AS-35). Callers of `JobsService.cancel` use the discriminated result; schedule registration catches `InvalidScheduleError` (S49 follow-up). `auctions.second-chance` (today's job) is removed; a leftover enqueued row of that type is rejected by the registry as unknown and dead-lettered.

## Consumer (`infra/auction-settlement.consumer.ts`, registered by `AuctionsWorkerModule`)

`Projector` `auctions-order-results` on `orders.events`, handles `order.paid` and `order.cancelled` (R-05). Payload shapes from S10's contracts package; invalid → `PermanentError`; unknown order ignored; the pre-ID window raises `TransientError`.

## Modules

- `AuctionsModule` (core, HTTP): controllers `AuctionSellerController`, `AuctionPublicController`, `AuctionBidController` (three thin controllers, II.1), `AuctionExceptionFilter`; imports `BillingModule`, `TenancyModule` (R1 `ShopAccessService`), `CatalogModule` (R1), `JobsModule`, `RealtimeModule`, `RateLimitModule.forFeature`, cache, `EventsModule.forAggregates`.
- `AuctionsWorkerModule` (worker): job handlers, consumer, imports only the orders public module for `OrderCommandService` (no `ORDER_MODELS`, no `OrderService`, no `BisOrderModel`). `FlashStockService` is already gone (S11). `OrderService`, `BisOrderModel` and `ORDER_MODELS` stay in S10's TRANSITIONAL block because `asset-library/assets.e2e-spec.ts` and `payments/ledger-ops.e2e-spec.ts` still import them; auctions no longer does (grep in WP-9 proves the auctions files are clean; the remaining importers are noted in `gaps.md` under Sibling-spec follow-ups).
- Both modules must start in the real apps (L-015, L-018): `apps/core` and `apps/worker`; a standalone check boots each app's module alone (`Test.createTestingModule({ imports: [AppModule] })` for the app, not a hand-built module).

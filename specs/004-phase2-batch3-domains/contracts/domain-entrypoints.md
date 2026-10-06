# Contract: Domain Entry Points (batch 3)

The rules are the same as [batch 1](../../002-phase2-domain-restructuring/contracts/domain-entrypoints.md).
[T] marks a transitional export: D-7 for models, D-8 for infrastructure internals. Every model below is
consumed only by `all-models.ts` (D-9).

| Barrel | Exports |
|---|---|
| `@app/domains/billing` | `PlanModel`, `PriceModel`, `SubscriptionModel`, `InvoiceModel`, `InvoiceLineModel` [T]; `BillingModule`, `BillingWorkerModule`; `EntitlementsService`, `RequiresShopEntitlement` (R1: auctions and seller-onboarding check entitlements through these); `UsageService`; `InvoicePaymentFailed` (event); `UsageProjector` [T] |
| `@app/domains/statements` | `StatementsModule`, `StatementsWorkerModule` |
| `@app/domains/auctions` | `AuctionModel` [T]; `AuctionsModule`, `AuctionsWorkerModule`; `AuctionClosed`, `AuctionLeaderChanged` (events) |
| `@app/domains/launch-events` | `LaunchEventModel`, `BookingModel` [T]; `LaunchEventsModule`, `LaunchEventsWorkerModule`, `LiveModule`, `LiveCoreModule`, `LiveWorkerModule`; `LiveService`; `Reservoir`; `LiveCommentsProjector`, `LiveModerationConsumer`, `LiveTicker`, the live-keys helpers (`ACTIVE_STREAMS`, `firehoseTopic`, `pinKey`, `RECENT_COMMENTS`, `recentKey`, `viewersKey`, `type LiveComment`) [T] |
| `@app/domains/shop-functions` | `ShopFunctionsModule`, `FunctionJudgeModule` |
| `@app/domains/asset-library` | `AssetsModule`, `AssetsWorkerModule` |
| `@app/domains/media` | `MediaModule`, `VideoModule`, `VideoWorkerModule`; `MediaProcessor`, `type Sql` [T] (used by the thumbnail Lambda) |
| `@app/domains/catalog-sync` | `CatalogImportModule`, `CatalogImportWorkerModule`, `IntegrationsModule`, `IntegrationsCoreModule`, `IntegrationsWorkerModule`, `OfflineSyncModule`; `StockPushProjector` [T] |

## Changes to earlier barrels

- `@app/domains/orders`: unchanged. `BisUtilsModule` / `BisUtilsService` were briefly appended,
  then moved to payments.
- `@app/domains/payments`: unchanged. `BisUtils*` are internal to payments (no outside
  consumer), so they're not exported.

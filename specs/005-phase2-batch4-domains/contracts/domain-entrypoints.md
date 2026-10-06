# Contract: Domain Entry Points (batch 4)

The rules are the same as [batch 1](../../002-phase2-domain-restructuring/contracts/domain-entrypoints.md).
**[T]** marks a transitional infrastructure internal (D-8). These are wired directly by the projector and worker apps.

| Barrel | Exports |
|---|---|
| `@app/domains/community` | `DiscussionsModule`, `DiscussionsWorkerModule`, `FeedModule`, `FeedPublisherModule`; `FeedFanoutConsumer` [T], `ProductFeedProjector` [T] |
| `@app/domains/content` | `StoriesModule`, `StoriesWorkerModule`, `StoryCacheModule`, `StoryCacheInvalidator` [T] |
| `@app/domains/notifications` | `NotificationsModule`, `NotificationsCoreModule`, `NotificationsWorkerModule`; `NotificationRouter` (R1: auctions, billing, orders, and seller-insights route notifications through it); `formatMoney`; `NotificationRouterProjector` [T] |
| `@app/domains/discovery` | `SearchAdminModule`, `SearchReindexWorkerModule`, `AutocompleteModule`, `AutocompleteWorkerModule`, `RecommendationsModule`, `RecommendationsWorkerModule`, `TrendingModule`, `TrendingConsumerModule`; `TrendingService`; `SearchQueryLogger` [T]; `SearchClicksProjector`, `SearchQueriesProjector`, `OrderBasketsProjector`, `TrendingConsumer` [T] |
| `@app/domains/seller-insights` | `LeaderboardsModule`, `LeaderboardsWorkerModule`, `SellerStatsModule`, `CrawlerModule`, `CrawlerWorkerModule`; `LeaderboardProjector`, `ShopLiveProjector`, `ShopSalesProjector` [T] |

# Contracts: S40

Schemas live in `packages/contracts/src/seller-insights/` and are the single source for backend validation, tests and the web client. Field-level shapes are in `spec.md` (Cross-capability contracts → Provides); this file fixes names and status codes.

## HTTP

| Route | Guard | Schema | Errors |
|---|---|---|---|
| `GET /leaderboards?period&id&category&limit` | anonymous, policy `seller-insights.leaderboard-read.ip` | `leaderboardPageSchema` | 400 `validation_failed`, 422 `period_in_future`, 429 `rate_limited`, 503 `service_unavailable` |
| `GET /shops/:shopId/rank?period&id&category` | `ShopScoped('shop.read')` | `shopRankSchema` | 401, 404 `shop_not_found`, 404 `not_ranked`, 400, 422, 503 |
| `GET /shops/:shopId/dashboard/today` | `ShopScoped('shop.read')` | `dashboardTodaySchema` | 401, 404, 503 |
| `GET /shops/:shopId/stats?days` | `ShopScoped('shop.read')` | `sellerStatsSchema` | 401, 404, 400, 503 |

Removed: `GET /leaderboards/shops/:shopId`, `GET /sellers/me/stats`.

Cache-Control: live `public, max-age=10, s-maxage=30`; frozen `public, max-age=3600, s-maxage=86400`; shop-scoped routes `private, no-store`.

## Realtime

Topic `shop:{shopId}:live`, event `dashboard`, payload `liveDashboardFrameSchema`, `replay:false`. Policy owned by tenancy.

## Events consumed (schemas from contracts)

| Topic | Types | Consumer group | Failure rule |
|---|---|---|---|
| `orders.events` | `order.paid` (board, live, sales), `order.reserved` (live), `order.refunded` (refund) | one group per consumer | invalid / non-EUR / unsupported version → DLQ with reason; foreign type ignored |
| `products.events` | `catalog.product_created|updated|archived|restored|deleted` | `seller-insights-products` | missing `productId` → DLQ |
| tenancy shop events | `tenancy.shop_created|updated|deleted` | `seller-insights-shops` | missing `shopId` or bad `shopVersion` → DLQ |

DLQ reason codes: `invalid_payload`, `unsupported_version`, `unsupported_currency`, `revenue_limit_exceeded`, `partial_refund_unsupported`, `refund_without_sale` (after 5 attempts).

Events emitted: none.

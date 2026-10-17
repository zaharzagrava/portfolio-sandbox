# Contract: competitor HTTP API (core)

Schemas live in `packages/contracts/src/seller-insights/competitors.ts` (V.2, VII.6); controller in `api/competitors.controller.ts`; every route is `ShopScoped(permission)` (answer order `401`, `404 shop_not_found`, `403 permission_denied`, status gate `403 shop_suspended` / `409 shop_offboarding`). Errors are problem+json with `type, title, status, detail, instance, requestId, code`.

| Route | Permission | Success | Schema |
|---|---|---|---|
| `POST /shops/:shopId/competitors` | `products.write` (+ rate limit `seller-insights.competitor-write.shop`, 30/min, fail closed) | `201` new / `200` replay | in `createCompetitorWatchSchema {productId: uuid, url: string≤2048}` (strict: unknown/repeated fields rejected); out `competitorWatchSchema` |
| `GET /shops/:shopId/competitors?productId&limit&cursor` | `shop.read` (see below) | `200` | `competitorWatchListSchema {items, nextCursor}`; `limit` 1–100 default 50 |
| `DELETE /shops/:shopId/competitors/:watchId` | `products.write` (same limiter) | `204` | — |
| `GET /shops/:shopId/competitors/:watchId/prices?days=` | `shop.read` (see below) | `200` | `competitorPricesSchema`; `days` 1–365 default 30, ≤ 1000 newest points |

**Read permission as built.** The two read routes are guarded by `shop.read`, not `products.read`: every role has both (S03 FR-020), and only `shop.read` stays available on a suspended or closing shop (S03 FR-013), which AS-07 requires of reads. **Limiter outage.** The fail-closed `503` on a write is the platform's `rate_limiter_unavailable` (S50), not `service_unavailable`.

`competitorWatchSchema`: `{id, productId, url, host, status: 'ACTIVE'|'PAUSED', lastPriceMinor: int|null, currency: string|null, lastCheckedAt: iso|null, lastStatus: string|null, nextCheckAt: iso, createdAt: iso}`. No target id, no other watcher.

## Error codes (FR-034)

| code | status | when |
|---|---|---|
| `validation_failed` | 400 | body/query/param shape; `errors[]` names the field |
| `url_not_allowed` | 422 | `SafeRequestError` kind `invalid_url` or `blocked_address`; generic detail |
| `url_unresolvable` | 422 | kind `unresolvable` |
| `product_not_found` | 404 | foreign or missing product (byte-identical) |
| `product_archived` | 409 | |
| `watch_limit_reached` | 422 | `{scope: 'shop'|'product', limit}` |
| `watch_not_found` | 404 | unknown or foreign id |
| `shop_not_found` | 404 | non-member, malformed, unknown |
| `permission_denied` / `shop_suspended` / `shop_offboarding` | 403 / 403 / 409 | S03 |
| `rate_limited` | 429 | `Retry-After` |
| `history_unavailable` | 503 | ClickHouse unreachable, within 3 s |
| `entitlements_unavailable` | 503 | billing read failed |
| `service_unavailable` | 503 | limiter store down on writes |

Tolerated registration spellings: scheme/host case, default port, fragment, tracking parameters, parameter order (AS-02).

## Required by this capability from others

- S03 `ShopScoped`, `MembershipQueryService.getMembersByShopIds`; S05 `ProductQueryService.getProductsByIds`; S18 `EntitlementsService.checkLimit('SHOP', shopId, 'maxCompetitorWatches', current)`; S50 rate-limit policy; S54 `safeGet`, `SafeRequestError`.

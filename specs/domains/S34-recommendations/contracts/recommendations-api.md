# Contract: bought-together recommendations (S34)

Schemas: `packages/contracts/src/search/recommendations.ts` (`recommendationsQuerySchema`, `recommendationsResponseSchema`). Clients import types from there (V.2).

## `GET /api/products/{productId}/recommendations` — anonymous

| Part | Rule |
|---|---|
| Path | `productId`: UUID |
| Query | `limit`: integer 1–20, default 8; `type`: `bought-together` only, default `bought-together`; any other parameter → `400` |
| Rate limit | policy `discovery.recommendations`, 600/min per address, fail open |

### 200

```json
{ "type": "bought-together",
  "items": [{ "productId": "uuid", "title": "string", "priceMinor": 0, "currency": "USD", "score": 0.2067, "hops": 1 }] }
```

`priceMinor` integer ≥ 0; `currency` 3 letters; `score` in (0, 1] with 4 decimals; `hops` 1 or 2. At most `limit` items, all visible when the request ran (product `ACTIVE`, not sandbox, in stock, shop `ACTIVE`); direct before indirect, then score desc, then `productId` asc; empty `items` is a valid answer. Header `Cache-Control: public, max-age=60, s-maxage=300`; no `Set-Cookie`, no `Vary: Cookie|Authorization`; the same body for every caller.

### Errors (`application/problem+json`, always `Cache-Control: no-store`)

| Status | `code` | When |
|---|---|---|
| 400 | `validation_failed` (`errors: [{field, message}]`) | bad id, `limit`, `type`, unknown parameter |
| 404 | `product_not_found` | unknown, archived, sandbox, or non-active-shop product (identical body) |
| 429 | `rate_limited` (`Retry-After` ≥ 1) | policy exceeded |
| 503 | `recommendations_unavailable` (`Retry-After: 5`) | list store, product lookup or shop lookup failed or timed out |

## Job `recommendations.build-bought-together`

Cron `17 3 * * *`, lease and `maxRuntimeMs` 1 h, `fleetConcurrency` 1. Payload `{days?: int 1–390 (180), buckets?: int 1–256 (16)}`, unknown keys rejected. Result `{outcome: 'completed'|'skipped_empty'|'skipped_locked', products, edges, removed}`.

## Consumer `discovery-order-baskets`

Topic `orders.events` (key `orderId`), event `order.paid` v1, idempotency `versionGuard` on `orderVersion`; invalid payload → dead letter; other types ignored.

## Consumer obligations (W02, S48)

Optional section with a 300 ms budget; money from `priceMinor`/`currency`; `title` as text; hide on empty `items`, `404`, `429`, `503`; validate with `recommendationsResponseSchema`.

# X-01 — "Bought Together" Graph Recommendations (README #18)

Status: ☑ done (typechecked; spec written, not run) · Phase 3 · Depends on: F-05, SD-19 (orders)

## Marketplace adaptation
Product page "Frequently bought together" and "Customers who viewed this also viewed". Genuinely a graph problem: co-occurrence edges between products.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Co-occurrence edges built from order events (pairs within an order) aggregated in **ClickHouse** (`SummingMergeTree(product_a, product_b) count`) | — |
| Top-N neighbours per product materialised into **Redis ZSET** `rec:bought:{productId}` by a nightly job — O(1) read on product page | — |
| 2-hop expansion (BFS depth 2 with decay) for cold products with few direct edges | 11/03 BFS |
| Popularity normalisation (lift / cosine) so iPhone doesn't appear next to everything | — |

## Steps
- [x] ClickHouse table + MV from `orders.events`.
- [x] Nightly job computing normalised top-20 neighbours → Redis.
- [x] `GET /products/:id/recommendations?type=bought-together`.
- [x] e2e: seeded orders → expected neighbour order.

## Scale
- Target: product page reads 100k RPS → Redis ZREVRANGE (sub-ms). Build job: 1B order lines → ClickHouse self-join per order bucket in minutes.

## Implementation notes (2026-10-01)
- `OrderBasketsProjector` (apps/projector): `order.paid` → ClickHouse `order_baskets` (`clickhouse/040_order_baskets.sql`, ReplacingMergeTree by order id; baskets with < 2 or > 30 distinct products are skipped).
- `CoOccurrenceJobs` (apps/worker, nightly `17 3 * * *`):
  - Pairs come from a double `ARRAY JOIN` over `order_baskets FINAL` (exact counts despite redelivery). Pairs with fewer than 3 co-orders are dropped.
  - Score = cosine `co / sqrt(n_a · n_b)`; top 20 per product via `LIMIT 20 BY a`.
  - Processed in cityHash buckets of the anchor product.
  - Written to a staging ZSET, then `RENAME`d over `rec:bought:{id}` (same hash-tag slot), with a 3-day TTL.
- `RecommendationsService`:
  - One `ZREVRANGE`. If there are fewer than `limit` direct neighbours, a depth-2 BFS runs over the top 5 neighbours in one pipeline (score s1 · s2 · 0.5, best path wins).
  - Hydrated from Postgres, out-of-stock items dropped.
  - `GET /api/products/:id/recommendations?limit=` with `s-maxage=300`.
- "Also viewed": see DOUBTS Q42.
- Spec `recommendations/recommendations.e2e-spec.ts` covers: cosine vs popularity, redelivery dedupe, the noise threshold, 2-hop expansion and stock filtering.

---
id: S34
title: "Bought together" recommendations: co-occurrence graph, normalisation, 2-hop cold start
kind: capability
status: draft
generated_at: e95ce81
depends_on: [S05, S03, S49, S50, S53, S54]
concepts: [projection-and-replay, job-scheduler-lease, cache-layers, rate-limit-policy, problem-json-errors]
models: []
scope:
  - packages/backend/libs/domains/discovery/**
  - packages/contracts/src/search/**
---
# S34 - "Bought together" recommendations
## Purpose
A buyer on a product page needs a "Frequently bought together" rail of products that other buyers purchased in the same order. The capability turns paid orders into baskets, builds a nightly co-occurrence graph with cosine normalisation, and serves the top neighbours of a product to anonymous callers. Products with few neighbours receive a 2-hop expansion (cold start).

## Entry points
- `GET /api/products/:productId/recommendations` (query `limit`, `type`): anonymous, CDN-cacheable rail of neighbours for one product. [code: packages/backend/libs/domains/discovery/api/recommendations.controller.ts#RecommendationsController]
- Event `order.paid` on the orders topic (key `orderId`): the projector records one basket per paid order, see {{concept:projection-and-replay}}. [code: packages/backend/libs/domains/discovery/infra/projectors/order-baskets.projector.ts#OrderBasketsProjector]
- Job `recommendations.build-bought-together`, cron `17 3 * * *`: builds and publishes all neighbour lists, see {{concept:job-scheduler-lease}} and {{cap:S49}}. [code: packages/backend/libs/domains/discovery/infra/co-occurrence.jobs.ts#CoOccurrenceJobs]
- Order events other than `order.paid` on the same topic: ignored without effect.

## Rules
- **S34.R-01** The endpoint MUST be anonymous and MUST return an identical body for every caller; an invalid bearer token is ignored, not answered with `401`. [proof: S34 AS-07] [code: packages/backend/libs/domains/discovery/api/recommendations.controller.ts#RecommendationsController]
- **S34.R-02** `productId` MUST be a UUID, `limit` an integer from 1 to 20 (default 8), and `type` only `bought-together`. Any other value or unknown parameter answers `400` `validation_failed` naming the field. [proof: S34 AS-03, S34 AS-04, S34 AS-05] [code: packages/backend/libs/domains/discovery/domain/recommendation-errors.ts#RecommendationsValidationError]
- **S34.R-03** A product that does not exist, is archived, is a sandbox product, or belongs to a non-active shop MUST answer one identical `404` `product_not_found`. [proof: S34 AS-06] [code: packages/backend/libs/domains/discovery/domain/recommendation-errors.ts#RecommendationsProductNotFoundError]
- **S34.R-04** A `200` answer MUST carry `Cache-Control: public, max-age=60, s-maxage=300`; every `400`, `404`, `429` and `503` MUST carry `no-store`. [proof: S34 AS-01, S34 AS-09] [code: packages/backend/libs/domains/discovery/api/recommendations.controller.ts#RecommendationsController]
- **S34.R-05** The endpoint MUST be limited to 600 requests per minute per address by policy `discovery.recommendations`; the 601st answers `429` `rate_limited` with `Retry-After`. See {{concept:rate-limit-policy}}. [proof: S34 AS-08] [code: packages/backend/libs/domains/discovery/rate-limit-policies.ts#discoveryRatePolicies]
- **S34.R-06** An item MUST appear only if the product is active, not a sandbox product, in stock, and its shop is active; the visibility check runs on every origin request. [proof: S34 AS-10, S34 AS-12]
- **S34.R-07** A hidden neighbour MUST be replaced by the next visible one, and the list MUST NOT be padded when fewer visible neighbours exist. [proof: S34 AS-10, S34 AS-11]
- **S34.R-08** Items MUST be ordered direct (`hops: 1`) before indirect (`hops: 2`), then by score descending, then by `productId` ascending; the same input yields a byte-identical body. [proof: S34 AS-02, S34 AS-18] [code: packages/backend/libs/domains/discovery/domain/recommendation-ranking.ts#rankCandidates]
- **S34.R-09** When direct neighbours number fewer than `limit`, the system MUST read the lists of the 5 best direct neighbours in one batch; with enough direct neighbours it reads only one list. [proof: S34 AS-15, S34 AS-16] [code: packages/backend/libs/domains/discovery/domain/two-hop-blend.ts#blendTwoHop]
- **S34.R-10** A second-hop score MUST equal seed score × entry score × 0.5; the best path wins, a direct neighbour keeps its direct score and hop, and the requested product is never listed. [proof: S34 AS-13, S34 AS-17] [code: packages/backend/libs/domains/discovery/domain/two-hop-blend.ts#blendTwoHop]
- **S34.R-11** A hidden neighbour MUST still serve as a bridge for second-hop candidates. [proof: S34 AS-19]
- **S34.R-12** A stored entry whose member is not a UUID, equals the requested product, or whose score is not a number in (0, 1] MUST be skipped and counted, never fail the request. [proof: S34 AS-21] [code: packages/backend/libs/domains/discovery/domain/neighbour-entry.ts#sanitiseEntries]
- **S34.R-13** When the list store (100 ms), product lookup (100 ms) or shop lookup (50 ms) fails or exceeds its budget, the endpoint MUST answer `503` `recommendations_unavailable` with `Retry-After: 5` and never an unfiltered list. [proof: S34 AS-45, S34 AS-46] [code: packages/backend/libs/domains/discovery/domain/recommendation-errors.ts#RecommendationsUnavailableError]
- **S34.R-14** A basket MUST hold the sorted distinct products of a paid order, one basket per `orderId`, however often the event is delivered. [proof: S34 AS-29, S34 AS-30] [code: packages/backend/libs/domains/discovery/domain/basket.ts#toBasket]
- **S34.R-15** An order with fewer than 2 or more than 30 distinct products MUST be skipped and counted, not dead-lettered; an invalid payload MUST be dead-lettered without a basket. [proof: S34 AS-31, S34 AS-33] [code: packages/backend/libs/domains/discovery/domain/recommendation-events.ts#parsePaidOrder]
- **S34.R-16** A pair MUST become an edge only with at least 3 co-orders and at least 3 distinct buyers, counted over baskets paid at or after `now − days`. [proof: S34 AS-24, S34 AS-26]
- **S34.R-17** An edge score MUST equal `co(a,b) / sqrt(n(a) · n(b))`, identical in both directions. [proof: S34 AS-22, S34 AS-25] [code: packages/backend/libs/domains/discovery/domain/cosine-score.ts#cosineScore]
- **S34.R-18** Each list MUST hold at most the 20 best edges, ordered by score descending then `productId` ascending, and MUST NOT depend on the bucket count. [proof: S34 AS-27, S34 AS-28]
- **S34.R-19** Each list MUST be replaced atomically with a time-to-live of 3 days; after expiry the endpoint answers `items: []`. [proof: S34 AS-37, S34 AS-43] [code: packages/backend/libs/domains/discovery/infra/redis-neighbour-lists.adapter.ts#RedisNeighbourListsAdapter]
- **S34.R-20** A build MUST remove lists of products without edges only after a complete success, MUST end `skipped_empty` with zero eligible baskets, and MUST fail without deleting anything. [proof: S34 AS-38, S34 AS-39, S34 AS-40]
- **S34.R-21** At most one build MUST run at a time; a concurrent run returns `skipped_locked`, and a crashed holder's lock expires by its lease. [proof: S34 AS-41] [code: packages/backend/libs/domains/discovery/infra/redis-build-lock.adapter.ts#RedisBuildLockAdapter]
- **S34.R-22** Build parameters `days` (1–390, default 180) and `buckets` (1–256, default 16) MUST be validated before any read or write; unknown keys fail. [proof: S34 AS-42] [code: packages/backend/libs/domains/discovery/domain/build-params.ts#parseBuildParams]

## Behaviors
- **S34.B-01** Given dataset D is built, when an anonymous caller requests `M`, then `200` lists `C` (0.2067, hops 1) before `P` (0.1794, hops 1). [proof: S34 AS-01, S34 AS-22]
- **S34.B-02** Given `limit` is omitted, when the product has more than 8 neighbours, then at most 8 items return; `limit=3` returns the best three. [proof: S34 AS-03]
- **S34.B-03** Given `type=also-viewed`, when requested, then `400` `validation_failed` returns with `errors: [{field: "type"}]`. [proof: S34 AS-04]
- **S34.B-04** Given ten neighbours of which five are hidden and `limit=4`, when requested, then the next four visible neighbours return. [proof: S34 AS-10]
- **S34.B-05** Given `Y` has only hidden neighbours, when requested, then `200` returns `items: []` with the standard cache header. [proof: S34 AS-11]
- **S34.B-06** Given `S` has one direct neighbour `K`, when requested, then `K` (0.2046, hops 1) is followed by `P` (0.0673, hops 2). [proof: S34 AS-13]
- **S34.B-07** Given `P` has three direct neighbours, when requested, then expansion adds `S` (0.0673, hops 2) via `K`. [proof: S34 AS-14]
- **S34.B-08** Given a direct neighbour `Z` (0.2) and an indirect `W` (0.36), when requested, then `Z` ranks above `W`. [proof: S34 AS-18]
- **S34.B-09** Given `Y` is out of stock and bridges to `W`, when requested, then only `W` (0.36, hops 2) returns. [proof: S34 AS-19]
- **S34.B-10** Given a visible product with no list, when requested, then `200` returns `items: []` after one list read. [proof: S34 AS-20]
- **S34.B-11** Given an order paid with lines `M`, `C`, `M`, when consumed twice, then one basket with products `[C, M]` exists. [proof: S34 AS-29, S34 AS-30]
- **S34.B-12** Given `order.reserved`, `order.cancelled`, `order.refunded` or `order.fulfilment_changed`, when consumed, then no basket is written and nothing is dead-lettered. [proof: S34 AS-32]
- **S34.B-13** Given two orders delivered in reverse order after a build, when the next build runs, then it counts both exactly once. [proof: S34 AS-34]
- **S34.B-14** Given the topic is replayed into an empty basket store, when the next build runs, then the lists equal the original lists. [proof: S34 AS-35]
- **S34.B-15** Given pair `A–B` has 5 co-orders by one buyer and `A–D` has 3 co-orders by 3 buyers, when the build runs, then `A` lists `D` but not `B`. [proof: S34 AS-24]
- **S34.B-16** Given unchanged baskets, when the build runs twice, then lists and `{products, edges, removed}` are identical. [proof: S34 AS-36]
- **S34.B-17** Given 50 concurrent readers during a build, when a list changes, then each answer shows the full old or full new list. [proof: S34 AS-37]
- **S34.B-18** Given a product lost all edges and the build succeeds, when requested, then `items: []` returns and `removed` counts it. [proof: S34 AS-38]
- **S34.B-19** Given two worker instances start, when scheduling runs, then exactly one schedule exists. [proof: S34 AS-44]

## Lifecycles
No status changes. A neighbour list is written by each build, expires after 3 days, and the next successful build removes it when no edge remains.

## Owns
- Basket store: ClickHouse table `recommendation_baskets` (`packages/backend/clickhouse/041_recommendation_baskets.sql`).
- Neighbour lists: Redis sorted sets, one per product, TTL 3 days; build lock with a 1-hour lease.
- Job: `recommendations.build-bought-together`, cron `17 3 * * *`.
- Rate-limit policy: `discovery.recommendations`.
- Metrics: `recommendations_requests_total`, `recommendations_hops_total`, `recommendations_bad_entries_total`, `recommendations_build_skipped_total` and others in `recommendations-metrics.ts`.
- Configuration: thresholds, window and bucket defaults, caps, TTLs and time budgets in `recommendations-config.ts`, validated at startup.

## Decisions
- Cosine similarity replaces raw counts so a hub product in almost every basket does not appear next to everything.
- An edge needs 3 orders and 3 distinct buyers so one buyer cannot create a link.
- Expansion reads only the 5 best neighbours in one batch to bound cost.
- Direct neighbours rank before indirect ones, whatever the score.
- The visibility check runs on every origin request, so the CDN copy (300 s) is the only staleness window.
- An empty source or failed build never wipes lists: a stale rail is withdrawn only by the 3-day TTL.
- The endpoint answers `503` instead of an unfiltered list.
- The basket store is rebuildable by replay, so it is a projection ({{concept:projection-and-replay}}).

## Known gaps
- AS-23 (noise threshold: `M–S` with 2 co-orders is excluded) has no test carrying its id.
- AS-50 and AS-51 carry test ids, but the work-order text provided does not state them. Startup validation of configuration (FR-029) is therefore unverified in this page.
- Rules R-06, R-07, R-11, R-16, R-18, R-20 and R-22 have no `` link; the facts do not show the symbols.
- AS-47 (metrics and logs) and AS-48 (UI rail) are P2; the page does not describe their detail beyond the metric names.
- AS-49 (composition by S48) is owned by S48; only a platform test carries its id.
- The 429 `Retry-After` rounding and the behaviour when the rate limiter fails open are not covered in the facts.

### Claims the generator could not verify (removed from the rules above)
- code ref `...` (file not found: ...)

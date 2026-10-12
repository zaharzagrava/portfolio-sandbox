---
id: S35
title: Trending products: windowed approximate top-K per category
kind: capability
status: draft
generated_at: e95ce81
depends_on: [S48, S50, S52, S54, S05, S03]
concepts: [problem-json-errors, rate-limit-policy, cache-layers, projection-and-replay, bff-aggregate]
models: []
scope:
  - packages/backend/libs/domains/discovery/**
  - packages/contracts/src/analytics/**
  - packages/contracts/src/search/**
---
# S35 - Trending products: windowed approximate top-K per category
## Purpose
Buyers see a "Trending now" rail of the products that gained the most interest in the last hour, overall and per category. The capability counts product views and add-to-carts from the analytics event stream in one-minute windows. It keeps the heaviest products in fixed memory with an approximate top-K, and serves the result through one anonymous, cacheable endpoint.

## Entry points
- `GET /api/trending?category=&limit=`: anonymous read of the ranking for the last 60 minutes. [code: packages/backend/libs/domains/discovery/api/trending.controller.ts#TrendingController]
- Topic `analytics.events` (key `anonymous_id`), consumer group `discovery-trending-topk`: the stream consumer counts `product_view` and `add_to_cart`, closes windows and merges them into the aggregate. [code: packages/backend/libs/domains/discovery/infra/trending.consumer.ts#TrendingConsumer]
- Home page "Trending now" section (W02): lists the endpoint items with price and link to the product page.
- Product-page composition ({{cap:S48}}): calls the endpoint with the product's category as an optional section, with a 200 ms budget.

## Rules
- **S35.R-01** The endpoint MUST answer anonymous callers; the body is identical for an anonymous caller, a signed-in buyer, a signed-in seller and a caller with an invalid bearer token. [proof: S35 AS-07] [code: packages/backend/libs/domains/discovery/api/trending.controller.ts#TrendingController]
- **S35.R-02** `category` MUST be 1–40 characters of lowercase letters, digits and hyphen, default `all`; any other value MUST answer `400` `validation_failed`. [proof: S35 AS-04] [code: packages/contracts/src/search/trending.ts#trendingQuerySchema]
- **S35.R-03** `limit` MUST be an integer from 1 to 20, default 20; `0`, `21`, `-1`, `abc`, `2.5` and an empty value MUST answer `400` and MUST NOT be clamped. [proof: S35 AS-03]
- **S35.R-04** An unknown query parameter MUST answer `400`. [proof: S35 AS-04]
- **S35.R-05** The score of a product MUST equal the sum of its weighted counts over the 60 one-minute windows ending at the latest minute boundary: view 1, add-to-cart 5. [proof: S35 AS-16, S35 AS-18] [code: packages/backend/libs/domains/discovery/domain/trending-ranking.ts#sumAndOrder]
- **S35.R-06** Items MUST be ordered by score descending, equal scores by `productId` ascending; the same input MUST give a byte-identical body. [proof: S35 AS-05] [code: packages/backend/libs/domains/discovery/domain/trending-ranking.ts#sumAndOrder]
- **S35.R-07** A well-formed category without data MUST answer `200` with empty `items`, never `404`. [proof: S35 AS-06]
- **S35.R-08** An item MUST be shown only when the product is not hidden (out of stock, archived, sandbox, shop not `ACTIVE`, or unknown to the catalog); hidden items MUST be replaced by the next visible ones and the list MUST NOT be padded. [proof: S35 AS-10, S35 AS-12]
- **S35.R-09** The catalog category MUST decide the category of an item; a product whose catalog category differs from the requested one MUST be absent. [proof: S35 AS-11]
- **S35.R-10** A `200` answer MUST carry `Cache-Control: public, max-age=30, s-maxage=30`; every `400`, `429` and `503` MUST carry `no-store`. [proof: S35 AS-01, S35 AS-09] [code: packages/backend/libs/domains/discovery/api/trending.controller.ts#TrendingController]
- **S35.R-11** The endpoint MUST read product facts and visibility on every origin request, so a stock change shows at origin at once although the ranking is cached 30 seconds. [proof: S35 AS-13]
- **S35.R-12** Concurrent cold requests for the same ranking MUST share one aggregate read. [proof: S35 AS-15]
- **S35.R-13** If the aggregate store, the product lookup (100 ms) or the shop lookup (50 ms) fails or runs over budget, the endpoint MUST answer `503` `trending_unavailable` with `Retry-After: 5`. [proof: S35 AS-14] [code: packages/backend/libs/domains/discovery/domain/trending-errors.ts#TrendingUnavailableError]
- **S35.R-14** The policy `discovery.trending` MUST limit each address to 300 requests per minute; the 301st request MUST answer `429` `rate_limited` with `Retry-After`. [proof: S35 AS-08] [code: packages/backend/libs/domains/discovery/rate-limit-policies.ts#discoveryRatePolicies]
- **S35.R-15** The event time MUST be the earlier of `ts` and `received_at`, so a future clock cannot advance the watermark. [proof: S35 AS-20] [code: packages/backend/libs/domains/discovery/domain/trending-event.ts#normalise]
- **S35.R-16** A window MUST close when the watermark (maximum event time minus 2 minutes) passes its end; an idle partition (30 s) MUST advance its watermark with the wall clock. [proof: S35 AS-17, S35 AS-21] [code: packages/backend/libs/domains/discovery/domain/tumbling-windows.ts#PartitionWindows]
- **S35.R-17** A late event for a closed window inside the 60-minute horizon MUST be applied once through the correction path; older events MUST be dropped and counted. [proof: S35 AS-19]
- **S35.R-18** One visitor MUST add at most one view and one add-to-cart per product per window. [proof: S35 AS-22] [code: packages/backend/libs/domains/discovery/domain/visitor-cap.ts#WindowCaps]
- **S35.R-19** The Count-Min Sketch MUST NOT undercount, and its counters MUST saturate at the maximum instead of wrapping. [proof: S35 AS-23, S35 AS-28] [code: packages/backend/libs/domains/discovery/domain/count-min-sketch.ts#CountMinSketch]
- **S35.R-20** The merge of a partition window MUST change the aggregate once, however often it is replayed or run by concurrent owners. [proof: S35 AS-31, S35 AS-33] [code: packages/backend/libs/domains/discovery/domain/trending-ports.ts#TrendingAggregateWriter]

## Behaviors
- **S35.B-01** Given dataset T merged, when an anonymous caller requests `category=audio`, then the answer is `200` with `windowMinutes: 60` and ranked items with score. [proof: S35 AS-01]
- **S35.B-02** Given dataset T, when `category` is omitted or `all`, then both answers are identical and each item shows its catalog category. [proof: S35 AS-02]
- **S35.B-03** Given `limit=2`, then the best two items return; `limit=1` and `limit=20` are accepted. [proof: S35 AS-03]
- **S35.B-04** Given equal scores, when the endpoint is called twice, then both bodies are identical with ties ordered by `productId`. [proof: S35 AS-05]
- **S35.B-05** Given no merged window for `garden`, when requested, then `200` with empty `items` and the same `Cache-Control` as a normal answer. [proof: S35 AS-06]
- **S35.B-06** Given the first five of ten ranked products are hidden, when `limit=4`, then the next four visible products return. [proof: S35 AS-10]
- **S35.B-07** Given a view attributed to the wrong category by a client, when its category is requested, then the product is absent. [proof: S35 AS-11]
- **S35.B-08** Given events named `page_view`, `search`, `checkout_step`, `exposure` or `click`, then they change nothing and are counted as `ignored`. [proof: S35 AS-16]
- **S35.B-09** Given a view at 11:00:30, when the endpoint is called at 11:59:20, then the view counts; at 12:01:05 it does not. [proof: S35 AS-18]
- **S35.B-10** Given one visitor sends 50 views of `A` in one window, then `A` gains 1; the next minute adds 1 again. [proof: S35 AS-22]
- **S35.B-11** Given `B` has 20 points in `p1` and 15 in `p2`, when both windows close, then the aggregate holds `B 35`. [proof: S35 AS-26]
- **S35.B-12** Given the same `event_id` delivered three times, then the weighted total rises once and the copies count as `duplicate`. [proof: S35 AS-29]
- **S35.B-13** Given a message that is not valid, then it is dead-lettered with a reason and has no other effect. [proof: S35 AS-30]
- **S35.B-14** Given the consumer is killed before it commits offsets, when it restarts, then the replayed merge leaves the aggregate unchanged. [proof: S35 AS-31]
- **S35.B-15** Given three open windows and a crash, when the consumer restarts, then it rebuilds them from the earliest unmerged offset and loses nothing. [proof: S35 AS-32] [code: packages/backend/libs/domains/discovery/domain/commit-floor.ts#commitFloor]
- **S35.B-16** Given a termination signal, then the consumer merges all open windows with the matching offsets and exits within the deadline. [proof: S35 AS-34]
- **S35.B-17** Given the aggregate store is down at window close, then the merge is retried with backoff and jitter, at most 3 attempts per cycle, and no later offset is committed. [proof: S35 AS-35]
- **S35.B-18** Given 1,000 categories in one partition window, then at most 100 are tracked and the rest count in `all` only. [proof: S35 AS-27]
- **S35.B-19** Given a seeded stream of at least 200,000 events over 20,000 products, then at least 9 of the exact top 10 are in the heap. [proof: S35 AS-25]
- **S35.B-20** Given a heap of capacity 3 and offers `a:5, b:3, c:4, d:9, e:2, b:7`, then it holds `d 9, b 7, a 5`. [proof: S35 AS-24] [code: packages/backend/libs/domains/discovery/domain/top-k.ts#TopK]

## Lifecycles
No status changes. A window is open, then closed and merged, but the facts list no model.

## Owns
- Aggregate keys in Redis, per category and window, with bounded retention (maximum 10,800 s). [code: packages/backend/libs/domains/discovery/infra/trending-keys.ts#aggregateKey]
- Consumer group `discovery-trending-topk` on topic `analytics.events`.
- Rate-limit policy `discovery.trending`.
- Metrics of `trendingEvents`, `trendingMerges` and related counters. [code: packages/backend/libs/domains/discovery/application/trending-metrics.ts#trendingEvents]
- Configuration: `TRENDING_*` variables (weights 1 and 5, window 60 s, lateness 120 s, idle 30 s, heap K 50, depth 4, category cap 100, memory budget 512 MB, budgets 100/100/50/100 ms). [code: packages/backend/libs/domains/discovery/domain/trending-config.ts#TRENDING_DEFAULTS]

## Decisions
- A Count-Min Sketch plus a min-heap keeps the heavy hitters in fixed memory (pattern P1102).
- Windows follow event time with a watermark, so out-of-order events count in the right minute.
- Late events go through a correction path instead of being dropped silently.
- Merges are identified by (partition, window, offsets) and are idempotent; offsets commit only up to the earliest unmerged window, so a crash loses nothing and double-counts nothing.
- The catalog is the authority on category and visibility, read at every origin request; only the ranking is cached.
- Errors are never cached.

## Known gaps
- AS-36 (metrics and privacy) has no test carrying its id.
- AS-38 (module boundary), AS-39 (retention and key ownership) and AS-40 (readiness when the broker is unreachable) have no test carrying their id; R-23 readiness behavior is therefore unproven.
- AS-37 configuration validation is covered by a unit spec only; startup failure is not tested end to end.
- AS-41 and AS-42 are tested, but no rule here states the UI and composition behavior in detail (empty rail, 429, 503 handling).
- The 1% false-"seen" rate of the visitor cap has no test with its own id.
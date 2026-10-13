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
- **S35.R-01** The endpoint MUST answer [anonymous callers](../terms/viewer.md); the body is identical for an anonymous caller, a signed-in buyer, a signed-in seller and a caller with an [invalid bearer token ↗](../sw-external-terms.md#authorization-bearer). [proof: S35 AS-07] [code: packages/backend/libs/domains/discovery/api/trending.controller.ts#TrendingController]
- **S35.R-02** `category` MUST be 1–40 characters of lowercase letters, digits and hyphen, default `all`; any other value MUST answer `400` [`validation_failed`](../terms/validation-failed-error.md). [proof: S35 AS-04] [code: packages/contracts/src/search/trending.ts#trendingQuerySchema]
- **S35.R-03** `limit` MUST be an integer from 1 to 20, default 20; `0`, `21`, `-1`, `abc`, `2.5` and an empty value MUST answer `400` and [MUST NOT be clamped](../terms/clamping.md). [proof: S35 AS-03]
- **S35.R-04** An [unknown query parameter](../terms/unknown-query-parameter.md) MUST answer `400`. [proof: S35 AS-04]
- **S35.R-05** The [score](../terms/trending-score.md) of a product MUST equal the sum of its [weighted counts](../terms/trending-event-weight.md) over the 60 [one-minute windows](../terms/trending-minute-window.md) ending at the [latest minute boundary](../terms/trending-minute-window.md): view 1, add-to-cart 5. [proof: S35 AS-16, S35 AS-18] [code: packages/backend/libs/domains/discovery/domain/trending-ranking.ts#sumAndOrder]
- **S35.R-06** Items MUST be ordered by score descending, equal scores by [`productId`](../terms/product-id.md) ascending; the same input MUST give a [byte-identical](../terms/identical-registration-response.md) body. [proof: S35 AS-05] [code: packages/backend/libs/domains/discovery/domain/trending-ranking.ts#sumAndOrder]
- **S35.R-07** A well-formed category without data MUST answer `200` with empty [`items`](../terms/search-items.md), never `404`. [proof: S35 AS-06]
- **S35.R-08** An item MUST be shown only when the product is not [hidden](../terms/search-visibility.md) (out of stock, archived, [sandbox](../terms/sandbox-product.md), shop not [`ACTIVE`](../terms/shop-status.md), or unknown to the catalog); hidden items MUST be replaced by the next visible ones and [the list MUST NOT be padded](../terms/no-padding.md). [proof: S35 AS-10, S35 AS-12]
- **S35.R-09** The [catalog category](../terms/catalog-category.md) MUST decide the category of an item; a product whose catalog category differs from the requested one MUST be absent. [proof: S35 AS-11]
- **S35.R-10** A `200` answer MUST carry [`Cache-Control: public, max-age=30, s-maxage=30` ↗](../sw-external-terms.md#cache-control); every `400`, [`429` ↗](../sw-external-terms.md#http-429-too-many-requests) and `503` MUST carry [`no-store` ↗](../sw-external-terms.md#cache-control-no-store). [proof: S35 AS-01, S35 AS-09] [code: packages/backend/libs/domains/discovery/api/trending.controller.ts#TrendingController]
- **S35.R-11** The endpoint MUST read product facts and [visibility](../terms/search-visibility.md) on every [origin request](../terms/origin-request.md), so a stock change shows at origin at once although the [ranking is cached 30 seconds](../terms/trending-ranking-cache.md). [proof: S35 AS-13]
- **S35.R-12** [Concurrent cold requests](../terms/cold-request.md) for the same ranking MUST [share one aggregate read ↗](../sw-external-terms.md#single-flight). [proof: S35 AS-15]
- **S35.R-13** If the [aggregate store](../terms/trending-aggregate.md), the product lookup (100 ms) or the shop lookup (50 ms) fails or runs [over budget](../terms/search-budget.md), the endpoint MUST answer `503` [`trending_unavailable`](../terms/trending-unavailable.md) with [`Retry-After: 5` ↗](../sw-external-terms.md#retry-after). [proof: S35 AS-14] [code: packages/backend/libs/domains/discovery/domain/trending-errors.ts#TrendingUnavailableError]
- **S35.R-14** The policy [`discovery.trending`](../terms/rate-limit-policy.md) MUST limit each address to 300 requests per minute; the 301st request MUST answer `429` [`rate_limited`](../terms/rate-limited.md) with [`Retry-After` ↗](../sw-external-terms.md#retry-after). [proof: S35 AS-08] [code: packages/backend/libs/domains/discovery/rate-limit-policies.ts#discoveryRatePolicies]
- **S35.R-15** The [event time ↗](../sw-external-terms.md#event-time) MUST be the earlier of [`ts`](../terms/event-ts.md) and [`received_at`](../terms/received-at.md), so a future clock cannot advance the [watermark](../terms/watermark.md). [proof: S35 AS-20] [code: packages/backend/libs/domains/discovery/domain/trending-event.ts#normalise]
- **S35.R-16** [A window](../terms/trending-window.md) MUST close when the [watermark](../terms/watermark.md) (maximum event time minus 2 minutes) passes its end; an [idle partition](../terms/idle-partition.md) (30 s) MUST advance its watermark with the [wall clock ↗](../sw-external-terms.md#wall-clock). [proof: S35 AS-17, S35 AS-21] [code: packages/backend/libs/domains/discovery/domain/tumbling-windows.ts#PartitionWindows]
- **S35.R-17** A late event for a [closed window](../terms/trending-window.md) inside the [60-minute horizon](../terms/late-event-horizon.md) MUST be applied once through the [correction path](../terms/correction-path.md); older events MUST be [dropped and counted](../terms/dropped-late-event.md). [proof: S35 AS-19]
- **S35.R-18** One [visitor](../terms/visitor.md) MUST add at most one [view](../terms/product-view-count.md) and one [add-to-cart](../terms/add-to-cart-signal.md) per product per [window](../terms/trending-window.md). [proof: S35 AS-22] [code: packages/backend/libs/domains/discovery/domain/visitor-cap.ts#WindowCaps]
- **S35.R-19** The [Count-Min Sketch ↗](../sw-external-terms.md#count-min-sketch) MUST NOT [undercount](../terms/sketch-overcount.md), and its counters MUST [saturate at the maximum instead of wrapping ↗](../sw-external-terms.md#saturating-counter). [proof: S35 AS-23, S35 AS-28] [code: packages/backend/libs/domains/discovery/domain/count-min-sketch.ts#CountMinSketch]
- **S35.R-20** The [merge of a partition window](../terms/partition-window-merge.md) MUST change the [aggregate](../terms/trending-aggregate.md) once, however often it is [replayed](../terms/event-replay.md) or run by [concurrent owners](../terms/partition-owner.md). [proof: S35 AS-31, S35 AS-33] [code: packages/backend/libs/domains/discovery/domain/trending-ports.ts#TrendingAggregateWriter]

## Behaviors
- **S35.B-01** Given [dataset T](../terms/dataset-t.md) merged, when an [anonymous caller](../terms/viewer.md) requests `category=audio`, then the answer is `200` with [`windowMinutes: 60`](../terms/trending-window.md) and [ranked items with score](../terms/business-score.md). [proof: S35 AS-01]
- **S35.B-02** Given dataset T, when `category` is omitted or `all`, then both answers are identical and each item shows its [catalog category](../terms/catalog-category.md). [proof: S35 AS-02]
- **S35.B-03** Given [`limit=2`](../terms/trending-limit.md), then the best two items return; `limit=1` and `limit=20` are accepted. [proof: S35 AS-03]
- **S35.B-04** Given equal scores, when the endpoint is called twice, then both bodies are identical with [ties ordered by `productId`](../terms/discount-tie-break.md). [proof: S35 AS-05]
- **S35.B-05** Given no [merged window](../terms/trending-window.md) for `garden`, when requested, then `200` with empty `items` and the same [`Cache-Control` ↗](../sw-external-terms.md#cache-control) as a normal answer. [proof: S35 AS-06]
- **S35.B-06** Given the first five of ten ranked products are [hidden](../terms/search-visibility.md), when `limit=4`, then the next four visible products return. [proof: S35 AS-10]
- **S35.B-07** Given [a view attributed to the wrong category by a client](../terms/product-view-count.md), when its category is requested, then the product is absent. [proof: S35 AS-11]
- **S35.B-08** Given events named `page_view`, `search`, `checkout_step`, `exposure` or `click`, then they change nothing and are counted as [`ignored`](../terms/consumer-outcomes.md). [proof: S35 AS-16]
- **S35.B-09** Given a view at 11:00:30, when the endpoint is called at 11:59:20, then [the view counts](../terms/trending-window.md); at 12:01:05 it does not. [proof: S35 AS-18]
- **S35.B-10** Given [one visitor sends 50 views](../terms/distinct-searchers.md) of `A` in one window, then `A` [gains 1](../terms/per-visitor-view-cap.md); the next minute adds 1 again. [proof: S35 AS-22]
- **S35.B-11** Given `B` has 20 points in `p1` and 15 in `p2`, when both [windows](../terms/build-window.md) close, then the [aggregate](../terms/page-aggregate.md) holds `B 35`. [proof: S35 AS-26]
- **S35.B-12** Given the same [`event_id`](../terms/event-id.md) delivered three times, then the [weighted total](../terms/weighted-total.md) rises once and the copies count as [`duplicate`](../terms/consumer-outcomes.md). [proof: S35 AS-29]
- **S35.B-13** Given a message that is not valid, then it is [dead-lettered ↗](../sw-external-terms.md#dead-letter-queue) with a reason and has no other effect. [proof: S35 AS-30]
- **S35.B-14** Given the consumer is killed before it [commits offsets ↗](../sw-external-terms.md#kafka-offset-commit), when it restarts, then the [replayed merge](../terms/window-merge.md) leaves the aggregate unchanged. [proof: S35 AS-31]
- **S35.B-15** Given three open windows and a crash, when the consumer restarts, then it rebuilds them from the [earliest unmerged offset ↗](../sw-external-terms.md#kafka-offset-commit) and loses nothing. [proof: S35 AS-32] [code: packages/backend/libs/domains/discovery/domain/commit-floor.ts#commitFloor]
- **S35.B-16** Given a [termination signal ↗](../sw-external-terms.md#graceful-shutdown), then the consumer merges all open windows with the matching offsets and exits within [the deadline](../terms/shutdown-deadline.md). [proof: S35 AS-34]
- **S35.B-17** Given the [aggregate store](../terms/aggregate-store.md) is down at window close, then the merge is retried with [backoff ↗](../sw-external-terms.md#exponential-backoff) and [jitter](../terms/jitter.md), at most 3 attempts per [cycle](../terms/merge-cycle.md), and no later offset is committed. [proof: S35 AS-35]
- **S35.B-18** Given 1,000 [categories](../terms/category-tracking.md) in one [partition window](../terms/build-window.md), then at most 100 are tracked and the rest count in [`all`](../terms/all-bucket.md) only. [proof: S35 AS-27]
- **S35.B-19** Given a [seeded stream](../terms/seeded-stream.md) of at least 200,000 events over 20,000 products, then at least 9 of the [exact top 10](../terms/exact-top-k.md) are in the [heap](../terms/top-k-heap.md). [proof: S35 AS-25]
- **S35.B-20** Given a [heap of capacity 3](../terms/top-k-heap.md) and [offers](../terms/heap-offer.md) `a:5, b:3, c:4, d:9, e:2, b:7`, then it holds `d 9, b 7, a 5`. [proof: S35 AS-24] [code: packages/backend/libs/domains/discovery/domain/top-k.ts#TopK]

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
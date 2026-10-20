---
id: J05
title: A buyer follows a shop, sees its new product in the feed, discusses it, shares an affiliate link that converts, and the purchase shows up in recommendations, trending, and A/B experiment results
kind: capability
status: draft
generated_at: 12774eda
depends_on: [S05, S10, S25, S26, S28, S34, S35, S37, S39, S53]
concepts: [outbox-task-queue, idempotency-key, projection-and-replay, order-reservation, payment-lifecycle, realtime-topic-stream, problem-json-errors]
models: []
scope:
---
# J05 - Engagement loop: follow, feed, discuss, share, convert

## Purpose
A buyer follows a shop, sees its new product in the feed, discusses it and shares an affiliate link. A friend buys through the link and the owner is credited. The purchase then feeds three read models: "bought together", trending and A/B results. This journey proves only the hand-offs between domains; each domain's own rules belong to its capability page.

## Entry points
The facts list no routes or pages for this journey, so no route is named in backticks. The journey drives these public surfaces of other capabilities (names from the work-order specification):
- Follow and feed (S26): follow a shop, read follow status, read the feed. A product event creates the feed item.
- Discussion (S25): create a post on a product board, comment, delete a post. Each writes a `discussion.*` event.
- Notifications (S28): a comment notifies the post author.
- Share links (S37): create a link, follow the short link, read stats and conversions.
- Checkout (S10): `ref` on checkout carries the share reference; `order.paid` and `order.refunded` feed conversions, baskets and experiments.
- Recommendations (S34): a build job produces the "bought together" rail.
- Trending (S35) and analytics events and experiments (S39).
- Control surface: pause and resume consumer groups, read their lag, run the job `recommendations.build-bought-together`, replay topics.

## Rules
- **J05.R-01** A product created after a [follow](../terms/follower-fan-out.md) MUST reach an active follower's [feed](../terms/device-feed.md) [exactly once](../terms/exactly-once-load.md), through the product's [event](../terms/event-payload.md) only. [proof: J05 AS-01, J05 AS-02]
- **J05.R-02** [Replaying](../terms/event-replay.md) [`products.events`](../terms/products-events-topic.md) and [`feed.events`](../terms/feed-events-topic.md) MUST leave the [feed](../terms/device-feed.md) with one item per product. [proof: J05 AS-03]
- **J05.R-03** The feed MUST hide a product that is no longer [sellable](../terms/is-publicly-visible.md), and an [older event](../terms/order-tolerant.md) MUST NOT bring it back. [proof: J05 AS-04, J05 AS-06]
- **J05.R-04** A [sandbox product](../terms/sandbox-product.md) or a draft (not [ACTIVE](../terms/product-lifecycle.md)) product MUST NOT become a [feed item](../terms/feed-item.md). [proof: J05 AS-06]
- **J05.R-05** A [paused feed consumer](../terms/consumer-pause.md) MUST NOT delay the seller's create; after resume the item MUST appear once and the [lag](../terms/consumer-lag.md) MUST be visible. [proof: J05 AS-05, J05 AS-11]
- **J05.R-06** A [post](../terms/board-post.md) MUST reach its author's followers' feeds through its [event](../terms/event-payload.md), and MUST leave every feed at once when deleted. [proof: J05 AS-07, J05 AS-10]
- **J05.R-07** A [board](../terms/product-board.md) MUST exist only for a known product; a post to an unknown product answers [`404 board_not_found`](../terms/board-not-found.md) and emits no event. [proof: J05 AS-12]
- **J05.R-08** Creating a post, a [comment](../terms/board-comment.md), a [link](../terms/referral-link.md) or a checkout MUST be [safe to retry ↗](../sw-external-terms.md#idempotency) with the same [`Idempotency-Key`](../terms/idempotency-key.md); the same key with another body answers `422`. [proof: J05 AS-08, J05 AS-14, J05 AS-21]
- **J05.R-09** A comment MUST [notify](../terms/notification.md) the post's author once, not the commenter. [proof: J05 AS-09]
- **J05.R-10** Checkout MUST accept an optional [`ref`](../terms/checkout-ref.md); an unknown, malformed, [disabled](../terms/referral-link.md) or self-owned reference MUST answer `202` with [`attribution: null`](../terms/checkout-attribution.md). [proof: J05 AS-16, J05 AS-17]
- **J05.R-11** A clicked link MUST NOT [credit the owner](../terms/referral-credit.md) unless the order carries [`ref`](../terms/order-ref.md). [proof: J05 AS-18]
- **J05.R-12** Each [attributed paid order](../terms/attributed-order.md) MUST yield exactly one [conversion](../terms/conversion.md) for the [link owner](../terms/link-owner.md), even under duplicate or late [`order.paid`](../terms/order-paid-event.md). [proof: J05 AS-13, J05 AS-15]
- **J05.R-13** A full refund MUST [reverse the conversion](../terms/conversion-reversal.md); a declined or cancelled order MUST NOT create one. [proof: J05 AS-19, J05 AS-20]
- **J05.R-14** The [recommendations rail](../terms/recommendation-rail.md) MUST show a [pair](../terms/recommendation-pair.md) only when at least 3 orders by 3 buyers support it, after the [build job](../terms/order-baskets-build.md). [proof: J05 AS-22, J05 AS-23]
- **J05.R-15** A refund MUST NOT [retract a pair](../terms/recommendation-pair.md) from the rail. [proof: J05 AS-25]
- **J05.R-16** A paid order MUST NOT change [trending scores](../terms/trending-score.md). [proof: J05 AS-27]
- **J05.R-17** [Duplicate event ids](../terms/event-id.md) and [invalid events](../terms/invalid-event.md) MUST NOT change trending scores; an invalid event is reported in [`rejected`](../terms/rejected-members.md). [proof: J05 AS-28]
- **J05.R-18** A signed-in purchase converts in an [experiment](../terms/experiment.md) only after the buyer's [exposure](../terms/experiment-exposure.md), and at most once; an [anonymous exposure](../terms/anonymous-exposure.md) does not join. [proof: J05 AS-30, J05 AS-31, J05 AS-33]
- **J05.R-19** [Replaying events](../terms/event-replay.md) MUST NOT change exposure or conversion counts per [variant](../terms/experiment-variant.md). [proof: J05 AS-32]
- **J05.R-20** Conversion, [stats](../terms/link-stats.md) and [`link.converted`](../terms/link-converted-event.md) MUST NOT expose the buyer's identity to the link owner. [proof: J05 AS-36]

## Behaviors
- **J05.B-01** Given a buyer follows shop S, when the seller creates product P, then [follow status](../terms/follow-status.md) shows `following: true` and the [feed](../terms/follow-feed.md) holds P once. [proof: J05 AS-01]
- **J05.B-02** Given a buyer follows S only after P exists, when they read the [feed](../terms/follow-feed.md) the first time, then P is in the first page once. [proof: J05 AS-02]
- **J05.B-03** Given the operator [replays](../terms/event-replay.md) the product and feed [topics](../terms/aggregate-type-events-topic.md), when [lag](../terms/consumer-lag.md) reaches 0, then the feed still holds P once. [proof: J05 AS-03]
- **J05.B-04** Given the seller [archives](../terms/product-archive.md) P, when the buyer reads the [feed](../terms/follow-feed.md), then P is absent. [proof: J05 AS-04]
- **J05.B-05** Given the [feed consumer](../terms/event-consumer.md) is [paused](../terms/consumer-pause.md), when the seller creates P2, then the create answers at once, P2 is absent and [lag](../terms/consumer-lag.md) is at least 1; after resume P2 appears. [proof: J05 AS-05]
- **J05.B-06** Given follower W follows buyer B, when B posts on a [product board](../terms/product-board.md), then W's feed holds one [`post` item](../terms/feed-item.md). [proof: J05 AS-07]
- **J05.B-07** Given B repeats a post five times at once with [one key](../terms/idempotency-key.md), when answers return, then all are `2xx` with one [`postId`](../terms/post-id.md) and the board lists one post. [proof: J05 AS-08]
- **J05.B-08** Given the seller comments on B's post, when B reads notifications, then one [`discussion.comment` item](../terms/discussion-comment-notification.md) exists. [proof: J05 AS-09]
- **J05.B-09** Given B deletes the post, when W reads the feed, then the post item is gone at once and a [late event](../terms/dropped-late-event.md) changes nothing. [proof: J05 AS-10]
- **J05.B-10** Given the [discussion consumer](../terms/discussion-consumer.md) is paused, when B posts, then the post exists at once and W's feed lacks it until resume. [proof: J05 AS-11]
- **J05.B-11** Given B creates a [link](../terms/referral-link.md) and anonymous F follows it, when F checks out with the [code](../terms/referral-code.md) and pays, then B has one [conversion](../terms/referral-conversion.md). [proof: J05 AS-13]
- **J05.B-12** Given F sends checkout five times with [one key](../terms/idempotency-key.md), when answers return, then one order exists with the first request's [attribution](../terms/referral-attribution.md). [proof: J05 AS-14]
- **J05.B-13** Given B checks out with their own link, when the order is paid, then [`attribution`](../terms/referral-attribution.md) is `null` and B has no new conversion. [proof: J05 AS-16]
- **J05.B-14** Given a full refund of the attributed order, when the [conversion consumer](../terms/conversion-consumer.md) runs, then B's conversion shows the [reversal](../terms/conversion-reversal.md). [proof: J05 AS-19]
- **J05.B-15** Given three buyers each paid a [basket](../terms/basket.md) `{P, Q}`, when the [build job](../terms/order-baskets-build.md) runs, then P's [rail](../terms/recommendation-rail.md) lists Q. [proof: J05 AS-22]
- **J05.B-16** Given a pair bought by one buyer, when the build runs, then [it is not shown](../terms/co-order-threshold.md). [proof: J05 AS-23]
- **J05.B-17** Given storefront events for P and Q, when [trending](../terms/trending-score.md) is read, then P ranks by views and [add-to-carts](../terms/add-to-cart-signal.md); [archiving](../terms/product-archive.md) P removes it from [`GET /trending?category=audio`](../terms/get-trending.md) results. [proof: J05 AS-26, J05 AS-29]
- **J05.B-18** Given a [destination](../terms/referral-destination.md) outside the marketplace, when B creates a link, then the answer is [`422 destination_not_allowed`](../terms/destination-not-allowed.md) and nothing is created. [proof: J05 AS-21]

## Lifecycles
This journey owns no status. Orders, conversions (credited, then reversed by refund), links and experiments change status in their own capabilities.

## Owns
No tables, queues, topics or events. It reads the topics `products.events`, `feed.events`, `discussion.events` and `orders.events`. It uses the consumer groups `community-feed-products`, `community-feed-fanout`, `community-feed-discussions`, `marketing-affiliate-conversions`, `discovery-order-baskets` and `experimentation-purchases`. It adds the job `recommendations.build-bought-together` to the control surface.

## Decisions
- The journey tests hand-offs only; each domain's own rules are proven by its own capability page.
- Domains exchange data through events, exported lookups or UI composition; none reads another's tables.
- Every consumer is idempotent and discards events older than the applied state.
- State changes publish through the outbox, never by a direct send after the write.
- All domains take time from the injected platform clock, so tests advance the clock.
- The link owner never learns who bought.

## Known gaps
- AS-34 (UI happy path) is pending until a web capability owns the pages; its test id exists but the page is not built.
- AS-35 (full replay), AS-36 (privacy inspection of logs) and AS-37 (static gates) carry test ids; their detail is not in the facts, so no rule here relies on them beyond R-20.
- The facts list no files, symbols or routes, so no `` clause appears.
- AS-33's second half (the anonymous exposure not counted) is truncated in the facts and is not stated as a rule.
- AS-24, AS-28 (consumer-down parts) and AS-32 are only partly described in the facts; the rules cover the visible parts.
- FR-030 time limits (H1–H15) have no values in the facts and are not stated.
- Test `J05 G-22` (jobs-cron.e2e-spec.ts) has no scenario text in the facts.

### Claims the generator could not verify (removed from the rules above)
- code ref `...` (file not found: ...)

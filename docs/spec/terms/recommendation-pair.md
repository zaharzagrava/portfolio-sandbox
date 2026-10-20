---
id: recommendation-pair
title: Recommendation pair
kind: term
status: draft
aliases: [pairs]
defined_for: J05-engagement-loop
rules_hash: 1449a083df7a
---
# Recommendation pair
## Definition
A recommendation pair is two products that appear together in buyers' [paid baskets](basket.md). The pair is shown on the [bought-together recommendation rail](recommendation-rail.md). The [`discovery-order-baskets` consumer group](consumer-group.md) collects baskets from [`orders.events`](orders-events-topic.md). The pair reaches the rail only after the [`recommendations.build-bought-together` job](order-baskets-build.md) runs. It must also meet both the [co-order threshold](co-order-threshold.md) and the [distinct buyers threshold](distinct-buyers-threshold.md). A later refund does not retract a pair from the rail (J05.R-15).

## Example
Three different buyers each pay for a basket `{P, Q}`. After the build job runs, P's rail lists Q (J05 AS-22). If the pair `{P, Q}` was bought by only one buyer, it is not shown (J05 AS-23).

## Known gaps
- The spec does not say whether a pair is symmetric, meaning whether Q's rail also lists P.
- The spec does not say why refunds do not retract pairs, or whether a later build recounts without the refunded order.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->

---
id: feed-events-topic
title: feed.events topic
kind: term
status: draft
aliases: [feed.events]
defined_for: J05-engagement-loop
rules_hash: e3b0c44298fc
---
# feed.events topic
## Definition
`feed.events` is the event topic for the follow-and-feed capability. The engagement journey reads it alongside [`products.events`](products-events-topic.md) to check that the feed stays correct. An operator can replay it from the [control surface](control-surface.md). Replaying it, together with `products.events`, must still leave the feed with one [feed item](feed-item.md) per product. Like every consumer here, the feed's consumers are [idempotent ↗](../sw-external-terms.md#idempotency) and discard events older than the state they already applied.

## Example
The operator replays `products.events` and `feed.events` and waits for [consumer lag](consumer-lag.md) to reach 0. The buyer then reads the feed, and product P is still listed exactly once (J05 AS-03).

## Known gaps
- The spec does not say which capability publishes to `feed.events` or which event types it carries.
- The spec does not say which of the [consumer groups](consumer-group.md) (`community-feed-products`, `community-feed-fanout`, `community-feed-discussions`) reads this topic.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->

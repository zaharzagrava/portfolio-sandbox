---
id: consumer-pause
title: Consumer pause
kind: term
status: draft
aliases: [paused, resume]
defined_for: J04-catalog-sync-to-search
rules_hash: bbc89c3ed04d
---
# Consumer pause
## Definition
Stopping one [event consumer](event-consumer.md) while every other consumer keeps running. Events for the paused consumer wait on its topic and its [consumer lag](consumer-lag.md) grows. Pausing one consumer must not delay or change any other consumer. After resume, the consumer works through the waiting events and must reach [`lag: 0`](consumer-lag.md). The [journey](main-journeys.md) always resumes consumers, even when a test fails.

## Example
From J04 B-18: [`integrations-stock-push`](integrations-stock-push-queue.md) is paused while three pushes sell 1, 1 and 2. Nothing is written to Shopify while it is paused. After resume, one write follows.

## Known gaps
- Not confirmed in the code: that pausing is done through the [control surface](control-surface.md). The facts only say the control surface exists outside production and is used for replays.
- The spec does not say whether consumers can be paused in production.

## Used by
<!-- used-by:start -->
- [J04](../capabilities/J04-catalog-sync-to-search.md): R-18
- [offline-sync-feed-consumer](offline-sync-feed-consumer.md)
- [queue-pause](queue-pause.md)
- [shopify-push-consumer](shopify-push-consumer.md)
<!-- used-by:end -->

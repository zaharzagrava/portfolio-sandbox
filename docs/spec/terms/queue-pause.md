---
id: queue-pause
title: Queue pause
kind: term
status: draft
aliases: [pause, resume]
defined_for: J04-catalog-sync-to-search
rules_hash: 3e0c3c5ab81d
---
# Queue pause
## Definition
A [pause](consumer-pause.md) stops one [consumer](event-consumer.md) in the chain from processing events, while the rest of the system keeps running. Events for that consumer wait until it resumes. It then catches up and reaches `[lag: 0](consumer-lag.md)`. Pausing one consumer must not affect the others, because each consumer is [idempotent ↗](../sw-external-terms.md#idempotency) and [version-guarded](version-guard.md). [Journey J04](main-journeys.md) uses pauses to prove that the hand-offs are independent, and it always resumes paused consumers, even when a test fails.

## Example
[`integrations-stock-push`](integrations-stock-push-queue.md) is paused, and a device makes three sales of 1, 1 and 2 units. The catalog and search update at once, but nothing is written to Shopify. After resume, one Shopify write follows and the consumer reaches `lag: 0`.

## Known gaps
- The spec does not say how a consumer is paused or resumed. The [control surface](control-surface.md) is a likely route, but the facts only name it for [replays](event-replay.md).
- The spec does not say whether pause is possible in production. The control surface exists only outside production.

## Used by
<!-- used-by:start -->
- [J04](../capabilities/J04-catalog-sync-to-search.md): B-17, B-18
<!-- used-by:end -->

---
id: consumer-outcomes
title: Consumer outcomes (duplicate, stale, ignored)
kind: term
status: draft
aliases: [duplicate, ignored, stale]
defined_for: projection-and-replay
rules_hash: bd2c79cac64e
---
# Consumer outcomes (duplicate, stale, ignored)
## Definition
Each event a consumer receives ends in a [counted outcome](cache-miss.md) instead of a silent skip. `duplicate` means a [`versionGuard`](version-guard.md) consumer saw an [`aggregateVersion`](aggregate-version.md) equal to the one it stored. `stale` means the version was lower. `ignored` means the consumer does not handle that event type. An ignored event still has its [offset committed ↗](../sw-external-terms.md#kafka-offset-commit) and is never [dead-lettered ↗](../sw-external-terms.md#dead-letter-queue). Separately, an event whose payload fails its schema is dead-lettered with [`SCHEMA_INVALID`](schema-invalid.md).

## Example
A consumer with stored version 5 for an aggregate receives three events: version 5 (`duplicate`), version 4 (`stale`), and an event type it has no handler for (`ignored`, offset committed). All values are illustrative.

## Known gaps
- The spec does not say where these counts are exposed, such as metric names or logs.
- The spec does not say whether an `inbox` consumer that finds an existing `(consumer, eventId)` record also counts the event as `duplicate`.
- The spec does not say whether offsets are committed for `duplicate` and `stale` events. The rules only state this for `ignored`.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): R-19
- [cache-invalidator](cache-invalidator.md)
- [cache-miss](cache-miss.md)
- [known-unmapped-type](known-unmapped-type.md)
- [monotonic-version](monotonic-version.md)
- [notification-version-check](notification-version-check.md)
- [orders-events-topic](orders-events-topic.md)
- [post-webhooks-stripe](post-webhooks-stripe.md)
- [search-projector](search-projector.md)
- [shop-onboarding-submitted-event](shop-onboarding-submitted-event.md)
- [shop-status-consumer](shop-status-consumer.md)
- [sponsorship-event](sponsorship-event.md)
- [subscription-plan-changed-event](subscription-plan-changed-event.md)
- [webhook-redelivery](webhook-redelivery.md)
<!-- used-by:end -->

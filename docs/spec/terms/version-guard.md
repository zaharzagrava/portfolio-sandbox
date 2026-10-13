---
id: version-guard
title: versionGuard
kind: term
status: draft
aliases: []
defined_for: outbox-task-queue
rules_hash: e3b0c44298fc
---
# versionGuard
## Definition
`versionGuard` is one of the three [deduplication modes](consumer-deduplication-mode.md) a [Kafka consumer](event-consumer.md) of [outbox events](inbox-table.md) must declare. With it, the consumer uses the event's `version` to decide whether to apply the event. The goal is that redelivered or duplicate events take effect once in effect. The comparison against stored state is general practice; this page assumes it from that practice, not from the facts.

## Example
A projection already stores `version` 7 for [`aggregateId`](aggregate-id.md) `prod-42` (illustrative values). A duplicate of event version 7 arrives after a relay crash, with the same [`eventId`](event-id.md). The guard sees that the version is not newer and skips the event. The consumer still [commits the offset ↗](../sw-external-terms.md#kafka-offset-commit) afterwards.

## Known gaps
- The spec does not say where the consumer stores the last applied version, or whether a "newer" version must be exactly one higher or just greater.
- The spec does not say what happens to an older or out-of-order version: silent skip, log, or error.
- Not confirmed in the code: which consumers declare `versionGuard`. S32's "external versioning" suggests it but does not confirm it.

## Used by
<!-- used-by:start -->
- [consumer-deduplication-mode](consumer-deduplication-mode.md)
- [event-consumer](event-consumer.md)
- [gallery-event](gallery-event.md)
- [guarded-update](guarded-update.md)
- [image-url](image-url.md)
- [inbox-table](inbox-table.md)
- [natural-idempotency](natural-idempotency.md)
- [sponsorship-event](sponsorship-event.md)
<!-- used-by:end -->

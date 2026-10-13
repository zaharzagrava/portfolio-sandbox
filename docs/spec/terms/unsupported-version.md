---
id: unsupported-version
title: UNSUPPORTED_VERSION
kind: term
status: draft
aliases: []
defined_for: S53-events-projections
rules_hash: e3b0c44298fc
---
# UNSUPPORTED_VERSION
## Definition
`UNSUPPORTED_VERSION` is the [reason code](dead-letter-reason-code.md) an [event consumer](event-consumer) attaches when it [dead-letters ↗](../sw-external-terms.md#dead-letter-queue) an event whose version it cannot handle. This happens when the event's version is above the [consumer's highest supported version](consumer-highest-version). The event goes to the consumer's [`<consumer>.dlq` ↗](../sw-external-terms.md#dead-letter-queue) topic instead of being applied. The consumer does not guess at a newer [event payload](event-payload) shape. Design intent (not stated in the spec): this keeps old consumers from misreading new payloads during a [rolling upgrade ↗](../sw-external-terms.md#rolling-upgrade).

## Example
A consumer handles `fixtures.item_changed` up to version 1. A producer starts sending version 2 (illustrative). Each version 2 event is written to `<consumer>.dlq` with `UNSUPPORTED_VERSION`, and the consumer does not apply it.

## Known gaps
- The spec does not say whether the consumer [commits the offset ↗](../sw-external-terms.md#kafka-offset-commit) past an `UNSUPPORTED_VERSION` event, as it does for [`HANDLER_FAILED`](handler-failed.md). It also does not say whether such an event [blocks the partition ↗](../sw-external-terms.md#kafka-partition).
- The spec does not say which field or header of the dead-letter message carries the reason code.
- The spec does not say how to recover once the consumer is upgraded. Redrive with `pnpm projections:redrive` (S53.B-14) is the likely route, but no rule ties it to this code.

## Used by
<!-- used-by:start -->
- [dead-letter-reason-code](dead-letter-reason-code.md)
<!-- used-by:end -->

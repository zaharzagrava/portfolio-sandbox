---
id: event-too-large-error
title: EventTooLargeError
kind: term
status: draft
aliases: []
defined_for: outbox-task-queue
rules_hash: e3b0c44298fc
---
# EventTooLargeError
## Definition
`EventTooLargeError` is the error raised when an event's [serialized envelope](event-envelope.md) is larger than the limit in rule outbox-task-queue.C-02. The event is rejected, not stored or published. Design intent (not stated in the spec): this keeps [outbox rows](inbox-table.md) and [Kafka messages ↗](../sw-external-terms.md#kafka-message) small and stays under broker message-size limits.

## Example
[S05](../capabilities/S05-products.md) tries to emit a product event that embeds a very large product description. Its serialized envelope is 300 KiB (illustrative), which is above the 256 KiB limit. The event is rejected with `EventTooLargeError`.

## Known gaps
- The spec does not say whether the size check runs at [`append`](outbox-append.md) (inside the [caller's transaction ↗](../sw-external-terms.md#database-transaction)) or later, at the [relay](outbox-relay.md).
- The spec does not say what a domain should do with data that is too large, for example whether to send a reference instead.

## Used by
<!-- used-by:start -->
- [event-envelope](event-envelope.md)
- [inbox-table](inbox-table.md)
- [outbox-relay](outbox-relay.md)
<!-- used-by:end -->

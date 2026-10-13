---
id: event-row
title: Event row (outbox)
kind: term
status: draft
aliases: [event row]
defined_for: transaction-runner
rules_hash: 3cadddb55c0a
---
# Event row (outbox)
## Definition
An event row is an outbox row that records a domain event to publish. Code writes it with [`append`](outbox-append.md), inside the caller's [active transaction](active-transaction.md). The event row commits together with the business change it describes, or is [rolled back ↗](../sw-external-terms.md#database-transaction) with it. This means an event is never recorded for a change that did not happen. {{cap:S53}} owns event rows and moves them from the outbox to Kafka.

## Example
Inside one [transaction-runner scope](transaction-scope.md), a service updates an order and calls `append` with an event such as `order.paid`.
After commit, the row is published to Kafka. On rollback, no event row is left (see rollback).

## Known gaps
- The spec does not say which columns an event row has, or how it maps to the [event envelope](event-envelope.md).
- The spec does not say whether the event row is published by the [outbox relay](outbox-relay.md) polling the table or by [CDC ↗](../sw-external-terms.md#change-data-capture). The S53 summary names both "outbox/CDC".
- The spec does not say what happens to an event row after it is published, for example whether it is deleted or marked.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): B-03
- [S10](../capabilities/S10-cart-checkout.md): R-26
- [S53](../capabilities/S53-events-projections.md): R-04, R-12, R-15, B-01, B-02
- [active-transaction](active-transaction.md)
- [append-standalone](append-standalone.md)
- [event-envelope](event-envelope.md)
- [no-op-update](no-op-update.md)
- [outbox-append-task](outbox-append-task.md)
- [outbox-relay](outbox-relay.md)
- [pending-row](pending-row.md)
- [published-row](published-row.md)
- [task-row](task-row.md)
- [transaction-scope](transaction-scope.md)
- [unregistered-aggregate-type-error](unregistered-aggregate-type-error.md)
- [write-model](write-model.md)
<!-- used-by:end -->

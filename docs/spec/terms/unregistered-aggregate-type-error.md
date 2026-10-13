---
id: unregistered-aggregate-type-error
title: UnregisteredAggregateTypeError
kind: term
status: draft
aliases: []
defined_for: S53-events-projections
rules_hash: e3b0c44298fc
---
# UnregisteredAggregateTypeError
## Definition
`UnregisteredAggregateTypeError` is the typed error thrown when an event names an [aggregate type](aggregate-type.md) that is not registered. It stops the event from reaching any [`<aggregateType>.events` topic](aggregate-type-events-topic.md). If you see it, the [writing domain](domain.md) has used a misspelled aggregate type or never registered it. Design intent (not stated in the spec): an unknown aggregate type fails loudly instead of creating a stray topic or losing the event silently.

## Example
A domain appends an event whose aggregate type is `invoices` (illustrative), but `invoices` is not registered. The call throws `UnregisteredAggregateTypeError`, and nothing is published to `invoices.events` (S53.R-06, proven by S53 AS-11).

## Known gaps
- The spec does not say at which step the error is thrown: when the event is created, at append, or in the [relay](outbox-relay.md).
- The spec does not say whether an [outbox row](event-row.md) is left behind. Other rules, like S53.R-03, say "nothing is appended", but S53.R-06 does not.
- The spec does not say whether the [framework-free append](outbox-append.md) (used by S29 and S24) checks registration the same way.

## Used by
<!-- used-by:start -->
- [aggregate-type-events-topic](aggregate-type-events-topic.md)
- [aggregate-type](aggregate-type.md)
- [domain](domain.md)
- [event-row](event-row.md)
- [outbox-append](outbox-append.md)
- [outbox-relay](outbox-relay.md)
<!-- used-by:end -->

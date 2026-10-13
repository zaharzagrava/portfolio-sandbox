---
id: aggregate-version
title: aggregateVersion
kind: term
status: draft
aliases: []
defined_for: projection-and-replay
rules_hash: 74f35cf12fc0
---
# aggregateVersion
## Definition
`[aggregate](aggregate-id.md)Version` is a number carried on each event that shows how far along its aggregate was when the event was produced. A [`versionGuard`](version-guard.md) [consumer](event-consumer.md) stores the last version it applied for each aggregate. It applies an incoming event only if the event's version is higher than the stored one. An equal version counts as [`duplicate`](consumer-outcomes.md) and a lower version counts as [`stale`](consumer-outcomes.md). This stops a late or repeated event from overwriting newer state.

## Example
The stored version for a product is 7. An event with `aggregateVersion: 8` is applied, and the stored version becomes 8. A redelivered event with version 8 counts as `duplicate`, and a late event with version 6 counts as `stale` (all values illustrative).

## Known gaps
- The spec does not say who assigns `aggregateVersion` or whether it always goes up by exactly one.
- The spec does not say where a `versionGuard` consumer keeps the stored version, for example in the read model's own row or in a separate table.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-18
- [S53](../capabilities/S53-events-projections.md): B-01
- [search-index](../concepts/search-index.md): C-02, C-03
- [event-consumer](event-consumer.md)
- [guarded-update](guarded-update.md)
- [search-visibility](search-visibility.md)
- [terminal-payment-status](terminal-payment-status.md)
<!-- used-by:end -->

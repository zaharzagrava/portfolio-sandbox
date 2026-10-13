---
id: autocomplete-snapshot-age-seconds
title: autocomplete_snapshot_age_seconds
kind: term
status: draft
aliases: []
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# autocomplete_snapshot_age_seconds
## Definition
`autocomplete_snapshot_age_seconds` is one of the metrics that [S33](../capabilities/S33-autocomplete.md) owns. Judging by its name, it reports how old the [suggestion snapshot](suggest-snapshot.md) is that a [serving node](serving-node.md) currently holds in memory. The spec lists the metric under "Owns" and gives no other details. Design intent (not stated in the spec): it shows when nodes are stuck on an old version, or when the builder has stopped publishing. It works alongside [`autocomplete_snapshot_load_failed_total`](autocomplete-snapshot-load-failed-total.md), which counts why loads failed.

## Example
The [`search.build-autocomplete`](search-build-autocomplete.md) job runs hourly. If it keeps failing, the [pointer](autocomplete-pointer.md) stops moving. Every node keeps serving the same `autocomplete/<version>`, and this metric keeps rising (for example 3 h instead of under 1 h; illustrative values).

## Known gaps
- The spec does not say what the age is measured from: when the build ran, when the snapshot was published, or when the node loaded it. Build outcomes `unchanged` and `skipped_empty` do not publish. If the age counts from publication, it can grow past the build interval even when everything is healthy.
- The spec does not say whether the metric is reported per node, or what it reports when no snapshot is loaded (for example at startup with no pointer).
- The spec does not say whether an alert or threshold is attached to this metric.

## Used by
<!-- used-by:start -->
- [autocomplete-pointer](autocomplete-pointer.md)
- [serving-node](serving-node.md)
- [suggest-snapshot](suggest-snapshot.md)
<!-- used-by:end -->

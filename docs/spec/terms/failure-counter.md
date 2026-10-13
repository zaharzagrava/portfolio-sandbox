---
id: failure-counter
title: Failure counter
kind: term
status: draft
aliases: [failure count]
defined_for: S33-autocomplete
rules_hash: ac932223c7c8
---
# Failure counter
## Definition
A node counts every failed [snapshot load](suggest-snapshot.md), labelled by the reason it failed, and then keeps serving its current index. In this system the count is exposed as the metric [`autocomplete_snapshot_load_failed_total{reason}`](autocomplete-snapshot-load-failed-total.md). A failed load never fails a request. This counter is how [operators](operator.md) find out that nodes are stuck on an older version.

## Example
[The pointer](autocomplete-pointer.md) names [`autocomplete/<version>`](autocomplete-object.md), but the object has been deleted. The node keeps answering from the previous version and increments `autocomplete_snapshot_load_failed_total` with a `reason` label (for example, a "missing" reason; the label value is illustrative).

## [Known gaps](known-gaps.md)
- The spec does not list the possible `reason` label values.
- Not confirmed in the code: that the count required by rule S33.R-24 is recorded in exactly this metric. The link is inferred from the matching name and the `reason` label.
- The spec does not say whether any alert is attached to this counter, or to [`autocomplete_snapshot_age_seconds`](autocomplete-snapshot-age-seconds.md).

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-19
- [autocomplete-pointer](autocomplete-pointer.md)
- [known-gaps](known-gaps.md)
- [operator](operator.md)
- [reset-on-success](reset-on-success.md)
- [suggest-snapshot](suggest-snapshot.md)
<!-- used-by:end -->

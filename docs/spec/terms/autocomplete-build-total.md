---
id: autocomplete-build-total
title: autocomplete_build_total
kind: term
status: draft
aliases: []
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# autocomplete_build_total
## Definition
`autocomplete_build_total` is a metric owned by [S33](../capabilities/S33-autocomplete.md) that counts runs of the [autocomplete build](autocomplete-build.md). The `_total` suffix is the usual naming convention for a [counter that only grows ↗](../sw-external-terms.md#counter-metric). Every build ends in one of the [build end states](build-end-states.md), so the metric tells operators how often the hourly [`search.build-autocomplete`](search-build-autocomplete.md) job ran. It is one of several S33 metrics, along with `autocomplete_[snapshot](snapshot.md)_age_seconds` and `autocomplete_snapshot_load_failed_total{reason}`.

## Example
The hourly `search.build-autocomplete` job runs on one [worker instance](worker-instance.md). Its entries match the current snapshot, so it ends `unchanged` and publishes nothing. The counter is then expected to go up by one, for example from 41 to 42 (illustrative values).

## Known gaps
- The spec does not say whether `autocomplete_build_total` has a label for the outcome (published, `unchanged`, `skipped_empty`, `superseded`). Unlike `autocomplete_snapshot_load_failed_total{reason}`, no label is listed for it.
- The spec does not say whether a build that fails with an error, rather than ending in one of the four outcomes, is counted.
- The spec does not say whether a worker that does not run the build counts anything. This is a worker that loses the race for the job lease when two replicas share the schedule.

## Used by
<!-- used-by:start -->
- [autocomplete-build](autocomplete-build.md)
- [build-end-states](build-end-states.md)
- [worker-instance](worker-instance.md)
<!-- used-by:end -->

---
id: autocomplete-build
title: Autocomplete build
kind: term
status: draft
aliases: [build, builds]
defined_for: S33-autocomplete
rules_hash: a1c6112459c5
---
# Autocomplete build
## Definition
The autocomplete build is the offline run of the job `search.build-autocomplete`. It turns the recorded history of past searches into a new [snapshot](suggest-snapshot.md). It counts [distinct eligible searchers](distinct-searchers.md) per query, removes queries that are barred from suggestions, drops queries with too few searchers, keeps the top queries up to the configured cap, and publishes a versioned object. The scheduler runs it on a schedule, and only once across replicas under a [job lease](job-lease.md). Each run ends in one outcome: published, `unchanged`, `skipped_empty` or `superseded`.

## Example
Two worker instances are running and the hourly schedule fires. Exactly one build runs (S33.B-17). It writes `autocomplete/<version>` and moves the pointer to `<version>`. If the entries matched the current snapshot, it would end `unchanged` and publish nothing.

## Known gaps
- The spec does not say how the build chooses the `<version>` value (for example, a timestamp or a counter). Yet the `superseded` rule depends on comparing versions.
- The spec does not give the default window or popularity floor. It gives only the default cap.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-13, B-15
- [S34](../capabilities/S34-recommendations.md): R-20
- [autocomplete-blocklist](autocomplete-blocklist.md)
- [autocomplete-build-total](autocomplete-build-total.md)
- [autocomplete-retention](autocomplete-retention.md)
- [blocklist-reload](blocklist-reload.md)
- [build-window](build-window.md)
- [decode-snapshot](decode-snapshot.md)
- [distinct-searchers](distinct-searchers.md)
- [eligible-searcher](eligible-searcher.md)
- [job-lease](job-lease.md)
- [popularity-floor](popularity-floor.md)
- [published-query](published-query.md)
- [query-log](query-log.md)
- [query-snapshot](query-snapshot.md)
- [search-log](search-log.md)
- [suggest-snapshot](suggest-snapshot.md)
<!-- used-by:end -->

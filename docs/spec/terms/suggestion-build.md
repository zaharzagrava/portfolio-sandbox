---
id: suggestion-build
title: Suggestion build
kind: term
status: draft
aliases: [build, build input]
defined_for: S33-autocomplete
rules_hash: b938b30b919d
---
# Suggestion build
## Definition
The suggestion build is the job `search.build-autocomplete`. It runs hourly and only once across replicas, guarded by a [job lease](job-lease.md). It reads S32's [search log](search-log.md), de-duplicates rows by [event id](event-id.md) and counts [distinct searchers](distinct-searchers.md) per query, not searches. Before counting, it applies the blocklist, [window](build-window.md) and [popularity floor](popularity-floor.md) to that input. It keeps the top queries up to the configured cap and writes a suggestion snapshot. Each run ends as published, `unchanged`, [`skipped_empty`](build-end-states.md) or `superseded`. Only a published run advances the [version pointer](version-pointer.md).

## Example
One searcher types `iphone case` 100 times. The build does not publish it, because it lacks enough distinct [eligible](eligible-searcher.md) searchers (S33.B-13).
Two builds overlap and the older one finishes last. The pointer stays on the newer version, and the older run deletes its own object and ends `superseded` (S33.B-15).

## Known gaps
- The spec does not give default values for the popularity floor or the window, and it does not define an "eligible" searcher.
- The spec does not say what "unchanged entries" is compared against (the pointed snapshot or the previous build). That decides when a build ends `unchanged`.
- Not confirmed in the code: whether a build that ends `skipped_empty` or `unchanged` still runs the cleanup of old snapshots.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-18, R-20
- [build-window](build-window.md)
- [catalog-completions](catalog-completions.md)
- [distinct-searchers](distinct-searchers.md)
- [eligible-searcher](eligible-searcher.md)
- [event-id](event-id.md)
- [job-lease](job-lease.md)
- [popularity-floor](popularity-floor.md)
- [search-log](search-log.md)
- [suggestion-blocklist](suggestion-blocklist.md)
- [version-pointer](version-pointer.md)
<!-- used-by:end -->

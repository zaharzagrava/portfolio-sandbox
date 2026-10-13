---
id: suggest-builder
title: Suggest builder
kind: term
status: draft
aliases: [build]
defined_for: S33-autocomplete
rules_hash: 45cafde9724e
---
# Suggest builder
## Definition
The suggest builder is the job `search.build-autocomplete`. It runs on a schedule and [holds a job lease](job-lease.md), so only one replica runs it at a time. It reads [S32's search log](search-log.md), applies the [blocklist](suggestion-blocklist.md) and the rules that decide which logged queries may become suggestions, and counts searchers for each query. It keeps the configured maximum number of queries and writes a new [suggest snapshot](suggest-snapshot.md). It is the only component allowed to advance the version pointer, and it removes old snapshot versions but never the one the pointer names.

## Example
Two worker instances both see the hourly schedule fire, and exactly one build runs. The job lives in `AutocompleteBuilderJobs` (`autocomplete-builder.jobs.ts`) and calls `AutocompleteBuildService`. It is wired up by `AutocompleteWorkerModule`.

## Known gaps
- The spec does not give the default aggregation window, meaning how far back in the search log the build reads.
- The spec does not say what happens when a build crashes partway through. Retry behaviour presumably follows the S49 job rules, but this is not stated.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-22
- [autocomplete-pointer](autocomplete-pointer.md)
- [build-end-states](build-end-states.md)
- [can-advance](can-advance.md)
- [eligible-query](eligible-query.md)
- [job-lease](job-lease.md)
- [operator](operator.md)
- [search-log](search-log.md)
- [suggest-snapshot](suggest-snapshot.md)
- [suggestion-blocklist](suggestion-blocklist.md)
- [version-pointer](version-pointer.md)
<!-- used-by:end -->

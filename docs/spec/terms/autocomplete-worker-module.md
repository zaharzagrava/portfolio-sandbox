---
id: autocomplete-worker-module
title: AutocompleteWorkerModule
kind: term
status: draft
aliases: []
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# AutocompleteWorkerModule
## Definition
`AutocompleteWorkerModule` is the module that hosts the autocomplete build job, [`search.build-autocomplete`](search-build-autocomplete.md). It is separate from `AutocompleteModule`, which hosts the [`GET /suggest`](get-suggest.md) API and the [snapshot poll](suggest-snapshot.md). A process that loads this module can run the hourly build, which turns the [search log](search-log.md) into a published snapshot. Several replicas may load it. The job's [lease](job-lease.md) makes sure only one of them runs each scheduled build.

## Example
Two worker instances load `AutocompleteWorkerModule`. The hourly schedule fires. One instance runs `search.build-autocomplete` and publishes `autocomplete/<version>`. The other does nothing for that run (S33.B-17).

## Known gaps
- Not confirmed in the code: whether `AutocompleteWorkerModule` and `AutocompleteModule` can be loaded in the same process. The code reference points only to `autocomplete.module.ts#AutocompleteModule`.
- Not confirmed in the code: which scheduler provides the lease. The spec says only "once across replicas, with a lease".

## Used by
<!-- used-by:start -->
- [job-lease](job-lease.md)
- [search-log](search-log.md)
- [suggest-snapshot](suggest-snapshot.md)
<!-- used-by:end -->

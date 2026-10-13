---
id: search-build-autocomplete
title: search.build-autocomplete job
kind: term
status: draft
aliases: [search.build-autocomplete]
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# search.build-autocomplete job
## Definition
`search.build-autocomplete` is the hourly offline job that builds the [query index](query-index.md). It reads S32's [search log](search-log.md) and counts [distinct searchers](distinct-searchers.md) per query. It removes blocked queries and keeps the most popular ones, up to a configured cap. Then it writes a [checksummed snapshot](autocomplete-checksum.md) to object storage and moves the [version pointer](version-pointer.md) forward. The pointer only moves forward in this job. Each run ends in one outcome: published, `unchanged`, `skipped_empty` or `superseded`.

## Example
A successful run creates `autocomplete/<version>`, sets the pointer to `<version>`, and its checksum verifies (S33.B-14). If two runs overlap and the older one finishes last, the pointer keeps the newer version. The older run deletes its own object and ends `superseded` (S33.B-15).

## Known gaps
- The spec does not say what happens if a run lasts longer than its job lease and another replica starts the job too. The `superseded` check still keeps the pointer correct.
- The spec does not say which component deletes old versions under the "latest five" retention (S33.B-16): this job or something else.

## Used by
<!-- used-by:start -->
- [autocomplete-checksum](autocomplete-checksum.md)
- [distinct-searchers](distinct-searchers.md)
- [query-index](query-index.md)
- [search-log](search-log.md)
- [version-pointer](version-pointer.md)
<!-- used-by:end -->

---
id: synonym-rules-version
title: Synonym rules version
kind: term
status: draft
aliases: [version]
defined_for: S32-product-search
rules_hash: 636b66dbab2b
---
# Synonym rules version
## Definition
The synonym rules version is a value that identifies the current set of synonym rules. `GET /admin/search/synonyms` returns it as `version`. Every edit must send it back as [`expectedVersion`](expected-version.md), which is how concurrent edits are detected (see `synonyms_version_conflict`). The version changes only when an edit succeeds. It stays the same after an invalid edit, an unchanged edit, or [an edit the search engine refuses](search-engine.md).

## Example
```json
GET /admin/search/synonyms
200 { "version": 8, "rules": ["sofa, couch", "tv => television"], "updatedAt": "2026-10-01T09:00:00Z", "updatedBy": "<adminId>" }
```
(All values are illustrative.)

## Known gaps
- The spec does not say whether the version is an integer that goes up by one, or what its starting value is.
- The spec does not say whether a [reindex](zero-downtime-reindexing.md) leaves the version as it is. It says only that the rules survive a reindex.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-31, B-26
- [invalid-synonym-rules](invalid-synonym-rules.md)
- [search-engine](search-engine.md)
- [synonym-cycle](synonym-cycle.md)
- [synonym-history](synonym-history.md)
- [synonym-rules](synonym-rules.md)
- [synonyms-unchanged-flag](synonyms-unchanged-flag.md)
- [synonyms-version-conflict](synonyms-version-conflict.md)
- [zero-downtime-reindexing](zero-downtime-reindexing.md)
<!-- used-by:end -->

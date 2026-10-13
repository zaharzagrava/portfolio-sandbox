---
id: put-admin-search-synonyms
title: PUT /admin/search/synonyms
kind: term
status: draft
aliases: [/admin/search/synonyms]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# PUT /admin/search/synonyms
## Definition
`PUT /admin/search/synonyms` is the administrator endpoint that replaces the whole set of [synonym rules](synonym-rules.md) in one call. The body carries the new `rules` and the `[expectedVersion](expected-version.md)` the caller last read. This is [optimistic concurrency](optimistic-concurrency.md): a stale version gets `[409 synonyms_version_conflict](synonyms-version-conflict.md)` with `currentVersion`. Rules that break the grammar get `[422 invalid_synonym_rules](invalid-synonym-rules.md)` with one `{index, code}` entry per bad rule, and nothing changes. A successful edit takes effect in search [without a reindex](zero-downtime-reindexing.md) and writes an [audit line](audit-log.md). A body identical to the current rules answers `[unchanged: true](synonyms-unchanged-flag.md)` without calling the engine.

## Example
```json
PUT /admin/search/synonyms
{ "expectedVersion": 7, "rules": ["sofa, couch", "tv => television"] }
```
Values are illustrative. If another administrator has already saved version 8, the answer is `409 synonyms_version_conflict` with `"currentVersion": 8`.

## Known gaps
- The spec does not give the full body of a successful (changed) response. It only states the `unchanged: true` case. `GET` returns `{version, rules, updatedAt, updatedBy}`.
- The spec does not list the values of `code` inside `errors`, so a client cannot depend on them yet.
- If the engine refuses the edit, the answer is `[503 search_unavailable](search-unavailable.md)`. The spec does not say whether the client should retry with the same `expectedVersion`. Since the version stays unchanged, a retry would presumably work.

## Used by
<!-- used-by:start -->
- [audit-log](audit-log.md)
- [optimistic-concurrency](optimistic-concurrency.md)
- [synonym-rules](synonym-rules.md)
- [zero-downtime-reindexing](zero-downtime-reindexing.md)
<!-- used-by:end -->

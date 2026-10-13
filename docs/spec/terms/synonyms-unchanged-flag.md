---
id: synonyms-unchanged-flag
title: unchanged flag
kind: term
status: draft
aliases: [unchanged]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# unchanged flag
## Definition
`unchanged: true` is a flag in the `200` answer to [`PUT /admin/search/synonyms`](put-admin-search-synonyms.md). It appears when the submitted [rules](synonym-rules.md) are identical to the current rules. In that case the [synonym rules version](synonym-rules-version.md) stays the same and [the search engine](search-engine.md) is not called. Design intent (not stated in the spec): sending the same rules twice is harmless and does not create a new version for nothing.

## Example
An admin sends again exactly the rules that are already stored:
```json
200 { "unchanged": true }
```
(The other members of the body are not specified.)

## Known gaps
- The spec does not say what "identical" means. For example, it does not say whether rules in a different order or with different spacing count as identical.
- The spec does not say whether an unchanged edit writes an [audit line](audit-log.md) or adds an entry to the [synonym history](synonym-history.md).
- The spec does not say what else the `200` body contains.

## Used by
<!-- used-by:start -->
- [audit-log](audit-log.md)
- [search-engine](search-engine.md)
- [synonym-history](synonym-history.md)
- [synonym-rules-version](synonym-rules-version.md)
- [synonym-rules](synonym-rules.md)
<!-- used-by:end -->

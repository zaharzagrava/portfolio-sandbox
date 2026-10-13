---
id: invalid-synonym-rules
title: invalid_synonym_rules (422)
kind: term
status: draft
aliases: [invalid_synonym_rules]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# invalid_synonym_rules (422)
## Definition
`invalid_synonym_rules` is the error that `PUT /admin/search/synonyms` returns when the request body has the right shape but the rules break the [synonym grammar](synonym-rules.md). Examples of a broken rule are a duplicate, a cycle, an empty side or a disallowed character. The answer has an [`errors` list](errors-entry.md), and each entry gives the `index` of the rule that failed and a `code` that says why. When this error is returned, the stored rules and the [synonym rules version](synonym-rules-version.md) do not change, and nothing is sent to the [search engine](search-engine.md). A body with the wrong shape gets [`validation_failed`](validation-failed-error.md) instead.

## Example
An admin sends a two-way rule and then a one-way rule whose right side is empty:
```json
PUT /admin/search/synonyms
{ "rules": ["sofa, couch", "tv =>"], "expectedVersion": 7 }

422 { "code": "invalid_synonym_rules", "errors": [{ "index": 1, "code": "empty_side" }] }
```
(`7` and the code `empty_side` are illustrative. The spec does not give the real per-rule code strings.)

## Known gaps
- The spec does not say what the per-rule `code` values are. It lists only the kinds of grammar break.
- The spec does not say whether every broken rule is reported or only the first one.
- The spec does not say which `index` is reported for a cycle, because a cycle is made by several rules together.

## Used by
<!-- used-by:start -->
- [errors-entry](errors-entry.md)
- [search-engine](search-engine.md)
- [synonym-rules-version](synonym-rules-version.md)
- [synonym-rules](synonym-rules.md)
<!-- used-by:end -->

---
id: search-query-sanitisation
title: Plain-word query matching
kind: term
status: draft
aliases: [operators, wildcards]
defined_for: S32-product-search
rules_hash: 26289a92b2b5
---
# Plain-word query matching
## Definition
Plain-word query matching means search treats everything in `q` as ordinary words to look for. It ignores any search-engine meaning those characters might have. [Boolean operators ↗](../sw-external-terms.md#boolean-operators), wildcards, quotes and field syntax such as `title:` get no special meaning. A query like this never causes an error and always answers `200`. Design intent (not stated in the spec): callers cannot [inject engine query syntax ↗](../sw-external-terms.md#sql-injection), and odd input cannot make a request fail.

## Example
`GET /products/search?q=title:iphone OR case*` answers `200`. It searches for words like "title", "iphone", "OR" and "case", not for a field filter or a wildcard. The query value is illustrative.

## Known gaps
- The spec does not say whether special characters are removed, escaped or kept as part of the words before matching.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-04, R-37
- [S33](../capabilities/S33-autocomplete.md): R-03, R-08, B-04
- [field-weights](field-weights.md)
- [lexical-search](lexical-search.md)
- [suggest-prefix](suggest-prefix.md)
<!-- used-by:end -->

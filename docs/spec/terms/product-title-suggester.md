---
id: product-title-suggester
title: ProductTitleSuggester
kind: term
status: draft
aliases: []
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# ProductTitleSuggester
## Definition
`ProductTitleSuggester` is a component owned by [S32 (product search)](../capabilities/S32-product-search.md). It returns product titles that complete a prefix. [S33](../capabilities/S33-autocomplete.md) does not own it. S33 reads it through [`CatalogTitleSourceAdapter`](catalog-title-source-adapter.md) to produce [catalog completions](catalog-completions.md). [Only visible products](search-visibility.md) may come back through it.

## Example
For `q=IPH`, S33 reduces the prefix to `iph` and asks `ProductTitleSuggester` for completions. Visible iPhone product titles come back and appear in the response as `catalog` entries.

## Known gaps
- The spec does not say what its interface is (inputs, result shape, maximum results). The S32 page would be the place to check.

## Used by
<!-- used-by:start -->
- [catalog-completions](catalog-completions.md)
- [search-visibility](search-visibility.md)
<!-- used-by:end -->

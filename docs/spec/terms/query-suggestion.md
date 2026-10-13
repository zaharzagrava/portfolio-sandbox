---
id: query-suggestion
title: Query suggestion
kind: term
status: draft
aliases: [query suggestions]
defined_for: S33-autocomplete
rules_hash: 972aec2750db
---
# Query suggestion
## Definition
A query suggestion is a suggestion that comes from the [query index](query-index.md): a popular past search that begins with the text the user has typed so far. Query suggestions are sorted by [distinct searchers](distinct-searchers.md) from highest to lowest, and ties are broken by text in ascending order. Because of that order, two identical calls return [byte-identical](identical-registration-response.md) answers. [In the blend](suggestion-blend.md), queries get the larger share of the slots and win any duplicate against suggestions drawn from the catalog or from typo correction. Any slots left unused go to the other source.

## Example
`iphone case` and `iphone cable` have the same number of searchers. For `q=iph`, the answer lists `iphone cable` before `iphone case`, and it does so on every call.

## Known gaps
- The spec does not say whether the searcher count is exposed in the response or used only for ordering.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-07
- [catalog-completions](catalog-completions.md)
- [distinct-searchers](distinct-searchers.md)
- [get-suggest](get-suggest.md)
- [identical-registration-response](identical-registration-response.md)
- [popularity-floor](popularity-floor.md)
- [query-index](query-index.md)
- [suggest-entry-kinds](suggest-entry-kinds.md)
- [suggest-limit](suggest-limit.md)
- [suggest-prefix](suggest-prefix.md)
- [suggestion-blend](suggestion-blend.md)
- [typo-suggestion-source](typo-suggestion-source.md)
<!-- used-by:end -->

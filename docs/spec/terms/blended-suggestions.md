---
id: blended-suggestions
title: Blended suggestions
kind: term
status: draft
aliases: [blended list]
defined_for: S33-autocomplete
rules_hash: f69438637d65
---
# Blended suggestions
## Definition
Blended suggestions are the single `suggestions` list that [`GET /suggest`](get-suggest.md) returns. [`blendSuggestions`](suggestion-blend.md) merges three sources in this order: popular queries from the [suggest index](suggest-index.md), [catalog completions](catalog-completions.md) from visible products, and [typo-corrected titles](typo-suggestion-source.md). Each source gets a [slot budget](slot-budget.md) and gives its unused slots to the other. Duplicates are removed on [normalised text](normalised-text.md), and the first source wins. A source that fails is left out and named in [`degraded`](degraded.md).

## Example
`GET /api/suggest?q=IPH` with the default limit of 8: queries get ⌈0.6 × 8⌉ = 5 slots, and the catalog gets up to 5. Unused slots move to the other source, and the total stays at 8 or fewer.
```json
{"prefix":"iph","suggestions":[/* query entries, then catalog entries */],"degraded":[]}
```

## Known gaps
- The spec does not show the JSON shape of one suggestion entry. The text only says entries are of kind `query` or `catalog`.
- The spec does not say when the typo source runs, what slot budget it gets, or which `degraded` name it reports when it fails.
- The spec does not say whether the order within the final list is all queries first, or interleaved.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-01
- [autocomplete-module](autocomplete-module.md)
- [catalog-completions](catalog-completions.md)
- [normalised-text](normalised-text.md)
- [slot-budget](slot-budget.md)
- [suggest-index](suggest-index.md)
- [typo-suggestion-source](typo-suggestion-source.md)
<!-- used-by:end -->

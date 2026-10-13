---
id: synonym-cycle
title: Synonym cycle
kind: term
status: draft
aliases: [cycle]
defined_for: S32-product-search
rules_hash: 065b359ae115
---
# Synonym cycle
## Definition
A synonym cycle is a set of [one-way synonym rules](synonym-rules.md) that leads from a term back to itself. One example is `a => b` with `b => a`. A longer one is `a => b`, `b => c`, `c => a`. A cycle breaks the [synonym grammar](synonym-rules.md), so [`PUT /admin/search/synonyms`](put-admin-search-synonyms.md) rejects the whole edit with [`422 invalid_synonym_rules`](invalid-synonym-rules.md), and the stored rules and [version](synonym-rules-version.md) stay as they were. Design intent (not stated in the spec): a cycle makes it unclear which way a term should expand, and the expansion could go on forever.

## Example
```json
{ "expectedVersion": 3, "rules": ["laptop => notebook", "notebook => laptop"] }
```
Values are illustrative. The answer is `422 invalid_synonym_rules` with an [`errors` entry](errors-entry.md) for the offending rule. If you want two words to match each other, write one two-way rule instead: `laptop, notebook`.

## Known gaps
- The spec does not define "cycle" precisely. The reading above (one-way rules leading back to their start) is the usual meaning, but it is not confirmed.
- The spec does not say which rule `index` an `errors` entry points to when a cycle spans several rules.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-27
- [errors-entry](errors-entry.md)
- [synonym-rules-version](synonym-rules-version.md)
- [synonym-rules](synonym-rules.md)
<!-- used-by:end -->

---
id: autocomplete-module
title: AutocompleteModule
kind: term
status: draft
aliases: []
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# AutocompleteModule
## Definition
`AutocompleteModule` is the API-side module of the autocomplete capability in the discovery domain. A process that loads it becomes a [serving node](serving-node.md) and answers [`GET /suggest`](get-suggest.md). The hourly build job is wired separately, in [`AutocompleteWorkerModule`](autocomplete-worker-module.md). Keeping the two apart lets the build run away from request traffic. That reason is design intent (not stated in the spec).

## Example
A serving node that loads `AutocompleteModule` answers `GET /api/suggest?q=IPH` with `200`, `prefix: "iph"` and a [blended list](blended-suggestions.md) of `query` and `catalog` entries (S33.B-01). The job [`search.build-autocomplete`](search-build-autocomplete.md) does not run from this module. It runs from `AutocompleteWorkerModule`.

## Known gaps
- Not confirmed in the code: which providers `AutocompleteModule` registers. The facts do not show whether `SuggestController`, `QueryIndexService`, `CatalogTitleSourceAdapter`, `CatalogCircuit` and the `discovery.suggest` rate-limit policy are all wired in this module.
- The spec does not say whether one process may load both `AutocompleteModule` and `AutocompleteWorkerModule`, or whether they must run in separate deployments.
- The spec does not say whether this module validates the autocomplete configuration (budgets, poll interval, blocklist) at startup or leaves that to another module.

## Used by
<!-- used-by:start -->
- [blended-suggestions](blended-suggestions.md)
- [serving-node](serving-node.md)
<!-- used-by:end -->

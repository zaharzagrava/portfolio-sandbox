---
id: redacted-query
title: Redacted query
kind: term
status: draft
aliases: [[redacted]]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# Redacted query
## Definition
A redacted query is a [query log](query-log.md) row whose text was replaced with the literal `[redacted]` because it looked like personal data. A query is redacted when it holds an email address, a long run of digits or a card-like number. The row still keeps its result count, so volume and [zero-result statistics](zero-result-rate.md) stay usable. The goal is to keep personal data out of the search logs, which is design intent (not stated in the spec). Redacted rows expire with the rest of the query table.

## Example
A buyer searches `jane@example.com order 123456789`. The query log stores `query: "[redacted]"` with `results: 0`, not the original text. (The query is illustrative.)

## [Known gaps](known-gaps.md)
- The spec does not say what exactly counts as "card-like", for example whether a checksum test is used.
- The spec does not say whether the `query` field of the [`search.performed`](search-performed-event.md) event is redacted the same way.
- The spec does not say how redacted rows appear in [`GET /admin/search/quality`](get-admin-search-quality.md), for example whether they are grouped as one `[redacted]` query.

## Used by
<!-- used-by:start -->
- [known-gaps](known-gaps.md)
- [query-log](query-log.md)
- [zero-result-rate](zero-result-rate.md)
<!-- used-by:end -->

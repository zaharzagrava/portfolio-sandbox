---
id: shop-search-q-parameter
title: q (shop search parameter)
kind: term
status: draft
aliases: [q]
defined_for: S32-product-search
rules_hash: 961cf17e3978
---
# q (shop search parameter)
## Definition
`q` is [the search text a shop member sends to the shop search route](shop-product-search-route.md), and the route requires it. The route matches it literally, so quotes, operators and backslashes are treated as ordinary characters. If [full text ↗](../sw-external-terms.md#full-text-search) finds nothing, the search falls back to a [trigram match ↗](../sw-external-terms.md#trigram-match) on each word. The [opaque cursor](pagination-cursor.md) is tied to the `q` it came from, so the next page must reuse the same text.

## Example
`GET /shops/shop_123/products/search?q=blue%20mug&status=ACTIVE&limit=25` (shop id is illustrative)
- Leaving out `q`, or sending 101 characters, answers [`400 validation_failed`](validation-failed-error.md).
- Sending the `nextCursor` from a `q=blue mug` page together with `q=red mug` answers [`422 invalid_cursor`](invalid-cursor.md).

## Known gaps
- The spec does not say whether `q` is trimmed or normalised (case, whitespace) before the length check or the match.
- The spec does not say how the trigram fallback ranks its results compared with full-text results.

## Used by
<!-- used-by:start -->
- [pagination-cursor](pagination-cursor.md)
- [semantic-requires-query](semantic-requires-query.md)
- [shop-product-search-route](shop-product-search-route.md)
<!-- used-by:end -->

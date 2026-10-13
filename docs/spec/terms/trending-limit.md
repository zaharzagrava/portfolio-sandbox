---
id: trending-limit
title: Trending limit parameter
kind: term
status: draft
aliases: [limit]
defined_for: S35-trending
rules_hash: e3b0c44298fc
---
# Trending limit parameter
## Definition
`limit` is the query parameter that sets how many ranked items the [trending endpoint](get-trending.md) returns. It must be an integer within the allowed range. When you leave it out, the default applies. Any value outside the range or not a whole number is rejected with `400` and is [never clamped](clamping.md). [Hidden products](search-visibility.md) are skipped and replaced by the next visible ones, so a response can hold fewer items than `limit` but is [never padded](no-padding.md).

## Example
`GET /api/trending?category=audio&limit=2` returns the best two visible items. `limit=1` and `limit=20` are accepted. `limit=0`, `limit=21`, `limit=-1`, `limit=abc`, `limit=2.5` and an empty `limit=` all answer `400`.

## Used by
<!-- used-by:start -->
- [clamping](clamping.md)
- [get-trending](get-trending.md)
- [no-padding](no-padding.md)
- [search-visibility](search-visibility.md)
<!-- used-by:end -->

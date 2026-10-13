---
id: unknown-query-parameter
title: Unknown query parameter rejection
kind: term
status: draft
aliases: [unknown query parameter]
defined_for: S35-trending
rules_hash: c83e10b56e34
---
# Unknown query parameter rejection
## Definition
[The trending endpoint](get-trending.md) accepts only the query parameters it defines, `category` and `limit`. Any other parameter makes the request fail with `400` instead of being ignored. Like every `400` from this endpoint, the answer carries [`Cache-Control: no-store` ↗](../sw-external-terms.md#cache-control-no-store). The reason is design intent (not stated in the spec): a typo in a parameter name should fail loudly instead of quietly returning [the default ranking](trending-ranking-cache.md).

## Example
`GET /api/trending?category=audio&sort=new` answers `400`, because `sort` is not a known parameter (`sort` is illustrative).

## Known gaps
- The spec does not say which [error code](error-code.md) or [problem body](exact-body-members.md) the `400` carries for an unknown parameter.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): R-04
- [error-code](error-code.md)
- [exact-body-members](exact-body-members.md)
- [get-trending](get-trending.md)
- [trending-ranking-cache](trending-ranking-cache.md)
<!-- used-by:end -->

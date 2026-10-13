---
id: clamping
title: Clamping (no silent adjustment of out-of-range values)
kind: term
status: draft
aliases: [clamped]
defined_for: S35-trending
rules_hash: 8c3ab7d9f1a1
---
# Clamping (no silent adjustment of out-of-range values)
## Definition
Clamping means quietly changing an out-of-range value to the nearest allowed value, such as turning a too-large [`limit`](trending-limit.md) into the maximum. [The trending endpoint](get-trending.md) must never do this. An invalid `limit` is rejected with `400`, so the caller always gets exactly what was asked for or an error. The reason is design intent (not stated in the spec): a silent fix would hide bugs on the caller's side.

## Example
`GET /api/trending?limit=21` answers `400`. It does not return 20 items.
`GET /api/trending?limit=0`, `limit=-1`, `limit=abc`, `limit=2.5` and an empty `limit=` also answer `400`.

## Known gaps
- The spec does not say which [error code](error-code.md) a bad `limit` returns. The rule for [`category`](category-tracking.md) names [`validation_failed`](validation-failed-error.md), but the rule for `limit` only says `400`.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): R-03
- [S50](../capabilities/S50-rate-limiter.md): R-11
- [acquire](acquire.md)
- [combined-business-multiplier](combined-business-multiplier.md)
- [error-code](error-code.md)
- [get-trending](get-trending.md)
- [trending-limit](trending-limit.md)
<!-- used-by:end -->

---
id: validate-day
title: validateDay
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# validateDay
## Definition
`validateDay` is the domain rule that checks a [reconciliation `day`](statement-day.md) before the day is used. It accepts only a [closed UTC day](closed-utc-day.md) inside the [look-back window](look-back-window.md), and it refuses any other day. It lives in the [domain layer](domain-layer.md), so the check has no [I/O ↗](../sw-external-terms.md#pure-function). Design intent (not stated in the spec): with one shared check, every path that starts a [run](reconciliation-run.md) accepts the same days.

## Example
The current time is 2026-10-13 09:00 UTC. The call shape below is illustrative.
```
validateDay("2026-10-12")  // accepted: closed, inside the window
validateDay("2026-10-13")  // refused: the day has not ended yet
validateDay("2026-07-01")  // refused: older than the 90-day window
```

## Known gaps
- The spec does not say what `validateDay` returns or throws when it refuses a day, or which error code the caller sees.
- Not confirmed in the code: whether "now" comes from the [injected clock](injected-clock.md).
- The spec does not say whether the oldest boundary day of the window is accepted.

## Used by
<!-- used-by:start -->
- [closed-utc-day](closed-utc-day.md)
- [domain-layer](domain-layer.md)
- [injected-clock](injected-clock.md)
- [look-back-window](look-back-window.md)
- [reconciliation-run](reconciliation-run.md)
- [statement-day](statement-day.md)
<!-- used-by:end -->

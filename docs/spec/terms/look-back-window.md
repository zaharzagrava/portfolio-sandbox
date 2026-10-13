---
id: look-back-window
title: Look-back window
kind: term
status: draft
aliases: [allowed look-back window, look-back]
defined_for: S14-ledger-reconciliation
rules_hash: 1f76b8c707d5
---
# Look-back window
## Definition
The look-back window is how far into the past a reconciliation `day` may be. [`validateDay`](validate-day.md) accepts a day only if it is a closed UTC day inside this window, and refuses any other day. Design intent (not stated in the spec): the window keeps reconciliation to recent days, where the provider statement is still available and a difference can still be acted on. The window is separate from the [reconciliation schedule's catch-up range](reconciliation-schedule.md), which is shorter.

## Example
The current time is 2026-10-13 09:00 UTC. The dates below are illustrative.
- `2026-07-20` is 85 days back. It is inside the 90-day window, so it is accepted.
- `2026-07-01` is 104 days back. It is outside the window, so it is refused.

## Known gaps
- The spec does not say whether the oldest boundary day is accepted. It also does not say which clock "now" comes from.
- The spec does not say which error a day outside the window produces.
- The spec does not say how a run is started for a day older than the schedule's catch-up range. The finance API listed only reads runs and issues, and resolves issues.

## Used by
<!-- used-by:start -->
- [closed-utc-day](closed-utc-day.md)
- [reconciliation-schedule](reconciliation-schedule.md)
- [statement-day](statement-day.md)
- [validate-day](validate-day.md)
<!-- used-by:end -->

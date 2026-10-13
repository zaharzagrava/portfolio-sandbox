---
id: corrects-day
title: correctsDay
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: 39548a70109c
---
# correctsDay
## Definition
`correctsDay` is a field on a correction journal. It records which already-[reconciled UTC day](closed-utc-day.md) the correction is for. Entries of a reconciled day never change, so the correction is posted in the [current period](ledger-period.md) and points back to that day with `correctsDay`. It is set on the `ADJUSTMENT` journal that is posted when an admin resolves an [issue](reconciliation-issue.md) as `adjusted`. This lets finance tie today's correction to the day that had the difference. That reason is design intent (not stated in the spec).

## Example
On 2026-10-13, an `ADJUSTMENT` journal fixes a difference found in the run for 2026-10-10. The journal's `postedAt` is 2026-10-13 and its `correctsDay` is `2026-10-10` (illustrative dates).

## Known gaps
- The spec does not say how `correctsDay` is stored (date format, or a column on the header table).
- The spec does not say whether `correctsDay` is required or allowed on journal kinds other than `ADJUSTMENT`.
- The spec does not say whether a reconciliation run of the corrected day, or of the current day, takes `correctsDay` into account.

## Used by
<!-- used-by:start -->
- [closed-utc-day](closed-utc-day.md)
- [ledger-period](ledger-period.md)
- [posted-at](posted-at.md)
- [reconciliation-issue](reconciliation-issue.md)
- [reconciliation-resolution](reconciliation-resolution.md)
- [reconciliation](reconciliation.md)
<!-- used-by:end -->

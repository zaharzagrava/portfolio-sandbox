---
id: reconciliation-schedule
title: Reconciliation schedule
kind: term
status: draft
aliases: [schedule]
defined_for: S14-ledger-reconciliation
rules_hash: 0b8e0da087ee
---
# Reconciliation schedule
## Definition
The reconciliation schedule picks which days get a reconciliation run automatically. Each time it fires, it runs the previous closed UTC day. It also [catches up](cron-catch-up.md) recent days that have no `COMPLETED` run, so a day that failed or was missed gets another try. A run is unique per (provider, day) and a `COMPLETED` run is final, so a repeated fire never reconciles a day twice.

## Example
On 2026-10-13 the schedule runs `2026-10-12`. The statuses below are illustrative.
- `2026-10-09` ended `FAILED(provider_unavailable)`, so the schedule catches it up.
- `2026-10-10` is already `COMPLETED`, so the schedule skips it.

## Known gaps
- The spec does not say what time of day the schedule fires.
- Not confirmed in the code: whether the `payments.reconcile-daily` job carries this schedule.
- The spec does not say exactly where the catch-up range ("the last 7") starts. So it does not say which day is the oldest one caught up.

## Used by
<!-- used-by:start -->
- [closed-utc-day](closed-utc-day.md)
- [cron-catch-up](cron-catch-up.md)
- [look-back-window](look-back-window.md)
<!-- used-by:end -->

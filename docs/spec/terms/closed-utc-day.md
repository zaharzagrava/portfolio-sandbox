---
id: closed-utc-day
title: Closed UTC day
kind: term
status: draft
aliases: [day]
defined_for: S14-ledger-reconciliation
rules_hash: e6202ba24361
---
# Closed UTC day
## Definition
A closed UTC day is a calendar day, counted in UTC, that has already fully ended. Reconciliation only accepts a closed day within its [allowed look-back window](look-back-window.md), and [`validateDay`](validate-day.md) refuses any other day. Because the day is closed, the provider's statement for it should no longer change. Matching an unfinished day would report false differences. Both of these reasons are design intent (not stated in the spec).

## Example
The current time is 2026-10-13 09:00 UTC.
- `2026-10-12` is a closed UTC day, and it is the day [the schedule runs](reconciliation-schedule.md).
- `2026-10-13` is not closed yet, so a run for it is refused.
- A day older than 90 days is also refused.

## Known gaps
- The spec does not say which error a refused `day` produces.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-33
- [corrects-day](corrects-day.md)
- [ledger-jobs](ledger-jobs.md)
- [ledger-period](ledger-period.md)
- [ledger-reconciliation-completed-event](ledger-reconciliation-completed-event.md)
- [ledger](ledger.md)
- [look-back-window](look-back-window.md)
- [payments-reconcile-daily-job](payments-reconcile-daily-job.md)
- [posted-at](posted-at.md)
- [provider-statement](provider-statement.md)
- [reconciliation-run-service](reconciliation-run-service.md)
- [reconciliation-schedule](reconciliation-schedule.md)
- [reconciliation](reconciliation.md)
- [statement-day](statement-day.md)
- [stripe-statement-adapter](stripe-statement-adapter.md)
- [validate-day](validate-day.md)
<!-- used-by:end -->

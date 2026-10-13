---
id: statement-day
title: Statement day
kind: term
status: draft
aliases: [statement]
defined_for: S14-ledger-reconciliation
rules_hash: e69456e6f8db
---
# Statement day
## Definition
A statement day is the [closed UTC day](closed-utc-day.md) of the payment provider's statement that one [reconciliation run](reconciliation-run.md) checks against the [ledger](ledger.md). A run is unique per (provider, day), and a [`COMPLETED`](reconciliation-run-status.md) run for that day is final. The day must be closed and fall within the [allowed lookback window](look-back-window.md). The schedule checks the previous UTC day and catches up recent days that have no `COMPLETED` run.

## Example
On 2026-10-13 the [`payments.reconcile-daily`](payments-reconcile-daily-job.md) job reads the provider's statement for 2026-10-12 (UTC) through the [statement adapter](stripe-statement-adapter.md). It matches each line and ends the run `COMPLETED`.

## Known gaps
- The spec does not say how a `SALE` or `REFUND` journal near midnight is assigned to a statement day, for example by [`postedAt`](posted-at.md) or by the provider's own timestamp.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): B-11, B-12
- [closed-utc-day](closed-utc-day.md)
- [ledger](ledger.md)
- [look-back-window](look-back-window.md)
- [reconciliation-run](reconciliation-run.md)
- [stripe-statement-adapter](stripe-statement-adapter.md)
- [validate-day](validate-day.md)
<!-- used-by:end -->

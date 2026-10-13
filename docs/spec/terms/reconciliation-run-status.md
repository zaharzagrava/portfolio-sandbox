---
id: reconciliation-run-status
title: Reconciliation run status
kind: term
status: draft
aliases: [completed, failed]
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# Reconciliation run status
## Definition
A [reconciliation run](reconciliation-run.md)'s status records where the run for one [(provider, day)](reconciliation-run-uniqueness.md) stands. Once a run is `COMPLETED`, its result is final and the day is not reconciled again. If the provider fails, the run ends `FAILED` with the reason [`provider_unavailable`](provider-unavailable-failed-run.md), and a failed run stores no [issues](reconciliation-issue.md). The legal status changes are decided in one place, the [run state machine](reconciliation-run-transition.md) (`nextRunState`).

## Example
The `payments.reconcile-daily` job runs for the previous UTC day.
- If the statement adapter (`StripeStatementAdapter`) cannot reach the provider, the run ends `FAILED(provider_unavailable)`. The job layer may try again, up to its attempt limit.
- If the run finishes, it ends `COMPLETED`. Later runs then skip that day, both in the schedule and in catch-up.

## Known gaps
- The spec does not say which statuses exist besides `COMPLETED` and `FAILED`, for example whether there is a status for a run in progress.
- The spec does not say whether a `FAILED` run row is reused or replaced when the day is attempted again.
- Not confirmed in the code: how a crashed run is detected before its day is restarted.

## Used by
<!-- used-by:start -->
- [reconciliation-issue](reconciliation-issue.md)
- [reconciliation-run-transition](reconciliation-run-transition.md)
- [reconciliation-run-uniqueness](reconciliation-run-uniqueness.md)
- [reconciliation-run](reconciliation-run.md)
<!-- used-by:end -->

---
id: reconciliation-run-transition
title: Reconciliation run transitions
kind: term
status: draft
aliases: [legal pairs, run state machine]
defined_for: S14-ledger-reconciliation
rules_hash: 0975784e5751
---
# Reconciliation run transitions
## Definition
The run state machine is the set of legal status changes for a reconciliation run, and the pure function `nextRunState` decides them. `COMPLETED` is final: once a day's run reaches it, that run does not change again. A provider failure moves the run to [`FAILED(provider_unavailable)`](provider-unavailable-failed-run.md), and a failed run keeps no issues. A crashed run starts its day over, and because [issues are unique per (run, kind, reference)](reconciliation-issue.md), the restart does not create duplicate issues. When several attempts start for the same (provider, day), only one of them runs.

## Example
The [`payments.reconcile-daily` job](payments-reconcile-daily-job.md) reconciles the previous UTC day, for example 2026-10-12 (illustrative).
- `StripeStatementAdapter` cannot reach the provider, so the run ends `FAILED(provider_unavailable)` with no issues stored. The adapter does not retry, and the job layer makes at most 3 attempts.
- On a later attempt the run finishes and becomes `COMPLETED`. [Catch-up](cron-catch-up.md) only picks days that have no `COMPLETED` run, so it skips this day from then on.

## Known gaps
- The spec names only the `COMPLETED` and `FAILED` statuses. It does not say whether other statuses exist, such as one for a run that is in progress.
- The spec does not say whether `FAILED` is final, or whether a retry moves the same run out of `FAILED` or creates a new run for the day.
- Not confirmed in the code: how a crashed run is detected before its day is restarted.

## Used by
<!-- used-by:start -->
- [cron-catch-up](cron-catch-up.md)
- [payments-reconcile-daily-job](payments-reconcile-daily-job.md)
- [reconciliation-issue](reconciliation-issue.md)
- [reconciliation-run-status](reconciliation-run-status.md)
<!-- used-by:end -->

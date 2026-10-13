---
id: reconciliation-run-uniqueness
title: Reconciliation run uniqueness
kind: term
status: draft
aliases: [unique per (provider, day)]
defined_for: S14-ledger-reconciliation
rules_hash: 852549afe869
---
# Reconciliation run uniqueness
## Definition
There is at most one reconciliation run per (provider, day). If two attempts start for the same provider and day at the same time, only one of them does the work. This means the same day is never [matched](statement-line-matching.md) twice in parallel. That matters because two parallel matches would report the same differences twice. Avoiding that duplicate reporting is design intent (not stated in the spec).

## Example
The scheduled [`payments.reconcile-daily`](payments-reconcile-daily-job.md) job and a [catch-up attempt](cron-catch-up.md) both pick up the same day (illustrative: `2026-10-12`) for the same provider. One of them runs the day. The other does nothing, so the finance operators see one run and one set of [issues](reconciliation-issue.md).

## Known gaps
- The spec does not say how this is enforced: a store constraint, [a lock ↗](../sw-external-terms.md#distributed-lock), or the [job lease](job-lease.md).
- The spec does not say what the losing attempt returns or records.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-32
- [cron-catch-up](cron-catch-up.md)
- [job-lease](job-lease.md)
- [payments-reconcile-daily-job](payments-reconcile-daily-job.md)
- [reconciliation-issue](reconciliation-issue.md)
- [reconciliation-run-status](reconciliation-run-status.md)
- [reconciliation-run](reconciliation-run.md)
- [statement-line-matching](statement-line-matching.md)
<!-- used-by:end -->

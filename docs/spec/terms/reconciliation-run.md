---
id: reconciliation-run
title: Reconciliation run
kind: term
status: draft
aliases: [run, runs]
defined_for: S14-ledger-reconciliation
rules_hash: 18172bac7d93
---
# Reconciliation run
## Definition
A [reconciliation](reconciliation.md) run is one execution of reconciliation for one [(provider, day) pair](reconciliation-run-uniqueness.md). Only one run can exist per pair. If several attempts start at the same time, only one of them actually runs. Once a run is [`COMPLETED`](reconciliation-run-status.md) it is final. A failed run stores no issues. If a run crashes, it [restarts its day](crash-recovery.md). [Issues](reconciliation-issue.md) are unique per (run, kind, reference), so the restart never creates duplicate issues.

## Example
The schedule starts a run for `("stripe", 2026-10-12)` (illustrative provider id). The provider is down, so the run ends `FAILED(provider_unavailable)` with no issues. [Later catch-up](cron-catch-up.md) repeats that day until a `COMPLETED` run exists. Admins can see runs through `GET /finance/reconciliation/runs`.

## Known gaps
- The spec does not list every run state or every allowed transition. Only `COMPLETED` and `FAILED` are named, and the full set is in `nextRunState`.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-32
- [adjusted-resolution](adjusted-resolution.md)
- [classify-line](classify-line.md)
- [crash-recovery](crash-recovery.md)
- [cron-catch-up](cron-catch-up.md)
- [issue](issue.md)
- [keyset-pagination](keyset-pagination.md)
- [lazy-statement-stream](lazy-statement-stream.md)
- [ledger-reconciliation-completed-event](ledger-reconciliation-completed-event.md)
- [ledger-reconciliation-issue-opened-event](ledger-reconciliation-issue-opened-event.md)
- [provider-unavailable-failed-run](provider-unavailable-failed-run.md)
- [reconciliation-controller](reconciliation-controller.md)
- [reconciliation-issue-status](reconciliation-issue-status.md)
- [reconciliation-issue](reconciliation-issue.md)
- [reconciliation-run-service](reconciliation-run-service.md)
- [reconciliation-run-status](reconciliation-run-status.md)
- [reconciliation-run-uniqueness](reconciliation-run-uniqueness.md)
- [reconciliation](reconciliation.md)
- [resolve-issue](resolve-issue.md)
- [statement-day](statement-day.md)
- [stripe-statement-adapter](stripe-statement-adapter.md)
- [validate-day](validate-day.md)
<!-- used-by:end -->

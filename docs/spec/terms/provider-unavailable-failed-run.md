---
id: provider-unavailable-failed-run
title: FAILED(provider_unavailable)
kind: term
status: draft
aliases: [provider_unavailable]
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# FAILED(provider_unavailable)
## Definition
`FAILED(provider_unavailable)` is the end state of a [reconciliation run](reconciliation-run.md) when the payment provider's statement could not be read. The [statement adapter](stripe-statement-adapter.md) does not retry by itself. Instead, the [job layer](job.md) starts a new [job attempt](job-attempt.md), up to its [attempt limit](job-max-attempts.md). A failed run stores no [issues](reconciliation-issue.md), even if some statement pages were already matched. A later attempt reconciles the same day from the start.

## Example
The [`payments.reconcile-daily`](payments-reconcile-daily-job.md) job reconciles 2026-10-12 (illustrative day). The provider has an outage while page 3 of the statement is loading. The run ends `FAILED(provider_unavailable)` with zero issues stored, and the next attempt completes the day.

## Known gaps
- The spec does not say whether the job layer waits before the next attempt, or how long.
- The spec does not say what happens to the day after the last job attempt fails. Possibly the [scheduled catch-up](cron-catch-up.md) of days with no `COMPLETED` run picks it up again, but that is not stated.
- The spec does not say whether other failure reasons exist besides `provider_unavailable`.

## Used by
<!-- used-by:start -->
- [cron-catch-up](cron-catch-up.md)
- [job-attempt](job-attempt.md)
- [job-max-attempts](job-max-attempts.md)
- [job](job.md)
- [reconciliation-issue](reconciliation-issue.md)
- [reconciliation-run](reconciliation-run.md)
- [stripe-statement-adapter](stripe-statement-adapter.md)
<!-- used-by:end -->

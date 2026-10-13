---
id: payments-reconcile-daily-job
title: payments.reconcile-daily job
kind: term
status: draft
aliases: [payments.reconcile-daily]
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# payments.reconcile-daily job
## Definition
`payments.reconcile-daily` is the scheduled job that runs [reconciliation](reconciliation.md). Each run reads the [provider statement](provider-statement.md) for the previous [closed UTC day](closed-utc-day.md) as a [lazily advanced stream](lazy-statement-stream.md), sending [job heartbeats](job-heartbeat.md) while it reads. It also [catches up](cron-catch-up.md) recent days that have no [`COMPLETED`](reconciliation-run-status.md) run, and re-checks recent open [`MISSING_*` issues](reconciliation-issue-kind.md) so they can be [auto-resolved](reconciliation-issue-auto-resolve.md). [A run is unique per (provider, day)](reconciliation-run-uniqueness.md), so concurrent attempts run only once. If the provider fails, the run ends [`FAILED(provider_unavailable)`](provider-unavailable-failed-run.md) and the [job layer](job-retries.md) retries it a limited number of times.

## Example
On 2026-10-13 (illustrative), the job reconciles the 2026-10-12 UTC day. It also picks up 2026-10-09, which has no `COMPLETED` run yet. One Stripe statement line matches no [`SALE` journal](journal-kind.md), so the run opens a `MISSING_IN_LEDGER` issue. Per the rules, the job makes at most 3 attempts, and the catch-up looks back over the last 7 days.

## Known gaps
- The spec does not say what time of day the job fires or which time zone its schedule uses. It only says the target day is the previous UTC day.
- The spec does not say what happens to a day that is still not `COMPLETED` once it falls outside the catch-up range. Finance would have to notice that gap some other way.
- Not confirmed in the code: how the job's own retries interact with the [adapter](stripe-statement-adapter.md). Only the rule is stated: the adapter does not retry.

## Used by
<!-- used-by:start -->
- [closed-utc-day](closed-utc-day.md)
- [cron-catch-up](cron-catch-up.md)
- [job-heartbeat](job-heartbeat.md)
- [job-retries](job-retries.md)
- [journal-kind](journal-kind.md)
- [lazy-statement-stream](lazy-statement-stream.md)
- [provider-statement](provider-statement.md)
- [reconciliation-issue-auto-resolve](reconciliation-issue-auto-resolve.md)
- [reconciliation-issue-kind](reconciliation-issue-kind.md)
- [reconciliation-run-transition](reconciliation-run-transition.md)
- [reconciliation-run-uniqueness](reconciliation-run-uniqueness.md)
- [reconciliation](reconciliation.md)
- [stripe-statement-adapter](stripe-statement-adapter.md)
<!-- used-by:end -->

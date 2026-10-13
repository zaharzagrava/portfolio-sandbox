---
id: stripe-statement-adapter
title: StripeStatementAdapter
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: a4a18a99e2ab
---
# StripeStatementAdapter
## Definition
`StripeStatementAdapter` is the [infra-layer](infrastructure-layer.md) implementation of the [domain port](in-process-port.md) that reconciliation uses to read the [provider statement](provider-statement.md) from Stripe. It fetches the statement for a [closed UTC day](closed-utc-day.md), and the [reconciliation run](reconciliation-run.md) reads it as a [lazily advanced stream](lazy-statement-stream.md). Keeping Stripe behind a port means the matching rules never depend on Stripe's API; this is design intent (not stated in the spec). The adapter never retries. If the provider fails, the run ends `FAILED(provider_unavailable)`, and the [job layer](job-retries.md) decides whether to make another [job attempt](job-attempt.md).

## Example
The [`payments.reconcile-daily`](payments-reconcile-daily-job.md) job reconciles 2026-10-12 (illustrative date). Halfway through the stream, Stripe stops answering. The adapter raises a failure without retrying, and the run is stored as `FAILED(provider_unavailable)` with no issues. The job layer then retries the whole day, up to 3 attempts.

## Known gaps
- The spec does not say which Stripe errors count as a provider failure, for example timeouts, `5xx` answers or rate limiting.
- The spec does not say whether the adapter or [`ReconciliationRunService`](reconciliation-run-service.md) handles the page fetching and the [page cursor](pagination-cursor.md).
- The spec does not say which Stripe API or report the adapter reads the statement from.

## Used by
<!-- used-by:start -->
- [closed-utc-day](closed-utc-day.md)
- [in-process-port](in-process-port.md)
- [infrastructure-layer](infrastructure-layer.md)
- [job-attempt](job-attempt.md)
- [job-retries](job-retries.md)
- [lazy-statement-stream](lazy-statement-stream.md)
- [pagination-cursor](pagination-cursor.md)
- [payments-reconcile-daily-job](payments-reconcile-daily-job.md)
- [provider-statement](provider-statement.md)
- [provider-unavailable-failed-run](provider-unavailable-failed-run.md)
- [reconciliation-run](reconciliation-run.md)
- [statement-day](statement-day.md)
<!-- used-by:end -->

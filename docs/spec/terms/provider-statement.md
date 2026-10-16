---
id: provider-statement
title: Provider statement
kind: term
status: draft
aliases: [statement]
defined_for: S14-ledger-reconciliation
rules_hash: ce62a2077059
---
# Provider statement
## Definition
The provider statement is the [payment provider](payment-provider.md)'s list of transactions for one [closed UTC day](closed-utc-day.md). Reconciliation reads it through a [domain port](in-process-port.md). The Stripe implementation is [`StripeStatementAdapter`](stripe-statement-adapter.md). Every line is validated before use, and its provider reference, amount and currency are compared with the [ledger's journals](ledger-journal.md). If the provider fails, the adapter does not retry: the run ends [`FAILED(provider_unavailable)`](provider-unavailable-failed-run.md), and the [job layer](job.md) decides whether to try again.

## Example
A statement line (shape illustrative) is matched by reference to a [`SALE` journal](journal-kind.md):
```json
{ "reference": "pi_123", "amountMinor": 2500, "currency": "EUR" }
```

## Known gaps
- The spec does not list the fields of a statement line. The names in the example are illustrative.
- Not confirmed in the code: that a line which fails [`parseStatementLine`](parse-statement-line.md) always becomes an [`INVALID_PROVIDER_RECORD` issue](reconciliation-issue-kind.md).

## Used by
<!-- used-by:start -->
- [J01](../capabilities/J01-buy-to-payout.md): R-07, R-15, B-06
- [S14](../capabilities/S14-ledger-reconciliation.md): R-28
- [classify-line](classify-line.md)
- [closed-utc-day](closed-utc-day.md)
- [in-process-port](in-process-port.md)
- [issue](issue.md)
- [job](job.md)
- [journal-kind](journal-kind.md)
- [lazy-statement-stream](lazy-statement-stream.md)
- [ledger-journal](ledger-journal.md)
- [ledger-reconciliation-issue-opened-event](ledger-reconciliation-issue-opened-event.md)
- [parse-statement-line](parse-statement-line.md)
- [payment-provider](payment-provider.md)
- [payments-reconcile-daily-job](payments-reconcile-daily-job.md)
- [reconciliation-issue-auto-resolve](reconciliation-issue-auto-resolve.md)
- [reconciliation-issue-kind](reconciliation-issue-kind.md)
- [reconciliation-issue-reference](reconciliation-issue-reference.md)
- [reconciliation-issue](reconciliation-issue.md)
- [reconciliation-run-service](reconciliation-run-service.md)
- [reconciliation](reconciliation.md)
- [resolve-issue](resolve-issue.md)
- [statement-line-matching](statement-line-matching.md)
- [stripe-statement-adapter](stripe-statement-adapter.md)
<!-- used-by:end -->

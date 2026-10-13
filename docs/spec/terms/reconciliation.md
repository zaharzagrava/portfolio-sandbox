---
id: reconciliation
title: Reconciliation
kind: term
status: draft
aliases: [reconcile]
defined_for: S14-ledger-reconciliation
rules_hash: 7f01c612fc9b
---
# Reconciliation
## Definition
Reconciliation is the daily check of the ledger against the payment provider's own records. For each [closed UTC day](closed-utc-day.md) it reads the [provider statement](provider-statement.md) and matches every line to [`SALE`](journal-kind.md) and [`REFUND`](journal-kind.md) [journals](ledger-journal.md) by [provider reference](provider-idempotency-reference.md). Each difference is recorded as an [issue](reconciliation-issue.md) that [finance operators](operator.md) handle through the [`/finance/reconciliation/*` API](finance-reconciliation-api.md). Reconciliation never posts journals. It only reports. Any fix is a new journal in the [current period](ledger-period.md) that [names the day it corrects](corrects-day.md).

## Example
The [`payments.reconcile-daily` job](payments-reconcile-daily-job.md) checks yesterday's UTC day. The statement has a charge whose reference matches no `SALE` journal, so the job opens a [`MISSING_IN_LEDGER`](reconciliation-issue-kind.md) issue. An admin later closes it with [`POST /finance/reconciliation/issues/:issueId/resolve`](post-finance-reconciliation-issue-resolve.md).

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-28, R-31
- [closed-utc-day](closed-utc-day.md)
- [corrects-day](corrects-day.md)
- [finance-reconciliation-api](finance-reconciliation-api.md)
- [ledger-journal](ledger-journal.md)
- [ledger-period](ledger-period.md)
- [ledger](ledger.md)
- [operator](operator.md)
- [parse-statement-line](parse-statement-line.md)
- [payments-reconcile-daily-job](payments-reconcile-daily-job.md)
- [posted-at](posted-at.md)
- [provider-idempotency-reference](provider-idempotency-reference.md)
- [provider-statement](provider-statement.md)
- [reconciliation-issue-kind](reconciliation-issue-kind.md)
- [reconciliation-issue-status](reconciliation-issue-status.md)
- [reconciliation-issue](reconciliation-issue.md)
- [reconciliation-run](reconciliation-run.md)
- [statement-line-matching](statement-line-matching.md)
<!-- used-by:end -->

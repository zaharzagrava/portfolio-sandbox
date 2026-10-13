---
id: reconciliation-issue
title: Reconciliation issue
kind: term
status: draft
aliases: [issue, issues]
defined_for: S14-ledger-reconciliation
rules_hash: 8c0552b38e08
---
# Reconciliation issue
## Definition
A reconciliation issue is one difference that a run found between the [provider's statement](provider-statement.md) and the ledger's [`SALE` and `REFUND` journals](ledger-journal.md). Each issue has a kind:
- `MISSING_IN_LEDGER`
- `MISSING_AT_PROVIDER`
- `AMOUNT_MISMATCH`
- `CURRENCY_MISMATCH`
- `DUPLICATE_AT_PROVIDER`
- `INVALID_PROVIDER_RECORD`

Issues only report problems. Reconciliation never posts a journal to fix one; [finance operators](operator.md) handle them. Within one run, each issue is unique per (run, kind, [reference](reconciliation-issue-reference.md)), so a restarted run does not create duplicates.

## Example
A statement line has provider reference `pi_123` (illustrative) for 2,000 [minor units](minor-units.md). The `SALE` journal for that reference has 1,999. The run records an `AMOUNT_MISMATCH` issue.

A [platform `admin`](platform-admin.md) lists it with `GET /finance/reconciliation/issues` and closes it with `POST /finance/reconciliation/issues/:issueId/resolve`.

## Known gaps
- The spec does not say which fields an issue exposes, for example both amounts or the journal id.
- The spec does not say the full name of the event emitted for each new issue (the source text is cut off after [`ledger.reconcil`](ledger-reconciliation-issue-opened-event.md)).

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-32, B-12
- [adjusted-resolution](adjusted-resolution.md)
- [adjustment-journal](adjustment-journal.md)
- [corrects-day](corrects-day.md)
- [finance-reconciliation-api](finance-reconciliation-api.md)
- [keyset-pagination](keyset-pagination.md)
- [ledger-journal](ledger-journal.md)
- [minor-units](minor-units.md)
- [operator](operator.md)
- [platform-admin](platform-admin.md)
- [post-finance-reconciliation-issue-resolve](post-finance-reconciliation-issue-resolve.md)
- [provider-statement](provider-statement.md)
- [provider-unavailable-failed-run](provider-unavailable-failed-run.md)
- [reconciliation-controller](reconciliation-controller.md)
- [reconciliation-issue-auto-resolve](reconciliation-issue-auto-resolve.md)
- [reconciliation-issue-reference](reconciliation-issue-reference.md)
- [reconciliation-resolution](reconciliation-resolution.md)
- [reconciliation-run-status](reconciliation-run-status.md)
- [reconciliation-run-transition](reconciliation-run-transition.md)
- [reconciliation-run-uniqueness](reconciliation-run-uniqueness.md)
- [reconciliation-run](reconciliation-run.md)
- [reconciliation](reconciliation.md)
- [statement-line-matching](statement-line-matching.md)
<!-- used-by:end -->

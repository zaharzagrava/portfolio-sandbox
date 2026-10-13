---
id: reconciliation-resolution
title: Reconciliation resolution
kind: term
status: draft
aliases: [adjusted]
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# Reconciliation resolution
## Definition
A reconciliation resolution is the way an [operator](operator.md) closes an [`OPEN` reconciliation issue](reconciliation-issue.md) through the [resolve endpoint](post-finance-reconciliation-issue-resolve.md). The request requires an [`Idempotency-Key`](idempotency-key.md) and is restricted to the [platform `admin`](platform-admin.md). With the [`adjusted` resolution](adjusted-resolution.md), the [ledger](ledger.md) posts one [balanced `ADJUSTMENT` journal](adjustment-journal.md) in the [same transaction ↗](../sw-external-terms.md#database-transaction) that marks the issue [`RESOLVED`](reconciliation-issue-status.md). The issue and the money correction therefore succeed or fail together. Reconciliation itself never posts journals, so `adjusted` is the only point where a finding leads to a ledger change, and only after an operator decides.

## Example
```http
POST /finance/reconciliation/issues/9f2c.../resolve   (id illustrative)
Idempotency-Key: 4b1e...                               (illustrative)
```
The resolution is `adjusted`, with a note. The issue becomes `RESOLVED`, and one `ADJUSTMENT` journal is posted in the [current period](ledger-period.md).

## Known gaps
- The spec does not say what other resolution values exist besides `adjusted`.
- The spec does not say how the request specifies the `ADJUSTMENT` journal's accounts and amounts.
- The spec does not say whether that journal must [record the corrected day](corrects-day.md) in the same way as other corrections.

## Used by
<!-- used-by:start -->
- [adjusted-resolution](adjusted-resolution.md)
- [adjustment-journal](adjustment-journal.md)
- [corrects-day](corrects-day.md)
- [ledger-period](ledger-period.md)
- [ledger](ledger.md)
- [operator](operator.md)
- [platform-admin](platform-admin.md)
- [post-finance-reconciliation-issue-resolve](post-finance-reconciliation-issue-resolve.md)
- [reconciliation-issue](reconciliation-issue.md)
<!-- used-by:end -->

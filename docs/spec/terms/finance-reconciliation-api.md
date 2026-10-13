---
id: finance-reconciliation-api
title: /finance/reconciliation/* API
kind: term
status: draft
aliases: [/finance/reconciliation/*]
defined_for: S14-ledger-reconciliation
rules_hash: eab27bd63224
---
# /finance/reconciliation/* API
## Definition
The `/finance/reconciliation/*` API is the [HTTP surface](http-surface.md) that finance operators use to work with reconciliation results. It lists reconciliation runs, lists [reconciliation issues](reconciliation-issue.md), and resolves an issue. Only a [platform admin](platform-admin.md) may call it. It is served by [`ReconciliationController`](reconciliation-controller.md) in the [payments domain](payments-domain-layer.md). Like reconciliation itself, it does not [post journals](post-journal.md); any correction is a separate new journal in the [current period](ledger-period.md).

## Example
An admin checks the result of yesterday's run, then the issues it opened, then closes one:
```
GET  /finance/reconciliation/runs
GET  /finance/reconciliation/issues
POST /finance/reconciliation/issues/:issueId/resolve
```

## Known gaps
- The spec does not say what filters, paging or response shapes `GET /finance/reconciliation/runs` and `GET /finance/reconciliation/issues` use.
- The spec does not say whether the API can start or re-run a reconciliation run for a chosen day. Only the three routes above are listed.
- The spec does not say which error a non-admin caller gets.

## Used by
<!-- used-by:start -->
- [http-surface](http-surface.md)
- [ledger-period](ledger-period.md)
- [ledger-reconciliation-completed-event](ledger-reconciliation-completed-event.md)
- [payments-domain-layer](payments-domain-layer.md)
- [platform-admin](platform-admin.md)
- [post-finance-reconciliation-issue-resolve](post-finance-reconciliation-issue-resolve.md)
- [post-journal](post-journal.md)
- [reconciliation-controller](reconciliation-controller.md)
- [reconciliation-issue](reconciliation-issue.md)
- [reconciliation](reconciliation.md)
<!-- used-by:end -->

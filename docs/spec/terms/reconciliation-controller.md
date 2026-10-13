---
id: reconciliation-controller
title: ReconciliationController
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# ReconciliationController
## Definition
`ReconciliationController` is the HTTP controller in the [payments domain's API layer](api-layer.md) that serves the [`/finance/reconciliation/*` API](finance-reconciliation-api.md). It exposes three routes: one lists [reconciliation runs](reconciliation-run.md), one lists [reconciliation issues](reconciliation-issue.md), and one resolves an issue. Only a [platform admin](platform-admin.md) may call it. It only reads and reports results and never posts journals. Any correction to the books is a separate new journal in the current period.

## Example
A platform admin looks at a day's run, opens the issues it raised, and resolves one after checking it (the issue id below is illustrative):
```
GET  /finance/reconciliation/runs
GET  /finance/reconciliation/issues
POST /finance/reconciliation/issues/iss_123/resolve
```
Source: `packages/backend/libs/domains/payments/api/reconciliation.controller.ts#ReconciliationController`.

## Known gaps
- The spec does not say what filters, paging or response shapes the two list routes use.
- The spec does not say what the resolve request body contains (for example a resolution value or a note). It also does not say which error a caller gets for an issue that is already resolved, or for a caller who is not an admin.
- The spec does not say whether the controller can start or re-run a reconciliation run. Only the three routes above are listed. Runs come from the `payments.reconcile-daily` job.

## Used by
<!-- used-by:start -->
- [api-layer](api-layer.md)
- [finance-reconciliation-api](finance-reconciliation-api.md)
- [platform-admin](platform-admin.md)
- [reconciliation-issue](reconciliation-issue.md)
- [reconciliation-run](reconciliation-run.md)
<!-- used-by:end -->

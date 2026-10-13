---
id: post-finance-reconciliation-issue-resolve
title: POST /finance/reconciliation/issues/:issueId/resolve
kind: term
status: draft
aliases: [/finance/reconciliation/issues/:issueid/resolve]
defined_for: S14-ledger-reconciliation
rules_hash: 48ba1be032b1
---
# POST /finance/reconciliation/issues/:issueId/resolve
## Definition
`POST /finance/reconciliation/issues/:issueId/resolve` lets a [platform admin](platform-admin.md) mark one [open reconciliation issue](reconciliation-issue.md) as resolved. It is part of the [`/finance/reconciliation/*` API](finance-reconciliation-api.md), served by [`ReconciliationController`](reconciliation-controller.md). It only changes the issue's [status](reconciliation-issue-status.md); it never posts a [journal](ledger-journal.md). If money needs correcting, that is a separate new journal (for example an [`ADJUSTMENT`](adjustment-journal.md)) in the [current period](ledger-period.md) that records the day it corrects. Keeping "resolve" apart from "post" is design intent (not stated in the spec): reconciliation is meant to only report.

## Example
An issue [`MISSING_IN_LEDGER`](reconciliation-issue-kind.md) for [provider reference](reconciliation-issue-reference.md) `ch_123` (illustrative) was fixed by an `ADJUSTMENT` journal whose [`correctsDay`](corrects-day.md) is the reconciled day. The admin then closes the issue:
```
POST /finance/reconciliation/issues/9f1c.../resolve   (issueId illustrative)
```

## Known gaps
- The spec does not say what request body this endpoint takes, for example a note or a link to the correcting journal.
- Not confirmed in the code: that resolving an already-resolved issue returns `issue_already_resolved` (409). That error exists in the system, but the given facts do not tie it to this route.
- The spec does not say how a manual resolve interacts with [auto-resolve](reconciliation-issue-auto-resolve.md) when a `MISSING_*` issue later matches on its own.

## Used by
<!-- used-by:start -->
- [finance-reconciliation-api](finance-reconciliation-api.md)
- [issue-already-resolved](issue-already-resolved.md)
- [ledger-journal](ledger-journal.md)
- [ledger-period](ledger-period.md)
- [platform-admin](platform-admin.md)
- [reconciliation-issue-auto-resolve](reconciliation-issue-auto-resolve.md)
- [reconciliation-issue-reference](reconciliation-issue-reference.md)
- [reconciliation-issue-status](reconciliation-issue-status.md)
- [reconciliation-issue](reconciliation-issue.md)
- [reconciliation-resolution](reconciliation-resolution.md)
<!-- used-by:end -->

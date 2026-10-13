---
id: issue-already-resolved
title: issue_already_resolved (409)
kind: term
status: draft
aliases: [issue_already_resolved]
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# issue_already_resolved (409)
## Definition
`issue_already_[resolved](reconciliation-issue-status.md)` is the `409` conflict answer from the [reconciliation resolve endpoint](post-finance-reconciliation-issue-resolve.md) when the issue is no longer [`OPEN`](reconciliation-issue-status.md). An issue is resolved only once. If several resolutions compete, exactly one wins and the issue keeps that winner's actor, time and note. The endpoint is [admin-only](platform-admin.md) and [rate limited per user](rate-limit.md), and it [fails closed ↗](../sw-external-terms.md#fail-open-fail-closed) if the rate limiter is unavailable.

## Example
```
POST /finance/reconciliation/issues/:issueId/resolve   (issue already RESOLVED)
→ 409  { "code": "issue_already_resolved", ... }
```

## Known gaps
- The spec does not say whether the losing request in a race also gets `409 issue_already_resolved` or some other answer.
- The spec does not say whether repeating a request with the same [`Idempotency-Key`](idempotency-key.md) replays the stored success, or answers this `409` instead.
- The spec does not say whether an issue [auto-resolved](reconciliation-issue-auto-resolve.md) by the re-check of open [`MISSING_*`](reconciliation-issue-kind.md) issues gives this same answer.

## Used by
<!-- used-by:start -->
- [platform-admin](platform-admin.md)
- [post-finance-reconciliation-issue-resolve](post-finance-reconciliation-issue-resolve.md)
- [rate-limit](rate-limit.md)
- [reconciliation-issue-auto-resolve](reconciliation-issue-auto-resolve.md)
<!-- used-by:end -->

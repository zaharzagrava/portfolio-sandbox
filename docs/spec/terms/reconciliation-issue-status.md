---
id: reconciliation-issue-status
title: Reconciliation issue status
kind: term
status: draft
aliases: [open, resolved]
defined_for: S14-ledger-reconciliation
rules_hash: ced610f88848
---
# Reconciliation issue status
## Definition
The [reconciliation](reconciliation.md) issue status tracks whether a difference found by reconciliation still needs attention. A new issue is `OPEN`. A platform [`admin`](platform-admin.md) moves it to `RESOLVED` through [`POST /finance/reconciliation/issues/:issueId/resolve`](post-finance-reconciliation-issue-resolve.md), which records the actor, the time and a note. Open [`MISSING_*` issues](reconciliation-issue-kind.md) from recent days are also re-checked on each [run](reconciliation-run.md) and [auto-resolved](reconciliation-issue-auto-resolve.md) when they now match.

## Example
A `MISSING_AT_PROVIDER` issue is `OPEN` after one day's run. The provider's statement for the next day now contains the matching line, so that run auto-resolves the issue.

## Known gaps
- The spec does not say whether `OPEN` and `RESOLVED` are the only statuses, or whether a resolved issue can be reopened.
- The spec does not say what resolving an already `RESOLVED` issue returns, apart from replays with the same [`Idempotency-Key`](idempotency-key.md).
- The spec does not say how an auto-resolved issue is recorded, for example which actor or note is stored.

## Used by
<!-- used-by:start -->
- [classify-line](classify-line.md)
- [post-finance-reconciliation-issue-resolve](post-finance-reconciliation-issue-resolve.md)
- [reconciliation-issue-auto-resolve](reconciliation-issue-auto-resolve.md)
- [reconciliation-issue-kind](reconciliation-issue-kind.md)
- [reconciliation-run](reconciliation-run.md)
- [reconciliation](reconciliation.md)
<!-- used-by:end -->

---
id: reconciliation-issue-auto-resolve
title: Reconciliation issue auto-resolve
kind: term
status: draft
aliases: [auto-resolved]
defined_for: S14-ledger-reconciliation
rules_hash: 24fa59554187
---
# Reconciliation issue auto-resolve
## Definition
On each run, open [`MISSING_IN_LEDGER`](reconciliation-issue-kind.md) and [`MISSING_AT_PROVIDER`](reconciliation-issue-kind.md) [issues](reconciliation-issue.md) from recent previous days are checked again. If the [statement line](provider-statement.md) and the [journal](ledger-journal.md) now match, the issue is resolved automatically and no [operator](operator.md) is needed. Only `MISSING_*` kinds are re-checked, so other kinds stay open until an operator resolves them. The likely reason is that a payment near midnight can appear on different days in the [ledger](ledger.md) and in the statement. That reason is design intent (not stated in the spec).

## Example
On 2026-10-12, a capture `pi_123` (illustrative) is in the ledger but not on the statement, so a `MISSING_AT_PROVIDER` issue is raised. The 2026-10-13 statement lists it. The next run re-checks the issue, finds the match, and resolves it ([`resolveIssue`](resolve-issue.md)).

## Known gaps
- The spec does not say how an automatic resolution is marked differently from an operator's resolution.
- The spec does not say whether an automatic resolution emits an event.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-35
- [issue-already-resolved](issue-already-resolved.md)
- [issue](issue.md)
- [ledger-journal](ledger-journal.md)
- [ledger](ledger.md)
- [operator](operator.md)
- [payments-reconcile-daily-job](payments-reconcile-daily-job.md)
- [post-finance-reconciliation-issue-resolve](post-finance-reconciliation-issue-resolve.md)
- [provider-statement](provider-statement.md)
- [reconciliation-issue-kind](reconciliation-issue-kind.md)
- [reconciliation-issue-status](reconciliation-issue-status.md)
- [reconciliation-issue](reconciliation-issue.md)
- [resolve-issue](resolve-issue.md)
<!-- used-by:end -->

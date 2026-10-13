---
id: resolve-issue
title: resolveIssue
kind: term
status: draft
aliases: [resolve issue]
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# resolveIssue
## Definition
`resolveIssue` is the [pure domain-layer function](domain-layer.md), in the [payments domain](payments-domain-layer.md), behind [reconciliation issue auto-resolve](reconciliation-issue-auto-resolve.md). On each [reconciliation run](reconciliation-run.md), the system re-checks open [`MISSING_IN_LEDGER`](reconciliation-issue-kind.md) and `MISSING_AT_PROVIDER` issues from recent previous days. If a [statement line](provider-statement.md) and a journal now match, the issue is resolved and no operator is needed. Issues of other kinds stay open until an operator resolves them. Design intent (not stated in the spec): a payment near midnight can land on different days in the ledger and in the provider statement.

## Example
On 2026-10-12, a capture `pi_123` is in the ledger but not on that day's statement, so the run opens a `MISSING_AT_PROVIDER` issue. The statement for 2026-10-13 lists `pi_123`. The next run re-checks the open issue, finds the match, and `resolveIssue` marks it resolved. (The dates and `pi_123` are illustrative.)

## Known gaps
- Not confirmed in the code: whether `POST /finance/reconciliation/issues/:issueId/resolve` calls `resolveIssue` too, or only the automatic re-check does.
- The spec does not say how an automatic resolution is marked differently from an operator's resolution.
- The spec does not say whether an automatic resolution emits an event.

## Used by
<!-- used-by:start -->
- [domain-layer](domain-layer.md)
- [payments-domain-layer](payments-domain-layer.md)
- [provider-statement](provider-statement.md)
- [reconciliation-issue-auto-resolve](reconciliation-issue-auto-resolve.md)
- [reconciliation-run](reconciliation-run.md)
<!-- used-by:end -->

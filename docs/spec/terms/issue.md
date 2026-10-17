---
id: issue
title: Issue
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: a14010673142
---
# Issue
## Definition
An issue is one difference that a [reconciliation run](reconciliation-run.md) finds between the [provider's statement](provider-statement.md) and the ledger's [`SALE`](journal-kind.md) and [`REFUND`](journal-kind.md) [journals](ledger-journal.md). Its kind says what went wrong: [`MISSING_IN_LEDGER`](reconciliation-issue-kind.md), `MISSING_AT_PROVIDER`, `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `DUPLICATE_AT_PROVIDER` or `INVALID_PROVIDER_RECORD`. An issue is unique per (run, kind, reference), so a run that restarts after a crash does not create duplicates. Issues only report problems; the run never posts journals to fix them. A [platform admin](platform-admin.md) resolves them through the finance API, and [open `MISSING_*` issues](reconciliation-issue-auto-resolve.md) resolve themselves when a later run finds a match.

## Example
The statement has a capture with [provider reference](reconciliation-issue-reference.md) `pi_123` (illustrative), but no `SALE` journal has that reference. The run stores a `MISSING_IN_LEDGER` issue. A finance operator finds it with [`GET /finance/reconciliation/issues`](finance-reconciliation-api.md) and closes it with [`POST /finance/reconciliation/issues/:issueId/resolve`](post-finance-reconciliation-issue-resolve.md).

## Known gaps
- The spec does not say which fields an issue stores beyond its run, kind and reference, for example expected and actual amounts.
- The spec does not list every resolution value. Only [`adjusted`](reconciliation-resolution.md) is confirmed.
- The spec text available here is cut off in the middle of the event name for new issues (`ledger.reconcil…`), so the exact event name is not confirmed.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): B-13
- [holder-name-check](holder-name-check.md)
- [ledger-journal](ledger-journal.md)
- [platform-admin](platform-admin.md)
- [provider-statement](provider-statement.md)
- [reconciliation-issue-auto-resolve](reconciliation-issue-auto-resolve.md)
- [reconciliation-issue-reference](reconciliation-issue-reference.md)
- [reconciliation-run](reconciliation-run.md)
<!-- used-by:end -->

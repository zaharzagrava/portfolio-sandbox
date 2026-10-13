---
id: adjusted-resolution
title: adjusted resolution
kind: term
status: draft
aliases: [adjusted]
defined_for: S14-ledger-reconciliation
rules_hash: cf661285db4f
---
# adjusted resolution
## Definition
`adjusted` is a way for a [platform admin](platform-admin.md) to resolve an issue when the [ledger](ledger.md) needs a correction. Resolving with `adjusted` posts one [`ADJUSTMENT` journal](adjustment-journal.md) that carries [`correctsDay`](corrects-day.md). The issue change, its [history row](reconciliation-issue.md), the event and the [journal](ledger-journal.md) are all written in [one transaction ↗](../sw-external-terms.md#database-transaction), so either all of them happen or none do. A [reconciled day's entries](ledger-posting.md) are never edited, so this is how a difference gets fixed: a new journal in the [current period](ledger-period.md). This is the admin's action; the [reconciliation run](reconciliation-run.md) itself never posts journals.

## Example
An admin calls `POST /finance/reconciliation/issues/:issueId/resolve` with resolution `adjusted` on an [`AMOUNT_MISMATCH`](reconciliation-issue-kind.md) issue from 2026-10-12 (illustrative). One `ADJUSTMENT` journal is posted today with `correctsDay: "2026-10-12"`, and the issue is marked resolved in the same transaction.

## Known gaps
- The spec does not say how the lines of the `ADJUSTMENT` journal (accounts and amounts) are decided: entered by the admin or worked out from the issue.
- The spec does not say what other resolution values exist, or which of them leave the ledger unchanged.
- The spec does not say whether posting the same `adjusted` resolution twice is [idempotent ↗](../sw-external-terms.md#idempotency). Journals are unique per [(kind, reference)](journal-kind-reference.md), but the reference used for this journal is not stated.

## Used by
<!-- used-by:start -->
- [adjustment-journal](adjustment-journal.md)
- [journal-kind-reference](journal-kind-reference.md)
- [ledger-journal](ledger-journal.md)
- [ledger-period](ledger-period.md)
- [ledger-posting](ledger-posting.md)
- [ledger](ledger.md)
- [platform-admin](platform-admin.md)
- [reconciliation-issue](reconciliation-issue.md)
- [reconciliation-resolution](reconciliation-resolution.md)
- [reconciliation-run](reconciliation-run.md)
<!-- used-by:end -->

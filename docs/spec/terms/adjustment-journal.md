---
id: adjustment-journal
title: ADJUSTMENT journal
kind: term
status: draft
aliases: [adjustment]
defined_for: S14-ledger-reconciliation
rules_hash: b53771983788
---
# ADJUSTMENT journal
## Definition
An `ADJUSTMENT` journal is a manual correction to the [ledger](ledger.md), posted when a [finance operator](operator.md) resolves a [reconciliation issue](reconciliation-issue.md) with the [`adjusted`](adjusted-resolution.md) outcome. Like every journal, it is [balanced and immutable](balanced-journal.md), and it is [unique per (kind, reference)](journal-kind-reference.md). It is one of the kinds that callers of [`postJournal`](post-journal.md) may post, alongside `PAYOUT`, `PAYOUT_REVERSAL` and `AD_CHARGE`. It is written in the same transaction that moves the issue to [`RESOLVED`](reconciliation-issue-status.md), so the issue is never resolved without its journal. Because a reconciled day's entries never change, the adjustment goes into the [current period](ledger-period.md) and records the day it corrects.

## Example
An operator calls `POST /finance/reconciliation/issues/:issueId/resolve` with an [`Idempotency-Key` header](idempotency-key.md), the `adjusted` outcome and a note. The ledger posts one `ADJUSTMENT` journal whose lines sum to zero, and the issue becomes `RESOLVED` with the operator, the time and the note.

## Known gaps
- The spec does not say which accounts an `ADJUSTMENT` journal debits and credits, or who chooses its lines and amounts.
- The spec does not say what reference the journal uses, so it is unclear what makes a second adjustment for the same issue a duplicate.
- The spec does not list the resolution outcomes other than `adjusted`.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): B-14
- [adjusted-resolution](adjusted-resolution.md)
- [balanced-journal](balanced-journal.md)
- [idempotency-key](idempotency-key.md)
- [journal-kind-reference](journal-kind-reference.md)
- [journal-unbalanced](journal-unbalanced.md)
- [ledger-period](ledger-period.md)
- [ledger](ledger.md)
- [operator](operator.md)
- [reconciliation-issue](reconciliation-issue.md)
- [reconciliation-resolution](reconciliation-resolution.md)
<!-- used-by:end -->

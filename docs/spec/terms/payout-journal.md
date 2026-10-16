---
id: payout-journal
title: PAYOUT journal
kind: term
status: draft
aliases: [payout]
defined_for: S14-ledger-reconciliation
rules_hash: 7647347bff78
---
# PAYOUT journal
## Definition
A `PAYOUT` journal is a journal kind that records money paid out to a seller. The payouts domain posts it through `postJournal`, inside its own transaction. When it debits a seller account, that account is guarded: the posting is refused with `insufficient_balance` if the balance would go below zero. Like any journal, it must be [balanced](balanced-journal.md) and is unique per kind and reference. A mistaken payout is never edited; a new [`PAYOUT_REVERSAL`](reversing-journal.md) journal corrects it.

## Example
Shop account `SHOP_<uuid>` holds 3,000 [minor units](minor-units.md) (illustrative). The payouts domain posts a `PAYOUT` journal debiting it by 5,000, so it is refused with `insufficient_balance` and nothing is written.
If the same `PAYOUT` is posted again with the same reference and the same lines, it returns the existing journal with [`created: false`](enqueue-created-flag.md). With different lines it raises `JournalConflict`.

## Known gaps
- The spec does not say which accounts a `PAYOUT` journal's lines use. A seller debit is named, but the credited account (`PAYOUT_CLEARING` or `PAYOUTS_SENT`) is not stated.
- The spec does not say what the payouts domain uses as the journal's reference.
- The spec does not say whether a `PAYOUT_REVERSAL` debiting a seller account is guarded. The rule only names `PAYOUT` debits.

## Used by
<!-- used-by:start -->
- [J01](../capabilities/J01-buy-to-payout.md): R-09, R-10, B-11
- [balanced-journal](balanced-journal.md)
- [guarded-account](guarded-account.md)
- [minor-units](minor-units.md)
<!-- used-by:end -->

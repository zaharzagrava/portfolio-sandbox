---
id: post-journal
title: postJournal
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: 2826bdc9111b
---
# postJournal
## Definition
`postJournal` is the method on [`LedgerService`](ledger-service.md) that other domains call to record a money movement. Payments, payouts and ad billing call it in-process. Callers may post only the [caller kinds](journal-kind.md) (`PAYOUT`, `PAYOUT_REVERSAL`, `AD_CHARGE`, `ADJUSTMENT`). The ledger posts `SALE`, `REFUND`, `SETTLEMENT` and `SWEEP` itself. The call joins the caller's transaction, validates the journal, and writes entries, [running balances](running-balance.md) and the [outbox event](event-row.md) together. A repeat of the same [(kind, reference)](journal-kind-reference.md) returns the existing journal with [`created: false`](enqueue-created-flag.md). A different journal with that pair raises [`JournalConflict`](journal-conflict.md).

## Example
The payouts code posts a `PAYOUT` inside its own transaction (amounts illustrative):
```
kind: PAYOUT, reference: <payout id>, currency: <platform currency>
lines: SHOP_<uuid> -5000, PAYOUT_CLEARING +5000
```
If the shop's balance would go below zero, the posting fails with [`insufficient_balance`](insufficient-balance.md) and nothing is written.

## Known gaps
- The spec does not give the exact input shape of `postJournal` or the named reason returned when a caller tries a ledger-only kind.
- Not confirmed in the code: which line accounts each caller kind is expected to use, apart from the `PAYOUT` guard on seller accounts and [`PAYOUT_CLEARING`](ledger-system-accounts.md).

## Used by
<!-- used-by:start -->
- [event-row](event-row.md)
- [finance-reconciliation-api](finance-reconciliation-api.md)
- [journal-kind-reference](journal-kind-reference.md)
- [journal-kind](journal-kind.md)
- [running-balance](running-balance.md)
<!-- used-by:end -->

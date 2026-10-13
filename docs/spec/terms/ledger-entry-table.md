---
id: ledger-entry-table
title: LedgerEntry table
kind: term
status: draft
aliases: [ledgerentry]
defined_for: S13-payment-intents
rules_hash: bfe656e5d37d
---
# LedgerEntry table
## Definition
`LedgerEntry` is the table that stores [ledger postings](ledger-posting.md) for [S13](../capabilities/S13-payment-intents.md). It is one of the tables [owned by payments](table-ownership.md), so only payment code reads or writes it. A row is added when a payment becomes [`COMPLETED`](payment-status.md). A [declined](definite-decline.md) or failed payment adds no row. Design intent (not stated in the spec): a separate ledger keeps a money record that does not depend on the payment's current status.

## Example
The provider answers "succeeded" for a charge. The payment moves from `PENDING` to `COMPLETED`, and one ledger posting for the order's amount is written to `LedgerEntry`. An example amount is `2599 EUR` (illustrative).
If the card is declined instead, the payment becomes `FAILED(card_declined)` and `LedgerEntry` gets no row.

## Known gaps
- The spec does not say what columns `LedgerEntry` has, such as accounts, sign convention or keys.
- The spec does not say whether the [reversing journal](reversing-journal.md) for a refund is stored in `LedgerEntry` or somewhere else.
- The spec does not say whether the ledger row is written in the [same transaction ↗](../sw-external-terms.md#database-transaction) as the status change. S13.R-10 lists only the payment, its history row, the charge command and the [idempotency record](idempotency-stored-answer.md).

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-03, R-22, R-36
- [definite-decline](definite-decline.md)
- [hot-copy](hot-copy.md)
- [idempotency-stored-answer](idempotency-stored-answer.md)
- [ledger-posting](ledger-posting.md)
- [reversing-journal](reversing-journal.md)
- [table-ownership](table-ownership.md)
<!-- used-by:end -->

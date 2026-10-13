---
id: payer-id
title: Payer id
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: 5dc50485e7b6
---
# Payer id
## Definition
The payer id identifies the buyer who paid. It is stored on the [journal](ledger-journal.md) as a plain reference, not as a [ledger account](ledger-account.md). The buyer never has a balance in the ledger, and no journal line ever [debits or credits ↗](../sw-external-terms.md#double-entry-bookkeeping) a buyer. Design intent (not stated in the spec): the ledger tracks only money the platform and shops hold, and the buyer's money goes through the [payment provider](payment-provider.md).

## Example
A [`SALE` journal](journal-kind.md) for a payment has lines only on [`PROVIDER_CLEARING`, `MARKETPLACE_CLEARING` and `PLATFORM_FEES`](ledger-system-accounts.md). The buyer's id appears only as the journal's payer reference.

## Known gaps
- The spec does not say the field name of the payer reference, or whether journals can be searched by it.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-12
- [journal-kind](journal-kind.md)
- [ledger-account](ledger-account.md)
- [ledger-journal](ledger-journal.md)
- [ledger-system-accounts](ledger-system-accounts.md)
- [payment-provider](payment-provider.md)
<!-- used-by:end -->

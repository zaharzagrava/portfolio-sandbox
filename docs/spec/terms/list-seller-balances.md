---
id: list-seller-balances
title: listSellerBalances
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# listSellerBalances
## Definition
`listSellerBalances` is the [`LedgerService`](ledger-service.md) method that lists the balances of seller accounts ([`SHOP_<uuid>`](ledger-account.md)) one page at a time. It uses [keyset pagination ↗](../sw-external-terms.md#keyset-pagination): each page returns a [signed cursor](pagination-cursor.md), and you pass that cursor back to get the next page. The signature stops callers from making or changing cursors. It is part of the [in-process contract](in-process-port.md) that payments, payouts and ad billing use.

## Example
A payout batch asks for the first page of seller balances, processes it, then calls again with the returned cursor. It stops when no cursor comes back. (This flow is illustrative.)

## Known gaps
- The spec does not give the page size, the sort key, or whether results can be filtered (for example by currency or by non-zero balance).
- The spec does not say whether the balances are [authoritative](authoritative-balance.md) or come from the [read model](read-model.md), or whether the method honours the caller's transaction.
- The spec does not say which error an invalid or tampered cursor raises.

## Used by
<!-- used-by:start -->
- [authoritative-balance](authoritative-balance.md)
- [in-process-port](in-process-port.md)
- [pagination-cursor](pagination-cursor.md)
- [read-model](read-model.md)
<!-- used-by:end -->

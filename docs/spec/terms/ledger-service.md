---
id: ledger-service
title: LedgerService
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: 7084159c9946
---
# LedgerService
## Definition
`LedgerService` is the ledger's [in-process contract](in-process-port.md), the only entry other domains use to post money movements and read balances. Payments, payouts and ad billing call it directly in code, not over HTTP or events. Its posting methods are `postJournal`, `recordPaymentCaptured` and `recordPaymentRefunded`. Its read methods are [`getBalances`](get-balances.md) and [`listSellerBalances`](list-seller-balances.md). Every posting joins the caller's [active transaction](active-transaction.md), so the ledger write commits or rolls back together with the caller's own work.

## Example
When payments records a captured payment, it calls `recordPaymentCaptured` inside its own transaction. This posts one `SALE` journal (amounts illustrative, fee at its default):
```
[PROVIDER_CLEARING](ledger-system-accounts.md)     -10000
[MARKETPLACE_CLEARING](ledger-system-accounts.md)   +9950
[PLATFORM_FEES](ledger-system-accounts.md)            +50
```

## Known gaps
- The spec does not give the method signatures or the input and return shapes of `LedgerService`.
- The spec does not say which caller domain uses which method. It names only the three callers (payments, payouts, ad billing) as a group.
- The spec does not say how `LedgerService` is exposed to other domains, for example which module exports it.

## Used by
<!-- used-by:start -->
- [active-transaction](active-transaction.md)
- [in-process-port](in-process-port.md)
- [ledger-journal-kinds](ledger-journal-kinds.md)
<!-- used-by:end -->

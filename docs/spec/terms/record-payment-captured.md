---
id: record-payment-captured
title: recordPaymentCaptured
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# recordPaymentCaptured
## Definition
`recordPaymentCaptured` is the [`LedgerService`](ledger-service.md) method that records a payment capture. It posts exactly one [`SALE` journal](journal-kind.md) per payment, which moves the captured amount out of [`PROVIDER_CLEARING`](ledger-system-accounts.md), splits off the fee into [`PLATFORM_FEES`](ledger-system-accounts.md) and puts the rest into [`MARKETPLACE_CLEARING`](ledger-system-accounts.md). It [joins the caller's transaction](active-transaction.md) and never opens or commits one. It is [idempotent ↗](../sw-external-terms.md#idempotency) per payment: a repeated identical call returns the existing journal with [`created: false`](enqueue-created-flag.md).

## Example
Capture `A = 2000`, fee `F = 50` (illustrative amount, default fee):
```
SALE  PROVIDER_CLEARING     -2000
      MARKETPLACE_CLEARING  +1950
      PLATFORM_FEES           +50
```
A second identical call returns that journal with `created: false`. A different call for the same payment raises [`JournalConflict`](journal-conflict.md).

## Known gaps
- The spec does not give the method's parameters, or confirm that the [journal reference](journal-kind-reference.md) is the payment id.

## Used by
<!-- used-by:start -->
- [active-transaction](active-transaction.md)
- [journal-kind-reference](journal-kind-reference.md)
- [journal-kind](journal-kind.md)
<!-- used-by:end -->

---
id: record-payment-refunded
title: recordPaymentRefunded
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# recordPaymentRefunded
## Definition
`recordPaymentRefunded` is the [`LedgerService`](ledger-service.md) method that records a refunded payment in the ledger. It posts one [`REFUND` journal](ledger-journal.md) that exactly reverses that payment's [`SALE` journal](journal-kind.md). If the order was [already settled](order-settlement.md), it also reverses [each shop's share](shop-share.md). It refuses a payment with no sale, and a refund whose amount or currency differs from the sale. Posting the same payment again does not create a second journal. Like every posting, it joins the caller's transaction and is [serialized ↗](../sw-external-terms.md#serializable-isolation) with settlement of the same payment.

## Example
Refund of an unsettled 10000-unit sale (amounts illustrative):
```
PROVIDER_CLEARING     +10000
MARKETPLACE_CLEARING   -9950
PLATFORM_FEES             -50
```
If the order was settled, the journal also debits each `SHOP_<uuid>` its share.

## Known gaps
- The spec does not say whether partial refunds are possible anywhere. This method refuses any amount other than the sale's.
- The spec does not name the error returned for a missing sale or for an amount or currency mismatch.
- Not confirmed in the code: which class implements the method. The rule has no `[code]` link, unlike `recordPaymentCaptured`, which is in `PaymentPostingsService`.

## Used by
<!-- used-by:start -->
- [journal-kind](journal-kind.md)
- [ledger-journal](ledger-journal.md)
- [order-settlement](order-settlement.md)
- [shop-share](shop-share.md)
<!-- used-by:end -->

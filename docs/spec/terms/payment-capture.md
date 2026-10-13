---
id: payment-capture
title: Payment capture
kind: term
status: draft
aliases: [capture, captured]
defined_for: S14-ledger-reconciliation
rules_hash: 9165b78ac7a7
---
# Payment capture
## Definition
A payment capture is the point where the [payment provider](payment-provider.md) has actually taken the buyer's money for a payment. [The ledger](ledger.md) records each capture once, as a [`SALE` journal](journal-kind.md) posted through [`recordPaymentCaptured`](record-payment-captured.md). At that moment the ledger's single fee rule applies: it takes a flat fee into [`PLATFORM_FEES`](ledger-system-accounts.md). A capture whose amount is not above the fee is refused.

## Example
A capture of 2,000 [minor units](minor-units.md) (illustrative) with the default fee of 50 posts:
[`PROVIDER_CLEARING -2000`](ledger-system-accounts.md), [`MARKETPLACE_CLEARING +1950`](ledger-system-accounts.md), `PLATFORM_FEES +50`.

## Known gaps
- The spec does not say which provider event or component triggers the call to `recordPaymentCaptured`.
- The spec does not name the refusal reason for a capture that is not above the fee.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-11, B-05
- [journal-kind](journal-kind.md)
- [ledger](ledger.md)
- [minor-units](minor-units.md)
- [payment-provider](payment-provider.md)
- [platform-fee](platform-fee.md)
<!-- used-by:end -->

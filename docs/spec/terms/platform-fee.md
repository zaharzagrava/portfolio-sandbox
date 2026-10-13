---
id: platform-fee
title: Platform fee
kind: term
status: draft
aliases: [fee]
defined_for: S14-ledger-reconciliation
rules_hash: dea0cfd64c8b
---
# Platform fee
## Definition
The platform fee is what the platform keeps from each [captured payment](payment-capture.md). It is a flat amount per payment, not a percentage, and it comes from one [validated setting](validated-config-module.md). The fee rule exists in one place only, inside the [ledger](ledger.md). When [`recordPaymentCaptured`](record-payment-captured.md) posts the [`SALE` journal](journal-kind.md), it credits the fee to [`PLATFORM_FEES`](ledger-system-accounts.md) and the rest of the amount to [`MARKETPLACE_CLEARING`](ledger-system-accounts.md). If a capture is not larger than the fee, the ledger refuses it.

## Example
A captured payment of 10000 [minor units](minor-units.md) (illustrative), with the default fee of 50 minor units, gives this `SALE` journal:
```
PROVIDER_CLEARING     -10000
MARKETPLACE_CLEARING   +9950
PLATFORM_FEES             +50
```

## Known gaps
- The spec does not say which error is returned when a capture is not above the fee.
- The spec does not say what the fee setting is called, or whether it can differ by currency.
- The spec does not say whether a change to the setting affects payments that were captured before the change. Only the [`REFUND` journal](journal-kind.md) is stated to exactly reverse the sale, including its fee line.

## Used by
<!-- used-by:start -->
- [balanced-journal](balanced-journal.md)
- [journal-kind](journal-kind.md)
- [ledger-system-accounts](ledger-system-accounts.md)
- [ledger](ledger.md)
- [minor-units](minor-units.md)
- [payment-capture](payment-capture.md)
- [shop-share](shop-share.md)
- [validated-config-module](validated-config-module.md)
<!-- used-by:end -->

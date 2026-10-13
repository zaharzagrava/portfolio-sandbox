---
id: shop-share
title: Shop share
kind: term
status: draft
aliases: [share, shares]
defined_for: S14-ledger-reconciliation
rules_hash: 121bbbd74f27
---
# Shop share
## Definition
A shop share is the part of a sale's [clearing credit](clearing-credit.md) (the captured amount minus the [platform fee](platform-fee.md)) that [settlement](order-settlement.md) credits to one shop. The credit is divided by each shop's [`subtotalMinor`](shop-subtotal.md) using the [largest-remainder method ↗](../sw-external-terms.md#largest-remainder-method). When remainders tie, the extra unit goes to the lowest shop id. As a result, the shares are whole [minor units](minor-units.md) and add up exactly to the clearing credit. Because the fee is taken off before the split, each shop effectively pays the fee in proportion to its subtotal. A refund of a settled order reverses every share.

## Example
A clearing credit of 9950 split across three shops, each with a `subtotalMinor` of 1000 (illustrative): each exact share is 3316.67. Each shop first gets 3316, and the 2 leftover units go to the two lowest shop ids, giving 3317, 3317 and 3316.

## Known gaps
- The spec does not say what `subtotalMinor` includes, for example seller discounts or shipping.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-14
- [clawback](clawback.md)
- [clearing-credit](clearing-credit.md)
- [minor-units](minor-units.md)
- [order-settlement](order-settlement.md)
- [platform-fee](platform-fee.md)
- [record-payment-refunded](record-payment-refunded.md)
<!-- used-by:end -->

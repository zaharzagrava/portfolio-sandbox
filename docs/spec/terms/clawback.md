---
id: clawback
title: Clawback
kind: term
status: draft
aliases: [clawed back]
defined_for: S14-ledger-reconciliation
rules_hash: 124b96b698dd
---
# Clawback
## Definition
A clawback is the full reversal of the [shop shares](shop-share.md) when a payment that was already settled is refunded. [`recordPaymentRefunded`](record-payment-refunded.md) performs it inside the same [`REFUND` journal](ledger-journal-kinds.md) by debiting each [`SHOP_<uuid>` account](ledger-account.md) exactly what [settlement](order-settlement.md) credited. A `REFUND` journal is allowed to take a seller account below zero, so the clawback always posts even if the shop has already been [paid out](journal-kind.md). Settlement and refund of one payment are [serialized ↗](../sw-external-terms.md#serializable-isolation), so a payment is either settled and then fully clawed back, or refunded and never settled.

## Example
Shop A received 5970 from a settlement and has since been paid out, leaving a balance of 0 (illustrative). The refund posts `SHOP_<A> -5970`, and the shop's [`availableMinor`](available-minor.md) becomes -5970.

## Known gaps
- The spec does not say how a seller balance that went negative after a clawback is recovered.
- Not confirmed in the code: how the serialization is done (lock, uniqueness check or other). The spec points to `SettlementService` only.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-17
- [insufficient-balance](insufficient-balance.md)
- [journal-kind](journal-kind.md)
- [ledger-account](ledger-account.md)
- [ledger-journal-kinds](ledger-journal-kinds.md)
- [order-settlement](order-settlement.md)
- [settled-sale](settled-sale.md)
- [shop-share](shop-share.md)
<!-- used-by:end -->

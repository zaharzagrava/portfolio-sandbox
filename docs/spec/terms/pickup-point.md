---
id: pickup-point
title: Pickup point
kind: term
status: draft
aliases: [pickup points]
defined_for: J04-catalog-sync-to-search
rules_hash: 1f3424f49513
---
# Pickup point
## Definition
A pickup point is a place where a shop holds stock that buyers can collect. The seller sets pickup stock for a product at each pickup point. The near-me index follows those pickup stock changes, so stocking a pickup point makes the product show in "[available near me](pickup-near-me.md)". Pickup stock is kept separate from [catalog stock](catalog-stock.md): changing one never changes the other.

## Example
Product `Pc` has catalog quantity 5 and no pickup stock, so it is not in "available near me". The seller sets pickup stock 4 at pickup point `PP1`, and `Pc` now appears in the near-me results. A later catalog stock change leaves the `PP1` count at 4.

## Known gaps
- The spec does not say what data a pickup point holds, or how it is created.
- The spec does not say whether a [till sale](till.md) in the store ever lowers pickup stock. It only says catalog stock changes must not change it.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->

---
id: leaderboard
title: Leaderboard
kind: term
status: draft
aliases: [board, board entry]
defined_for: J02-seller-to-first-sale
rules_hash: 927216943429
---
# Leaderboard
## Definition
The leaderboard is a public list of shops ordered by their shop rank, which comes from revenue on [paid orders](order-status.md). A shop appears on it after its first paid order. Each entry shows the shop's current name, taken from [tenancy events](tenancy-shop-events.md), so a rename updates the name but keeps the rank. A cancelled, declined or expired order creates no board entry.

## Example
In AS-25 a buyer pays for the new shop's product. The shop receives [`order.paid`](order-paid-event.md), stock drops, and the shop appears on the leaderboard. In AS-30 the owner renames the shop; the board shows the new name at the same rank.

## Known gaps
- The spec does not say which domain owns the leaderboard or which route serves it.
- The spec does not say how many shops the board shows or how often it is refreshed.

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): R-18, R-19
- [order-status](order-status.md)
- [shop-rank](shop-rank.md)
- [tenancy-shop-events](tenancy-shop-events.md)
<!-- used-by:end -->

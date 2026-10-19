---
id: shop-leaderboard
title: Shop leaderboard
kind: term
status: draft
aliases: [rank, ranked]
defined_for: J02-seller-to-first-sale
rules_hash: 555993f29581
---
# Shop leaderboard
## Definition
The shop leaderboard is a public [rank](shop-rank.md)ing of shops by their sales revenue. A shop appears on it after its first paid order. Each shop is ranked only on its own revenue, even when one order holds products from several shops. The leaderboard shows the shop's current name, taken from [tenancy events](tenancy-shop-events.md), and renaming a shop keeps its rank. Cancelled, declined or expired orders create no board entry and do not change rank revenue.

## Example
A buyer pays an order holding lines from shop A and shop B. Each shop receives its own [`order.paid`](order-paid-event.md) and is ranked on its own lines. If shop A is then renamed, its row shows the new name at the same rank.

## Known gaps
- The spec does not name the route that serves the leaderboard, nor the domain that owns it.
- The spec does not say the ranking period or the [tie-break rule](suggest-ordering.md).
- The spec does not say how long a paused leaderboard consumer delays an entry. J02.R-16 only says no fact is lost and the lag is visible.

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): B-15, B-16, B-19
<!-- used-by:end -->

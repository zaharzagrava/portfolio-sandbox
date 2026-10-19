---
id: shop-rank
title: Shop rank
kind: term
status: draft
aliases: [rank]
defined_for: J02-seller-to-first-sale
rules_hash: fec8c69866ef
---
# Shop rank
## Definition
A shop's rank is its position on the [public leaderboard](leaderboard.md), based on the revenue from its [paid orders](paid-mark.md). A shop gets a rank only after an order for its products is paid. In a [mixed order](shop-subtotal.md), each shop is ranked on its own revenue, not the whole order total. A cancelled, declined or expired order never creates or changes a rank, and renaming the shop keeps its rank.

## Example
In [AS-26](acceptance-scenario.md), a buyer pays one order with products from two shops. Each shop is ranked only on the revenue of its own lines. If [`orders.events`](orders-events-topic.md) is [replayed](event-replay.md) from the start, both ranks stay the same (AS-29).

## [Known gaps](known-gaps.md)
- The spec does not say which domain owns the rank or how it is computed, for example the [revenue window](trending-window.md) or [tie-breaks](suggest-ordering.md).
- The spec does not say whether a refund lowers a rank.

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): R-15, R-19
- [shop-leaderboard](shop-leaderboard.md)
<!-- used-by:end -->

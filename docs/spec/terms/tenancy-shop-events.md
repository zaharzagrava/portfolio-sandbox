---
id: tenancy-shop-events
title: Tenancy shop events
kind: term
status: draft
aliases: [tenancy shop event]
defined_for: S05-products
rules_hash: 48575cac59db
---
# Tenancy shop events
## Definition
Tenancy shop events are the events the [tenancy domain](tenancy-domain-layer.md) publishes when a shop changes. The catalog consumes two of them: [`tenancy.shop_status_changed`](shop-status-changed-event.md) and [`tenancy.shop_deleted`](shop-deleted-event.md). With these events the catalog keeps its own copy of each shop's status and never reads tenancy tables directly. A status change can hide or show a shop's products and drops the shop's [cache entries](cache-entry.md). A deletion starts the [catalog shop purge](catalog-shop-purge.md).

## Example
A shop with 2,500 products is suspended, and `tenancy.shop_status_changed` arrives with `shopVersion: 5`. The catalog stores the new status, and the shop's products now answer `404`. Later, reinstatement arrives with `shopVersion: 6`, and the products are public again.

## Known gaps
- The spec does not say which topic carries tenancy shop events, or which consumer group the catalog uses to read them.
- The spec does not say whether `tenancy.shop_deleted` carries `shopVersion` or how a stale deletion event is handled.
- The spec does not list every tenancy shop event. It names only the two that the catalog consumes.

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): R-19
- [cache-entry](cache-entry.md)
- [catalog-shop-purge](catalog-shop-purge.md)
- [leaderboard](leaderboard.md)
- [shop-leaderboard](shop-leaderboard.md)
- [shop-version](shop-version.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
<!-- used-by:end -->

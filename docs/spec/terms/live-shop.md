---
id: live-shop
title: Live shop
kind: term
status: draft
aliases: [live shops]
defined_for: S03-shops-rbac
rules_hash: b736518c88a7
---
# Live shop
## Definition
A live shop is a real shop that trades on the marketplace, as opposed to a [sandbox shop](sandbox-shop.md) used for testing. Each live shop can have at most one sandbox shop, created by [`ensureSandboxShop`](ensure-sandbox-shop.md). Do not confuse this with the [realtime topic](realtime-topic.md) `shop:<shopId>:live`, which is a member-only channel for any shop.

## Example
[`POST /shops`](post-shops.md) creates a live shop with [plan `STARTER`](plan-limit.md) and [status `ACTIVE`](shop-status.md). Calling `ensureSandboxShop` for it then gives it one sandbox shop.

## Known gaps
- The spec does not say how a shop is marked as live or sandbox (a field, a flag or a relation).
- The spec does not say whether "live" depends on shop status, for example whether a [`SUSPENDED`](shop-status.md) shop still counts as live.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-17
- [ensure-sandbox-shop](ensure-sandbox-shop.md)
- [is-publicly-visible](is-publicly-visible.md)
- [plan-limit](plan-limit.md)
- [realtime-topic](realtime-topic.md)
- [sandbox-shop](sandbox-shop.md)
- [shop-status](shop-status.md)
<!-- used-by:end -->

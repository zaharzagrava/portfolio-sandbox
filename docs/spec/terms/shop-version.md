---
id: shop-version
title: shopVersion
kind: term
status: draft
aliases: []
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# shopVersion
## Definition
`shopVersion` is a version number carried on [tenancy shop events](tenancy-shop-events.md). It goes up each time the shop changes. The catalog stores the last `shopVersion` it applied for each shop. If an event's `shopVersion` is not higher than the stored one, the catalog ignores it, so duplicate or [out-of-order events](stale-response-discard.md) cannot roll a shop back to an older status.

## Example
The catalog has stored `shopVersion: 6` with status `ACTIVE` for a shop. A late, [redelivered ↗](../sw-external-terms.md#at-least-once-delivery) event with `shopVersion: 5` saying `SUSPENDED` arrives. The catalog ignores it, and the products stay public.

## Known gaps
- The spec does not say whether every tenancy shop event carries `shopVersion` or only [`tenancy.shop_status_changed`](shop-status-changed-event.md).

## Used by
<!-- used-by:start -->
- [stale-response-discard](stale-response-discard.md)
- [tenancy-shop-events](tenancy-shop-events.md)
<!-- used-by:end -->

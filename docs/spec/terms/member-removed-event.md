---
id: member-removed-event
title: tenancy.member_removed event
kind: term
status: draft
aliases: [tenancy.member_removed]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# tenancy.member_removed event
## Definition
`tenancy.member_removed` is the event tenancy publishes when a person stops being a shop member. Other capabilities consume it to react to the removal. When the [purge](shop-purge.md) removes members because the shop is closing, the event carries the reason [`shop_deleted`](shop-status.md). [It is delivered at least once ↗](../sw-external-terms.md#at-least-once-delivery), so [consumers](event-consumer.md) must handle duplicates.

## Example
A shop with three members is purged. Tenancy publishes `tenancy.member_removed` with reason `shop_deleted` for the former members, together with [`tenancy.shop_deleted`](shop-deleted-event.md) for the shop.

## Known gaps
- The spec does not list the event's [payload fields](event-payload.md) or its other reason values, for example for a member who leaves or is removed by an owner.
- Not confirmed in the code: whether the purge publishes one event per former member or one event for all of them.

## Used by
<!-- used-by:start -->
- [event-consumer](event-consumer.md)
- [event-payload](event-payload.md)
- [shop-purge](shop-purge.md)
<!-- used-by:end -->

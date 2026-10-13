---
id: shop-verification-changed-event
title: tenancy.shop_verification_changed event
kind: term
status: draft
aliases: [tenancy.shop_verification_changed]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# tenancy.shop_verification_changed event
## Definition
`tenancy.shop_verification_changed` is the event the [tenancy capability](tenancy-domain-layer.md) publishes when a shop's [verification state](shop-verification.md) changes. It is one of the events tenancy owns. It goes through the [outbox](inbox-table.md) in the same transaction as the state change. If the outbox append fails, the verification change is rolled back, so the stored state and the event never disagree. Other capabilities can use it to react, for example when a shop becomes eligible for payouts. That use is design intent (not stated in the spec).

## Example
A shop moves from `PENDING` to `VERIFIED`. In one transaction, the `Shop` row gets the new verification state and `payoutsEnabled: true`, and a `tenancy.shop_verification_changed` row is appended to the outbox.

## Known gaps
- The spec does not say what the [event payload](event-payload.md) contains, for example whether it carries the previous state or [`payoutsEnabled`](payouts-enabled.md).
- The spec does not say which capabilities consume this event.

## Used by
<!-- used-by:start -->
- [event-payload](event-payload.md)
- [inbox-table](inbox-table.md)
- [shop-verification](shop-verification.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
<!-- used-by:end -->

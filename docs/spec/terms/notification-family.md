---
id: notification-family
title: Notification family
kind: term
status: draft
aliases: [family]
defined_for: S28-notifications
rules_hash: 4107cc3d5a35
---
# Notification family
## Definition
A family is a group of related event types that the notification capability handles together. The [entry points](entry-point.md) list one [event consumer](event-consumer.md) per source family, for example identity, tenancy, orders, payments, auctions or chat. S28.R-05 tracks the [highest notified version](notified-version.md) separately for each [aggregate](aggregate-id.md) and family. Because of this, events from different families do not block each other's [version check](notification-version-check.md).

## Example
If "family" means source family (not confirmed), then `order.paid` and `order.cancelled` events for one `orderId` go through the orders family's version check. A payments-family event about the same order is checked separately.

## Known gaps
- The spec does not define "family" in S28.R-05. It may be the same as the source family in the entry points, or a narrower grouping of event types.
- The spec does not list which event types belong to each family.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-05
- [aggregate-id](aggregate-id.md)
- [auctions-source-family](auctions-source-family.md)
- [entry-point](entry-point.md)
- [event-consumer](event-consumer.md)
- [generic-fallback-text](generic-fallback-text.md)
- [maximum-age](maximum-age.md)
- [monotonic-version](monotonic-version.md)
- [notification-routing](notification-routing.md)
- [notification-version-check](notification-version-check.md)
- [notified-version](notified-version.md)
<!-- used-by:end -->

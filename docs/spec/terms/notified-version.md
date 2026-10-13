---
id: notified-version
title: Highest notified version
kind: term
status: draft
aliases: [notified version]
defined_for: S28-notifications
rules_hash: 5bbcbece6c69
---
# Highest notified version
## Definition
The highest notified version is the largest [aggregate version](aggregate-version.md) the [notification consumer](event-consumer.md) has already notified for one aggregate and one family. It is the reference value for the [notification version check](notification-version-check.md). The consumer drops any later-arriving event with a lower version than this value. It only applies to aggregates that carry a monotonic version.

## Example
Illustrative values: the orders family has already notified version 7 for one `orderId`. A delayed `order.paid` event for the same order then arrives with `aggregateVersion` 5. Because 5 is lower than 7, the consumer drops it and creates no [inbox item](inbox-item.md) or [delivery](delivery.md) (S28.R-05, proof S28 AS-10).

## Known gaps
- The spec does not say where the highest notified version is stored, or whether it is updated before or after the routing steps finish.
- The spec does not say what happens to an event whose version equals the highest notified version. S28.R-05 only drops lower versions, so a repeat of the same event is presumably left to the [dedupe identity](dedupe-identity.md).
- The spec does not say which outcome or counter records a dropped event.

## Used by
<!-- used-by:start -->
- [aggregate-version](aggregate-version.md)
- [auctions-source-family](auctions-source-family.md)
- [dedupe-identity](dedupe-identity.md)
- [delivery](delivery.md)
- [event-consumer](event-consumer.md)
- [inbox-item](inbox-item.md)
- [notification-family](notification-family.md)
- [notification-version-check](notification-version-check.md)
<!-- used-by:end -->

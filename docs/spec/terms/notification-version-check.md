---
id: notification-version-check
title: Notification version check
kind: term
status: draft
aliases: [version check]
defined_for: S28-notifications
rules_hash: d6838c3bfe2a
---
# Notification version check
## Definition
The notification version check is the step where the [event consumer](event-consumer.md) compares an incoming event's [aggregate version](aggregate-version.md) with the highest notified version for that aggregate and family. If the incoming version is lower, the event is dropped and nothing is notified. The check only runs for aggregates with a monotonic version. Design intent (not stated in the spec): it stops an [out-of-order ↗](../sw-external-terms.md#out-of-order-delivery) older event from telling users about a state the aggregate has already moved past.

## Example
Illustrative values: for one `orderId`, the orders family has notified up to version 7. An `order.cancelled` event with version 8 passes the check and is routed. A late event with version 6 fails the check and is dropped (S28.R-05, proof S28 AS-10).

## Known gaps
- The spec does not say whether the check runs before or after payload validation and the dedupe identity check in the consumer.
- The spec does not say whether a dropped event is reported as the [`stale` consumer outcome](consumer-outcomes.md) or counted any other way.
- Not confirmed in the code: S28.R-05 cites only an acceptance scenario and no code location.

## Used by
<!-- used-by:start -->
- [aggregate-version](aggregate-version.md)
- [consumer-outcomes](consumer-outcomes.md)
- [event-consumer](event-consumer.md)
- [mandatory-type](mandatory-type.md)
- [notification-family](notification-family.md)
- [notified-version](notified-version.md)
<!-- used-by:end -->

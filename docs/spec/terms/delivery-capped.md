---
id: delivery-capped
title: Delivery capped status
kind: term
status: draft
aliases: [capped]
defined_for: S28-notifications
rules_hash: eea3f40424f5
---
# Delivery capped status
## Definition
`capped` is the [timeline status](delivery-timeline.md) given to a [marketing delivery](marketing-delivery.md) that the [marketing cap](marketing-cap.md) refused. A capped delivery is never [queued on its line](notification-channel.md) and never reaches a provider. The inbox item for the same notification stays. Because the cap decision is final for a [delivery id](delivery-id.md), a capped delivery is not reconsidered later.

## Example
A user already had 1 marketing SMS in the last 24 hours. A second marketing SMS gets the timeline status `capped`, nothing is put on `[notify-marketing-sms](notification-queue.md)`, and the notice still appears in `[GET /notifications](get-notifications.md)`.

## Known gaps
- The spec does not say whether `capped` is ever shown to the user or reported through a metric.
- The spec does not say what status a delivery gets when the counting store is down and [marketing fails closed ↗](../sw-external-terms.md#fail-open-fail-closed): `capped` or some other status.

## Used by
<!-- used-by:start -->
- [delivery-id](delivery-id.md)
- [delivery-timeline](delivery-timeline.md)
- [inbox-item](inbox-item.md)
- [marketing-cap](marketing-cap.md)
- [marketing-delivery](marketing-delivery.md)
- [notification-bell](notification-bell.md)
- [notification-channel](notification-channel.md)
- [notification-delivery](notification-delivery.md)
<!-- used-by:end -->

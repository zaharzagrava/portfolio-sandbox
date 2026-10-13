---
id: outbid-event
title: Outbid event
kind: term
status: draft
aliases: [outbid]
defined_for: S28-notifications
rules_hash: f626fa36bfe7
---
# Outbid event
## Definition
An outbid event comes from the [auctions source family](auctions-source-family.md). It tells a bidder that someone else has placed a higher bid. The [notifications consumer](event-consumer.md) validates it, maps it to [notification requests](notification-routing.md) and routes them to the recipient. The [inbox item](inbox-item.md) is created immediately. External deliveries such as push still follow the recipient's preferences and [quiet hours](quiet-hours.md).

## Example
A user is outbid at 23:30 local time, and their quiet hours are `22:00`–`07:00` (illustrative). The inbox item appears and the [bell](notification-bell.md) updates right away. The push is held until 07:00 in the user's [IANA time zone ↗](../sw-external-terms.md#iana-time-zone). At that moment it is checked again for [maximum age](maximum-age.md), [suppression](suppression.md) and current preference.

## Known gaps
- The spec does not say the exact event type name or schema version of the outbid event.
- The spec does not say whether the outbid notice is [transactional or marketing](transactional-send.md), or whether it is a [mandatory type](mandatory-type.md). Both affect [caps](marketing-cap.md) and quiet hours.
- The spec does not say the maximum age of this event type. After that age, a delayed push is recorded [`expired`](pre-send-terminal-status.md) instead of being sent.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): B-06
- [auctions-source-family](auctions-source-family.md)
- [event-consumer](event-consumer.md)
- [inbox-item](inbox-item.md)
- [mandatory-type](mandatory-type.md)
- [marketing-cap](marketing-cap.md)
- [maximum-age](maximum-age.md)
- [notification-bell](notification-bell.md)
- [notification-routing](notification-routing.md)
- [push-notification](push-notification.md)
- [quiet-hours](quiet-hours.md)
- [suppression](suppression.md)
- [transactional-send](transactional-send.md)
<!-- used-by:end -->

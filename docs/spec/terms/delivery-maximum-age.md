---
id: delivery-maximum-age
title: Delivery maximum age
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: e82d7bf97937
---
# Delivery maximum age
## Definition
Every event type has a [maximum age](maximum-age.md): how old its event can be and still cause an external message. An event older than its maximum age still creates the [inbox item](inbox-item.md). Its e-mail, SMS and push deliveries are not sent, and their [timeline](delivery-timeline.md) shows [`expired`](delivery-timeline-expired.md). The age is checked when routing, again at a delayed delivery's [wake instant](wake-instant.md), and before every send. Design intent (not stated in the spec): this stops a late or replayed event from sending a message that no longer makes sense.

## Example
A delivery event is replayed hours after it happened (illustrative case). The recipient still sees the item in `GET /notifications`. The push delivery is recorded `expired` and is never put on [`notify-push`](notify-push.md).

## Known gaps
- The spec does not give the maximum age of any event type, or say where these values are configured.
- The spec does not say which timestamp the age is measured from (the event time, publication, or consumption).

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-27
- [delivery-timeline](delivery-timeline.md)
- [inbox-item](inbox-item.md)
- [maximum-age](maximum-age.md)
- [wake-instant](wake-instant.md)
<!-- used-by:end -->

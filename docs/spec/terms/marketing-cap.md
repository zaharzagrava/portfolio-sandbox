---
id: marketing-cap
title: Marketing cap
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: c197ec78c010
---
# Marketing cap
## Definition
The marketing cap is a [rolling ↗](../sw-external-terms.md#sliding-window) limit on how many [marketing deliveries](marketing-delivery.md) one user can receive on one channel. Push, e-mail and SMS each have their own limit. [Transactional deliveries](transactional-delivery.md) are never capped. The cap decision is [atomic under concurrency ↗](../sw-external-terms.md#atomicity) and [final for a delivery id](delivery-id.md). If the store that holds the counts is down, marketing deliveries are refused ([fail closed ↗](../sw-external-terms.md#fail-open-fail-closed)). This is separate from the [provider send budget](send-budget.md) that the [rate limiter](rate-limiter-service.md) enforces.

## Example
Under S28.R-28, push allows 3 per hour, e-mail 2 per 24 hours and SMS 1 per 24 hours. A user has already had 3 marketing pushes in the last hour, so a fourth is recorded [`capped`](delivery-capped.md) and is never queued on `notify-marketing-push`. Its inbox item stays.

## Known gaps
- The spec does not say which store holds the cap counters, or how "rolling" is computed (an exact sliding window or an estimate).
- The spec does not say whether a [mandatory type](mandatory-notification-type.md) can ever be marketing, so it is unclear whether mandatory types bypass the cap.
- The spec does not give the purpose. Protecting users from too many promotional messages is design intent (not stated in the spec).

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-10
- [delivery-capped](delivery-capped.md)
- [delivery-id](delivery-id.md)
- [follower-fan-out](follower-fan-out.md)
- [mandatory-notification-type](mandatory-notification-type.md)
- [marketing-delivery](marketing-delivery.md)
- [marketing-email](marketing-email.md)
- [marketing-external-channels](marketing-external-channels.md)
- [notification-recipient](notification-recipient.md)
- [notification-router](notification-router.md)
- [notification-routing](notification-routing.md)
- [notify-marketing-email-queue](notify-marketing-email-queue.md)
- [outbid-event](outbid-event.md)
- [rate-limiter-service](rate-limiter-service.md)
- [routing-step](routing-step.md)
- [send-budget](send-budget.md)
- [transactional-delivery](transactional-delivery.md)
<!-- used-by:end -->

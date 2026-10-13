---
id: transactional-send
title: Transactional vs marketing send
kind: term
status: draft
aliases: [marketing sends]
defined_for: S28-notifications
rules_hash: b3058b3d08e6
---
# Transactional vs marketing send
## Definition
Every delivery is either transactional or marketing, and the two are treated differently. Marketing sends follow the per-user, per-channel cap, run on their own lower-capacity [delivery lines](notification-line.md), and [fail closed ↗](../sw-external-terms.md#fail-open-fail-closed) when the [rate limiter](rate-limiter-service.md) or the cap's counting store is down. Transactional sends are never capped and [fail open ↗](../sw-external-terms.md#fail-open-fail-closed) when the rate limiter is down. Marketing external channels and SMS are switched off by default in the preference matrix.

## Example
The rate limiter is unreachable. An order-update push on [`notify-push`](notify-push.md) is still sent (illustrative type). A campaign push on `notify-marketing-push` is not sent.

Reasons for this split. These are design intent (not stated in the spec):
- Fail open for transactional: an outage should not swallow messages people are waiting for.
- Fail closed for marketing: an outage should not let users be flooded with promotions.

## Known gaps
- The spec does not say how a type is classified as transactional or marketing.
- The spec does not say what happens to a marketing send held back by fail-closed. It might be retried later, recorded as `failed`, or recorded as `capped`.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-31
- [delivery-line](delivery-line.md)
- [email-line](email-line.md)
- [marketing-delivery-cap](marketing-delivery-cap.md)
- [marketing-delivery](marketing-delivery.md)
- [marketing-email](marketing-email.md)
- [marketing-notice](marketing-notice.md)
- [notification-line](notification-line.md)
- [outbid-event](outbid-event.md)
- [push-notification](push-notification.md)
- [rate-limiter-service](rate-limiter-service.md)
- [send-budget](send-budget.md)
- [worker-capacity](worker-capacity.md)
<!-- used-by:end -->

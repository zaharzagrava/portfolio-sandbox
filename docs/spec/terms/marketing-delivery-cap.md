---
id: marketing-delivery-cap
title: Marketing delivery cap
kind: term
status: draft
aliases: [cap, capped]
defined_for: S28-notifications
rules_hash: 3bb60b879d73
---
# Marketing delivery cap
## Definition
The marketing delivery cap limits how many marketing deliveries one user can get on one channel within a [rolling window ↗](../sw-external-terms.md#sliding-window). Each channel has its own limit and window. [Transactional deliveries](transactional-send.md) are never capped. A delivery over the cap is recorded `capped` and is not queued, but its inbox item stays. The decision is [atomic under concurrency ↗](../sw-external-terms.md#atomicity), final for each [delivery id](delivery-id.md), and [fails closed ↗](../sw-external-terms.md#fail-open-fail-closed) when the [counting store](rate-limit-counter-store.md) is down.

## Example
A user has already received 2 marketing e-mails in the last 24 hours. A third is routed, so the cap blocks it:
```
timeline: capped   (not put on [notify-marketing-email](notify-marketing-email-queue.md); inbox item kept)
```
A push in the same hour is still allowed if fewer than 3 marketing pushes went out in that hour.

## Known gaps
- The spec does not say what the counting store is, or how the rolling window is computed (exact log or estimate).
- The spec does not say whether a delivery uses up its slot at routing time or at send time. For example, it is unclear whether a push held for [quiet hours](quiet-hours.md) counts before it is sent.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-28
- [capped-delivery](capped-delivery.md)
- [delivery-id](delivery-id.md)
- [marketing-delivery](marketing-delivery.md)
- [marketing-notice](marketing-notice.md)
- [notification-channel](notification-channel.md)
- [notify-marketing-push](notify-marketing-push.md)
- [quiet-hours](quiet-hours.md)
- [rate-limit-counter-store](rate-limit-counter-store.md)
- [transactional-send](transactional-send.md)
<!-- used-by:end -->

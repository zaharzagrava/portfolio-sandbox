---
id: notification-delivery
title: Notification delivery
kind: term
status: draft
aliases: [deliveries]
defined_for: S28-notifications
rules_hash: 98556be62a8b
---
# Notification delivery
## Definition
A notification delivery is one notification on its way to one recipient over one external channel. It is handed to its [line](notification-line.md), sent through the [provider chain](provider-chain.md), and recorded in a [timeline](delivery-timeline.md) of statuses. Before each send, the worker re-checks [suppression](suppression.md), the current preference and the [maximum age](maximum-age.md). A delivery already sent is never handed to a provider again.

## Example
A push delivery during the recipient's [quiet hours](quiet-hours.md), with illustrative timeline steps:
```
queued → delayed (quiet hours) → sent → delivered
```
If the whole provider chain keeps failing, the delivery retries through [`notify-push`](notify-push.md) with [backoff ↗](../sw-external-terms.md#exponential-backoff), then ends as `failed` with reason [`exhausted`](exhausted.md).

## Known gaps
- The spec does not give the allowed status transitions, or say which statuses are final.
- The spec does not say what `skipped` means, as distinct from `suppressed`, `capped` or `expired`.
- The spec does not say how a [delivery id](delivery-id.md) is formed. The [cap decision](delivery-capped.md) is "final per delivery id".

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-02
- [delivery-capped](delivery-capped.md)
- [delivery-id](delivery-id.md)
- [delivery-suppression](delivery-suppression.md)
- [delivery-timeline](delivery-timeline.md)
- [maximum-age](maximum-age.md)
- [notification-line](notification-line.md)
- [provider-chain](provider-chain.md)
- [quiet-hours](quiet-hours.md)
- [side-effects](side-effects.md)
- [suppression](suppression.md)
<!-- used-by:end -->

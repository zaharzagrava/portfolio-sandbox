---
id: capped-delivery
title: Capped delivery
kind: term
status: draft
aliases: [capped]
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# Capped delivery
## Definition
[`capped`](delivery-capped.md) is a [delivery timeline](delivery-timeline.md) status. It means a [marketing delivery](marketing-delivery.md) was stopped because the user hit the [rolling per-user, per-channel marketing cap](marketing-delivery-cap.md). A capped delivery is never [queued to its line](notification-queue.md), but its [inbox item](inbox-item.md) stays. [Transactional deliveries](transactional-delivery.md) are never capped. The cap decision is [atomic under concurrency ↗](../sw-external-terms.md#atomicity) and final for that [delivery id](delivery-id.md). It [fails closed ↗](../sw-external-terms.md#fail-open-fail-closed) (the delivery is capped) when the counting store is down.

## Example
One user gets four marketing e-mails within 24 hours. The cap is 2 per 24 hours, so the first two are queued on `notify-marketing-email`. The third (and the fourth) are recorded `capped` and never sent. All four still create inbox items.

## Known gaps
- The spec does not say whether `capped` deliveries count toward the cap themselves.
- Not confirmed in the code: which store holds the cap counters, or how the rolling window is computed.

## Used by
<!-- used-by:start -->
- [delivery-id](delivery-id.md)
- [delivery-timeline](delivery-timeline.md)
- [inbox-item](inbox-item.md)
- [marketing-delivery-cap](marketing-delivery-cap.md)
- [marketing-delivery](marketing-delivery.md)
- [notification-queue](notification-queue.md)
- [transactional-delivery](transactional-delivery.md)
<!-- used-by:end -->

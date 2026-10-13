---
id: marketing-delivery
title: Marketing delivery
kind: term
status: draft
aliases: [marketing]
defined_for: S28-notifications
rules_hash: 9ad7fb72be2d
---
# Marketing delivery
## Definition
A marketing delivery is an e-mail, SMS or push message for a [marketing notice](marketing-notice.md), as opposed to a [transactional](transactional-send.md) one. It goes on its own line ([`notify-marketing-email`](notify-marketing-email-queue.md), `notify-marketing-sms` or `notify-marketing-push`), which has less [worker capacity](worker-capacity.md). This means a campaign backlog never delays transactional mail. It is subject to the [marketing delivery cap](marketing-delivery-cap.md). It [fails closed ↗](../sw-external-terms.md#fail-open-fail-closed) when the rate limiter or the cap's counting store is down. Its external channels are off by default in the preference matrix.

## Example
A shop's marketing notice reaches its followers through follower fan-out. For each follower who opted in to marketing e-mail, the router creates the inbox item, checks the cap, and then puts the e-mail on `notify-marketing-email`, not `notify-email`.

## Known gaps
- The spec does not list which event types or categories count as marketing.
- Not confirmed in the code: the follower fan-out rule (R-11) and the delivery lines have `[proof: none]`.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-28
- [capped-delivery](capped-delivery.md)
- [delivery-capped](delivery-capped.md)
- [follower-fan-out](follower-fan-out.md)
- [marketing-cap](marketing-cap.md)
- [marketing-delivery-cap](marketing-delivery-cap.md)
- [marketing-notice](marketing-notice.md)
- [notify-marketing-push](notify-marketing-push.md)
- [transactional-send](transactional-send.md)
- [worker-capacity](worker-capacity.md)
<!-- used-by:end -->

---
id: notify-marketing-push
title: notify-marketing-push
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# notify-marketing-push
## Definition
`notify-marketing-push` is the [delivery line](delivery-line.md) for push notifications that are [marketing deliveries](marketing-delivery.md). Transactional push uses the separate [`notify-push`](notify-push.md) line. The marketing line has its own lower [worker capacity](worker-capacity.md), so a campaign backlog or outage never delays transactional push. A delivery joins this line only after it passes the [marketing cap](marketing-delivery-cap.md) and [quiet hours](quiet-hours.md). A capped delivery is recorded `capped` and never queued. Before each send, the worker checks [suppression](suppression.md), the user's current preference and the [maximum age](maximum-age.md). When the [rate limiter](rate-limiter-service.md) is down, sends on this line [fail closed ↗](../sw-external-terms.md#fail-open-fail-closed).

## Example
A [follower fan-out](follower-fan-out.md) of a marketing notice reaches a user who turned on marketing push. The [inbox item](inbox-item.md) is created first. If the cap allows it (3 marketing pushes per hour), the delivery is queued on `notify-marketing-push`. If that line has a backlog, an outbid push on `notify-push` still goes out without waiting.

## Known gaps
- The spec does not give a proof for the delivery lines (the entry point is marked [`[proof: none]`](rule-proof.md)), so the line names are not confirmed by a scenario.
- The spec does not say the worker capacity of this line, or the queue technology behind it.
- The spec does not say which notification types count as marketing push.

## Used by
<!-- used-by:start -->
- [delivery-line](delivery-line.md)
- [follower-fan-out](follower-fan-out.md)
- [inbox-item](inbox-item.md)
- [marketing-delivery-cap](marketing-delivery-cap.md)
- [marketing-delivery](marketing-delivery.md)
- [maximum-age](maximum-age.md)
- [quiet-hours](quiet-hours.md)
- [rate-limiter-service](rate-limiter-service.md)
- [suppression](suppression.md)
- [worker-capacity](worker-capacity.md)
<!-- used-by:end -->

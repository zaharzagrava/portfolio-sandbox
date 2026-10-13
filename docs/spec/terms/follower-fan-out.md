---
id: follower-fan-out
title: Follower fan-out
kind: term
status: draft
aliases: [fan-out]
defined_for: S28-notifications
rules_hash: 4f6123f36912
---
# Follower fan-out
## Definition
Follower fan-out sends one [marketing notice](marketing-delivery.md) to every follower: one notification per follower, created by walking the follower list. It must be [resumable](resumable-fan-out.md) and [idempotent ↗](../sw-external-terms.md#idempotency). If it is retried, it walks the followers again and creates only the [inbox items](inbox-item.md) and [deliveries](delivery.md) that are still missing. Each delivery it creates is still subject to the [marketing cap](marketing-cap.md), [quiet hours](quiet-hours.md) and preferences.

## Example
A seller publishes a marketing notice, for example a launch event. The fan-out walks the followers and creates an inbox item, plus allowed marketing deliveries on the [`notify-marketing-{email,sms,push}`](notification-channel.md) lines, for each follower. If it crashes partway, a retry skips the followers who were already done.

## Known gaps
- The spec does not say what is being followed (a shop, a seller or something else), or which capability supplies the follower list.
- The spec does not say how many followers are walked per step or per batch.
- No acceptance scenario backs this rule (S28.R-11 is `[proof: none]`). Not confirmed in the code: that fan-out is implemented at all.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-11
- [delivery](delivery.md)
- [device-cap](device-cap.md)
- [inbox-item](inbox-item.md)
- [marketing-cap](marketing-cap.md)
- [marketing-delivery](marketing-delivery.md)
- [marketing-email](marketing-email.md)
- [notify-marketing-push](notify-marketing-push.md)
- [quiet-hours](quiet-hours.md)
- [resumable-fan-out](resumable-fan-out.md)
<!-- used-by:end -->

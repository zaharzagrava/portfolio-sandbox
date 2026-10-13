---
id: pre-send-terminal-status
title: Pre-send terminal status
kind: term
status: draft
aliases: [capped, expired, skipped, suppressed]
defined_for: S28-notifications
rules_hash: 4646e70914b9
---
# Pre-send terminal status
## Definition
A pre-send terminal status is a [final delivery status](delivery-status.md) recorded when a delivery ends before any provider receives it. There are four: `suppressed`, `capped`, `skipped` and `expired`. A delivery can reach one only from `queued` or `delayed`. Once a delivery is `sent`, it can never take one of these statuses. Each one stops the external message, but the recipient's inbox item stays.

## Example
An SMS is held for quiet hours, so its timeline reads `delayed`. At its wake instant the event is older than the maximum age for its type, so the timeline moves `delayed` → `expired` and nothing goes to the SMS provider.
A marketing push over the per-user cap is recorded `capped` and is not handed to its line.

## Known gaps
- The spec does not say what causes `skipped`. One likely cause is a preference opt-out found when the delivery is re-checked, but the spec does not confirm it.
- The spec does not say where `failed` sits in the forward-only rank order, or whether it can follow `sent`.
- The spec does not say what happens to a write that tries to break the order, such as `capped` after `sent`. It could be rejected, ignored or counted.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-47
- [delivery-status](delivery-status.md)
- [delivery-timeline](delivery-timeline.md)
<!-- used-by:end -->

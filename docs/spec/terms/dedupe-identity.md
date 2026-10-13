---
id: dedupe-identity
title: Dedupe identity
kind: term
status: draft
aliases: [dedupe key]
defined_for: S28-notifications
rules_hash: a42e7884ed0a
---
# Dedupe identity
## Definition
The dedupe identity is the single key that makes one notification unique. It has three parts: the [source event id](event-id.md) (or the owner's own key), the [recipient](notification-recipient.md) and the [channel](notification-channel.md). Processing the same identity again, one after another or at the same time, creates no second [inbox item](inbox-item.md), delivery, realtime event or [unread count](unread-count.md). This makes the notification consumer safe under [at-least-once publication ↗](../sw-external-terms.md#at-least-once-delivery) and event replay.

## Example
Event `evt-7f3a` (illustrative), recipient user `u-42`, channel e-mail → one identity. If the same event arrives twice from the backbone, the second copy finds that identity already exists, so it queues no second e-mail on `notify-email`.

## Known gaps
- The spec does not say what "the owner's own key" is, or which notifications use it instead of a source event id.
- Not confirmed in the code: how uniqueness is enforced (for example a unique constraint or a lookup before the write).
- The spec does not say whether the inbox counts as a "channel" in this identity. The phrase "each other allowed channel" suggests it does.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-02
- [done-marker](done-marker.md)
- [event-id](event-id.md)
- [inbox-item](inbox-item.md)
- [notification-channel](notification-channel.md)
- [notification-recipient](notification-recipient.md)
- [notified-version](notified-version.md)
- [queue-refusal](queue-refusal.md)
- [resumable-fan-out](resumable-fan-out.md)
- [routing-step](routing-step.md)
- [tenancy-invite-requested-queue](tenancy-invite-requested-queue.md)
- [unread-count](unread-count.md)
<!-- used-by:end -->

---
id: dead-letter-without-body
title: Dead-lettered without body
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: 5a240d2d3a48
---
# Dead-lettered without body
## Definition
A [delivery line](notification-line.md) ([`notify-email`](notify-email-queue.md), [`notify-sms`](notify-sms-queue.md), [`notify-push`](notify-push.md) or a [marketing line](marketing-external-channels.md)) sometimes receives a queue message it cannot parse. That message is moved aside as a [dead-letter record](dead-letter-topic.md), but its content is dropped. The record keeps enough to show that a bad message arrived, but none of what it carried. Design intent (not stated in the spec): a delivery message can hold secrets such as reset links or one-time codes, and the rules forbid secrets in dead-letter records.

## Example
A message on `notify-email` arrives with a truncated, unparseable payload. The worker never hands it to a provider. It writes a dead-letter record that has no body, so no invite token or reset link from the payload is stored.

## Known gaps
- The spec does not say which fields the dead-letter record keeps instead of the body, such as a message id, the line name or a reason code.
- The spec does not say what counts as "malformed": broken JSON only, or also a message that fails schema validation.
- The spec does not say how an operator can investigate or redrive a record that has no body.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-35
- [dead-letter-topic](dead-letter-topic.md)
- [malformed-queue-message](malformed-queue-message.md)
- [marketing-external-channels](marketing-external-channels.md)
- [notification-line](notification-line.md)
- [notifications-callbacks-queue](notifications-callbacks-queue.md)
<!-- used-by:end -->

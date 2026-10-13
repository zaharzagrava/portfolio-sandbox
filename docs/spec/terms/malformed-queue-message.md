---
id: malformed-queue-message
title: Malformed queue message
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: 20965fe65ba9
---
# Malformed queue message
## Definition
A malformed queue message is a message on a [delivery line](notification-channel.md) or on [`notifications-callbacks`](notifications-callbacks-queue.md) that the worker cannot parse or validate as a delivery. Such a message is [dead-lettered](dead-letter-topic.md) without its body, and it is not retried. The body is dropped because messages can contain secrets such as [reset tokens](password-reset-token.md), [invite tokens](invite-token.md), one-time codes and [unsubscribe tokens](unsubscribe-token.md). Those secrets must never appear in [dead-letter records](dead-letter-without-body.md).

## Example
A message on `notify-email` with a broken JSON body arrives. The worker writes a dead-letter record with a reason but without the original payload. No send happens, and the worker moves on to the next message.

## Known gaps
- The spec does not say what the dead-letter record does contain, for example a message id, a reason code or the line name. Without the body, it is hard to investigate or [redrive](dead-letter-redrive.md) the message.
- The spec does not say whether a malformed message on `notifications-callbacks` is handled like one on a delivery line.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-35
- [dead-letter-redrive](dead-letter-redrive.md)
- [dead-letter-topic](dead-letter-topic.md)
- [dead-letter-without-body](dead-letter-without-body.md)
- [invite-token](invite-token.md)
- [known-unmapped-type](known-unmapped-type.md)
- [notification-channel](notification-channel.md)
- [password-reset-token](password-reset-token.md)
- [unsubscribe-token](unsubscribe-token.md)
<!-- used-by:end -->

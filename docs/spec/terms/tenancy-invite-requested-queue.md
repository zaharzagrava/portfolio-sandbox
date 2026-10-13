---
id: tenancy-invite-requested-queue
title: tenancy-invite-requested queue
kind: term
status: draft
aliases: [tenancy-invite-requested]
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# tenancy-invite-requested queue
## Definition
The `tenancy-invite-requested` queue is an [SQS queue ↗](../sw-external-terms.md#sqs-queue) that the notifications capability reads from. It sits alongside the [event consumers](event-consumer.md) built on the S53 framework. Its messages ask notifications to send a shop invitation to an e-mail address, not to a known user. Each request goes to the [e-mail line](email-line.md) only. It creates no [inbox item](inbox-item.md), skips the [preference lookup](preference-lookup.md) and is still subject to [suppression](suppression.md). The [invite token](invite-token.md) in the message may appear only in the e-mail handed to the [mail provider](mail-provider.md). It must never appear in logs, the [delivery timeline](delivery-timeline.md) or [dead-letter records](dead-letter-topic.md).

## Example
A shop manager invites `new.staff@example.com` (illustrative) to join their shop. A request arrives on `tenancy-invite-requested`. Notifications renders the invitation e-mail and puts it on the [`notify-email`](notify-email-queue.md) line. No bell or inbox item is created, because there is no user to own one.

## Known gaps
- The spec does not say what a message on this queue contains or who publishes it. The queue name suggests tenancy publishes it, and rule S28.R-08 (backed by proof AS-08) links it to invitations.
- The spec does not say whether payload validation and dead-lettering (S28.R-01) apply here as they do to event consumers. It also does not say which [dedupe identity](dedupe-identity.md) is used, the source event id or "the owner's own key".
- The spec does not say why invitations arrive through a separate SQS queue instead of the S53 event framework. Any reason given would be design intent (not stated in the spec).

## Used by
<!-- used-by:start -->
- [dead-letter-topic](dead-letter-topic.md)
- [dedupe-identity](dedupe-identity.md)
- [delivery-timeline](delivery-timeline.md)
- [email-line](email-line.md)
- [event-consumer](event-consumer.md)
- [inbox-item](inbox-item.md)
- [invite-token](invite-token.md)
- [mail-provider](mail-provider.md)
- [notification-type](notification-type.md)
- [preference-lookup](preference-lookup.md)
- [recipient-rule](recipient-rule.md)
- [suppression](suppression.md)
<!-- used-by:end -->

---
id: notify-marketing-email-queue
title: notify-marketing-email queue
kind: term
status: draft
aliases: [notify-marketing-email]
defined_for: S28-notifications
rules_hash: 6f8c5ac0d53b
---
# notify-marketing-email queue
## Definition
`notify-marketing-email` is the [delivery line](notification-channel.md) that carries e-mail deliveries of marketing notifications. It is separate from [`notify-email`](notify-email-queue.md), which carries transactional e-mail, and has lower [worker capacity](worker-capacity.md). A large campaign backlog or a [provider outage](mail-provider.md) here therefore never delays a password-reset or order e-mail. Design intent (not stated in the spec): the cheap, bulky traffic should never compete with messages users are waiting for. A delivery reaches this line only after the [router](notification-router.md) has applied the [preference matrix](preference-matrix.md) and the [marketing cap](marketing-cap.md).

## Example
A shop launch event fans out to followers. One follower has opted in to marketing e-mail and is under the e-mail cap (2 per 24 hours), so the router queues the delivery on `notify-marketing-email`. Another follower already hit the cap, so their delivery is recorded [`capped`](delivery-capped.md) and never queued. A password-reset mail sent at the same moment goes on `notify-email` and doesn't wait behind the campaign.

## Known gaps
- The spec does not say which queue technology backs this line, or how much lower its worker capacity is. The [entry point](entry-point.md) has no proof ([`[proof: none]`](rule-proof.md)).
- The spec does not say whether marketing and transactional e-mail share the same [provider chain](provider-chain.md) and [send budget](send-budget.md), or whether each line has its own.
- Not confirmed in the code: the exact queue name. The spec writes it only as the pattern `notify-marketing-{email,sms,push}`.

## Used by
<!-- used-by:start -->
- [entry-point](entry-point.md)
- [mail-provider](mail-provider.md)
- [marketing-cap](marketing-cap.md)
- [notification-channel](notification-channel.md)
- [notification-queue](notification-queue.md)
- [notification-router](notification-router.md)
- [preference-matrix](preference-matrix.md)
- [provider-chain](provider-chain.md)
- [send-budget](send-budget.md)
- [worker-capacity](worker-capacity.md)
<!-- used-by:end -->

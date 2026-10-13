---
id: notify-email-queue
title: notify-email queue
kind: term
status: draft
aliases: [notify-email]
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# notify-email queue
## Definition
`notify-email` is the [delivery line](notification-channel.md) for non-marketing e-mail. The [notification router](notification-router.md) puts an e-mail delivery on it after the [inbox item](inbox-item.md), the [preference check](preference-lookup.md) and [suppression](suppression.md). E-mail workers take deliveries from it and send them through the [e-mail provider chain](provider-chain.md). Marketing e-mail goes on its own line, `notify-marketing-email`, so a marketing backlog or a provider outage there never delays mail on `notify-email`. A delivery that is over its [send budget](send-budget.md), or that hits a [transient failure](transient-failure.md) across the whole chain, goes back onto this line to wait before it is tried again.

## Example
A shop manager invites a new member. The [`tenancy-invite-requested`](tenancy-invite-requested-queue.md) message reaches the router, which skips the inbox and the preference lookup because the invite is addressed to an e-mail address. It checks suppression and puts one delivery on `notify-email`. A worker picks it up, checks suppression and the [maximum age](maximum-age.md) again, and hands the message to the first e-mail provider in the chain.

## Known gaps
- The spec does not say which queue technology backs `notify-email`. SQS is named only for `tenancy-invite-requested`.
- Not confirmed in the code: the spec lists the line name with `[proof: none]` and cites no code file for it.
- The spec does not say how many workers serve `notify-email`. It only says marketing lines have lower worker capacity.

## Used by
<!-- used-by:start -->
- [inbox-item](inbox-item.md)
- [maximum-age](maximum-age.md)
- [notification-channel](notification-channel.md)
- [notification-router](notification-router.md)
- [preference-lookup](preference-lookup.md)
- [provider-chain](provider-chain.md)
- [send-budget](send-budget.md)
- [suppression](suppression.md)
- [transactional-mail-module](transactional-mail-module.md)
- [transient-failure](transient-failure.md)
<!-- used-by:end -->

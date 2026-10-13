---
id: notification-recipient
title: Notification recipient
kind: term
status: draft
aliases: [recipient]
defined_for: S28-notifications
rules_hash: 457a7a85e88e
---
# Notification recipient
## Definition
A notification recipient is the person one notification is for. Usually it is a platform user, but for an invitation it is a bare e-mail address. The recipient is one of the three parts of the dedupe identity, so each recipient gets their own [inbox item](inbox-item.md) and [deliveries](delivery.md). Recipients are resolved only through the exported services of identity and tenancy, in batches, and an unknown user gets nothing. For each user recipient, the [router](notification-router.md) renders the message once in that user's locale. It then applies their preferences, [quiet hours](quiet-hours.md) in their time zone and the [marketing cap](marketing-cap.md).

## Example
An order event (event id `evt-7f3a`, illustrative) maps to recipient user `u-42` (illustrative), whose locale is `uk`. The router creates one inbox item, announces it as event `notification` on `user:u-42`, and hands each allowed channel to its [line](notification-channel.md), such as `notify-email`.
An invitation from the queue `[tenancy-invite-requested](tenancy-invite-requested-queue.md)` names an e-mail address as its recipient. It goes to the e-mail line only: no inbox item and no preference lookup, though [suppression](suppression.md) still applies.

## Known gaps
- The spec does not say how each event type decides who its recipients are (for example, buyer, seller or shop members).
- The spec does not say which locale is used to render a message for an e-mail-address recipient, which has no stored settings.
- Not confirmed in the code: which exported service methods of identity and tenancy the router calls to resolve recipients.

## Used by
<!-- used-by:start -->
- [dedupe-identity](dedupe-identity.md)
- [delivery](delivery.md)
- [exported-service](exported-service.md)
- [inbox-item](inbox-item.md)
- [marketing-cap](marketing-cap.md)
- [notification-channel](notification-channel.md)
- [notification-router](notification-router.md)
- [quiet-hours](quiet-hours.md)
- [suppression](suppression.md)
<!-- used-by:end -->

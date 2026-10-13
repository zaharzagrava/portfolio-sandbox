---
id: address-suppression
title: Address suppression
kind: term
status: draft
aliases: [suppressed]
defined_for: S28-notifications
rules_hash: fa817816f884
---
# Address suppression
## Definition
Address suppression marks a destination as one that must never be sent to again. Bad addresses then stop receiving mail for good. An address is suppressed after a permanent provider failure or an SES complaint. Suppression is checked before every send and again when a [delayed delivery wakes up](wake-instant.md). [Mandatory types](mandatory-type.md) and e-mail invitations must obey it too. A blocked delivery is recorded on its [timeline](delivery-timeline.md) as `suppressed`.

## Example
A provider reports a permanent failure for `old-user@example.com` (illustrative). The delivery is `failed` and is not retried or failed over. The address is suppressed. A later mandatory security e-mail to that address is recorded `suppressed`, and no provider is called.

## Known gaps
- The spec does not say whether suppression can ever be lifted, for example after a user fixes the address, or by whom.
- The spec does not say whether phone numbers can be suppressed the same way. For push it only says the dead token is removed.
- The spec does not say whether the inbox item is still created for a suppressed user. The router creates the inbox item first (S28.R-10), which suggests it is, but no rule states it.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): B-11
- [bounce](bounce.md)
- [callback-deduplication](callback-deduplication.md)
- [callback-freshness-window](callback-freshness-window.md)
- [complaint](complaint.md)
- [delivery-bounced](delivery-bounced.md)
- [delivery-timeline](delivery-timeline.md)
- [mandatory-notification](mandatory-notification.md)
- [mandatory-type](mandatory-type.md)
- [notification-queue](notification-queue.md)
- [notification-webhooks-controller](notification-webhooks-controller.md)
- [post-notifications-webhooks-twilio](post-notifications-webhooks-twilio.md)
- [ses-complaint](ses-complaint.md)
- [sms-stop](sms-stop.md)
- [wake-instant](wake-instant.md)
<!-- used-by:end -->

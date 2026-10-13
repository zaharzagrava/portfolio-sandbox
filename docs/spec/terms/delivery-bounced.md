---
id: delivery-bounced
title: Delivery bounced status
kind: term
status: draft
aliases: [bounced, complained]
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# Delivery bounced status
## Definition
`bounced` is one of the statuses on a delivery's [timeline](delivery-timeline.md). It records that the message reached a provider, but the provider later reported that it could not be delivered to the address. Each delivery has a timeline, and `bounced` sits next to [`delivered`](delivery-status.md), [`complained`](complaint.md) and `failed`. If the timeline write for this status fails, the send is neither failed nor repeated.

## Example
An order e-mail goes out through the [`notify-email` line](notification-channel.md) and is recorded as `sent`. Later the provider calls [`POST /notifications/webhooks/ses`](provider-callback.md) to say the mailbox does not exist, and the delivery's timeline gets `bounced`.

## Known gaps
- The spec does not say which provider callbacks set `bounced`, or how `bounced` differs from `failed` after a permanent provider failure.
- The spec does not say whether every bounce suppresses the address. [Suppression](address-suppression.md) is stated only for a permanent provider failure at send time.
- Not confirmed in the code: the mapping from SES or Twilio callback payloads to this status.

## Used by
<!-- used-by:start -->
- [address-suppression](address-suppression.md)
- [delivery-timeline](delivery-timeline.md)
- [notification-channel](notification-channel.md)
<!-- used-by:end -->
